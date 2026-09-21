// Schedule timing: when a scheduled task is due, in words and in minutes.
// Pure functions over a schedule row's timing fields (every, atHour, atMinute,
// weekday, cron). No timers, no I/O. Main ticks once a minute and asks
// `dueSince`; the renderer asks `nextDueAt` and `describeTiming` to show
// "next run" and the preset in words. Shared by main and the renderer the same
// way snooze.js is.
//
// Three things here are this fork's, not upstream's, and their comments say
// why: the per-kind fire key (`fireSlotKey`), the window evaluation
// (`dueSince`) and the slot memo (`createFireGate`). Upstream asks "is it due
// in the minute containing now" once a minute and keeps no memo at all.
(function (root) {
  const MINUTE_MS = 60 * 1000;
  // How far `nextDueAt` looks before giving up: a weekly schedule is at most
  // seven days out, and a cron with an impossible date never fires.
  const LOOKAHEAD_MINUTES = 8 * 24 * 60;

  /** The choices the dialog offers. `every = 'cron'` is never offered: it only comes from an imported file. */
  const PRESETS = [
    { every: '15m', label: 'Every 15 minutes' },
    { every: '30m', label: 'Every 30 minutes' },
    { every: 'hour', label: 'Every hour' },
    { every: 'day', label: 'Every day' },
    { every: 'weekdays', label: 'Weekdays' },
    { every: 'week', label: 'Every week' },
  ];
  const EVERY_VALUES = new Set([...PRESETS.map(p => p.every), 'cron']);
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /**
   * The two families a kind can belong to, and the whole of the DST decision.
   *
   * A CALENDAR kind names a wall-clock time on a date — "every day at 01:30",
   * "cron 30 1 * * *". It means that clock reading, once. On a fall-back day
   * the reading happens twice (America/Los_Angeles 2026-11-01: local
   * 01:00-01:59 runs at 08:00-08:59Z and again at 09:00-09:59Z), and firing
   * both is the bug closed in 2837596 — two unattended, billed runs.
   *
   * An INTERVAL kind names a spacing — "every 30 minutes", "every hour". The
   * repeated hour is two real hours, so two fires are two correct fires.
   * Suppressing the second would silently drop an hour of runs.
   *
   * So the fire key differs by family: calendar kinds key on the wall-clock
   * minute (the repeat collapses), interval kinds key on the absolute UTC
   * minute (the repeat stays distinct). Keying everything one way or the other
   * is wrong in one direction or the other.
   */
  const CALENDAR_KINDS = new Set(['day', 'weekdays', 'week', 'cron']);
  const INTERVAL_KINDS = new Set(['15m', '30m', 'hour']);

  /**
   * How far back a single tick will look for a due minute it missed.
   *
   * setInterval does not guarantee a tick a minute: under load, or on a
   * machine that was busy or briefly suspended, a tick arrives late and the
   * minute it should have covered is simply gone. Evaluating the window
   * (lastTick, now] instead of "is it this minute" recovers it. The clamp is
   * what keeps that from turning a resume-from-sleep into a burst: anything
   * older than this belongs to the opt-in catch-up path (`missedRun`), which
   * the user asked for per schedule, not to the ticker.
   */
  const MAX_TICK_CATCHUP_MINUTES = 10;

  /**
   * How long a fired wall-clock slot is remembered, so the repeat of that
   * slot can be recognised. It has to outlast the largest offset change a
   * zone has ever made — one hour nearly everywhere, two in the zones that
   * once ran double summer time — and nothing else depends on it, so three
   * hours is the cheap safe answer. See createFireGate.
   *
   * KNOWN LIMITATION, deliberately not fixed. This memo is in memory only, so
   * a restart inside the repeated hour forgets that the first 01:30 fired and
   * the second one fires too - the exact double-run 2837596 closed, in the one
   * window where the process does not survive. A restart is the only way to
   * reach it; a running app collapses the repeat correctly.
   *
   * It is not fixed because the obvious persisted marker does not answer the
   * question. `schedules.lastRunAt` (db.js:419, written by scheduleRecordRun at
   * db.js:668) is an instant, and the two 01:30s are one wall-clock slot an
   * hour apart in UTC - so `lastRunAt >= dueAt` is false for the second one and
   * suppresses nothing. Fixing it properly means persisting the SLOT KEY that
   * fireSlotKey computes, i.e. a new column, which is a schema change for a
   * once-a-year window of a few minutes. If that column is ever added, seed
   * this memo from it at startup and the gate needs no other change.
   */
  const MEMO_RETENTION_MS = 3 * 60 * 60 * 1000;

  // Check if a cron field matches a value. Supports *, ranges (1-5), lists
  // (1,3,5) and steps (*/5). Kept from the old schedule-runner so imported
  // crons keep firing exactly as they did.
  function cronFieldMatches(field, value) {
    if (field === '*') return true;
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    if (field.includes(',')) return field.split(',').some(f => cronFieldMatches(f.trim(), value));
    if (field.includes('-')) {
      const [lo, hi] = field.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field, 10) === value;
  }

  /** Whether a 5-field cron expression matches the given local time. */
  function cronMatches(cronExpr, date) {
    const parts = String(cronExpr || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minute, hour, dom, month, dow] = parts;
    return cronFieldMatches(minute, date.getMinutes()) &&
      cronFieldMatches(hour, date.getHours()) &&
      cronFieldMatches(dom, date.getDate()) &&
      cronFieldMatches(month, date.getMonth() + 1) &&
      cronFieldMatches(dow, date.getDay());
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Does this schedule fire in the minute containing `date` (local time)? */
  function dueThisMinute(schedule, date) {
    if (!schedule) return false;
    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDay();
    const atMinute = num(schedule.atMinute, 0);
    const atHour = num(schedule.atHour, 9);
    switch (schedule.every) {
      case '15m': return minute % 15 === 0;
      case '30m': return minute % 30 === 0;
      case 'hour': return minute === atMinute;
      case 'day': return hour === atHour && minute === atMinute;
      case 'weekdays': return day >= 1 && day <= 5 && hour === atHour && minute === atMinute;
      case 'week': return day === num(schedule.weekday, 1) && hour === atHour && minute === atMinute;
      case 'cron': return cronMatches(schedule.cron, date);
      default: return false;
    }
  }

  // --- Firing once, per kind (the DST rule above, made usable) ---

  /**
   * The local wall-clock minute an instant falls in. Carried over from
   * schedule-runner.js localSlotKey (2837596), where the fall-back double-fire
   * was first closed; identical output, so a calendar schedule suppressed
   * there is suppressed here.
   */
  function localSlotKey(d) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${d.getHours()}:${d.getMinutes()}`;
  }

  /** The absolute minute an instant falls in — unaffected by any offset change. */
  function utcSlotKey(d) {
    return String(Math.floor(d.getTime() / MINUTE_MS));
  }

  /**
   * The key that answers "have I already fired this schedule for this
   * occurrence". Calendar kinds collapse a repeated wall-clock minute;
   * interval kinds keep the two apart. See CALENDAR_KINDS above.
   *
   * The L/U prefix keeps the two namespaces from ever colliding if a
   * schedule's kind is edited between ticks — the memo then simply misses and
   * the schedule is allowed to fire, which is the safe direction for an edit.
   *
   * Known and accepted: an imported cron that is really an interval — an
   * every-5-minutes step expression, which presetFromCron has no preset for —
   * counts as a calendar kind here and loses the repeated hour's runs on a
   * fall-back day. The steps an imported file usually carries (15 and 30
   * minutes, and an on-the-minute hourly) are converted to real interval
   * presets at import by presetFromCron, so they are unaffected. This is
   * exactly what 2837596 already did to every cron; it is not a new loss.
   */
  function fireSlotKey(schedule, date) {
    const d = date instanceof Date ? date : new Date(date);
    return CALENDAR_KINDS.has(schedule?.every) ? `L${localSlotKey(d)}` : `U${utcSlotKey(d)}`;
  }

  /** Start of the minute after `ms`. */
  function nextMinuteStart(ms) {
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  }

  /** Start of the minute containing `ms`. */
  function minuteStart(ms) {
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  }

  /**
   * The latest due minute in the window (fromMs, toMs], as ms, or null.
   *
   * This is what a ticker asks instead of `dueThisMinute(row, now)`: a tick
   * that arrives late still sees the minute it slept through. It answers with
   * the *latest* due minute rather than all of them, because a schedule that
   * came due three times while the tick was away wants one session, not three.
   *
   * `fromMs` is the previous tick. Null or missing means "no window yet" and
   * only the minute containing `toMs` is considered, which is exactly
   * upstream's behaviour on the first tick. The window is clamped to
   * MAX_TICK_CATCHUP_MINUTES; see that constant.
   */
  function dueSince(schedule, fromMs, toMs, maxMinutes = MAX_TICK_CATCHUP_MINUTES) {
    if (!schedule || !Number.isFinite(toMs)) return null;
    const end = minuteStart(toMs);
    const floor = end - Math.max(0, maxMinutes) * MINUTE_MS;
    let start = Number.isFinite(fromMs) ? nextMinuteStart(fromMs) : end;
    if (start < floor) start = floor;
    let latest = null;
    for (let t = start; t <= end; t += MINUTE_MS) {
      if (dueThisMinute(schedule, new Date(t))) latest = t;
    }
    return latest;
  }

  /**
   * The ticker's memory, so a caller cannot get the three parts of the rule —
   * the window, the per-kind key and the slot memo — subtly wrong on its own.
   *
   *   const gate = createFireGate();
   *   // once a minute:
   *   const now = Date.now();
   *   for (const row of rows) {
   *     const dueAt = gate.due(row, now);
   *     if (dueAt === null) continue;        // not due, or already fired
   *     if (pausedOrBusy(row)) continue;     // the caller's own filters
   *     gate.markFired(row, dueAt);
   *     fire(row);
   *   }
   *   gate.endTick(now, rows.map(r => r.id));
   *
   * `markFired` is the caller's job, not `due`'s, so a schedule skipped
   * because its previous run is still working does not burn its slot.
   *
   * A schedule remembers a SET of recent slots, not just its last one. One
   * slot is enough only for a schedule that fires at most once per repeated
   * hour — `30 1 * * *`, the entry 2837596 was written against. A cron that
   * fires several times an hour (`0,30 1 * * *`) walks its memo forward
   * through the first pass, so by the time the repeat arrives the memo holds
   * the wrong slot and every one of them fires again. Keeping the slots of
   * the last MEMO_RETENTION_MS is what actually makes "once per wall-clock
   * slot" true.
   *
   * The memo is in memory only. A restart inside a repeated wall-clock hour
   * can still double-fire a calendar schedule; closing that needs the fired
   * slots persisted with the row, and is not attempted here.
   */
  function createFireGate() {
    // schedule id → Map<fire key, the due minute it was fired for>
    const fired = new Map();
    let lastTickMs = null;

    const idOf = (schedule) => (schedule && schedule.id != null ? String(schedule.id) : null);

    // A plain closure rather than a method, so a destructured `due` still works.
    function hasFired(schedule, dueAtMs) {
      const id = idOf(schedule);
      if (id === null) return false;
      const slots = fired.get(id);
      return !!slots && slots.has(fireSlotKey(schedule, dueAtMs));
    }

    return {
      /**
       * The due minute this schedule should fire for now, or null when it is
       * not due in the window or already fired for that occurrence.
       * Read-only: call `markFired` to commit.
       */
      due(schedule, nowMs) {
        const dueAt = dueSince(schedule, lastTickMs, nowMs);
        if (dueAt === null) return null;
        return hasFired(schedule, dueAt) ? null : dueAt;
      },
      /** Has this schedule already run for the occurrence at `dueAtMs`? */
      hasFired,
      /** Remember that this schedule ran for that occurrence. */
      markFired(schedule, dueAtMs) {
        const id = idOf(schedule);
        if (id === null) return;
        let slots = fired.get(id);
        if (!slots) { slots = new Map(); fired.set(id, slots); }
        slots.set(fireSlotKey(schedule, dueAtMs), dueAtMs);
        // Bounded by time, not by count: a repeated hour is at most an hour
        // (two, in the zones that ever shifted twice), so anything older than
        // the retention can never be the slot a repeat lands on again.
        const cutoff = dueAtMs - MEMO_RETENTION_MS;
        for (const [key, at] of slots) if (at < cutoff) slots.delete(key);
      },
      /** The slots a schedule is remembered for, for logging and tests. */
      firedSlots(schedule) {
        const id = idOf(schedule);
        const slots = id === null ? null : fired.get(id);
        return slots ? [...slots.keys()] : [];
      },
      /**
       * Close the tick: the next window starts here. Pass the live schedule
       * ids to drop the memo of ones that no longer exist, so a long-running
       * app does not keep a row per schedule it has ever seen.
       */
      endTick(nowMs, liveIds) {
        if (Number.isFinite(nowMs)) lastTickMs = nowMs;
        if (liveIds) {
          const live = new Set([...liveIds].map(String));
          for (const id of [...fired.keys()]) if (!live.has(id)) fired.delete(id);
        }
      },
      /** Where the next window starts, or null before the first endTick. */
      get lastTickMs() { return lastTickMs; },
    };
  }

  /**
   * The first due minute strictly after `fromMs`, as ms, or null when none is
   * found within the lookahead. Walks minute by minute so it can never
   * disagree with `dueThisMinute`.
   */
  function nextDueAt(schedule, fromMs) {
    if (!schedule || !EVERY_VALUES.has(schedule.every)) return null;
    let t = nextMinuteStart(fromMs);
    for (let i = 0; i < LOOKAHEAD_MINUTES; i++, t += MINUTE_MS) {
      if (dueThisMinute(schedule, new Date(t))) return t;
    }
    return null;
  }

  /**
   * A run that should have happened while the app was closed: there is a due
   * minute after the last run (or the schedule's creation) and before now.
   */
  function missedRun(schedule, nowMs) {
    if (!schedule || !schedule.catchUp) return false;
    const since = Date.parse(schedule.lastRunAt || schedule.created || '');
    if (!Number.isFinite(since)) return false;
    const due = nextDueAt(schedule, since);
    return due !== null && due <= nowMs;
  }

  function timeOfDay(hour, minute) {
    const d = new Date(2000, 0, 1, hour, minute, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** The timing in words: "every 15 minutes", "every day at 9:00 AM", "Mondays at 9:00 AM". */
  function describeTiming(schedule) {
    if (!schedule) return '';
    const atMinute = num(schedule.atMinute, 0);
    const atHour = num(schedule.atHour, 9);
    switch (schedule.every) {
      case '15m': return 'every 15 minutes';
      case '30m': return 'every 30 minutes';
      case 'hour': return atMinute ? `every hour at :${String(atMinute).padStart(2, '0')}` : 'every hour';
      case 'day': return `every day at ${timeOfDay(atHour, atMinute)}`;
      case 'weekdays': return `weekdays at ${timeOfDay(atHour, atMinute)}`;
      case 'week': return `${WEEKDAYS[num(schedule.weekday, 1)] || 'Monday'}s at ${timeOfDay(atHour, atMinute)}`;
      case 'cron': return describeCron(schedule.cron);
      default: return '';
    }
  }

  /** Plain words for the crons an imported file is likely to have; the raw string otherwise. */
  function describeCron(cron) {
    const preset = presetFromCron(cron);
    if (preset) return describeTiming(preset) + ' (from file)';
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length === 5 && /^\*\/\d+$/.test(parts[0]) && parts.slice(1).every(p => p === '*')) {
      return `every ${parts[0].slice(2)} minutes (from file)`;
    }
    return `cron ${String(cron || '').trim()} (from file)`;
  }

  /**
   * The preset a cron expression is exactly equivalent to, as timing fields,
   * or null when no preset fits and the cron has to be kept as is.
   */
  function presetFromCron(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minute, hour, dom, month, dow] = parts;
    if (dom !== '*' || month !== '*') return null;
    const m = /^\d+$/.test(minute) ? Number(minute) : null;
    const h = /^\d+$/.test(hour) ? Number(hour) : null;
    if (m !== null && (m < 0 || m > 59)) return null;
    if (h !== null && (h < 0 || h > 23)) return null;
    if (hour === '*' && dow === '*') {
      if (minute === '*/15') return { every: '15m' };
      if (minute === '*/30') return { every: '30m' };
      if (m !== null) return { every: 'hour', atMinute: m };
      return null;
    }
    if (m === null || h === null) return null;
    if (dow === '*') return { every: 'day', atHour: h, atMinute: m };
    if (dow === '1-5') return { every: 'weekdays', atHour: h, atMinute: m };
    if (/^[0-6]$/.test(dow)) return { every: 'week', atHour: h, atMinute: m, weekday: Number(dow) };
    return null;
  }

  /** "in 12 min", "in 3 h", "tomorrow 9:00 AM", "Mon 9:00 AM", else "Sep 20, 9:00 AM". */
  function describeNextRun(dueMs, nowMs) {
    if (!Number.isFinite(dueMs)) return '';
    const delta = dueMs - nowMs;
    if (delta < 90 * 1000) return 'in a minute';
    if (delta < 60 * MINUTE_MS) return `in ${Math.round(delta / MINUTE_MS)} min`;
    const due = new Date(dueMs);
    const time = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    const dayDelta = Math.floor((dueMs - startOfToday.getTime()) / (24 * 60 * MINUTE_MS));
    if (dayDelta === 0) return `today ${time}`;
    if (dayDelta === 1) return `tomorrow ${time}`;
    if (dayDelta > 1 && dayDelta < 7) return `${due.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
    return `${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  }

  const api = {
    PRESETS, EVERY_VALUES, WEEKDAYS, CALENDAR_KINDS, INTERVAL_KINDS,
    MAX_TICK_CATCHUP_MINUTES, MEMO_RETENTION_MS,
    cronMatches, dueThisMinute, nextDueAt, missedRun, describeTiming, presetFromCron,
    describeNextRun, timeOfDay,
    localSlotKey, utcSlotKey, fireSlotKey, dueSince, createFireGate,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
