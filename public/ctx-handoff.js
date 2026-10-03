// --- Context handoff: header meter, sidebar token chip, Hand off button ---
//
// Claude Code hooks (~/.claude/hooks/ctx-handoff) keep two small files per
// session in %LOCALAPPDATA%/claude-ctx:
//   <session_id>.json        the "sidecar": how full the context window is
//   <session_id>.state.json  whether a handoff is due / has been written.
//                            Often absent, and absent means nothing is due.
// This file only READS them. It shows the numbers (a chip on the Sessions
// sidebar row, a meter in the terminal header) and offers two actions in the
// header: ask the session to write its handoff, and start a sibling session
// that reads it. Nothing launches by itself, and the only thing that pops up is
// the question a click gets when the session has not reported the end of its
// turn (OVERRIDE_CONFIRM). A session that is busy is never typed into.
//
// How the state file is read follows the hook's own "Reader contract"
// (ctx_handoff.py module docstring): crossed_at ties the file to a request,
// written_at alone never does, a Stop counts only when it is later than the
// last line typed here, and reads of one file are 500 ms apart or slower.
//
// Two halves:
//   1. Pure functions (no DOM, no window) -- unit-tested under plain Node via
//      the module.exports at the bottom, so nothing above the guarded init may
//      touch window or document at load time.
//   2. The browser side, every name prefixed `handoff`. It is loaded
//      immediately before app.js, so the app globals it needs do not exist yet
//      when it is evaluated.
//
// Depends on globals, all read at the moment of use and never cached:
//   app.js: sessionMap, sessionBusyState, activePtyIds, activeSessionId,
//           pendingSessions, cachedProjectTree, cachedProjectTreeAll,
//           launchNewSession, window._isOwnedElsewhere, window._openSessions
//   dialogs.js: resolveDefaultSessionOptions
//   task-runner.js: activeTaskView
// Those are top-level const/let in classic scripts: global bindings, but NOT
// window properties, and `typeof x` on one that is still uninitialised THROWS
// (temporal dead zone -- e.g. app.js died half-way through loading). Hence a
// try/catch around every access as well as the typeof guard.
//
// Called from outside: handoffChipState() by sidebar.js buildSessionItem,
// onActiveSessionChanged() by app.js setActiveSession. Both are typeof-guarded
// at the call site and checked once at load in app.js.

const REQUEST_LINE = 'Write the context handoff now. [ctx-handoff:request]';
// Same thresholds as the status line: dim below WARN_AT, amber from it, red
// from DUE_AT.
const WARN_AT = 300000;
const DUE_AT = 400000;
// Asked before typing into a session whose turn marker does not say "ended".
const OVERRIDE_CONFIRM = 'This session has not reported the end of its turn. If a permission prompt or a question is open in the terminal, the typed line and Enter could answer it. Type the handoff request anyway?';
const OVERRIDE_TITLE = 'This session has not reported the end of its turn. Click to type the request anyway (asks first).';

// ---------------------------------------------------------------- pure

// Python's round(): an exact half goes to the even neighbour. Math.round sends
// it up, which put "413K" here beside "412K" in the status line.
function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// The hook's "%.1f". toFixed(1) agrees except on an exact tie, which it sends
// up and C sends to the even digit. x.25 and x.75 are the only halves of a
// tenth a double holds exactly, so those are the only ties there are.
function fixed1HalfEven(v) {
  const quarters = v * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) return (roundHalfEven(v * 10) / 10).toFixed(1);
  return v.toFixed(1);
}

// Same rule as fmt_tokens() in the hook, so the chip and the status line agree.
function fmtTokens(n) {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  if (v >= 1e6) {
    const m = v / 1e6;
    return (Number.isInteger(m) ? String(m) : fixed1HalfEven(m)) + 'M';
  }
  return roundHalfEven(v / 1000) + 'K';
}

function chipLevel(tokens) {
  if (tokens >= DUE_AT) return 'danger';
  if (tokens >= WARN_AT) return 'warn';
  return '';
}

// The renderer cannot read %LOCALAPPDATA%, but it can ask main where the
// diagnostics folder is (...\AppData\Roaming\switchboard\diagnostics), and the
// hook's folder is a fixed sibling of that Roaming segment. An instance started
// with SWITCHBOARD_DATA_DIR has no such segment: null, and the feature stays off.
function deriveCtxDir(diagDir) {
  if (typeof diagDir !== 'string') return null;
  const match = /^(.+?)[\\/]AppData[\\/]Roaming(?:[\\/]|$)/i.exec(diagDir);
  if (!match) return null;
  return (match[1] + '\\AppData\\Local\\claude-ctx').replace(/\//g, '\\');
}

function meterModel(sidecar) {
  if (!sidecar || typeof sidecar !== 'object') return null;
  const tokens = sidecar.total_input_tokens;
  // null = the hook has no reading yet. Nothing to show.
  if (!Number.isInteger(tokens) || tokens <= 0) return null;
  const rawSize = sidecar.context_window_size;
  const size = typeof rawSize === 'number' && rawSize > 0 ? rawSize : 0;
  let pct = null;
  if (typeof sidecar.used_percentage === 'number' && isFinite(sidecar.used_percentage)) pct = sidecar.used_percentage;
  else if (size > 0) pct = tokens / size * 100;
  const text = fmtTokens(tokens);
  const full = size > 0 && pct !== null
    ? text + ' / ' + fmtTokens(size) + ' · ' + Math.floor(pct) + '%'
    : text;
  return {
    tokens, size, pct, text, full,
    level: chipLevel(tokens),
    ts: typeof sidecar.ts === 'number' ? sidecar.ts : null,
  };
}

// True only when the LAST hook event was a Stop. A session waiting on a
// permission prompt looks idle to Switchboard (measured), so the busy flag
// alone must never be what lets this file type into a terminal unasked. Without
// the hook's last_stop_at / last_prompt_at keys this is false ("unknown", not
// "ended"), and typing needs the confirmed override -- see buttonModel.
function turnEnded(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.last_stop_at !== 'number') return false;
  const prompt = state.last_prompt_at;
  if (prompt === null || prompt === undefined) return true;
  return typeof prompt === 'number' && state.last_stop_at >= prompt;
}

// `pending` is tested FIRST: written_at stays set after a later crossing, and
// handoff_path survives compaction, so neither says the handoff is current.
function handoffInfo(state, handoffReadable) {
  if (!state || typeof state !== 'object') {
    return { status: 'none', path: null, writtenAt: null, writtenTokens: null };
  }
  const path = typeof state.handoff_path === 'string' && state.handoff_path ? state.handoff_path : null;
  const writtenAt = typeof state.written_at === 'number' ? state.written_at : null;
  const writtenTokens = typeof state.written_tokens === 'number' ? state.written_tokens : null;
  let status = 'none';
  if (state.pending === true) status = 'due';
  else if (writtenAt !== null && path !== null && handoffReadable === true) status = 'written';
  return { status, path, writtenAt, writtenTokens };
}

/** The Sessions-sidebar chip: running Claude sessions with a reading, only. */
function chipState(input) {
  const o = input || {};
  if (!o.running || o.isTerminal) return null;
  const meter = meterModel(o.sidecar);
  if (!meter) return null;
  const info = handoffInfo(o.state, o.handoffReadable);
  if (info.status === 'due') {
    return { text: meter.text + ' due', level: 'due', title: 'Context ' + meter.full + ' — handoff due' };
  }
  if (info.status === 'written') {
    return { text: meter.text + ' ✓', level: 'written', title: 'Context ' + meter.full + ' — handoff written' };
  }
  return { text: meter.text, level: meter.level, title: 'Context ' + meter.full };
}

/**
 * What the header buttons show. `primary` is one button in three guises (Hand
 * off / Writing… / Continue in new session); `update` is the small one beside
 * Continue, for a handoff that has gone stale.
 *
 * A typing control (Hand off, Update) is in one of three states:
 *   enabled, override false   the turn has ended: a click types the request
 *   enabled, override true    the session is not busy but has NOT reported the
 *                             end of its turn (no state file, no Stop since the
 *                             last prompt, the spinner came on after the last
 *                             Stop, or no Stop since the last request typed
 *                             here): a click asks first (OVERRIDE_CONFIRM)
 *   disabled                  never typed into: busy, still starting, shown in
 *                             another window, not running. `title` says which.
 * busy === true is never overridable.
 */
function buttonModel(input) {
  const o = input || {};
  const request = o.request && typeof o.request === 'object' ? o.request : { phase: 'idle' };
  const state = o.state && typeof o.state === 'object' ? o.state : null;
  const running = !!o.running;
  const model = {
    visible: false,
    primary: { kind: 'handoff', label: 'Hand off', enabled: false, override: false, title: '' },
    update: { visible: false, enabled: false, override: false, title: '' },
    note: null,
  };
  if (o.isTerminal) return model;

  if (request.phase === 'requested') {
    model.visible = true;
    model.primary = {
      kind: 'writing', label: 'Writing…', enabled: false, override: false,
      title: 'Waiting for the session to write the handoff',
    };
    return model;
  }

  const lastStopMs = state && typeof state.last_stop_at === 'number' ? state.last_stop_at * 1000 : null;
  // The spinner came on after the last Stop the hook recorded: a turn is
  // running that the state file has not caught up with.
  const busyAfterStop = o.lastBusyAtMs != null && lastStopMs !== null && o.lastBusyAtMs > lastStopMs;
  // The turn marker fails open on the prompt side (a failed userprompt write
  // leaves the old Stop in place), so a Stop only counts when it is later than
  // the last line this file typed. atMs survives the request going back to idle.
  const sentAtMs = typeof request.atMs === 'number' && request.atMs > 0 ? request.atMs : null;
  const stopAfterSent = sentAtMs === null || (lastStopMs !== null && lastStopMs > sentAtMs);
  const ended = turnEnded(state) && !busyAfterStop && stopAfterSent;
  const allowed = running && !o.ownedElsewhere && !o.pendingRow && o.busy !== true;
  const override = allowed && !ended;

  let why = '';
  if (!allowed) {
    if (o.ownedElsewhere) why = 'Shown in another window';
    else if (o.pendingRow) why = 'Session is still starting';
    else if (o.busy === true) why = 'Session is working';
    else why = 'Session is not running';
  }
  const typingTitle = okTitle => (!allowed ? why : override ? OVERRIDE_TITLE : okTitle);

  const info = handoffInfo(state, o.handoffReadable);
  if (info.status === 'written') {
    // Kept for a stopped session too: the handoff outlives the process.
    const locked = o.continueLocked === true;
    model.visible = true;
    model.primary = {
      kind: 'continue', label: 'Continue in new session', enabled: !locked, override: false,
      title: locked
        ? 'Starting the new session…'
        : 'Start a new session in the same folder that reads the handoff first',
    };
    model.update = {
      visible: running,
      enabled: allowed,
      override,
      title: typingTitle('Ask this session to write the handoff again'),
    };
  } else if (running) {
    model.visible = true;
    model.primary = {
      kind: 'handoff', label: 'Hand off', enabled: allowed, override,
      title: typingTitle('Ask this session to write its context handoff'),
    };
  }
  if (request.phase === 'timeout') model.note = request.reason != null ? request.reason : null;
  return model;
}

// The folder a sibling session starts in: the session's own, else the cwd the
// hook put in the sidecar (a session this window has no row for).
function launchFolder(session, sidecar) {
  if (session && typeof session.projectPath === 'string' && session.projectPath) return session.projectPath;
  if (sidecar && typeof sidecar.cwd === 'string' && sidecar.cwd) return sidecar.cwd;
  return null;
}

// Forward slashes: the path is pasted into a prompt, where a backslash is one
// escaping rule away from being eaten.
function continuePrompt(handoffPath) {
  return 'Read ' + String(handoffPath).replace(/\\/g, '/') + ' in full before doing anything else, then continue';
}

/**
 * Where a typed request has got to, by the hook's reader contract
 * (ctx_handoff.py, "Reader contract"). The hook stamps crossed_at when it sees
 * the request marker, and every request re-stamps it, so crossed_at is what ties
 * the state file to THIS request; the 1 s of slack covers the two clocks being
 * read a moment apart.
 *   acknowledged   manual and pending are true and crossed_at is not older than
 *                  the request
 *   written        pending and manual are false and written_at is later than a
 *                  crossed_at that is not older than the request. written_at
 *                  alone proves nothing: it survives from earlier handoffs.
 *   session_ended  the session stopped running first (`running` false)
 *   not_landed     20 s on, neither acknowledged nor written
 *   not_written    10 minutes on, still no handoff
 * A manual key that is missing counts as its default, false.
 */
function requestOutcome(input) {
  const o = input || {};
  const request = o.request;
  if (!request || typeof request.atMs !== 'number') return 'waiting';
  const state = o.state && typeof o.state === 'object' ? o.state : null;
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const crossedAt = state && typeof state.crossed_at === 'number' && isFinite(state.crossed_at) ? state.crossed_at : null;
  const forThisRequest = crossedAt !== null && crossedAt * 1000 >= request.atMs - 1000;
  if (forThisRequest && state.pending === false && (state.manual === false || state.manual === undefined)
    && typeof state.written_at === 'number' && state.written_at > crossedAt) {
    return 'written';
  }
  if (o.running === false) return 'session_ended';
  const acknowledged = forThisRequest && state.manual === true && state.pending === true;
  const elapsed = nowMs - request.atMs;
  if (elapsed > 20000 && !acknowledged) return 'not_landed';
  if (elapsed > 600000) return 'not_written';
  return 'waiting';
}

// ---------------------------------------------------------------- browser side
// Not unit-tested: everything below needs the app.

const HANDOFF_NOT_LANDED = 'The request did not reach the session. If the line is sitting in the input box, press Enter there.';
const HANDOFF_NOT_WRITTEN = 'No handoff was written after 10 minutes.';
const HANDOFF_SESSION_ENDED = 'The session ended before the handoff was written.';
// Session ids end up in a file path and in a CSS selector. Real ones are UUIDs.
const HANDOFF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// How often the handoff file itself is read again once it has been checked.
const HANDOFF_RECHECK_MS = 60000;
// activePtyIds is refreshed by a 3 s poll (app.js POLL_FAST_MS) and can lag a
// fork's new id by one round: "not running" has to hold this long to count.
const HANDOFF_ENDED_AFTER_MS = 6000;
const HANDOFF_CONTINUE_LOCK_MS = 3000;
const HANDOFF_MIN_READ_GAP_MS = 500;

const handoffRt = {
  // sessionId → see handoffEntry
  cache: new Map(),
  ctxDirPromise: null,
  inflight: new Map(), // sessionId → Promise of the read in progress
  lastReadAtMs: new Map(), // sessionId → when its last read was started
  els: null,           // header elements, once built
  logged: new Set(),
  started: false,
  primed: false,       // the first read of every running session has been sent
  tickCount: 0,
};

// Once per message: a failure in a 1 s tick must not become a log flood.
function handoffLogOnce(message, err) {
  if (handoffRt.logged.has(message)) return;
  handoffRt.logged.add(message);
  try { console.error('[handoff] ' + message, err === undefined ? '' : err); } catch {}
}

// Every entry point goes through this (or its own try/catch): an exception in
// here must never reach the sidebar render or the terminal.
function handoffGuard(message, fn) {
  return function (...args) {
    try {
      const out = fn(...args);
      if (out && typeof out.then === 'function') out.then(null, err => handoffLogOnce(message, err));
    } catch (err) {
      handoffLogOnce(message, err);
    }
  };
}

function handoffIdleRequest() {
  return { phase: 'idle', atMs: 0, reason: '' };
}

function handoffEntry(id) {
  let entry = handoffRt.cache.get(id);
  if (!entry) {
    entry = {
      id, sidecar: null, state: null,
      handoffReadable: false,
      readableFor: null,       // the written_at value handoffReadable was checked for
      readableCheckedAtMs: 0,  // when that check ran
      request: handoffIdleRequest(),
      lastBusyAtMs: null,
      notRunningSinceMs: 0,    // first time a request's session was seen not running
      continueLockUntil: 0,    // Continue ignores clicks until then
    };
    handoffRt.cache.set(id, entry);
  }
  return entry;
}

// --- App globals, read at the moment of use ---

function handoffActiveId() {
  try { return typeof activeSessionId !== 'undefined' ? (activeSessionId || null) : null; } catch { return null; }
}

// activePtyIds is REPLACED on every poll (app.js pollActiveSessions), so it is
// looked up each time and never held on to.
// → true / false, or undefined when app.js cannot be read.
function handoffRunningState(id) {
  try { return typeof activePtyIds !== 'undefined' && activePtyIds ? activePtyIds.has(id) : undefined; } catch { return undefined; }
}

function handoffIsRunning(id) {
  return handoffRunningState(id) === true;
}

function handoffRunningIds() {
  try { return typeof activePtyIds !== 'undefined' && activePtyIds ? [...activePtyIds] : []; } catch { return []; }
}

function handoffSession(id) {
  try {
    if (typeof sessionMap !== 'undefined' && sessionMap.has(id)) return sessionMap.get(id);
  } catch {}
  try {
    const open = typeof window !== 'undefined' && window._openSessions ? window._openSessions.get(id) : null;
    return (open && open.session) || null;
  } catch {
    return null;
  }
}

function handoffIsTerminal(id) {
  const session = handoffSession(id);
  return !!session && session.type === 'terminal';
}

// Everything buttonModel and chipState take, for one session. The three flags
// that can only DISABLE typing fail closed: if app.js cannot be read, the
// answer is "do not type".
function handoffInputs(id) {
  const entry = handoffRt.cache.get(id) || null;
  let busy = true;
  let pendingRow = true;
  let ownedElsewhere = true;
  try { busy = typeof sessionBusyState !== 'undefined' && !!sessionBusyState.get(id); } catch {}
  try { pendingRow = typeof pendingSessions !== 'undefined' && pendingSessions.has(id); } catch {}
  try { ownedElsewhere = typeof window._isOwnedElsewhere === 'function' && !!window._isOwnedElsewhere(id); } catch {}
  return {
    isTerminal: handoffIsTerminal(id),
    running: handoffIsRunning(id),
    ownedElsewhere, pendingRow, busy,
    lastBusyAtMs: entry ? entry.lastBusyAtMs : null,
    sidecar: entry ? entry.sidecar : null,
    state: entry ? entry.state : null,
    handoffReadable: entry ? entry.handoffReadable : false,
    request: entry ? entry.request : handoffIdleRequest(),
    continueLocked: !!entry && Date.now() < entry.continueLockUntil,
    nowMs: Date.now(),
  };
}

/**
 * The chip for a Sessions-sidebar row, or null for none. Synchronous and
 * never-throwing: sidebar.js calls it while building a row, and it reads only
 * the cache and the app globals -- no IPC.
 */
function handoffChipState(sessionId) {
  try {
    const entry = handoffRt.cache.get(sessionId);
    if (!entry) return null;
    return chipState({
      sidecar: entry.sidecar,
      state: entry.state,
      handoffReadable: entry.handoffReadable,
      running: handoffIsRunning(sessionId),
      isTerminal: handoffIsTerminal(sessionId),
    });
  } catch (err) {
    handoffLogOnce('handoffChipState failed', err);
    return null;
  }
}

// --- Reading the hook's files ---

function handoffCtxDir() {
  if (!handoffRt.ctxDirPromise) {
    handoffRt.ctxDirPromise = (async () => {
      let dir = null;
      try {
        if (typeof window.api.diagDir === 'function') dir = deriveCtxDir(await window.api.diagDir());
      } catch (err) {
        handoffLogOnce('diagDir failed', err);
      }
      if (!dir) handoffLogOnce('no AppData/Roaming data folder (an instance started with SWITCHBOARD_DATA_DIR?) — the context meter stays off');
      return dir;
    })();
  }
  return handoffRt.ctxDirPromise;
}

// → an object, null (the file is not there, which is normal), or undefined (it
// could not be read just now -- e.g. caught mid-write -- so keep what we had).
async function handoffReadJson(filePath) {
  const res = await window.api.readFileForPanel(filePath);
  if (!res || !res.ok) return res && res.code === 'ENOENT' ? null : undefined;
  try {
    const value = JSON.parse(res.content);
    if (value && typeof value === 'object') return value;
  } catch {}
  return undefined;
}

async function handoffReadPair(id) {
  // A dedicated main-process call, once it exists, replaces the generic panel read.
  if (typeof window.api.readCtxState === 'function') {
    const res = await window.api.readCtxState(id);
    if (!res || typeof res !== 'object') return { sidecar: undefined, state: undefined };
    return {
      sidecar: res.sidecar && typeof res.sidecar === 'object' ? res.sidecar : null,
      state: res.state && typeof res.state === 'object' ? res.state : null,
    };
  }
  if (typeof window.api.readFileForPanel !== 'function') return null;
  const dir = await handoffCtxDir();
  if (!dir) return null;
  const [sidecar, state] = await Promise.all([
    handoffReadJson(dir + '\\' + id + '.json'),
    handoffReadJson(dir + '\\' + id + '.state.json'),
  ]);
  return { sidecar, state };
}

// When written_at CHANGES, and after that at most once a minute -- not on every
// poll: the check reads the whole handoff file across IPC. The minute is what
// lets a failed check heal and a deleted handoff stop offering Continue.
async function handoffCheckReadable(entry) {
  const state = entry.state;
  const writtenAt = state && typeof state.written_at === 'number' ? state.written_at : null;
  const filePath = state && typeof state.handoff_path === 'string' ? state.handoff_path : '';
  if (writtenAt === null || !filePath) {
    entry.handoffReadable = false;
    entry.readableFor = null;
    entry.readableCheckedAtMs = 0;
    return;
  }
  const sameHandoff = entry.readableFor === writtenAt;
  if (sameHandoff && Date.now() - entry.readableCheckedAtMs < HANDOFF_RECHECK_MS) return;
  let readable = false;
  let gone = false;
  try {
    if (typeof window.api.readFileForPanel === 'function') {
      const res = await window.api.readFileForPanel(filePath);
      readable = !!(res && res.ok);
      gone = !!res && !res.ok && res.code === 'ENOENT';
    }
  } catch {}
  entry.readableCheckedAtMs = Date.now();
  // A handoff that was readable a minute ago and fails once is most likely
  // being rewritten: only "the file is gone" takes Continue away.
  if (sameHandoff && entry.handoffReadable && !readable && !gone) return;
  entry.handoffReadable = readable;
  entry.readableFor = writtenAt;
}

function handoffApplyOutcome(entry) {
  const request = entry.request;
  if (request.phase !== 'requested' && request.phase !== 'timeout') return;
  const nowMs = Date.now();
  let running = handoffRunningState(entry.id);
  if (running === false) {
    if (!entry.notRunningSinceMs) entry.notRunningSinceMs = nowMs;
    if (nowMs - entry.notRunningSinceMs < HANDOFF_ENDED_AFTER_MS) running = undefined;
  } else {
    entry.notRunningSinceMs = 0;
  }
  const outcome = requestOutcome({ request, state: entry.state, nowMs, running });
  if (outcome === 'written') {
    // Also clears a timeout note: the handoff turned up after all. atMs is
    // kept: buttonModel wants a Stop later than the last line typed here.
    entry.request = { phase: 'idle', atMs: request.atMs, reason: '' };
  } else if (request.phase === 'requested') {
    let reason = '';
    if (outcome === 'session_ended') reason = HANDOFF_SESSION_ENDED;
    else if (outcome === 'not_landed') reason = HANDOFF_NOT_LANDED;
    else if (outcome === 'not_written') reason = HANDOFF_NOT_WRITTEN;
    if (reason) entry.request = { phase: 'timeout', atMs: request.atMs, reason };
  } else if (request.reason === HANDOFF_NOT_LANDED && outcome === 'waiting') {
    // Acknowledged late (the line sat queued behind a running turn): it did
    // land, so this is "Writing…" again, with the 10 minutes still counting.
    entry.request = { phase: 'requested', atMs: request.atMs, reason: '' };
  }
}

async function handoffDoRefresh(id) {
  // A plain terminal has no Claude context and no sidecar.
  if (handoffIsTerminal(id)) return;
  const entry = handoffEntry(id);
  const pair = await handoffReadPair(id);
  if (!pair) return; // inert
  // The session was re-keyed (forked) while the read was out: what came back
  // describes the old id's files.
  if (handoffRt.cache.get(id) !== entry) return;
  if (pair.sidecar !== undefined) entry.sidecar = pair.sidecar;
  if (pair.state !== undefined) entry.state = pair.state;
  await handoffCheckReadable(entry);
  if (handoffRt.cache.get(id) !== entry) return;
  handoffApplyOutcome(entry);
  handoffPaint(id);
}

/** Read one session's sidecar + state and repaint. Overlapping calls share one read. */
function handoffRefresh(id) {
  if (!handoffRt.started || typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) return Promise.resolve();
  const running = handoffRt.inflight.get(id);
  if (running) return running;
  // The hook's reader contract: reads of a state file 500 ms apart or slower
  // (its own write has to get in between). A caller that comes sooner gets
  // what the cache already holds, which is that fresh.
  const nowMs = Date.now();
  if (nowMs - (handoffRt.lastReadAtMs.get(id) || 0) < HANDOFF_MIN_READ_GAP_MS) return Promise.resolve();
  handoffRt.lastReadAtMs.set(id, nowMs);
  const read = handoffDoRefresh(id)
    .catch(err => handoffLogOnce('read failed', err))
    .then(() => { handoffRt.inflight.delete(id); });
  handoffRt.inflight.set(id, read);
  return read;
}

// --- Painting ---

function handoffSetText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function handoffSetClass(el, className) {
  if (el.className !== className) el.className = className;
}

function handoffSetTitle(el, title) {
  if (title) {
    if (el.getAttribute('title') !== title) el.setAttribute('title', title);
  } else if (el.hasAttribute('title')) {
    el.removeAttribute('title');
  }
}

function handoffShow(el, on) {
  const display = on ? '' : 'none';
  if (el.style.display !== display) el.style.display = display;
}

// Rows already on screen. morphdom rebuilds rows on every sidebar render and
// buildSessionItem derives the chip again there, so this must produce exactly
// what that block produces or the two would fight.
function handoffPaintChips(id) {
  if (!HANDOFF_ID_RE.test(id)) return;
  const chip = handoffChipState(id);
  const className = 'handoff-chip' + (chip && chip.level ? ' handoff-' + chip.level : '');
  document.querySelectorAll('.session-item[data-session-id="' + id + '"] .handoff-chip').forEach(el => {
    handoffSetText(el, chip ? chip.text : '');
    handoffSetClass(el, className);
    handoffSetTitle(el, chip ? chip.title : '');
  });
}

function handoffPaint(id) {
  handoffPaintChips(id);
  if (handoffActiveId() === id) handoffRenderHeader();
}

function handoffPad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function handoffClock(seconds) {
  const date = new Date(seconds * 1000);
  return handoffPad2(date.getHours()) + ':' + handoffPad2(date.getMinutes());
}

// Our own elements inside #terminal-header-controls, the way file-panel.js
// adds its Files button and IDE Emulation indicator (addMcpToggle).
function handoffBuildHeader() {
  const controls = document.getElementById('terminal-header-controls');
  const status = document.getElementById('terminal-header-status');
  const stopBtn = document.getElementById('terminal-stop-btn');
  if (!controls || !status || !stopBtn) return null;
  if (status.parentNode !== controls || stopBtn.parentNode !== controls) return null;

  const meter = document.createElement('span');
  meter.id = 'handoff-meter';
  meter.style.display = 'none';
  const meterText = document.createElement('span');
  meterText.className = 'handoff-meter-text';
  const meterTrack = document.createElement('span');
  meterTrack.className = 'handoff-meter-track';
  const meterFill = document.createElement('span');
  meterFill.className = 'handoff-meter-fill';
  meterTrack.appendChild(meterFill);
  const meterState = document.createElement('span');
  meterState.className = 'handoff-meter-state';
  meter.append(meterText, meterTrack, meterState);

  // Why the last request came to nothing. Text in the header, not a popup.
  const note = document.createElement('span');
  note.id = 'handoff-note';
  note.style.display = 'none';

  const primary = document.createElement('button');
  primary.id = 'handoff-primary-btn';
  primary.type = 'button';
  primary.className = 'handoff-btn';
  primary.style.display = 'none';
  primary.addEventListener('click', handoffGuard('primary click failed', handoffOnPrimaryClick));

  const update = document.createElement('button');
  update.id = 'handoff-update-btn';
  update.type = 'button';
  update.className = 'handoff-btn handoff-btn-small';
  update.textContent = 'Update';
  update.style.display = 'none';
  update.addEventListener('click', handoffGuard('update click failed', handoffOnUpdateClick));

  controls.insertBefore(meter, status.nextSibling);
  controls.insertBefore(note, stopBtn);
  controls.insertBefore(primary, stopBtn);
  controls.insertBefore(update, stopBtn);
  return { meter, meterText, meterTrack, meterFill, meterState, note, primary, update };
}

// "Disabled" is aria-disabled plus a class, not the disabled attribute: a
// disabled button swallows the hover its tooltip needs, and the tooltip is
// where the reason is. The click handlers re-check buttonModel anyway.
function handoffSetButton(el, { visible, label, enabled, title, extraClass }) {
  handoffShow(el, visible);
  if (!visible) return;
  if (label !== undefined) handoffSetText(el, label);
  let className = el.id === 'handoff-update-btn' ? 'handoff-btn handoff-btn-small' : 'handoff-btn';
  if (extraClass) className += ' ' + extraClass;
  if (!enabled) className += ' handoff-btn-disabled';
  handoffSetClass(el, className);
  const disabled = enabled ? 'false' : 'true';
  if (el.getAttribute('aria-disabled') !== disabled) el.setAttribute('aria-disabled', disabled);
  handoffSetTitle(el, title);
}

function handoffRenderHeader() {
  const els = handoffRt.els;
  if (!els) return;
  const id = handoffActiveId();
  let taskView = false;
  try { taskView = typeof activeTaskView !== 'undefined' && !!activeTaskView; } catch {}
  // Hidden with no active session, for a plain terminal, and while a task log
  // has the pane (the header is then the task's, not a session's).
  if (!id || taskView || handoffIsTerminal(id)) {
    handoffShow(els.meter, false);
    handoffShow(els.note, false);
    handoffShow(els.primary, false);
    handoffShow(els.update, false);
    return;
  }

  const input = handoffInputs(id);
  const meter = meterModel(input.sidecar);
  const info = handoffInfo(input.state, input.handoffReadable);

  handoffShow(els.meter, !!meter || info.status !== 'none');
  handoffSetText(els.meterText, meter ? meter.full : '');
  const hasBar = !!meter && meter.pct !== null;
  handoffShow(els.meterTrack, hasBar);
  if (hasBar) {
    const width = Math.max(0, Math.min(100, meter.pct)).toFixed(1) + '%';
    if (els.meterFill.style.width !== width) els.meterFill.style.width = width;
    handoffSetClass(els.meterFill, 'handoff-meter-fill' + (meter.level ? ' handoff-' + meter.level : ''));
  }
  let stateText = '';
  let stateClass = 'handoff-meter-state';
  let stateTitle = '';
  if (info.status === 'due') {
    stateText = 'handoff due';
    stateClass += ' handoff-due';
    stateTitle = 'This session has passed its handoff threshold and has not written one yet';
  } else if (info.status === 'written') {
    stateText = 'handoff ✓ ' + handoffClock(info.writtenAt);
    stateClass += ' handoff-written';
    stateTitle = 'Handoff written ' + new Date(info.writtenAt * 1000).toLocaleString()
      + (info.writtenTokens !== null ? ' at ' + fmtTokens(info.writtenTokens) + ' tokens' : '')
      + ' — ' + info.path;
  }
  handoffShow(els.meterState, !!stateText);
  handoffSetText(els.meterState, stateText);
  handoffSetClass(els.meterState, stateClass);
  handoffSetTitle(els.meterState, stateTitle);
  handoffSetTitle(els.meterText, meter
    ? 'Context in use: ' + meter.full + (meter.ts !== null ? ' (read ' + handoffClock(meter.ts) + ')' : '')
    : '');

  const model = buttonModel(input);
  handoffSetButton(els.primary, {
    visible: model.visible,
    label: model.primary.label,
    enabled: model.primary.enabled,
    title: model.primary.title,
    extraClass: 'handoff-btn-' + model.primary.kind + (model.primary.override ? ' handoff-btn-override' : ''),
  });
  handoffSetButton(els.update, {
    visible: model.visible && model.update.visible,
    enabled: model.update.enabled,
    title: model.update.title,
    extraClass: model.update.override ? 'handoff-btn-override' : '',
  });
  const note = model.visible && model.note ? String(model.note) : '';
  handoffShow(els.note, !!note);
  handoffSetText(els.note, note);
  handoffSetTitle(els.note, note);
}

// --- Clicks ---

// Types the request into the session. The Enter goes as a SEPARATE write a
// moment later: in the same write the CLI takes the carriage return as part of
// a paste and leaves the line sitting in the input box.
function handoffSendRequest(id) {
  if (typeof window.api.sendInput !== 'function') return;
  const entry = handoffEntry(id);
  window.api.sendInput(id, REQUEST_LINE);
  setTimeout(handoffGuard('sending Enter failed', () => {
    // entry.id, not id: it follows the session through a fork.
    window.api.sendInput(entry.id, '\r');
  }), 250);
  entry.request = { phase: 'requested', atMs: Date.now(), reason: '' };
  handoffRenderHeader();
}

// The session's project/track, from the Projects tree this window already
// holds (app.js cachedProjectTree*, filled by loadProjects).
function handoffFindInTree(id) {
  const trees = [];
  try { if (typeof cachedProjectTreeAll !== 'undefined') trees.push(cachedProjectTreeAll); } catch {}
  try { if (typeof cachedProjectTree !== 'undefined') trees.push(cachedProjectTree); } catch {}
  for (const tree of trees) {
    for (const project of (tree && tree.projects) || []) {
      if ((project.sessions || []).some(s => s && s.sessionId === id)) {
        return { projectId: project.id, trackId: null };
      }
      for (const track of project.tracks || []) {
        if ((track.sessions || []).some(s => s && s.sessionId === id)) {
          return { projectId: project.id, trackId: track.id };
        }
      }
    }
  }
  return null;
}

// Where the sibling goes: the old session's folder, filed under the same
// project/track when one can be found, else by folder only.
function handoffLaunchTarget(id) {
  const session = handoffSession(id);
  const entry = handoffRt.cache.get(id);
  const folder = launchFolder(session, entry ? entry.sidecar : null);
  if (!folder) return null;
  const target = { projectPath: folder };
  let projectId = (session && session.projectId) || null;
  let trackId = (session && session.trackId) || null;
  if (!projectId) {
    let found = null;
    try { found = handoffFindInTree(id); } catch {}
    if (found) {
      projectId = found.projectId;
      trackId = found.trackId;
    }
  }
  if (projectId) {
    target.projectId = projectId;
    target.trackId = trackId || null;
  }
  return target;
}

// The second click. The old session is left running: nothing here stops it.
async function handoffContinue(id) {
  const entry = handoffRt.cache.get(id);
  if (!entry) return;
  // launchNewSession is not instant; a double click must not start two
  // siblings. The button shows as disabled meanwhile (buttonModel
  // continueLocked) and the 1 s tick brings it back.
  if (Date.now() < entry.continueLockUntil) return;
  const info = handoffInfo(entry.state, entry.handoffReadable);
  if (info.status !== 'written') return;
  entry.continueLockUntil = Date.now() + HANDOFF_CONTINUE_LOCK_MS;
  handoffRenderHeader();
  if (typeof resolveDefaultSessionOptions !== 'function' || typeof launchNewSession !== 'function') {
    handoffLogOnce('Continue: launchNewSession() / resolveDefaultSessionOptions() are missing');
    return;
  }
  const target = handoffLaunchTarget(id);
  if (!target) {
    handoffLogOnce('Continue: the session has no folder to launch in');
    return;
  }
  const options = await resolveDefaultSessionOptions(target);
  // Same folder as the old session, not a fresh worktree of it.
  delete options.worktree;
  delete options.worktreeName;
  options.initialPrompt = continuePrompt(info.path);
  await launchNewSession(target, options);
}

// The typing control a click is for, decided NOW and not from what the button
// looked like a second ago. null when that control is not on offer.
function handoffTypingControl(id, which) {
  const model = buttonModel(handoffInputs(id));
  if (!model.visible) return null;
  if (which === 'update') return model.update.visible ? model.update : null;
  return model.primary.kind === 'handoff' ? model.primary : null;
}

// The app's own confirm dialogs are window.confirm (app.js confirmAndStopSession).
// Anything but an explicit OK is a no.
function handoffConfirmOverride() {
  try { return typeof window.confirm === 'function' && window.confirm(OVERRIDE_CONFIRM) === true; } catch { return false; }
}

async function handoffTypeRequest(id, which) {
  let control = handoffTypingControl(id, which);
  if (!control || !control.enabled) return;
  if (control.override) {
    if (!handoffConfirmOverride()) return;
    // The dialog held this window up: busy events queued behind it and the
    // state file may have moved on. Read again and decide again. A session
    // that went busy meanwhile is not typed into; one that is still (or now
    // properly) clear is, with the question already answered.
    await handoffRefresh(id);
    if (handoffActiveId() !== id) return;
    control = handoffTypingControl(id, which);
    if (!control || !control.enabled) {
      handoffRenderHeader();
      return;
    }
  }
  handoffSendRequest(id);
}

function handoffOnPrimaryClick() {
  const id = handoffActiveId();
  if (!id) return undefined;
  const model = buttonModel(handoffInputs(id));
  if (!model.visible || !model.primary.enabled) return undefined;
  if (model.primary.kind === 'continue') return handoffContinue(id);
  if (model.primary.kind === 'handoff') return handoffTypeRequest(id, 'primary');
  return undefined;
}

function handoffOnUpdateClick() {
  const id = handoffActiveId();
  return id ? handoffTypeRequest(id, 'update') : undefined;
}

// --- Triggers ---

// One 1 s timer for all three cadences:
//   every tick   re-derive the header from the cache (no IPC; the busy and
//                running flags change without telling this file)
//   every 2 s    re-read sessions with a request outstanding
//   every 15 s   re-read every running session
function handoffTick() {
  handoffRt.tickCount++;
  const tick = handoffRt.tickCount;
  // The header was not there at load: the chips run without it, and the meter
  // and buttons join in if it turns up.
  if (!handoffRt.els) handoffRt.els = handoffBuildHeader();
  if (tick % 2 === 0) {
    for (const [id, entry] of handoffRt.cache) {
      if (entry.request.phase === 'requested') handoffRefresh(id);
    }
  }
  const running = handoffRunningIds();
  // `primed`: the first poll of activePtyIds lands some time after load, and
  // waiting for the next 15 s boundary would leave the chips blank until then.
  if (running.length && (!handoffRt.primed || tick % 15 === 0)) {
    handoffRt.primed = true;
    for (const id of running) handoffRefresh(id);
  }
  handoffRenderHeader();
}

/**
 * Called by app.js setActiveSession on every change of the active session
 * (null included -- a task log taking the pane goes through it too).
 */
function onActiveSessionChanged(id) {
  try {
    if (!handoffRt.started) return;
    handoffRenderHeader();
    if (id) handoffRefresh(id);
  } catch (err) {
    handoffLogOnce('onActiveSessionChanged failed', err);
  }
}

function handoffInit() {
  if (handoffRt.started) return;
  const api = window.api;
  if (!api || (typeof api.readFileForPanel !== 'function' && typeof api.readCtxState !== 'function')) {
    handoffLogOnce('window.api is missing — the context meter stays off');
    return;
  }
  // No header is not a reason to lose the sidebar chips: they need only the
  // cache and the reads. handoffRenderHeader does nothing without els.
  handoffRt.els = handoffBuildHeader();
  if (!handoffRt.els) {
    handoffLogOnce('the terminal header controls are missing — the header meter and buttons stay off, the sidebar chips still work');
  }
  handoffRt.started = true;

  // Our own listener, beside app.js's. It is registered first (this script
  // loads first), so sessionBusyState still holds the OLD value while it runs:
  // hence the deferred render.
  if (typeof api.onCliBusyState === 'function') {
    api.onCliBusyState(handoffGuard('busy listener failed', (sessionId, busy) => {
      if (typeof sessionId !== 'string' || !HANDOFF_ID_RE.test(sessionId)) return;
      const entry = handoffEntry(sessionId);
      if (busy) {
        entry.lastBusyAtMs = Date.now();
      } else {
        // A turn just ended: the hook is writing both files about now. Now,
        // and twice more in case this beat it.
        handoffRefresh(sessionId);
        for (const delay of [1000, 3000]) {
          setTimeout(handoffGuard('idle read failed', () => handoffRefresh(entry.id)), delay);
        }
      }
      setTimeout(handoffGuard('header render failed', handoffRenderHeader), 0);
    }));
  }
  if (typeof api.onProcessExited === 'function') {
    api.onProcessExited(handoffGuard('exit listener failed', (sessionId) => handoffRefresh(sessionId)));
  }
  if (typeof api.onSessionForked === 'function') {
    api.onSessionForked(handoffGuard('fork listener failed', (oldId, newId) => {
      const entry = handoffRt.cache.get(oldId);
      if (entry && typeof newId === 'string') {
        handoffRt.cache.delete(oldId);
        entry.id = newId;
        handoffRt.cache.set(newId, entry);
      }
      return handoffRefresh(newId);
    }));
  }
  setInterval(handoffGuard('tick failed', handoffTick), 1000);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try { handoffInit(); } catch (err) { handoffLogOnce('init failed', err); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REQUEST_LINE, WARN_AT, DUE_AT, OVERRIDE_CONFIRM,
    fmtTokens, chipLevel, deriveCtxDir, meterModel, turnEnded, handoffInfo,
    chipState, buttonModel, continuePrompt, requestOutcome, launchFolder,
    handoffChipState, onActiveSessionChanged,
  };
}
