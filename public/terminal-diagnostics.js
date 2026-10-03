// --- Terminal display diagnostics -------------------------------------------
//
// WHY THIS EXISTS
//
// Text in the terminal can go wrong in three different places, and on a
// screenshot all three look identical:
//
//   1. the PTY stream     — the CLI genuinely sent us those bytes
//   2. the xterm buffer   — the parser (or a reflow) wrote the wrong cells
//   3. the WebGL renderer — the cells are right, but painted rows are stale
//
// Telling them apart used to mean opening DevTools and typing `__find(...)`
// while the damage was still on screen. That is a bad instrument twice over:
// it needs a developer at the keyboard at the moment of failure, and opening
// DevTools *docked* narrows the pane, which resizes the terminal and destroys
// the evidence. The one measurement that settles the question was the one
// measurement that was hardest to take.
//
// This module takes it automatically. A capture pairs two things recorded at
// the same instant:
//
//   - a PNG of the window — what the renderer actually painted, and
//   - the buffer rows as text — what xterm believes is there.
//
//   garbled text in the PNG but NOT in the rows      → (3) renderer
//   garbled text in both, and in the raw PTY tail    → (1) the CLI sent it
//   garbled text in both, but NOT in the raw tail    → (2) the buffer
//
// The raw PTY tail is recorded here too, which is what closes that last fork.
//
// Nothing here needs DevTools and nothing here is opt-in: the recorders run
// from startup, so the evidence already exists by the time something looks
// wrong. The cost is three bounded ring buffers.
//
// WHAT THE USER DOES
//
//   Ctrl/Cmd+Shift+D   "this looks wrong" — writes a capture, repaints that
//                      terminal, and offers a full redraw.
//
// and nothing else. Nothing in this module acts unless that key is pressed.
//
// There used to be automatic detection as well: scan the rows after output
// settled, and capture and "repair" when they looked wrong. It was removed on
// 2026-10-01 after one day. In that time it fired about ten times, every one a
// false positive — Claude Code legitimately repeats lines like "Ran 2 shell
// commands" and "User answered Claude's questions:" — and caught nothing real.
// Worse, its repair cleared the shared WebGL glyph atlas (see repair() below)
// about once a second, which blanked every other session's text. The two real
// bugs it was built to find were both caught by the hotkey.

(function () {
  'use strict';

  // --- Limits -------------------------------------------------------------
  // Every buffer here is bounded. A diagnostic that grows without limit turns
  // into the next bug report.
  const RAW_TAIL_BYTES = 128 * 1024;   // per session, of PTY output
  const KEY_RING = 400;                // key/data events, app-wide
  const EVENT_RING = 200;              // lifecycle notes, app-wide
  const BUFFER_LINES = 240;            // scrollback lines included in a capture

  // --- Detector thresholds ------------------------------------------------
  // The detector now only annotates a capture the user asked for; it never
  // triggers anything (see the header). Its findings are hints for whoever
  // reads the capture, and the thresholds are loose enough that ordinary
  // Claude Code output can trip them — read them as "look here", not "broken".
  //
  // Tuned against the first observed failure: a Claude Code subagent panel drew
  // "Activity · last 3 of" about twelve times down the left column, and one row
  // held two frames at once ("...last 3 ofOutcome · 287 lines").
  //
  // A TUI legitimately repeats blank rows, borders and padding, so a row only
  // counts once its *substantive* characters — everything that is not
  // whitespace or box drawing — clear a length floor.
  const DUP_MIN_SUBSTANCE = 12;        // chars before a row can count as a dupe
  const DUP_MIN_COPIES = 4;            // identical rows on screen = corrupt
  const RUN_MIN_SUBSTANCE = 8;
  const RUN_MIN_LENGTH = 3;            // identical rows back to back
  const COLLIDE_MIN_SUBSTANCE = 14;    // for the "two frames on one row" note

  const BOX_AND_SPACE = /[\s ─-▟]/g;
  const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/;

  // --- State --------------------------------------------------------------
  const rawTails = new Map();          // sessionId -> { chunks: string[], bytes: number }
  const keyRing = [];
  const eventRing = [];
  let busy = false;                    // one capture at a time
  const startedAt = Date.now();

  function now() { return Date.now(); }
  function iso(t) { return new Date(t).toISOString(); }

  function push(ring, limit, item) {
    ring.push(item);
    if (ring.length > limit) ring.splice(0, ring.length - limit);
  }

  // --- Recorders ----------------------------------------------------------

  /** Raw PTY output, before xterm sees it. Always on; this is the (1) vs (2) fork. */
  function recordOutput(sessionId, data) {
    if (typeof data !== 'string' || !data) return;
    let tail = rawTails.get(sessionId);
    if (!tail) { tail = { chunks: [], bytes: 0 }; rawTails.set(sessionId, tail); }
    tail.chunks.push(data);
    tail.bytes += data.length;
    while (tail.bytes > RAW_TAIL_BYTES && tail.chunks.length > 1) {
      tail.bytes -= tail.chunks.shift().length;
    }
  }

  function forgetSession(sessionId) {
    rawTails.delete(sessionId);
  }

  function rekeySession(oldId, newId) {
    if (oldId === newId) return;
    const tail = rawTails.get(oldId);
    if (tail) { rawTails.delete(oldId); rawTails.set(newId, tail); }
  }

  /** Where DOM focus is, and whether Chromium thinks this window has it.
   *
   *  Both halves matter. xterm renders the hollow (outline) cursor when
   *  `_isFocused && textarea.ownerDocument.hasFocus()` is false — the second
   *  half alone can flip it while the textarea is still the active element and
   *  still receiving keys. A capture that recorded only `activeElement` could
   *  not tell those apart. */
  function focusSnapshot() {
    try {
      const el = document.activeElement;
      return {
        docHasFocus: document.hasFocus(),
        activeTag: el ? el.tagName : null,
        activeClass: el && el.className ? String(el.className).slice(0, 120) : null,
        activeIsXtermTextarea: !!(el && el.classList && el.classList.contains('xterm-helper-textarea')),
      };
    } catch {
      return { error: 'focusSnapshot failed' };
    }
  }

  /** A key event, at whichever layer saw it.
   *
   *  `layer` is 'document' for the capture-phase listener that sees every key
   *  regardless of focus, and 'xterm' for the custom handler that only runs
   *  when the terminal has the key. Recording both is what distinguishes
   *  "the key never arrived" from "the key arrived and we swallowed it" —
   *  which is the open question behind capital letters going missing. */
  function recordKey(layer, e, extra) {
    if (!e) return;
    try {
      push(keyRing, KEY_RING, {
        t: now(),
        layer,
        type: e.type,
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey,
        repeat: !!e.repeat,
        composing: e.isComposing === true || e.keyCode === 229,
        defaultPrevented: !!e.defaultPrevented,
        ...(extra || {}),
        focus: focusSnapshot(),
      });
    } catch {}
  }

  /** What xterm decided to send to the PTY. Pairs with the keydown above. */
  function recordInput(sessionId, data) {
    try {
      push(keyRing, KEY_RING, {
        t: now(), layer: 'onData', sessionId,
        data: visible(String(data).slice(0, 64)),
      });
    } catch {}
  }

  function note(kind, detail) {
    push(eventRing, EVENT_RING, { t: now(), kind, ...(detail || {}) });
  }

  /** Control bytes made readable, so a JSON file shows the escapes. */
  function visible(s) {
    return String(s)
      .replace(/\x1b/g, '\\e')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  // --- Detector -----------------------------------------------------------

  function substance(s) {
    return s.replace(BOX_AND_SPACE, '');
  }

  /** Read the rows currently on screen. Does not repaint, so it cannot disturb
   *  the thing being measured. */
  function viewportRows(terminal) {
    const rows = [];
    try {
      const b = terminal.buffer.active;
      for (let y = 0; y < terminal.rows; y++) {
        const line = b.getLine(b.viewportY + y);
        rows.push(line ? line.translateToString(true) : '');
      }
    } catch {}
    return rows;
  }

  /** Findings about the visible rows. `corrupt` is what triggers a capture;
   *  the rest is detail that only makes sense once something else has fired. */
  function inspect(rows) {
    const findings = [];
    let corrupt = false;

    // Repeated rows anywhere on screen.
    const counts = new Map();
    for (const r of rows) {
      if (substance(r).length < DUP_MIN_SUBSTANCE) continue;
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    for (const [text, n] of counts) {
      if (n >= DUP_MIN_COPIES) {
        corrupt = true;
        findings.push({ kind: 'repeated-row', copies: n, text: text.trim().slice(0, 160) });
      }
    }

    // Identical rows back to back.
    let run = 1;
    for (let i = 1; i <= rows.length; i++) {
      const same = i < rows.length && rows[i] === rows[i - 1] && substance(rows[i]).length >= RUN_MIN_SUBSTANCE;
      if (same) { run++; continue; }
      if (run >= RUN_MIN_LENGTH) {
        corrupt = true;
        findings.push({ kind: 'consecutive-run', length: run, at: i - run, text: rows[i - 1].trim().slice(0, 160) });
      }
      run = 1;
    }

    // Control bytes or replacement characters that reached the buffer.
    rows.forEach((r, i) => {
      if (CONTROL_CHARS.test(r)) {
        corrupt = true;
        findings.push({ kind: 'control-char-in-buffer', row: i, text: visible(r).slice(0, 160) });
      }
    });

    // Two frames on one row: some other visible row is a strict prefix of this
    // one. On its own this is an ordinary thing for a TUI to draw, so it never
    // sets `corrupt` — it is here to name the damage once something else has.
    const prefixes = rows.filter((r) => substance(r).length >= COLLIDE_MIN_SUBSTANCE);
    for (const r of rows) {
      for (const p of prefixes) {
        if (p !== r && r.startsWith(p) && r.length > p.length) {
          findings.push({ kind: 'row-collision', prefix: p.trim().slice(0, 80), full: r.trim().slice(0, 160) });
          break;
        }
      }
    }

    return { corrupt, findings };
  }

  // --- Repair ladder ------------------------------------------------------
  //
  // Two rungs, run in increasing order of disruption, and only when the user
  // asks (Ctrl+Shift+D, then the toast's button for the second).
  //
  //   1. refresh()      repaints every row of this terminal from its buffer.
  //                     Cheap and confined to the one terminal.
  //   2. column nudge   resize down one column and back. This is what the user
  //                     was doing by hand with the window edge, and it is NOT a
  //                     renderer fix: it sends SIGWINCH, and the CLI redraws
  //                     from scratch, which also repairs a wrong buffer. It is
  //                     disruptive and can lose in-flight output, so it runs
  //                     only from the button.
  //
  // DO NOT add terminal.clearTextureAtlas() here. It was the middle rung, and
  // it is unsafe in this app. addon-webgl shares ONE glyph atlas between every
  // terminal with the same font, theme and DPI (acquireTextureAtlas, keyed by
  // config, with an `ownedBy` list) — which is every session. Its
  // clearTextureAtlas() is `_charAtlas.clearTexture(); _clearModel(true);
  // _requestRedrawViewport()`: it empties the shared texture but rebuilds only
  // the terminal it was called on. Every other session keeps a model saying its
  // glyphs are cached, draws from an empty atlas, and shows blank text until
  // something rebuilds it. Captured 2026-10-01: a session whose buffer held 38
  // rows of text painted nothing but two emoji and a status hint.

  function stillCorrupt(entry) {
    try { return inspect(viewportRows(entry.terminal)).corrupt; } catch { return false; }
  }

  function repair(entry, { aggressive = false } = {}) {
    const steps = [];
    if (!entry || entry.closed || !entry.terminal) return steps;
    const term = entry.terminal;

    // "Cleared" only means something if the detector had fired. Without this,
    // a screen the detector never flagged reported the first rung as having
    // fixed it, and the toast told the user the display was repaired when
    // nothing had changed — which is exactly what the first real capture did.
    const wasCorrupt = stillCorrupt(entry);
    const cleared = () => wasCorrupt && !stillCorrupt(entry);

    try { term.refresh(0, term.rows - 1); steps.push({ step: 'refresh', wasCorrupt, cleared: cleared() }); } catch (e) {
      steps.push({ step: 'refresh', error: String(e && e.message) });
    }
    if (steps[steps.length - 1] && steps[steps.length - 1].cleared) return steps;

    if (aggressive) {
      try {
        const { cols, rows } = term;
        if (cols > 2) {
          term.resize(cols - 1, rows);
          term.resize(cols, rows);
          steps.push({ step: 'column-nudge', cols, cleared: cleared() });
        }
      } catch (e) {
        steps.push({ step: 'column-nudge', error: String(e && e.message) });
      }
    }
    return steps;
  }

  // --- Capture ------------------------------------------------------------

  function describeRenderer(entry) {
    try {
      const el = entry.element;
      return {
        canvases: el.querySelectorAll('.xterm-screen canvas').length,
        domRows: el.querySelectorAll('.xterm-rows > div').length,
      };
    } catch { return null; }
  }

  function scrollbackTail(terminal, lines) {
    const out = [];
    try {
      const b = terminal.buffer.active;
      const from = Math.max(0, b.length - lines);
      for (let i = from; i < b.length; i++) {
        const line = b.getLine(i);
        out.push(line ? line.translateToString(true) : '');
      }
    } catch {}
    return out;
  }

  function buildReport(reason, entry, scan) {
    const sessionId = (entry && entry.session && entry.session.sessionId) || null;
    const term = entry && entry.terminal;
    const rows = term ? viewportRows(term) : [];
    const result = scan || (rows.length ? inspect(rows) : { corrupt: false, findings: [] });
    const tail = sessionId ? rawTails.get(sessionId) : null;
    const rect = (() => {
      try { return entry.element.getBoundingClientRect().toJSON(); } catch { return null; }
    })();

    return {
      schema: 1,
      reason,
      at: iso(now()),
      uptimeMs: now() - startedAt,
      session: {
        id: sessionId,
        name: (entry && entry.session && (entry.session.name || entry.session.customName)) || null,
        cwd: (entry && entry.session && entry.session.projectPath) || null,
      },
      geometry: term ? {
        cols: term.cols, rows: term.rows,
        viewportY: safe(() => term.buffer.active.viewportY),
        baseY: safe(() => term.buffer.active.baseY),
        bufferLength: safe(() => term.buffer.active.length),
        bufferType: safe(() => term.buffer.active.type),
        containerRect: rect,
        devicePixelRatio: window.devicePixelRatio,
        zoom: safe(() => window.api.getZoomFactor()),
      } : null,
      renderer: entry ? describeRenderer(entry) : null,
      focus: focusSnapshot(),
      detector: result,
      // What xterm believes is on screen, right now. Compare against the PNG.
      viewport: rows,
      scrollbackTail: term ? scrollbackTail(term, BUFFER_LINES) : [],
      // What the CLI actually sent. If the garble is not in here, we made it.
      rawPtyTail: tail ? visible(tail.chunks.join('')) : null,
      rawPtyTailBytes: tail ? tail.bytes : 0,
      keys: keyRing.slice(-120),
      events: eventRing.slice(-60),
    };
  }

  function safe(fn) { try { return fn(); } catch { return null; } }

  /**
   * Write a capture. Snapshots the buffer synchronously *before* anything
   * async, so the text and the pixels describe the same instant.
   */
  async function capture(reason, entry, scan) {
    if (busy) return null;
    busy = true;
    try {
      const report = buildReport(reason, entry, scan);
      const res = await window.api.diagCapture(report);
      if (res && res.ok) {
        note('captured', { reason, json: res.json });
      }
      return res;
    } catch (e) {
      note('capture-failed', { reason, error: String(e && e.message) });
      return null;
    } finally {
      busy = false;
    }
  }

  // --- Toast --------------------------------------------------------------
  //
  // Styles are injected from here rather than living in style.css on purpose:
  // this is the thing that has to render correctly when the rest of the UI is
  // the subject of the bug report, so it carries its own dependencies.

  let styled = false;
  function ensureStyles() {
    if (styled) return;
    styled = true;
    const s = document.createElement('style');
    s.textContent = `
.diag-toast {
  position: fixed; right: 16px; bottom: 16px; z-index: 100000;
  max-width: 420px; padding: 12px 14px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #e8e8ea; background: #22232a;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.5);
}
.diag-toast h4 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.diag-toast p { margin: 0 0 8px; color: #a9abb5; word-break: break-all; }
.diag-toast-actions { display: flex; gap: 8px; }
.diag-toast button {
  font: inherit; padding: 5px 10px; cursor: pointer;
  color: #e8e8ea; background: #32343d;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
}
.diag-toast button:hover { background: #3c3f4a; }
.diag-toast button.diag-primary { background: #3b5bdb; border-color: #3b5bdb; }
.diag-toast button.diag-primary:hover { background: #4c6ef5; }
`;
    document.head.appendChild(s);
  }

  let liveToast = null;
  function toast(title, body, actions, { timeout = 12_000 } = {}) {
    ensureStyles();
    if (liveToast) liveToast.remove();
    const el = document.createElement('div');
    el.className = 'diag-toast';
    const h = document.createElement('h4'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = body;
    const row = document.createElement('div'); row.className = 'diag-toast-actions';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'diag-primary';
      b.addEventListener('click', () => { try { a.onClick(); } finally { el.remove(); if (liveToast === el) liveToast = null; } });
      row.appendChild(b);
    }
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { el.remove(); if (liveToast === el) liveToast = null; });
    row.appendChild(dismiss);
    el.append(h, p, row);
    document.body.appendChild(el);
    liveToast = el;
    if (timeout) setTimeout(() => { if (liveToast === el) { el.remove(); liveToast = null; } }, timeout);
  }

  // --- The user-facing action --------------------------------------------

  function activeEntry() {
    try {
      if (typeof activeSessionId === 'undefined' || !activeSessionId) return null;
      return openSessions.get(activeSessionId) || null;
    } catch { return null; }
  }

  /** Ctrl/Cmd+Shift+D. Record first, then try the two free repairs. */
  async function reportAndRepair() {
    const entry = activeEntry();
    if (!entry) {
      toast('Nothing to capture', 'No session is open in this window.', []);
      return;
    }
    const before = await capture('user', entry);
    const steps = repair(entry);
    const fixed = steps.some((s) => s.cleared);
    note('repair', { steps, aggressive: false });

    const where = before && before.ok ? before.json : 'the diagnostics folder';
    // Claim a repair only when the detector saw damage and then stopped seeing
    // it. The detector does not recognise every kind of damage, so "nothing
    // detected" is not "nothing wrong" — say what was saved and offer the
    // redraw, rather than reporting success.
    toast(
      fixed ? 'Captured, and repaired' : 'Captured',
      fixed
        ? 'A repaint fixed it. Saved to ' + where
        : 'Saved to ' + where + '. If it still looks wrong, Force full redraw makes the CLI repaint everything.',
      [
        { label: 'Force full redraw', primary: !fixed, onClick: forceRedraw },
        { label: 'Open folder', onClick: () => window.api.diagOpenFolder() },
      ],
    );
  }

  /** The rung that costs something: SIGWINCH, and the TUI redraws from scratch. */
  async function forceRedraw() {
    const entry = activeEntry();
    if (!entry) return;
    const steps = repair(entry, { aggressive: true });
    note('repair', { steps, aggressive: true });
    await capture('after-repair', entry);
    toast('Full redraw sent', 'The session was resized and restored, which makes the CLI repaint everything.', [
      { label: 'Open folder', onClick: () => window.api.diagOpenFolder() },
    ], { timeout: 6000 });
  }

  function isReportHotkey(e) {
    const mod = (window.api && window.api.platform === 'darwin') ? e.metaKey : e.ctrlKey;
    // Shift makes e.key 'D' rather than 'd', so match on `code`.
    return mod && e.shiftKey && !e.altKey && e.code === 'KeyD';
  }

  // --- Init ---------------------------------------------------------------

  function init() {
    // Capture-phase, on the window, so it sees keys before anything can stop
    // them — including keys that never reach a terminal at all. That asymmetry
    // against the 'xterm' layer is the whole point of recording here.
    window.addEventListener('keydown', (e) => {
      recordKey('document', e);
      if (isReportHotkey(e)) {
        e.preventDefault();
        e.stopPropagation();
        reportAndRepair();
      }
    }, { capture: true });

    window.addEventListener('focus', () => note('window-focus'));
    window.addEventListener('blur', () => note('window-blur'));
    window.addEventListener('resize', () => note('window-resize', {
      w: window.innerWidth, h: window.innerHeight,
    }));
    note('started');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.TermDiag = {
    recordOutput, recordInput, recordKey, note,
    forgetSession, rekeySession,
    inspect, viewportRows,
    capture, repair, reportAndRepair, forceRedraw,
  };
})();
