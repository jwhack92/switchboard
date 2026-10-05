// --- Focus watch -------------------------------------------------------------
//
// WHY THIS EXISTS
//
// The window can get into a state where Windows still delivers key-down and
// key-up to the page while Chromium treats the document as unfocused and has no
// text-input client attached. Everything driven by key-down keeps working
// (Backspace, lower-case letters in a terminal, Ctrl chords); everything that
// needs the character message is dropped (letters in a rename box, capitals in
// a terminal, because xterm leaves Shift+letter to keypress). Leaving the
// window and coming back resyncs it.
//
// Two captures show the state (2026-10-03 and 2026-10-05 by their file names,
// which are stamped in UTC, so a local evening reads as the next day): every
// keydown had document.hasFocus() false, and the last window event was a blur
// with no focus after it. Neither shows what CAUSED it, because nothing recorded what came
// before the blur. Electron 41 lacks an upstream fix (electron PR #54380) that
// names a dismissed alert()/confirm() as one trigger. That is a lead, not a
// finding.
//
// So this file does three things and repairs nothing:
//
//   1. notices the state while it is happening (a real key arriving at a page
//      that says it has no focus) and reports it once per episode;
//   2. keeps a short list of markers, the things suspected of causing it, so
//      the report can say which of them came after the last window focus;
//   3. wraps a native dialog call so its open and close are on that list.
//
// WHAT IS NEVER RECORDED
//
// No typed character, key value, key code, input data, dialog text or screen
// text. A key is reduced to a class (printable, named, chord, modifier) here
// and the class is all that leaves. A dialog is its kind, the source line that
// opened it, and how long it stayed open; its arguments are passed through
// unread. test/focus-watch.test.js holds the file to this.
//
// The rule is a pure state machine with its clock, timers and focus readers
// injected, so node --test can run it. terminal-diagnostics.js owns the
// browser side: the listeners, the notice and the log line.

(function () {
  'use strict';

  // A key can land a moment before Blink has caught up with a window that was
  // just activated. Wait this long and look again before calling it stuck. No
  // stored capture has a healthy keydown that close to a focus event, so the
  // number is a guess that the log lines are there to check.
  const CONFIRM_MS = 150;
  // Every list and every counter that reaches the log is bounded.
  const MAX_LOGGED_EPISODES = 20;      // per page load, then one last line
  const MAX_NOTICES = 3;               // per page load
  const MAX_DIALOG_LINES = 20;         // per page load
  const MARKER_RING = 40;
  const MARKERS_IN_LINE = 8;
  const MARKERS_IN_SNAPSHOT = 12;
  // When to look at document.hasFocus() again after a native dialog returns.
  const DIALOG_SAMPLE_MS = [250, 1500];

  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS']);
  const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

  /** A key event reduced to a class. The class is the only thing about a key
   *  that this file keeps or reports. */
  function keyClass(e) {
    if (!e) return 'named';
    if (MODIFIER_KEYS.has(e.key) || MODIFIER_CODE.test(String(e.code || ''))) return 'modifier';
    if (e.ctrlKey || e.altKey || e.metaKey) return 'chord';
    // One code point: a letter, digit, symbol or space. Enter, Tab, arrows and
    // the rest have multi-character names.
    if (typeof e.key === 'string' && Array.from(e.key).length === 1) return 'printable';
    return 'named';
  }

  /** An IME is assembling a character. Same test as recordKey() in
   *  terminal-diagnostics.js, plus the two key names an IME reports. */
  function isComposing(e) {
    return e.isComposing === true || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead';
  }

  /** The source line that called a wrapped dialog or set a marker, as
   *  `file.js:123`, or ''. Takes the first stack frame outside this file and
   *  keeps only the file's base name and line: no folder, no function name, no
   *  column. `alsoSkip` names one more file whose frames are passed over: the
   *  one a marker is relayed through (terminal-diagnostics.js). */
  function callSite(stack, alsoSkip) {
    const lines = String(stack || '').split('\n').slice(1);
    for (const line of lines) {
      if (line.includes('focus-watch.js')) continue;
      if (alsoSkip && line.includes(String(alsoSkip))) continue;
      const m = /([A-Za-z0-9_.-]+\.js):(\d+)(?::\d+)?\)?\s*$/.exec(line);
      if (m) return cleanSite(m[1] + ':' + m[2]);
    }
    return '';
  }

  // Everything that reaches a log line as text goes through one of these
  // three. They are what keeps a caller from writing free text into the log.
  function cleanSite(s) {
    return /^[A-Za-z0-9_.-]{1,40}:\d{1,7}$/.test(String(s || '')) ? String(s) : '';
  }
  function cleanKind(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'mark';
  }
  function cleanTag(s) {
    return String(s || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'none';
  }

  /**
   * The detector. Everything it needs from the page is injected:
   *
   *   now()               ms clock
   *   setTimer(fn, ms)    returns an id for clearTimer(id)
   *   hasFocus()          document.hasFocus()
   *   isVisible()         the page is not hidden
   *   activeTag()         a short tag for the focused element
   *   note(kind, detail)  the diagnostics event ring
   *   warn(line)          the log
   *   notify()            show the notice that names the cure
   *
   * A reader that throws counts as "focused and visible", so a broken reader
   * can never open an episode. A sink that throws is ignored.
   */
  function createFocusWatch(deps) {
    const d = deps || {};
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const setTimer = typeof d.setTimer === 'function' ? d.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof d.clearTimer === 'function' ? d.clearTimer : (id) => clearTimeout(id);
    const read = (fn, fallback) => { try { return typeof fn === 'function' ? fn() : fallback; } catch { return fallback; } };
    const hasFocus = () => read(d.hasFocus, true) !== false;
    const isVisible = () => read(d.isVisible, true) !== false;
    const activeTag = () => cleanTag(read(d.activeTag, ''));
    const note = (kind, detail) => { try { if (typeof d.note === 'function') d.note(kind, detail); } catch {} };
    const warn = (line) => { try { if (typeof d.warn === 'function') d.warn(line); } catch {} };

    let lastFocusAt = null;            // window 'focus' / 'blur' events
    let lastBlurAt = null;
    let pending = null;                // an unfocused keydown waiting out CONFIRM_MS
    let episode = null;                // the open episode
    let lastEpisode = null;            // the one that closed last
    let episodes = 0;
    let notices = 0;
    let overflowLogged = false;
    let lastDialog = null;
    let dialogLines = 0;
    const markers = [];                // { t, kind, site }
    const listeners = [];

    const ago = (t) => (t == null ? 'none' : String(Math.max(0, now() - t)));
    const agoMs = (t) => (t == null ? null : Math.max(0, now() - t));

    /** Something that might turn out to be the trigger just happened. */
    function mark(kind, site) {
      markers.push({ t: now(), kind: cleanKind(kind), site: cleanSite(site) });
      if (markers.length > MARKER_RING) markers.splice(0, markers.length - MARKER_RING);
    }

    /** Markers since the last window focus event. A focus event is the page
     *  being told it is active again, so anything older is cleared of this
     *  episode; what is left is the list of suspects. */
    function suspects() {
      const t = now();
      return markers
        .filter((m) => lastFocusAt == null || m.t >= lastFocusAt)
        .slice(-MARKERS_IN_LINE)
        .map((m) => ({ kind: m.kind, site: m.site, ageMs: Math.max(0, t - m.t) }));
    }

    function count(tally, cls) {
      tally.keydowns++;
      if (cls === 'printable') tally.printable++;
    }

    function dropPending() {
      if (!pending) return;
      try { clearTimer(pending.timer); } catch {}
      pending = null;
    }

    function confirmPending() {
      const p = pending;
      pending = null;
      // A window focus event or a focused keydown in the meantime dropped it
      // already; this covers focus coming back with neither.
      if (!p || hasFocus() || !isVisible()) return;
      openEpisode(p);
    }

    function openEpisode(p) {
      episodes++;
      episode = {
        n: episodes, t: p.t, logged: episodes <= MAX_LOGGED_EPISODES,
        keydowns: p.keydowns, printable: p.printable, keypress: p.keypress, insert: p.insert,
      };
      const report = {
        n: episode.n,
        keyClass: p.keyClass,
        active: p.active,
        sinceBlurMs: agoMs(lastBlurAt),
        sinceFocusMs: agoMs(lastFocusAt),
        sinceDialogCloseMs: lastDialog ? agoMs(lastDialog.closedAt) : null,
        markers: suspects(),
      };
      note('focus-desync', { n: report.n, keyClass: report.keyClass, active: report.active });
      if (episode.logged) {
        const list = report.markers
          .map((m) => m.kind + (m.site ? '@' + m.site : '') + '+' + m.ageMs + 'ms')
          .join(',') || 'none';
        warn('[focus] desync n=' + report.n + ' keyClass=' + report.keyClass + ' active=' + report.active
          + ' sinceBlurMs=' + ago(lastBlurAt) + ' sinceFocusMs=' + ago(lastFocusAt)
          + ' sinceDialogCloseMs=' + (lastDialog ? ago(lastDialog.closedAt) : 'none')
          + ' markers=' + list);
      } else if (!overflowLogged) {
        overflowLogged = true;
        warn('[focus] further episodes not logged (limit ' + MAX_LOGGED_EPISODES + ' per page load)');
      }
      if (notices < MAX_NOTICES) {
        notices++;
        try { if (typeof d.notify === 'function') d.notify(); } catch {}
      }
      for (const cb of listeners) { try { cb(report); } catch {} }
    }

    function closeEpisode(endedBy) {
      const ep = episode;
      episode = null;
      lastEpisode = {
        n: ep.n, endedAt: now(), durationMs: Math.max(0, now() - ep.t),
        keydowns: ep.keydowns, printable: ep.printable, keypress: ep.keypress, insert: ep.insert,
        endedBy,
      };
      note('focus-desync-end', {
        n: ep.n, durationMs: lastEpisode.durationMs, keydowns: ep.keydowns, printable: ep.printable,
        keypress: ep.keypress, insert: ep.insert, endedBy,
      });
      // printable > 0 with charEvents = 0 is the signature: keys arrived and
      // no character followed. charEvents > 0 would mean an unfocused page was
      // still getting its characters, which no capture has shown either way.
      if (ep.logged) {
        warn('[focus] episode-end n=' + ep.n + ' durationMs=' + lastEpisode.durationMs
          + ' keydowns=' + ep.keydowns + ' printable=' + ep.printable
          + ' charEvents=' + (ep.keypress + ep.insert) + ' keypress=' + ep.keypress + ' insert=' + ep.insert
          + ' endedBy=' + endedBy);
      }
    }

    /** Every keydown the window sees, capture phase. */
    function onKeydown(e) {
      // Only a key the user pressed. A script-made event says nothing about
      // where the OS is sending the keyboard.
      if (!e || e.isTrusted !== true) return;
      if (hasFocus()) {
        dropPending();
        if (episode) closeEpisode('hasFocus-true');
        return;
      }
      const cls = keyClass(e);
      if (episode) { count(episode, cls); return; }
      if (pending) { count(pending, cls); return; }
      // What may start the wait. Bare modifiers are most of the unfocused
      // keydowns in the stored captures and prove little alone; Alt and Meta
      // chords are how a window is left (Alt+Tab), so they arrive exactly
      // when focus is legitimately going away.
      if (cls === 'modifier' || e.repeat || isComposing(e) || e.altKey || e.metaKey) return;
      if (!isVisible()) return;
      pending = {
        t: now(), keyClass: cls, active: activeTag(),
        keydowns: 1, printable: cls === 'printable' ? 1 : 0, keypress: 0, insert: 0,
      };
      pending.timer = setTimer(confirmPending, CONFIRM_MS);
    }

    /** A keypress or beforeinput the window saw: a character did arrive.
     *  Counted only while an episode is open or waiting to be confirmed. */
    function onCharEvent(type, e) {
      if (!e || e.isTrusted !== true) return;
      const tally = episode || pending;
      if (!tally) return;
      if (type === 'keypress') tally.keypress++;
      else if (type === 'beforeinput' && /^insert/.test(String(e.inputType || ''))) tally.insert++;
    }

    function onWindowFocus() {
      lastFocusAt = now();
      dropPending();
      if (episode) closeEpisode('window-focus');
    }

    function onWindowBlur() {
      lastBlurAt = now();
    }

    /**
     * Wrap a native dialog function (window.confirm, window.alert).
     *
     * The wrapper calls the original synchronously with the same arguments and
     * returns exactly what it returned; a throw from the original still
     * throws. Everything this file adds sits in its own try/catch on either
     * side of that call, so a failure here cannot change what the caller gets.
     * The arguments are never read.
     *
     * `owner` is the object to call the original on. A native window method
     * throws "Illegal invocation" when called on anything else.
     */
    function wrapDialog(kind, original, owner) {
      if (typeof original !== 'function') return original;
      const k = cleanKind(kind);
      return function () {
        let opened = null;
        try { opened = dialogOpened(k, callSite(new Error().stack)); } catch {}
        try {
          return original.apply(owner === undefined ? this : owner, arguments);
        } finally {
          try { dialogClosed(opened); } catch {}
        }
      };
    }

    function dialogOpened(kind, site) {
      // `dialog`, not `kind`: the event ring spreads this over its own `kind`.
      note('dialog-open', { dialog: kind, site });
      return { kind, site, t: now() };
    }

    function dialogClosed(opened) {
      if (!opened) return;
      const t = now();
      const rec = {
        kind: opened.kind, site: opened.site, closedAt: t, openMs: Math.max(0, t - opened.t),
        hasFocusAtReturn: hasFocus(), hasFocusAt250: null, hasFocusAt1500: null,
      };
      lastDialog = rec;
      mark(rec.kind, rec.site);
      note('dialog-close', { dialog: rec.kind, site: rec.site, openMs: rec.openMs, hasFocus: rec.hasFocusAtReturn });
      // Did the page get its focus back? Sampled twice, because right after
      // the dialog returns "not yet" is the ordinary answer.
      setTimer(() => { rec.hasFocusAt250 = hasFocus(); }, DIALOG_SAMPLE_MS[0]);
      setTimer(() => {
        rec.hasFocusAt1500 = hasFocus();
        const focusEventAfter = lastFocusAt != null && lastFocusAt >= rec.closedAt;
        note('dialog-settled', {
          dialog: rec.kind, site: rec.site,
          hasFocusAt250: rec.hasFocusAt250, hasFocusAt1500: rec.hasFocusAt1500, focusEventAfter,
        });
        // A line only when focus has not come back. That is also what clicking
        // away to another program within the second and a half looks like, so
        // read it as a suspect, not a verdict. No line once a later dialog has
        // closed: a native dialog blocks the page, so these samples ran late
        // and describe the state that one left, which its own line reports.
        if (lastDialog === rec && rec.hasFocusAt1500 === false && isVisible() && dialogLines < MAX_DIALOG_LINES) {
          dialogLines++;
          warn('[focus] dialog kind=' + rec.kind + ' site=' + (rec.site || 'unknown') + ' openMs=' + rec.openMs
            + ' hasFocusAtReturn=' + rec.hasFocusAtReturn + ' hasFocusAt250=' + rec.hasFocusAt250
            + ' hasFocusAt1500=false focusEventAfter=' + focusEventAfter);
        }
      }, DIALOG_SAMPLE_MS[1]);
    }

    /** Called once per episode with the same facts the log line carries. */
    function onDesync(cb) {
      if (typeof cb === 'function') listeners.push(cb);
    }

    /** One line per page load. It also shows the log route works: main writes
     *  a renderer warning to the app log (main.js, 'console-message'). */
    function start() {
      mark('page-load', '');
      warn('[focus] page-load hasFocus=' + hasFocus() + ' visible=' + isVisible());
    }

    /** For a diagnostics capture. Flags, counts and ages only. */
    function snapshot() {
      const tally = (x) => ({ keydowns: x.keydowns, printable: x.printable, keypress: x.keypress, insert: x.insert });
      return {
        schema: 1,
        hasFocus: hasFocus(),
        visible: isVisible(),
        episodes,
        notices,
        candidatePending: !!pending,
        sinceWindowFocusMs: agoMs(lastFocusAt),
        sinceWindowBlurMs: agoMs(lastBlurAt),
        episode: episode ? { n: episode.n, ageMs: agoMs(episode.t), ...tally(episode) } : null,
        lastEpisode: lastEpisode ? {
          n: lastEpisode.n, endedMsAgo: agoMs(lastEpisode.endedAt), durationMs: lastEpisode.durationMs,
          ...tally(lastEpisode), endedBy: lastEpisode.endedBy,
        } : null,
        lastDialog: lastDialog ? {
          kind: lastDialog.kind, site: lastDialog.site, closedMsAgo: agoMs(lastDialog.closedAt),
          openMs: lastDialog.openMs, hasFocusAtReturn: lastDialog.hasFocusAtReturn,
          hasFocusAt250: lastDialog.hasFocusAt250, hasFocusAt1500: lastDialog.hasFocusAt1500,
        } : null,
        markers: markers.slice(-MARKERS_IN_SNAPSHOT).map((m) => ({ kind: m.kind, site: m.site, msAgo: agoMs(m.t) })),
      };
    }

    return { onKeydown, onCharEvent, onWindowFocus, onWindowBlur, wrapDialog, mark, onDesync, start, snapshot };
  }

  const api = {
    createFocusWatch, keyClass, callSite,
    CONFIRM_MS, MAX_LOGGED_EPISODES, MAX_NOTICES, DIALOG_SAMPLE_MS,
  };

  // Expose globally. Guarded, and mirrored onto module.exports, so this file
  // can be required under Node, where `window` does not exist.
  if (typeof window !== 'undefined') window.FocusWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
