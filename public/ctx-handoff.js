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
// the one box a click gets (handoffConfirmTyping) when the gate asks first: the
// session has not reported the end of its turn, this window has not yet been
// told whether the session is busy (after a reload), or the session's screen
// does not show an empty prompt. A busy session is never typed into while its
// turn runs; once the hook has recorded the end of its turn (a workflow keeps
// the spinner on after it), the same checks as for an idle one decide.
//
// The same files say whether a session has ultracode on. The header has a
// button that switches it by typing the /effort command, through the same
// gate as Hand off (typingGate), and a running session's row carries a bolt
// while it is on.
//
// The header also has the auto handoff switch, just after the meter: whether
// the hook may ask this session for a handoff by itself. A click types
// nothing: it asks main to make or delete the hook's opt-out marker,
// <session_id>.off in that folder. It is the only thing in this file that
// makes a file (through main).
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
//      when it is evaluated. test/ctx-handoff.test.js runs it in a vm context
//      with a fake DOM.
//
// Depends on globals, all read at the moment of use and never cached:
//   app.js: sessionMap, sessionBusyState, activePtyIds, activeSessionId,
//           pendingSessions, gridViewActive, cachedProjectTree,
//           cachedProjectTreeAll, launchNewSession, window._isOwnedElsewhere,
//           window._openSessions, didNotStopIds
//   dialogs.js: resolveDefaultSessionOptions
//   task-runner.js: activeTaskView
//   utils.js: cleanDisplayName
//   continue-name.js: window.ContinueName
//   prompt-screen.js: window.PromptScreen
//   xterm.js: the buffer of a window._openSessions entry's terminal
//   icons.js: window.ICONS.bolt
//   the browser: sessionStorage (per window; survives a reload of that window),
//           localStorage (every window; the names Continue has given)
// Those are top-level const/let in classic scripts: global bindings, but NOT
// window properties, and `typeof x` on one that is still uninitialised THROWS
// (temporal dead zone -- e.g. app.js died half-way through loading). Hence a
// try/catch around every access as well as the typeof guard.
//
// Called from outside: handoffChipState() by sidebar.js buildSessionItem,
// onActiveSessionChanged() by app.js setActiveSession. Both are typeof-guarded
// at the call site and checked once at load in app.js.
// handoffBoltState() by the row builders of both tabs (sidebar.js
// buildSessionItem, projects-view.js buildSessionRow),
// typeof-guarded at the call site too.

const REQUEST_LINE = 'Write the context handoff now. [ctx-handoff:request]';
// Same thresholds as the status line: dim below WARN_AT, amber from it, red
// from DUE_AT.
const WARN_AT = 300000;
const DUE_AT = 400000;
const OVERRIDE_TITLE = 'This session has not reported the end of its turn. Click to type the request anyway (asks first).';
// The turn marker says "ended", but this window has not been told whether the
// session is busy: the same question, a tooltip that gives the real reason.
const OVERRIDE_TITLE_UNSEEN = 'This window has seen no busy or idle event for this session since it loaded. Click to type the request anyway (asks first).';

// What the ultracode button types. Enter follows as a separate write, as it
// does for the request line.
const ULTRACODE_TEXT = { on: '/effort ultracode', off: '/effort ultracode off' };
const ULTRACODE_UNKNOWN_TITLE = 'Not known yet. The hook reports it after the session\'s first turn.';
// T6's tooltip (the /clear trial's fallback): what the Ultracode button would say if it had to
// wait for the cleared session's first idle title. Only the text is kept here, with a test of it.
// Nothing reads it: the behaviour is built only if the trial fails, and then as an input of
// typingGate, the one gate, not of ultracodeModel.
const CLEAR_WAIT_REASON = 'Session is starting again after /clear';
// Why the last switch came to nothing: text in the header note.
const ULTRACODE_NOT_CONFIRMED = 'No confirmation seen';
const ULTRACODE_NO_WORKFLOWS = 'Ultracode needs dynamic workflows enabled (see /config).';
const ULTRACODE_NO_MODEL = 'Ultracode isn\'t available on this session\'s model.';
// How long after a watched turn ended the files must have been read again
// before a reading that has not moved is called stale. The hook writes at the
// Stop, and the reads after an idle event go out at 0, 1 and 3 s: the last of
// them is the first that counts.
const STALE_AFTER_MS = 2500;

// Why the last request came to nothing: text beside the button, never a popup.
// Not "did not reach the session": a line typed while a turn is starting is
// queued behind it and is picked up when that turn ends.
const HANDOFF_NOT_LANDED = 'The session has not picked up the request yet. It may be queued behind the current turn; if the line is sitting in the input box, press Enter there.';
const HANDOFF_NOT_WRITTEN = 'No handoff was written after 10 minutes.';
const HANDOFF_SESSION_ENDED = 'The session ended before the handoff was written.';
const HANDOFF_NOT_SENT = 'Typed but not sent. Look at the session\'s input box.';
// T1's switch. false = Enter 250 ms after the text, always, and the box shows
// T1's line.
const ENTER_HOLD = true;
// The hook drops an unwritten request 30 minutes after it was made
// (MANUAL_EXPIRY), but only when an event comes along: an idle session never
// says so, and the reader contract asks the reader to time it out itself.
const REQUEST_EXPIRY_MS = 1800000;
// The 15 s poll, in ticks of the 1 s timer.
const POLL_EVERY_TICKS = 15;

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

// The bar's width, written the way the browser hands it back ("41%", not
// "41.0%"): the painter compares before it assigns, and a string the browser
// re-spells would be assigned again every second.
function meterWidth(pct) {
  const value = typeof pct === 'number' && isFinite(pct) ? pct : 0;
  return (Math.round(Math.max(0, Math.min(100, value)) * 10) / 10) + '%';
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

// Whether "Continue in new session" is on offer. A current handoff, always. A
// STOPPED session also keeps an older readable one although a newer one is
// due: the hook clears `pending` only on an event, a session that has exited
// sends none, and it cannot write the newer one any more.
function canContinue(state, handoffReadable, running) {
  const info = handoffInfo(state, handoffReadable);
  if (info.status === 'written') return true;
  return !running && info.status === 'due'
    && info.writtenAt !== null && info.path !== null && handoffReadable === true;
}

/**
 * The Sessions-sidebar chip: running Claude sessions with a reading, only.
 * The text is the token count and nothing else. A handoff that is due shows as
 * the colour (level 'due', red) and in the tooltip; one that is written adds a
 * tick (level 'written', green).
 * A reading that is no longer being updated (`staleSince`, a clock time: see
 * staleReading) keeps its number and colour, adds `stale: true` for the dimmed
 * look, and says so in the tooltip.
 */
function chipState(input) {
  const o = input || {};
  if (!o.running || o.isTerminal) return null;
  const meter = meterModel(o.sidecar);
  if (!meter) return null;
  const info = handoffInfo(o.state, o.handoffReadable);
  let chip = { text: meter.text, level: meter.level, title: 'Context ' + meter.full };
  if (info.status === 'due') {
    chip = { text: meter.text, level: 'due', title: 'Context ' + meter.full + ' — handoff due' };
  } else if (info.status === 'written') {
    chip = { text: meter.text + ' ✓', level: 'written', title: 'Context ' + meter.full + ' — handoff written' };
  }
  if (o.staleSince) {
    chip.stale = true;
    chip.title = staleTitle(o.staleSince);
  }
  return chip;
}

/**
 * Whether the reading can be TOLD to be no longer updated. After /clear the
 * program carries on under a new session id while the terminal stays filed
 * under the old one, so the files read here stop changing and the meter would
 * go on showing the old number as if it were current.
 *   turn      the last whole turn this window watched: { busyAtMs, idleAtMs }
 *   readAtMs  when the files were last read
 * Stale = the files were read STALE_AFTER_MS or more after that turn ended,
 * and nothing in them is as late as its start: not the reading (sidecar.ts),
 * not the hook's turn markers. → { sinceTs } (seconds), else null.
 * A busy-then-idle pair is not always a whole turn: a session that stops at a
 * permission prompt looks idle too, and so does one that was interrupted. So
 * where the hook's own markers say a turn is still running under this id (a
 * prompt with no Stop after it), nothing is marked: the hook is alive here,
 * and its prompt stamp may be a moment older than the spinner, which the
 * comparison with the turn's start would take for "did not move".
 * No watched turn, no mark: after a reload nothing is marked until a turn has
 * been seen from busy to idle. It goes as soon as anything in the files moves.
 */
function staleReading(input) {
  const o = input || {};
  const turn = o.turn;
  if (!turn || typeof turn.busyAtMs !== 'number' || typeof turn.idleAtMs !== 'number') return null;
  if (turn.idleAtMs < turn.busyAtMs) return null;
  if (typeof o.readAtMs !== 'number' || o.readAtMs - turn.idleAtMs < STALE_AFTER_MS) return null;
  const sidecar = o.sidecar && typeof o.sidecar === 'object' ? o.sidecar : null;
  const state = o.state && typeof o.state === 'object' ? o.state : null;
  if (state && typeof state.last_prompt_at === 'number' && !turnEnded(state)) return null;
  const readingTs = sidecar && typeof sidecar.ts === 'number' && isFinite(sidecar.ts) ? sidecar.ts : null;
  // Without a time on the reading there is nothing to say "since".
  if (readingTs === null) return null;
  let latest = readingTs;
  for (const at of state ? [state.last_stop_at, state.last_prompt_at] : []) {
    if (typeof at === 'number' && isFinite(at) && at > latest) latest = at;
  }
  return latest * 1000 < turn.busyAtMs ? { sinceTs: readingTs } : null;
}

function staleTitle(clock) {
  return 'Not updated since ' + clock + '. If you ran /clear in this session, the real count is lower.';
}

/**
 * Whether a line may be typed into the session, and plainly or only after
 * asking. One computation for every control that types (Hand off, Update, the
 * ultracode button), so no two of them can disagree. Takes what buttonModel
 * takes; the three states and `busyKnown` are described there. Three more
 * inputs:
 *   screen      what promptScreen (prompt-screen.js) read on the session's
 *               screen; anything but a state of 'empty', 'draft' or
 *               'question', a missing one included, counts as 'unknown'
 *   lineOnWay   true while an Ultracode switch of ours waits for the terminal
 *   didNotStop  true while a Stop of this session did not finish
 * Only the boolean true counts for the last two.
 * → { allowed, override, reason, advice, why, overrideTitle }
 *   allowed   false = never typed into, and `reason` says why
 *   override  allowed, but a click asks first, and `reason` says why
 *   reason    one bare sentence without a full stop, the stronger first; ''
 *             when a click types plainly
 *   advice    '' or one sentence that says what to do
 * gateText turns the reason and the advice into every text the user sees.
 * `why` (the reason when not allowed, else '') and `overrideTitle` keep their
 * old values; no code in this file reads them, and they stay because the tests
 * 'typingGate: Hand off is exactly what the gate says, in every combination'
 * and 'typingGate: no input at all is "not allowed"' read them.
 */
function typingGate(input) {
  const o = input || {};
  const state = o.state && typeof o.state === 'object' ? o.state : null;
  const request = o.request && typeof o.request === 'object' ? o.request : {};
  const lastStopMs = state && typeof state.last_stop_at === 'number' ? state.last_stop_at * 1000 : null;
  // The spinner came on after the last Stop the hook recorded: a turn is
  // running that the state file has not caught up with.
  const busyAfterStop = o.lastBusyAtMs != null && lastStopMs !== null && o.lastBusyAtMs > lastStopMs;
  // The turn marker fails open on the prompt side (a failed userprompt write
  // leaves the old Stop in place), so a Stop only counts when it is later than
  // the last line this file typed. atMs survives the request going back to idle.
  const sentAtMs = request.unsent !== true && typeof request.atMs === 'number' && request.atMs > 0 ? request.atMs : null;
  const stopAfterSent = sentAtMs === null || (lastStopMs !== null && lastStopMs > sentAtMs);
  const ended = turnEnded(state) && !busyAfterStop && stopAfterSent;
  const screenState = o.screen && typeof o.screen === 'object'
    && ['empty', 'draft', 'question'].includes(o.screen.state) ? o.screen.state : 'unknown';

  // Refusals, the first that holds.
  let reason = '';
  let advice = '';
  if (o.ownedElsewhere) reason = 'Shown in another window';
  else if (o.didNotStop === true) {
    reason = 'Session did not stop';
    advice = 'It takes no typing. Press Stop to try once more.';
  } else if (o.pendingRow) reason = 'Session is still starting';
  // Busy refuses only while the turn has not ended. Claude Code keeps its
  // spinner title on after a turn ends while a workflow is pending, so busy
  // stays true for the whole run; `ended` (the hook's Stop after the last
  // prompt, no spinner after it, later than our last line) says it is over.
  else if (o.busy === true && !ended) reason = 'Session is working';
  else if (!o.running) reason = 'Session is not running';
  else if (o.lineOnWay === true) reason = 'Waiting for the session to confirm the Ultracode switch';
  else if (screenState === 'question') {
    reason = 'Session is asking you something';
    advice = 'Answer it in the terminal first.';
  }
  const allowed = reason === '';

  // Asks first, the first that holds. The turn not having ended is the
  // stronger reason, so it is the one named.
  if (allowed) {
    if (!ended) reason = 'This session has not reported the end of its turn';
    else if (o.busyKnown !== true) reason = 'This window has seen no busy or idle event for this session since it loaded';
    else if (screenState === 'draft') reason = "There is text in this session's input box";
    else if (screenState === 'unknown') reason = "Switchboard cannot see an empty prompt on this session's screen";
  }
  const override = allowed && reason !== '';
  return {
    allowed, override, reason, advice,
    why: allowed ? '' : reason,
    overrideTitle: ended ? OVERRIDE_TITLE_UNSEEN : OVERRIDE_TITLE,
  };
}

/**
 * The one place that puts the gate's reason into a text the user sees.
 *   'tooltip'     a button that cannot be clicked: the reason, and the advice
 *   'asks-first'  the title of a button that asks first; opts { prefix, action }
 *                 (Hand off and Update: '' and 'Click to type the request')
 *   'box'         the one box: the reason, the question with the exact text,
 *                 and a last line; opts { line, hold }
 *   'note'        the header note of a click that typed nothing
 */
function gateText(gate, use, opts) {
  const g = gate && typeof gate === 'object' ? gate : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const reason = typeof g.reason === 'string' ? g.reason : '';
  const advice = typeof g.advice === 'string' ? g.advice : '';
  const prefix = typeof o.prefix === 'string' ? o.prefix : '';
  if (use === 'tooltip') return advice ? reason + '. ' + advice : reason;
  if (use === 'asks-first') {
    return reason ? prefix + reason + '. ' + o.action + ' anyway (asks first).' : prefix + o.action + ' (asks first).';
  }
  if (use === 'box') {
    const lines = [];
    if (reason) lines.push(reason + '.');
    lines.push('Type "' + o.line + '" into this session anyway?');
    if (reason === "There is text in this session's input box") {
      lines.push(o.hold === true
        ? 'If your own text is there, the line is typed after it and is not sent.'
        : 'If your own text is there, it is sent together with this line.');
    } else {
      lines.push('If the terminal is asking you something, cancel: the typed line could answer it.');
    }
    return lines.join('\n\n');
  }
  if (use === 'note') return 'Not typed. ' + reason + '.' + (advice ? ' ' + advice : '');
  return '';
}

/**
 * The one header note, chosen from the live ones: the later shows. Each note
 * is { text, atMs, open } and counts only with a non-empty text and a number
 * for atMs. One with `open` true (a request that is still outstanding) lives
 * while it is passed in; any other lives HANDOFF_ERROR_SHOWN_MS from atMs.
 * → the chosen note, or null. Never throws.
 */
function chooseHeaderNote(notes, nowMs) {
  if (!Array.isArray(notes)) return null;
  let chosen = null;
  for (const note of notes) {
    if (!note || typeof note !== 'object') continue;
    if (typeof note.text !== 'string' || !note.text || typeof note.atMs !== 'number') continue;
    const live = note.open === true || nowMs - note.atMs < HANDOFF_ERROR_SHOWN_MS;
    if (live && (!chosen || note.atMs > chosen.atMs)) chosen = note;
  }
  return chosen;
}

/**
 * What the header buttons show. `primary` is one button in three guises (Hand
 * off / Writing… / Continue in new session); `update` is the small one beside
 * Continue, for a handoff that has gone stale. `note` is the text beside them
 * (why the last request, the last Continue or the last click came to nothing:
 * the later of the live ones, chosen by chooseHeaderNote); it is shown whether
 * or not a button is.
 *
 * A typing control (Hand off, Update) is in one of three states:
 *   enabled, override false   the turn has ended and the screen shows an empty
 *                             prompt: a click types the request
 *   enabled, override true    one of four asks-first reasons (typingGate): the
 *                             session is not busy but has NOT reported the end
 *                             of its turn (no state file, no Stop since the
 *                             last prompt, the spinner came on after the last
 *                             Stop, or no Stop since the last request typed
 *                             here); `busyKnown` is not true (see below); there
 *                             is text in the input box; or the screen does not
 *                             show an empty prompt: a click asks first (the one
 *                             box, handoffConfirmTyping)
 *   disabled                  never typed into: shown in another window, did
 *                             not stop, still starting, busy with its turn not
 *                             ended, not running, an Ultracode switch on its
 *                             way, or a question on the screen. `title` says
 *                             which.
 * busy === true with the turn not ended is never overridable; with the turn
 * ended it is no reason at all (a workflow keeps the spinner on).
 *
 * `busyKnown` says whether `busy` can be believed. Main sends cli-busy-state
 * only when a session CHANGES between busy and idle, and a window that has
 * just loaded (a reload, a session moved in from another window) starts with
 * an empty busy map: "not busy" there means "not told". It is true once this
 * window has had a busy or idle event for the session since it loaded, or
 * main itself reported the flag (readCtxState with a boolean `busy`).
 * Anything but true turns a plain enabled control into an override.
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

  const gate = typingGate(o);
  const { allowed, override } = gate;
  const typingTitle = okTitle => (!allowed ? gateText(gate, 'tooltip')
    : override ? gateText(gate, 'asks-first', { prefix: '', action: 'Click to type the request' }) : okTitle);

  const info = handoffInfo(state, o.handoffReadable);
  if (canContinue(state, o.handoffReadable, running)) {
    // Kept for a stopped session too: the handoff outlives the process.
    const locked = o.continueLocked === true;
    let title = 'Start a new session in the same folder that reads the handoff first';
    if (locked) title = 'Starting the new session…';
    else if (info.status === 'due') {
      title = 'Start a new session in the same folder that reads the last handoff this session wrote (a newer one was due and was not written)';
    }
    // The new session is started the way this one was left (handoffContinue),
    // and the button says so before the click.
    const ultracode = o.ultracode === true;
    if (ultracode && !locked) title += '. It starts in ultracode, like this one';
    model.visible = true;
    model.primary = {
      kind: 'continue',
      label: ultracode ? 'Continue in new session (ultracode)' : 'Continue in new session',
      enabled: !locked, override: false, title,
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
  // The later of the things that went wrong is the one on screen.
  const notes = [];
  if (request.phase === 'timeout' && request.unsent === true) {
    notes.push({ text: HANDOFF_NOT_SENT, atMs: request.atMs, open: false });
  } else if (request.phase === 'timeout' && request.reason != null) {
    notes.push({ text: request.reason, atMs: typeof request.atMs === 'number' ? request.atMs : 0, open: true });
  }
  if (typeof o.continueError === 'string' && o.continueError) {
    notes.push({ text: o.continueError, atMs: typeof o.continueErrorAtMs === 'number' ? o.continueErrorAtMs : o.nowMs, open: false });
  }
  if (typeof o.clickNote === 'string' && o.clickNote) {
    notes.push({ text: o.clickNote, atMs: o.clickNoteAtMs, open: false });
  }
  const chosen = chooseHeaderNote(notes, o.nowMs);
  model.note = chosen ? chosen.text : null;
  return model;
}

// What the hook itself says: true / false, or null when it has not looked.
// It reads the switch from the transcript (ctx_handoff.py scan_ultracode) and
// writes true or false only once it has found a switch record there. Its null
// after a scan (ultra_scan says where the scan stopped) is "never switched in
// this session", which is off, by the hook's own rule ("treat anything but
// true as not ultracode") -- once it has recorded a Stop. Before that the scan
// is the one at the session's first prompt, and a session STARTED in ultracode
// (every "Continue in new session (ultracode)") seems to get its switch record
// only after that scan (one transcript, not measured): calling it off for the
// whole first turn would be a guess. Its null with no scan, a missing key (an
// older hook) and no state file at all are "not looked yet" too.
function ultracodeHook(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.ultracode === 'boolean') return state.ultracode;
  const scanned = !!state.ultra_scan && typeof state.ultra_scan === 'object';
  return scanned && typeof state.last_stop_at === 'number' ? false : null;
}

/**
 * Whether the session has ultracode on, as well as this window can tell:
 * true, false, or null for "not known". This is the value shown everywhere
 * (the button, the rows) and the one Continue passes on.
 *
 * The hook's value is behind right after a switch. `confirmed` ({ value, atMs })
 * is the last switch this window saw the terminal itself confirm, and it
 * stands until the hook has recorded a Stop later than it. A prompt later
 * than it is not enough: the hook scans at the prompt BEFORE the transcript
 * holds that prompt's own records, so what it writes then is still the value
 * from before the switch (ctx_handoff.py, "Known limit").
 */
function ultracodeValue(state, confirmed) {
  const hook = ultracodeHook(state);
  const seen = confirmed && typeof confirmed === 'object' && typeof confirmed.value === 'boolean'
    && typeof confirmed.atMs === 'number';
  if (!seen) return hook;
  if (hook === null) return confirmed.value;
  const stopAt = state.last_stop_at;
  const stoppedSince = typeof stopAt === 'number' && isFinite(stopAt) && stopAt * 1000 >= confirmed.atMs;
  return stoppedSince ? hook : confirmed.value;
}

/**
 * What the header's ultracode button shows and what a click may do. Takes
 * what buttonModel takes, and:
 *   ultracodeValue  true / false / null (see ultracodeValue)
 *   switching       a typed switch is waiting for the terminal to confirm it
 *   headerOff       the header is not this session's just now
 * → { visible, label, look, enabled, override, target, title }
 *   look    'on' (filled), 'off' (outline) or 'unknown' (outline, dimmed)
 *   target  what a click switches to: 'off' when it is on, 'on' when it is off
 * It types under the same gate as Hand off, so it is disabled wherever Hand off
 * is and asks first wherever Hand off does.
 * A value that is not known is never clickable: no guessing a direction.
 */
function ultracodeModel(input) {
  const o = input || {};
  const value = typeof o.ultracodeValue === 'boolean' ? o.ultracodeValue : null;
  const model = {
    visible: false, label: 'Ultracode', look: value === null ? 'unknown' : value ? 'on' : 'off',
    enabled: false, override: false, target: null, title: '',
  };
  if (o.isTerminal || !o.running || o.headerOff) return model;
  model.visible = true;
  if (o.switching) {
    model.label = 'Ultracode…';
    model.title = 'Waiting for the session to confirm the switch';
    return model;
  }
  if (value === null) {
    model.title = ULTRACODE_UNKNOWN_TITLE;
    return model;
  }
  // "Writing…": a line of this file's is already on its way into the session.
  if (o.request && o.request.phase === 'requested') {
    model.title = 'Waiting for the session to write the handoff';
    return model;
  }
  const gate = typingGate(o);
  if (!gate.allowed) {
    model.title = gateText(gate, 'tooltip');
    return model;
  }
  model.enabled = true;
  model.override = gate.override;
  model.target = value ? 'off' : 'on';
  const prefix = value ? 'Ultracode is on. ' : 'Ultracode is off. ';
  const action = value ? 'Click to switch it off' : 'Click to switch it on';
  model.title = model.override ? gateText(gate, 'asks-first', { prefix, action }) : prefix + action + '.';
  return model;
}

// The lines the program prints after /effort, counted on the rows of the
// terminal's screen: "Ultracode on (this session only): …" (older versions:
// "Set effort level to ultracode …"), "Ultracode off. …", and its two
// refusals. Capital U on purpose: the typed command is echoed in lower case.
// "isn.t": the apostrophe may come back as a typographic one.
// → the four counts, or null when there are no rows to read. A terminal always
// has rows, so an empty list is a read that failed and not a screen with
// nothing on it.
function ultracodeScreen(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const count = { on: 0, off: 0, noWorkflows: 0, noModel: 0 };
  for (const row of rows) {
    const text = String(row);
    if (/Ultracode on\b|Set effort level to ultracode/.test(text)) count.on++;
    if (/Ultracode off\b/.test(text)) count.off++;
    if (/Ultracode needs dynamic workflows/.test(text)) count.noWorkflows++;
    if (/Ultracode isn.t available/.test(text)) count.noModel++;
  }
  return count;
}

/**
 * What the screen says about a typed switch: `before` and `after` are
 * ultracodeScreen counts from before the text was typed and from now. Only
 * MORE lines than before count, so a line left on screen by an earlier switch
 * settles nothing; and a screen that could not be read either time settles
 * nothing at all. A refusal is looked for first: beside a new refusal, a new
 * line of the target's is not this switch's, and "not switched" is the side
 * to be wrong on.
 * → { outcome: 'confirmed' | 'refused' | 'waiting', reason }
 */
function ultracodeOutcome(target, before, after) {
  const waiting = { outcome: 'waiting', reason: '' };
  if (!before || !after) return waiting;
  if (after.noWorkflows > before.noWorkflows) return { outcome: 'refused', reason: ULTRACODE_NO_WORKFLOWS };
  if (after.noModel > before.noModel) return { outcome: 'refused', reason: ULTRACODE_NO_MODEL };
  if (after[target] > before[target]) return { outcome: 'confirmed', reason: '' };
  return waiting;
}

// The folder a sibling session starts in: the session's own, else the cwd the
// hook put in the sidecar (a session this window has no row for).
function launchFolder(session, sidecar) {
  if (session && typeof session.projectPath === 'string' && session.projectPath) return session.projectPath;
  if (sidecar && typeof sidecar.cwd === 'string' && sidecar.cwd) return sidecar.cwd;
  return null;
}

// Forward slashes: the path is pasted into a prompt, where a backslash is one
// escaping rule away from being eaten. "Main session only" matches the hook's
// own paste line: a workflow agent is handed the session's last typed message,
// and without it the agents open the handoff too.
function continuePrompt(handoffPath) {
  return 'Main session only; workflow agents and subagents skip this and do only the task in their prompt: read ' +
    String(handoffPath).replace(/\\/g, '/') + ' in full before doing anything else, then continue';
}

// How the state file relates to one request. The hook stamps crossed_at when
// it sees the request marker, and every request re-stamps it, so crossed_at is
// what ties the file to THIS request; the 1 s of slack covers the two clocks
// being read a moment apart.
function requestTie(request, state) {
  const crossedAt = state && typeof state.crossed_at === 'number' && isFinite(state.crossed_at) ? state.crossed_at : null;
  const forThisRequest = crossedAt !== null && crossedAt * 1000 >= request.atMs - 1000;
  return {
    crossedAt,
    forThisRequest,
    acknowledged: forThisRequest && state.manual === true && state.pending === true,
  };
}

/**
 * Where a typed request has got to, by the hook's reader contract
 * (ctx_handoff.py, "Reader contract"); see requestTie for crossed_at.
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
  const tie = requestTie(request, state);
  if (tie.forThisRequest && state.pending === false && (state.manual === false || state.manual === undefined)
    && typeof state.written_at === 'number' && state.written_at > tie.crossedAt) {
    return 'written';
  }
  if (o.running === false) return 'session_ended';
  const elapsed = nowMs - request.atMs;
  if (elapsed > 20000 && !tie.acknowledged) return 'not_landed';
  if (elapsed > 600000) return 'not_written';
  return 'waiting';
}

/**
 * The request record after one look at the state file and the clock: the same
 * object when nothing changes, a new one when it does. Takes
 * { request, state, nowMs, running } with `running` true / false / undefined
 * (not known, or not known for long enough).
 *
 * atMs is kept in every result, back at idle included: buttonModel wants a
 * Stop later than the last line typed here.
 *   requested → idle      the handoff for this request was written
 *   requested → timeout   with the note for session_ended / not_landed /
 *                         not_written
 *   timeout   → requested acknowledged late (the line sat queued behind a
 *                         running turn): "Writing…" again, the 10 minutes
 *                         still counting from the click
 *   timeout   → timeout   acknowledged later than that: the note changes from
 *                         "not picked up" to "not written"
 *   timeout   → idle      written after all; or the session that "ended" is
 *                         running again; or the hook dropped the request
 *                         (crossed_at is this request's, pending false, nothing
 *                         written)
 *   any       → idle      30 minutes after the click (REQUEST_EXPIRY_MS)
 */
function nextRequest(input) {
  const o = input || {};
  const request = o.request;
  if (!request || typeof request !== 'object') return request;
  if (request.phase !== 'requested' && request.phase !== 'timeout') return request;
  if (typeof request.atMs !== 'number') return request;
  const state = o.state && typeof o.state === 'object' ? o.state : null;
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const atMs = request.atMs;
  const idle = { phase: 'idle', atMs, reason: '' };
  const outcome = requestOutcome({ request, state, nowMs, running: o.running });
  if (outcome === 'written') return idle;
  if (nowMs - atMs > REQUEST_EXPIRY_MS) return idle;

  if (request.phase === 'requested') {
    let reason = '';
    if (outcome === 'session_ended') reason = HANDOFF_SESSION_ENDED;
    else if (outcome === 'not_landed') reason = HANDOFF_NOT_LANDED;
    else if (outcome === 'not_written') reason = HANDOFF_NOT_WRITTEN;
    return reason ? { phase: 'timeout', atMs, reason } : request;
  }

  const tie = requestTie(request, state);
  if (tie.forThisRequest && state.pending === false) return idle;
  if (request.unsent === true) return tie.acknowledged ? { phase: 'requested', atMs, reason: '' } : request;
  if (request.reason === HANDOFF_SESSION_ENDED) return o.running === true ? idle : request;
  if (request.reason === HANDOFF_NOT_LANDED) {
    if (outcome === 'waiting') return { phase: 'requested', atMs, reason: '' };
    // not_written is only ever reached by an acknowledged request.
    if (outcome === 'not_written') return { phase: 'timeout', atMs, reason: HANDOFF_NOT_WRITTEN };
  }
  return request;
}

// A request record as this file left it in sessionStorage, or null for
// anything else. A time in the future (the clock was set back) is refused: no
// Stop could ever be later than it.
function parseStoredRequest(text, nowMs) {
  if (typeof text !== 'string' || !text) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (value.phase !== 'idle' && value.phase !== 'requested' && value.phase !== 'timeout') return null;
  if (typeof value.atMs !== 'number' || !isFinite(value.atMs) || value.atMs <= 0) return null;
  if (typeof nowMs === 'number' && value.atMs > nowMs + 1000) return null;
  const reason = value.phase === 'timeout' && typeof value.reason === 'string' ? value.reason.slice(0, 300) : '';
  return { phase: value.phase, atMs: value.atMs, reason, ...(value.phase === 'timeout' && value.unsent === true ? { unsent: true } : {}) };
}

// A confirmed ultracode switch as this file left it in sessionStorage, or null
// for anything else. A time in the future is refused, as above: no report of
// the hook's could ever be later than it.
function parseStoredUltracode(text, nowMs) {
  if (typeof text !== 'string' || !text) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.value !== 'boolean') return null;
  if (typeof value.atMs !== 'number' || !isFinite(value.atMs) || value.atMs <= 0) return null;
  if (typeof nowMs === 'number' && value.atMs > nowMs + 1000) return null;
  return { value: value.value, atMs: value.atMs };
}

// Which of the running sessions the 15 s poll reads on this tick: each one
// once every POLL_EVERY_TICKS, on its own tick rather than all at once (every
// read is synchronous work in the main process). Sorted, so a session keeps
// its slot while the set of running sessions stays the same.
function pollDue(tick, ids) {
  if (!Array.isArray(ids)) return [];
  return [...ids].sort().filter((id, index) => (tick + index) % POLL_EVERY_TICKS === 0);
}

// The auto handoff switch's tooltips. The 400K and 150K are the hook's
// THRESHOLD and REARM_STEP, and AUTO_OFF_TITLE says what the hook does today
// with a session that is opted out (ctx_handoff.py, "Opt-out").
const AUTO_ON_TITLE = 'Automatic handoff prompts are on: the hook asks this session for a handoff when its context passes the trigger (400K, then 150K past each handoff). Click to turn them off for this session. Hand off and Update still work.';
const AUTO_OFF_TITLE = 'Automatic handoff prompts are off for this session. Hand off and Update still work. Click to turn them back on: if the context is past the trigger, the session is asked for a handoff at its next turn end.';
const AUTO_ENV_TITLE = 'Automatic handoff prompts are off for every session Switchboard starts: CLAUDE_CTX_HANDOFF is set in its environment. This switch cannot turn them on. Hand off and Update still work.';
// Why a click on the switch came to nothing: text in the header note, where
// " (<code>)." follows when main gave a code, else ".".
const AUTO_FAILED_OFF = 'Could not turn automatic handoff prompts off';
const AUTO_FAILED_ON = 'Could not turn automatic handoff prompts on';
const AUTO_REKEYED = 'The session changed id during the click. Click again.';

// The header's auto handoff switch: whether the ctx-handoff hook may ask this
// session for a handoff by itself (no <id>.off marker) or not. Not a typing
// control: a click makes or deletes a file through main and types nothing, so
// the typing gate plays no part. Takes:
//   isTerminal, running, headerOff, ownedElsewhere
//   hookSeen  this session's sidecar or state file has been read
//   off       true / false as main read the marker, null = not told
//   env       Switchboard's own environment opts every session out
//   saving    a click's write is on its way (entry.autoSaving: it moves with a re-key)
// → { visible, label, look ('on' | 'off'), enabled, target, title }
//   target    what a click asks for: true = make the marker (prompts off)
function autoHandoffModel(input) {
  const o = input || {};
  const off = typeof o.off === 'boolean' ? o.off : null;
  const model = {
    visible: false, label: off ? 'Auto handoff off' : 'Auto handoff on', look: off ? 'off' : 'on',
    enabled: false, target: null, title: '',
  };
  if (o.isTerminal || !o.running || o.headerOff || !o.hookSeen || off === null) return model;
  model.visible = true;
  if (o.env === true) {
    model.label = 'Auto handoff off';
    model.look = 'off';
    model.title = AUTO_ENV_TITLE;
    return model;
  }
  if (o.ownedElsewhere) {
    model.title = 'Shown in another window';
    return model;
  }
  if (o.saving === true) {
    model.label = 'Auto handoff…';
    model.title = 'Waiting for Switchboard to write the switch';
    return model;
  }
  model.enabled = true;
  model.target = !off;
  model.title = off ? AUTO_OFF_TITLE : AUTO_ON_TITLE;
  return model;
}

// ---------------------------------------------------------------- browser side
// Needs the app. test/ctx-handoff.test.js drives it in a vm context with a
// fake DOM, a fake window.api and its own clock.

// Session ids end up in a file path and in a CSS selector. Real ones are UUIDs.
const HANDOFF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// How often the handoff file itself is read again once it has been checked.
const HANDOFF_RECHECK_MS = 60000;
// After window.api.readCtxState throws or rejects, how long the files are read
// through the panel read before main is asked again.
const HANDOFF_CTX_STATE_BACKOFF_MS = 60000;
// activePtyIds is refreshed by a 3 s poll (app.js POLL_FAST_MS) and can lag a
// fork's new id by one round: "not running" has to hold this long to count.
const HANDOFF_ENDED_AFTER_MS = 6000;
// The least time Continue ignores clicks; it is held for as long as the launch
// takes when that is longer.
const HANDOFF_CONTINUE_LOCK_MS = 3000;
const HANDOFF_MIN_READ_GAP_MS = 500;
const HANDOFF_CONTINUE_FAILED = 'The new session could not be started.';
const HANDOFF_CONTINUE_NO_FOLDER = 'The new session could not be started: this session has no folder to start it in.';
// How long a failed Continue stays on screen.
const HANDOFF_ERROR_SHOWN_MS = 60000;
// sessionStorage key prefix for a session's request record.
const HANDOFF_STORE_PREFIX = 'handoff-request:';
// ...and for the last ultracode switch its terminal confirmed.
const HANDOFF_ULTRACODE_PREFIX = 'handoff-ultracode:';
// When the terminal's screen is looked at after the switch text was typed. The
// last look is the one that gives up.
const HANDOFF_ULTRACODE_LOOK_MS = [1000, 2500, 5000];
// When the screen is looked at for the typed line, counted from the text. The
// last look is the one that gives up.
const HANDOFF_ENTER_LOOK_MS = [250, 400, 600, 900, 1300];
// Every this many ticks, entries nobody needs any more are dropped.
const HANDOFF_PRUNE_EVERY_TICKS = 60;

const handoffRt = {
  // sessionId → see handoffEntry
  cache: new Map(),
  ctxDirPromise: null,
  inflight: new Map(), // sessionId → Promise of the read in progress
  lastReadAtMs: new Map(), // sessionId → when its last read was started
  rereading: new Set(), // sessionId → a busy click's re-read is on its way
  els: null,           // header elements, once built
  names: null,         // the names Continue has given (handoffNameStore), once asked for
  logged: new Set(),
  started: false,
  primed: false,       // the first read of every running session has been sent
  // The hook's files cannot be read at all (no folder, or the read itself
  // fails): the header shows nothing rather than a button whose outcome this
  // file could never see.
  inert: false,
  tickCount: 0,
  // window.api.readCtxState threw or rejected: until this time the hook's
  // files are read the old way (see handoffReadCtxState).
  ctxStateBrokenUntilMs: 0,
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

// --- The request record, kept across a reload of this window ---
//
// A reload rebuilds this file's memory. Without the record "Writing…" would
// turn back into a Hand off button that types a second request, and the time
// of the last typed line (which a Stop has to be later than) would be gone.

function handoffStorage() {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage ? sessionStorage : null; } catch { return null; }
}

function handoffStoreRequest(entry) {
  try {
    const store = handoffStorage();
    if (!store || !HANDOFF_ID_RE.test(entry.id)) return;
    const key = HANDOFF_STORE_PREFIX + entry.id;
    const request = entry.request;
    if (request.phase === 'idle' && !(request.atMs > 0)) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ phase: request.phase, atMs: request.atMs, reason: request.reason || '', ...(request.unsent === true ? { unsent: true } : {}) }));
  } catch {}
}

function handoffForgetStored(id) {
  try {
    const store = handoffStorage();
    if (store && typeof id === 'string' && HANDOFF_ID_RE.test(id)) {
      store.removeItem(HANDOFF_STORE_PREFIX + id);
      store.removeItem(HANDOFF_ULTRACODE_PREFIX + id);
    }
  } catch {}
}

function handoffRestoreRequest(id) {
  try {
    const store = handoffStorage();
    if (!store || typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) return null;
    return parseStoredRequest(store.getItem(HANDOFF_STORE_PREFIX + id), Date.now());
  } catch {
    return null;
  }
}

// The last ultracode switch the terminal confirmed, kept the same way: after a
// reload the hook's value would be back on screen although it is the older.
function handoffStoreUltracode(entry) {
  try {
    const store = handoffStorage();
    if (!store || !HANDOFF_ID_RE.test(entry.id)) return;
    const key = HANDOFF_ULTRACODE_PREFIX + entry.id;
    if (entry.ultraConfirmed) store.setItem(key, JSON.stringify(entry.ultraConfirmed));
    else store.removeItem(key);
  } catch {}
}

function handoffRestoreUltracode(id) {
  try {
    const store = handoffStorage();
    if (!store || typeof id !== 'string' || !HANDOFF_ID_RE.test(id)) return null;
    return parseStoredUltracode(store.getItem(HANDOFF_ULTRACODE_PREFIX + id), Date.now());
  } catch {
    return null;
  }
}

function handoffSetRequest(entry, request) {
  if (!request || entry.request === request) return;
  entry.request = request;
  handoffStoreRequest(entry);
}

// The class of every field of a handoff entry. 'terminal': a fact about the
// running program or about this window's last click; it stays with the
// terminal. 'conversation': a fact about the conversation, its files or its
// handoff. A clear re-key gives every conversation field its fresh value and
// carries every terminal field. `typed`, the hand-typed record, is in the
// table whether or not the entry still has the field.
const ENTRY_FIELD_CLASS = Object.freeze({
  id: 'conversation',
  sidecar: 'conversation',
  state: 'conversation',
  handoffReadable: 'conversation',
  readableFor: 'conversation',
  readableCheckedAtMs: 'conversation',
  request: 'terminal',
  lastBusyAtMs: 'terminal',
  seenBusyEvent: 'terminal',
  mainBusy: 'terminal',
  notRunningSinceMs: 'conversation',
  continueLockUntil: 'conversation',
  continueError: 'conversation',
  continueErrorAtMs: 'conversation',
  pruneMarked: 'conversation',
  turn: 'conversation',
  readAtMs: 'conversation',
  typed: 'terminal',
  ultraConfirmed: 'terminal',
  ultraSwitch: 'terminal',
  ultraNote: 'terminal',
  ultraNoteAtMs: 'terminal',
  autoOff: 'terminal',
  autoEnv: 'terminal',
  autoSeq: 'terminal',
  autoSaving: 'terminal',
});

function freshEntry(id) {
  return {
    id, sidecar: null, state: null,
    handoffReadable: false,
    readableFor: null,       // the written_at value handoffReadable was checked for
    readableCheckedAtMs: 0,  // when that check ran
    request: handoffIdleRequest(),
    lastBusyAtMs: null,
    // This window has had a cli-busy-state event (busy or idle) for the
    // session since this script loaded. Deliberately NOT kept across a
    // reload: that is exactly when the busy map starts out empty.
    seenBusyEvent: false,
    // The busy flag as main reported it on the last read: true / false, or
    // null when the reply carried none (always, until main has that step).
    mainBusy: null,
    notRunningSinceMs: 0,    // first time a request's session was seen not running
    continueLockUntil: 0,    // Continue ignores clicks until then
    continueError: '',       // why the last Continue came to nothing
    continueErrorAtMs: 0,
    pruneMarked: false,      // handoffPrune found it unneeded on its last pass
    // The last whole turn this window watched, { busyAtMs, idleAtMs }, and
    // when the files were last read: what staleReading goes by. Not kept
    // across a reload either.
    turn: null,
    readAtMs: 0,
    ultraConfirmed: null,    // { value, atMs }: the last switch the terminal confirmed
    ultraSwitch: null,       // { target, atMs } while a typed switch waits for the terminal's line
    ultraNote: '',           // why the last switch came to nothing
    ultraNoteAtMs: 0,
    autoOff: null,           // the hook's opt-out marker <id>.off as main read it: true / false, null = not told
    autoEnv: false,          // Switchboard's own environment opts every session out
    autoSeq: 0,              // counts the clicks on the switch: a read applies only if no click went out while it was away
    autoSaving: false,       // a click's write of the marker is on its way
  };
}

function entryAfterClear(entry, newId, opts) {
  const next = freshEntry(newId);
  for (const field of Object.keys(next)) {
    if (ENTRY_FIELD_CLASS[field] === 'terminal') next[field] = entry[field];
  }
  const clearedAtMs = opts ? opts.clearedAtMs : undefined;
  const request = entry.request;
  next.request = typeof clearedAtMs === 'number' && Number.isFinite(clearedAtMs)
    && request && typeof request.atMs === 'number' && request.atMs >= clearedAtMs
    ? request : handoffIdleRequest();
  const shown = ultracodeValue(entry.state, entry.ultraConfirmed);
  next.ultraConfirmed = typeof shown === 'boolean' ? { value: shown, atMs: opts ? opts.nowMs : undefined } : null;
  return next;
}

function handoffEntry(id) {
  let entry = handoffRt.cache.get(id);
  if (!entry) {
    entry = freshEntry(id);
    entry.request = handoffRestoreRequest(id) || handoffIdleRequest();
    entry.ultraConfirmed = handoffRestoreUltracode(id);
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

// didNotStopIds (app.js) holds the sessions whose Stop did not finish. Like
// activePtyIds it is REPLACED on every poll, so it is looked up each time and
// never held on to. An older page without the set reads as "did not stop: no".
function handoffDidNotStop(id) {
  try { return typeof didNotStopIds !== 'undefined' && !!didNotStopIds && didNotStopIds.has(id); } catch { return false; }
}

// Everything buttonModel, ultracodeModel and chipState take, for one session.
// `pendingRow` and `ownedElsewhere` can only DISABLE typing, and fail closed:
// each starts as "do not type" and is lowered only by a successful read of the
// app's own value. That covers a global that throws on access (temporal dead
// zone), one that does not exist at all, and a missing
// window._isOwnedElsewhere. `busy` starts as true too, but since part M true
// refuses only while the turn has not ended (typingGate); with neither source
// read, `busyKnown` is false and a click asks first. (`running` fails closed
// separately: without activePtyIds it is false, and nothing is typed into a
// session that is not running.)
//
// `busy` is the app's own flag OR main's (when main reports one): the app's is
// kept up by events and is the fresher of the two, main's is the only one that
// knows about a turn already running when this window loaded. Either saying
// "busy" is enough to refuse while the turn has not ended; once the hook has
// recorded its end, busy is no reason and the screen decides (part M).
// `busyKnown` (see buttonModel) is true once either source has actually
// spoken; with neither, the click asks first.
function handoffInputs(id) {
  const entry = handoffRt.cache.get(id) || null;
  const nowMs = Date.now();
  let busy = true;
  let pendingRow = true;
  let ownedElsewhere = true;
  try { if (typeof sessionBusyState !== 'undefined') busy = !!sessionBusyState.get(id); } catch {}
  try { if (typeof pendingSessions !== 'undefined') pendingRow = !!pendingSessions.has(id); } catch {}
  try { if (typeof window._isOwnedElsewhere === 'function') ownedElsewhere = !!window._isOwnedElsewhere(id); } catch {}
  const mainBusy = entry && typeof entry.mainBusy === 'boolean' ? entry.mainBusy : null;
  if (mainBusy === true) busy = true;
  const ultracode = entry ? ultracodeValue(entry.state, entry.ultraConfirmed) : null;
  return {
    isTerminal: handoffIsTerminal(id),
    running: handoffIsRunning(id),
    ownedElsewhere, pendingRow, busy,
    busyKnown: mainBusy !== null || (!!entry && entry.seenBusyEvent === true),
    lastBusyAtMs: entry ? entry.lastBusyAtMs : null,
    sidecar: entry ? entry.sidecar : null,
    state: entry ? entry.state : null,
    handoffReadable: entry ? entry.handoffReadable : false,
    ultracode: ultracode === true,
    ultracodeValue: ultracode,
    switching: !!entry && !!entry.ultraSwitch,
    // The same fact as `switching`: the gate refuses on it, and ultracodeModel
    // keeps reading `switching` for its own label.
    lineOnWay: !!entry && !!entry.ultraSwitch,
    screen: handoffScreenState(id),
    didNotStop: handoffDidNotStop(id),
    request: entry ? entry.request : handoffIdleRequest(),
    continueLocked: !!entry && nowMs < entry.continueLockUntil,
    continueError: entry ? entry.continueError : '',
    continueErrorAtMs: entry ? entry.continueErrorAtMs : 0,
    clickNote: entry ? entry.ultraNote : '',
    clickNoteAtMs: entry ? entry.ultraNoteAtMs : 0,
    autoOff: entry ? entry.autoOff : null,
    autoEnv: !!entry && entry.autoEnv === true,
    autoSaving: !!entry && entry.autoSaving === true,
    hookSeen: !!entry && !!(entry.sidecar || entry.state),
    nowMs,
  };
}

function handoffStale(entry) {
  if (!entry) return null;
  return staleReading({ turn: entry.turn, readAtMs: entry.readAtMs, sidecar: entry.sidecar, state: entry.state });
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
    const stale = handoffStale(entry);
    return chipState({
      sidecar: entry.sidecar,
      state: entry.state,
      handoffReadable: entry.handoffReadable,
      running: handoffIsRunning(sessionId),
      isTerminal: handoffIsTerminal(sessionId),
      staleSince: stale ? handoffClock(stale.sinceTs) : '',
    });
  } catch (err) {
    handoffLogOnce('handoffChipState failed', err);
    return null;
  }
}

/**
 * The ultracode bolt for a session row, on the Sessions tab and the Projects
 * tab: { html, title } for a running session that has ultracode on, else null.
 * Rows stay quiet: "not known" looks like "off" here. Synchronous and
 * never-throwing, like handoffChipState and for the same reason.
 */
function handoffBoltState(sessionId) {
  try {
    const entry = handoffRt.cache.get(sessionId);
    if (!entry || !handoffIsRunning(sessionId) || handoffIsTerminal(sessionId)) return null;
    if (ultracodeValue(entry.state, entry.ultraConfirmed) !== true) return null;
    const icons = typeof window !== 'undefined' ? window.ICONS : null;
    if (!icons || typeof icons.bolt !== 'function') return null;
    return { html: icons.bolt(11), title: 'Ultracode is on' };
  } catch (err) {
    handoffLogOnce('handoffBoltState failed', err);
    return null;
  }
}

// --- Reading the hook's files ---

// → { dir, failed }. `failed` = the question could not be asked, which is not
// the same as the answer "there is no such folder".
async function handoffLookupCtxDir() {
  let dir = null;
  let failed = false;
  try {
    if (typeof window.api.diagDir === 'function') dir = deriveCtxDir(await window.api.diagDir());
  } catch (err) {
    failed = true;
    handoffLogOnce('diagDir failed', err);
  }
  if (!dir && !failed) handoffLogOnce('no AppData/Roaming data folder (an instance started with SWITCHBOARD_DATA_DIR?) — the context meter stays off');
  return { dir, failed };
}

async function handoffCtxDir() {
  if (!handoffRt.ctxDirPromise) handoffRt.ctxDirPromise = handoffLookupCtxDir();
  const lookup = handoffRt.ctxDirPromise;
  const result = await lookup;
  // A lookup that failed is asked again by the next read, not remembered.
  if (result.failed && handoffRt.ctxDirPromise === lookup) handoffRt.ctxDirPromise = null;
  return result.dir;
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

// Main's read-ctx-state call. → { res } when main answered (res is whatever it
// said), or null when the caller has to read the files the old way.
//
// "The function exists" is not "main can answer": preload.js takes effect at a
// window reload, while the handler exists only in a main process started after
// the merge. Against an older main the invoke REJECTS ("No handler
// registered"), and without the catch that would stop the meter and the chips
// at exactly the moment the Hand off button matters. So a throw or a rejection
// sends this window back to the panel read for a minute, then it asks again.
// An answer of any kind, { error: 'bad session id' } included, is main
// answering and is no reason to back off.
async function handoffReadCtxState(id) {
  if (typeof window.api.readCtxState !== 'function') return null;
  if (Date.now() < handoffRt.ctxStateBrokenUntilMs) return null;
  try {
    return { res: await window.api.readCtxState(id) };
  } catch (err) {
    handoffRt.ctxStateBrokenUntilMs = Date.now() + HANDOFF_CTX_STATE_BACKOFF_MS;
    handoffLogOnce('readCtxState failed; reading the files through the panel read instead', err);
    return null;
  }
}

// One file of a readCtxState reply, in handoffReadJson's three values: main's
// code 'ENOENT' → null (not there, which is normal), an object → the object,
// anything else → undefined (could not be read just now: keep what we had).
function handoffCtxValue(value, code) {
  if (code === 'ENOENT') return null;
  if (value && typeof value === 'object') return value;
  return undefined;
}

async function handoffReadPair(id) {
  // The dedicated main-process call replaces the generic panel read, whose
  // handler marks every path it reads as save-allowed.
  const viaMain = await handoffReadCtxState(id);
  if (viaMain) {
    const res = viaMain.res;
    // `handoff: null` = this read says nothing about the handoff file (see
    // handoffCheckReadable).
    if (!res || typeof res !== 'object') return { sidecar: undefined, state: undefined, handoff: null };
    const codes = res.codes && typeof res.codes === 'object' ? res.codes : {};
    const state = handoffCtxValue(res.state, codes.state);
    let handoff = null;
    if (state) {
      // Main statted the file THIS state names, so its answer is only used
      // together with that state. A main that sent the state without the
      // answer leaves the check to the panel read (undefined).
      handoff = typeof res.handoffReadable === 'boolean'
        ? { readable: res.handoffReadable, gone: codes.handoff === 'ENOENT' }
        : undefined;
    }
    return {
      sidecar: handoffCtxValue(res.sidecar, codes.sidecar),
      state,
      // Main's own busy flag for the session, when it sends one. Only a real
      // boolean counts; anything else is "main did not say".
      busy: typeof res.busy === 'boolean' ? res.busy : undefined,
      handoff,
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
//
// `fromMain` is the `handoff` of a readCtxState reply: { readable, gone } =
// main statted the file with that read, so it is used at once and nothing is
// read here; null = main answered but could not read the state just now, so
// entry.state is an older one and what we had stands; undefined = main did not
// say (or the panel path is in use), checked below with the panel read.
async function handoffCheckReadable(entry, fromMain) {
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
  if (fromMain === null) return;
  let readable = false;
  let gone = false;
  if (fromMain) {
    // Costs nothing (it came with the read), so the once-a-minute rule below
    // does not apply: a deleted handoff stops offering Continue at this read.
    readable = fromMain.readable === true;
    gone = fromMain.gone === true;
  } else {
    if (sameHandoff && Date.now() - entry.readableCheckedAtMs < HANDOFF_RECHECK_MS) return;
    try {
      if (typeof window.api.readFileForPanel === 'function') {
        const res = await window.api.readFileForPanel(filePath);
        readable = !!(res && res.ok);
        gone = !!res && !res.ok && res.code === 'ENOENT';
      }
    } catch {}
  }
  entry.readableCheckedAtMs = Date.now();
  // A handoff that was readable a minute ago and fails once is most likely
  // being rewritten: only "the file is gone" takes Continue away.
  if (sameHandoff && entry.handoffReadable && !readable && !gone) return;
  entry.handoffReadable = readable;
  entry.readableFor = writtenAt;
}

// Called after every read AND from the 1 s tick: the notes are a matter of
// time as well as of what the files say, and a request whose files cannot be
// read must still stop saying "Writing…".
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
  handoffSetRequest(entry, nextRequest({ request, state: entry.state, nowMs, running }));
}

function handoffSetInert(on) {
  if (handoffRt.inert === on) return;
  handoffRt.inert = on;
  handoffRenderHeader();
}

// Main's read-handoff-off call: whether the hook's opt-out marker <id>.off is
// there. → { off, env }, or null for anything else (an older main rejects the
// invoke; a reply without a boolean `off`): the switch then stays hidden.
async function handoffReadOff(id) {
  let res;
  try {
    res = await window.api.readHandoffOff(id);
  } catch (err) {
    handoffLogOnce('readHandoffOff failed; the auto handoff switch stays hidden', err);
    return null;
  }
  if (res && typeof res.off === 'boolean') return { off: res.off, env: res.env === true };
  handoffLogOnce('readHandoffOff failed; the auto handoff switch stays hidden', res);
  return null;
}

async function handoffDoRefresh(id) {
  // A plain terminal has no Claude context and no sidecar.
  if (handoffIsTerminal(id)) return;
  const entry = handoffEntry(id);
  const startedMs = Date.now();
  // The auto handoff switch's marker is read side by side with the pair; a
  // page without the call awaits nothing more.
  const offSeq = entry.autoSeq;
  const offRead = typeof window.api.readHandoffOff === 'function' ? handoffReadOff(id) : null;
  let pair = null;
  try {
    pair = await handoffReadPair(id);
  } catch (err) {
    handoffSetInert(true);
    throw err;
  }
  if (!pair) {
    handoffSetInert(true);
    return;
  }
  handoffSetInert(false);
  // The session was re-keyed (forked) while the read was out: what came back
  // describes the old id's files.
  if (handoffRt.cache.get(id) !== entry) return;
  if (pair.sidecar !== undefined) {
    entry.sidecar = pair.sidecar;
    // The time the read went out: what came back is at least that fresh.
    entry.readAtMs = startedMs;
  }
  if (pair.state !== undefined) entry.state = pair.state;
  // Not kept from an earlier read: a reply without the flag is "not told".
  entry.mainBusy = typeof pair.busy === 'boolean' ? pair.busy : null;
  if (offRead) {
    const told = await offRead;
    if (handoffRt.cache.get(id) !== entry) return;
    // A read that went out before a click's write would show the old file:
    // it applies only if no click went out while it was away.
    if (entry.autoSeq === offSeq && entry.autoSaving !== true) {
      entry.autoOff = told ? told.off : null;
      entry.autoEnv = !!told && told.env;
    }
  }
  await handoffCheckReadable(entry, pair.handoff);
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
  const className = 'handoff-chip' + (chip && chip.level ? ' handoff-' + chip.level : '')
    + (chip && chip.stale ? ' handoff-stale' : '');
  document.querySelectorAll('.session-item[data-session-id="' + id + '"] .handoff-chip').forEach(el => {
    handoffSetText(el, chip ? chip.text : '');
    handoffSetClass(el, className);
    handoffSetTitle(el, chip ? chip.title : '');
  });
  // The ultracode bolt, in the same pass and under the same rule; these rows
  // are on the Projects tab as well. Whether there is one is compared, not the
  // markup: the browser hands innerHTML back re-spelled.
  const bolt = handoffBoltState(id);
  document.querySelectorAll('[data-session-id="' + id + '"] .handoff-bolt').forEach(el => {
    if (!!el.innerHTML !== !!bolt) el.innerHTML = bolt ? bolt.html : '';
    handoffSetTitle(el, bolt ? bolt.title : '');
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

  // The auto handoff switch (autoHandoffModel), just after the meter.
  const auto = document.createElement('button');
  auto.id = 'handoff-auto-btn';
  auto.type = 'button';
  auto.className = 'handoff-btn handoff-btn-small';
  auto.style.display = 'none';
  auto.addEventListener('click', handoffGuard('auto switch click failed', handoffOnAutoClick));

  // Why the last request came to nothing. Text in the header, not a popup.
  const note = document.createElement('span');
  note.id = 'handoff-note';
  note.style.display = 'none';

  // A bolt and a label, so the label can change without the icon being built
  // again.
  const ultracode = document.createElement('button');
  ultracode.id = 'handoff-ultracode-btn';
  ultracode.type = 'button';
  ultracode.className = 'handoff-btn';
  ultracode.style.display = 'none';
  const ultracodeIcon = document.createElement('span');
  ultracodeIcon.className = 'handoff-btn-icon';
  try { ultracodeIcon.innerHTML = window.ICONS.bolt(11); } catch {}
  const ultracodeLabel = document.createElement('span');
  ultracode.append(ultracodeIcon, ultracodeLabel);
  ultracode.addEventListener('click', handoffGuard('ultracode click failed', handoffOnUltracodeClick));

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
  controls.insertBefore(auto, meter.nextSibling);
  controls.insertBefore(note, stopBtn);
  controls.insertBefore(ultracode, stopBtn);
  controls.insertBefore(primary, stopBtn);
  controls.insertBefore(update, stopBtn);
  return { meter, meterText, meterTrack, meterFill, meterState, auto, note, ultracode, ultracodeLabel, primary, update };
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

// When the header shows nothing of ours and a click does nothing:
//   no active session, or a plain terminal
//   a task log has the pane (the header is then the task's, not a session's)
//   grid view: the header, when it is on screen at all there, still names the
//     last single-view session, while the active id follows the focused card
//   the hook's files cannot be read (handoffRt.inert)
function handoffHeaderOff(id) {
  if (!id || handoffRt.inert || handoffIsTerminal(id)) return true;
  let taskView = false;
  try { taskView = typeof activeTaskView !== 'undefined' && !!activeTaskView; } catch {}
  let grid = false;
  try { grid = typeof gridViewActive !== 'undefined' && !!gridViewActive; } catch {}
  return taskView || grid;
}

function handoffRenderHeader() {
  const els = handoffRt.els;
  if (!els) return;
  const id = handoffActiveId();
  if (handoffHeaderOff(id)) {
    handoffShow(els.meter, false);
    handoffShow(els.auto, false);
    handoffShow(els.note, false);
    handoffShow(els.ultracode, false);
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
    const width = meterWidth(meter.pct);
    if (els.meterFill.style.width !== width) els.meterFill.style.width = width;
    handoffSetClass(els.meterFill, 'handoff-meter-fill' + (meter.level ? ' handoff-' + meter.level : ''));
  }
  let stateText = '';
  let stateClass = 'handoff-meter-state';
  let stateTitle = '';
  // The hook's own order (its status line): off comes before due and written.
  if (input.autoOff === true || input.autoEnv === true) {
    stateText = 'handoff off';
    stateClass += ' handoff-off';
    stateTitle = 'Automatic handoff prompts are off for this session. Hand off and Update still work.';
  } else if (info.status === 'due') {
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
  // A reading that is no longer being updated keeps its number, dimmed, and
  // the tooltip says since when.
  const stale = meter ? handoffStale(handoffRt.cache.get(id)) : null;
  handoffSetClass(els.meter, stale ? 'handoff-stale' : '');
  let meterTitle = '';
  if (stale) meterTitle = staleTitle(handoffClock(stale.sinceTs));
  else if (meter) meterTitle = 'Context in use: ' + meter.full + (meter.ts !== null ? ' (read ' + handoffClock(meter.ts) + ')' : '');
  handoffSetTitle(els.meterText, meterTitle);

  // headerOff is false here: the early return above took the other case.
  const auto = autoHandoffModel({ ...input, headerOff: false, off: input.autoOff, env: input.autoEnv, saving: input.autoSaving });
  handoffSetButton(els.auto, {
    visible: auto.visible,
    label: auto.label,
    enabled: auto.enabled,
    title: auto.title,
    extraClass: 'handoff-btn-small handoff-auto-' + auto.look,
  });

  const ultra = ultracodeModel(input);
  handoffSetButton(els.ultracode, {
    visible: ultra.visible,
    enabled: ultra.enabled,
    title: ultra.title,
    extraClass: 'handoff-btn-ultracode-' + ultra.look + (ultra.override ? ' handoff-btn-override' : ''),
  });
  if (ultra.visible) handoffSetText(els.ultracodeLabel, ultra.label);

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
  // With or without a button: a session that ended before its handoff was
  // written has no button left to sit beside.
  const note = model.note ? String(model.note) : '';
  handoffShow(els.note, !!note);
  handoffSetText(els.note, note);
  handoffSetTitle(els.note, note);
}

// --- Clicks ---

function handoffDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function handoffTypeLine(entry, text, opts) {
  const { onSent, onUnsent, blindOk } = opts || {};
  window.api.sendInput(entry.id, text);
  let done = false;
  const enter = () => {
    done = true;
    try {
      window.api.sendInput(entry.id, '\r');
    } finally {
      if (typeof onSent === 'function') onSent();
    }
  };
  if (!ENTER_HOLD || blindOk === true) {
    setTimeout(handoffGuard('sending Enter failed', enter), 250);
    return;
  }
  const lastLook = HANDOFF_ENTER_LOOK_MS[HANDOFF_ENTER_LOOK_MS.length - 1];
  for (const delay of HANDOFF_ENTER_LOOK_MS) {
    setTimeout(handoffGuard('sending Enter failed', () => {
      if (done) return;
      const read = handoffScreenRead(entry.id);
      const screen = typeof window.PromptScreen !== 'undefined' ? window.PromptScreen : null;
      const seen = !!read && !!screen && typeof screen.echoSeen === 'function' && screen.echoSeen(read, text) === true;
      if (seen) {
        enter();
      } else if (delay === lastLook) {
        done = true;
        if (typeof onUnsent === 'function') onUnsent();
      }
    }), delay);
  }
}

// Types the request into the session. The Enter goes as a SEPARATE write a
// moment later: in the same write the CLI takes the carriage return as part of
// a paste and leaves the line sitting in the input box.
function handoffSendRequest(id, opts = {}) {
  if (typeof window.api.sendInput !== 'function') return;
  const entry = handoffEntry(id);
  let atMs = 0;
  handoffTypeLine(entry, REQUEST_LINE, {
    blindOk: opts.blindOk,
    onUnsent: () => {
      const now = entry.request;
      if (!now || now.phase !== 'requested' || now.atMs !== atMs) return;
      handoffSetRequest(entry, { phase: 'timeout', atMs, reason: '', unsent: true });
      handoffPaint(entry.id);
    },
  });
  atMs = Date.now();
  handoffSetRequest(entry, { phase: 'requested', atMs, reason: '' });
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

function handoffContinueFailed(entry, note, err) {
  entry.continueError = note;
  entry.continueErrorAtMs = Date.now();
  // Not handoffLogOnce: a second failure is worth a second line.
  try { console.error('[handoff] Continue failed: ' + note, err === undefined ? '' : err); } catch {}
}

// The title a session shows in the lists (projects-view.js sessionTitle,
// without its placeholder).
function handoffShownTitle(session) {
  if (!session) return '';
  const raw = session.name || session.aiTitle || session.summary || '';
  return (typeof cleanDisplayName === 'function' ? cleanDisplayName(raw) : raw) || '';
}

// The names Continue has given (continue-name.js), or null without that file.
// One store for the life of the page: it is also the copy that still works
// when localStorage does not.
function handoffNameStore() {
  if (handoffRt.names) return handoffRt.names;
  const names = typeof window !== 'undefined' ? window.ContinueName : null;
  if (!names || typeof names.createStore !== 'function') return null;
  let storage = null;
  try { storage = window.localStorage; } catch {}
  handoffRt.names = names.createStore(storage);
  return handoffRt.names;
}

// What the sibling of session `id` is called: the old session's title and a
// number (continue-name.js has the rule). null starts it unnamed, as a session
// with nothing to carry over is, and as every failure in here does: the name
// is a courtesy and must never be the reason a Continue did not start.
function handoffContinueName(id) {
  try {
    const names = typeof window !== 'undefined' ? window.ContinueName : null;
    if (!names || typeof names.continuedName !== 'function') return null;
    const session = handoffSession(id);
    if (!session) return null;
    const store = handoffNameStore();
    return names.continuedName(handoffShownTitle(session), {
      ours: !!store && store.isOurs(id, session.name),
      // Another session this window knows already shows that title.
      taken: (name) => {
        for (const other of sessionMap.values()) {
          if (other && other.sessionId !== id && handoffShownTitle(other) === name) return true;
        }
        return false;
      },
    });
  } catch {
    return null;
  }
}

// The second click. The old session is left running, and keeps its name:
// nothing here stops or renames it.
async function handoffContinue(id) {
  const entry = handoffRt.cache.get(id);
  if (!entry) return;
  // launchNewSession is not instant; a double click must not start two
  // siblings. The lock is held until the launch has settled, and for
  // HANDOFF_CONTINUE_LOCK_MS at least. The button shows as disabled meanwhile
  // (buttonModel continueLocked) and the 1 s tick brings it back.
  if (Date.now() < entry.continueLockUntil) return;
  if (!canContinue(entry.state, entry.handoffReadable, handoffIsRunning(id))) return;
  const info = handoffInfo(entry.state, entry.handoffReadable);
  const lockFloor = Date.now() + HANDOFF_CONTINUE_LOCK_MS;
  entry.continueLockUntil = Infinity;
  entry.continueError = '';
  handoffRenderHeader();
  try {
    if (typeof resolveDefaultSessionOptions !== 'function' || typeof launchNewSession !== 'function') {
      handoffContinueFailed(entry, HANDOFF_CONTINUE_FAILED, 'launchNewSession() / resolveDefaultSessionOptions() are missing');
      return;
    }
    const target = handoffLaunchTarget(id);
    if (!target) {
      handoffContinueFailed(entry, HANDOFF_CONTINUE_NO_FOLDER);
      return;
    }
    const options = await resolveDefaultSessionOptions(target);
    // Same folder as the old session, not a fresh worktree of it.
    delete options.worktree;
    delete options.worktreeName;
    // An ultracode session continues as one. Set after the defaults, so it
    // would win over an effort from them (they carry none today);
    // `--effort ultracode` is ultracode on at xhigh (harnesses/claude.js).
    if (ultracodeValue(entry.state, entry.ultraConfirmed) === true) options.effort = 'ultracode';
    options.initialPrompt = continuePrompt(info.path);
    const name = handoffContinueName(id);
    const newId = await launchNewSession(target, options, { name });
    // Remembered, so that continuing the sibling counts its number up and
    // does not append another.
    if (name && typeof newId === 'string') {
      try {
        const store = handoffNameStore();
        if (store) store.remember(newId, name);
      } catch {}
    }
  } catch (err) {
    handoffContinueFailed(entry, HANDOFF_CONTINUE_FAILED, err);
  } finally {
    entry.continueLockUntil = lockFloor;
    handoffRenderHeader();
  }
}

// The typing control a click is for, decided NOW and not from what the button
// looked like a second ago. null when that control is not on offer.
function handoffTypingControl(id, which) {
  if (handoffHeaderOff(id)) return null;
  const input = handoffInputs(id);
  const gate = typingGate(input);
  const model = buttonModel(input);
  if (!model.visible) return null;
  if (which === 'update') return model.update.visible ? { ...model.update, gate } : null;
  return model.primary.kind === 'handoff' ? { ...model.primary, gate } : null;
}

// The app's own in-page confirm (dialogs.js confirmDialog), which answers
// through a Promise: the call below is awaited, and so is every call of this
// function. Anything but an explicit yes is a no, a missing or failing dialog
// included.
async function handoffConfirmTyping(gate, line) {
  try {
    const text = gateText(gate, 'box', { line, hold: ENTER_HOLD });
    return typeof confirmDialog === 'function'
      && (await confirmDialog(text, { confirm: 'Type it anyway' })) === true;
  } catch { return false; }
}

function handoffSetClickNote(entry, text) {
  entry.ultraNote = text;
  entry.ultraNoteAtMs = Date.now();
  handoffRenderHeader();
}

function handoffNotTypedNote(left, gate, control, { boxOpen = true } = {}) {
  const changed = boxOpen
    ? 'Not typed. The session changed while the box was open.'
    : 'Not typed. The session changed.';
  if (left) return changed;
  if (!gate.allowed) {
    return gate.reason === 'Session is working' || gate.reason === 'Session is asking you something'
      ? gateText(gate, 'note') : changed;
  }
  if (!control || !control.enabled) return changed;
  return '';
}

async function handoffTypeRequest(id, which) {
  const entry = handoffEntry(id);
  let control = handoffTypingControl(entry.id, which);
  if (!control || !control.enabled) return;
  const unreadable = handoffScreenRead(entry.id) === null;
  let blindOk = false;
  // A busy session is typed into on its turn marker alone, and a turn that
  // starts under a spinner that never went off sends no busy event: read the
  // marker again now and decide again, with no box (part M). One click at a
  // time: a second click while the read is on its way does nothing.
  // The id is taken before the wait: a re-key meanwhile changes entry.id.
  const rereadId = entry.id;
  if (handoffRt.rereading.has(rereadId)) return;
  if (!control.override && handoffInputs(entry.id).busy === true) {
    handoffRt.rereading.add(rereadId);
    try {
      await handoffDelay(HANDOFF_MIN_READ_GAP_MS);
      await handoffRefresh(entry.id);
    } finally {
      handoffRt.rereading.delete(rereadId);
    }
    const gate = typingGate(handoffInputs(entry.id));
    control = handoffTypingControl(entry.id, which);
    const left = handoffActiveId() !== entry.id || handoffHeaderOff(entry.id);
    const note = handoffNotTypedNote(left, gate, control, { boxOpen: false });
    if (note) {
      handoffSetClickNote(entry, note);
      return;
    }
  }
  if (control.override) {
    if (!await handoffConfirmTyping(control.gate, REQUEST_LINE)) return;
    // The question was open for as long as the user took: the session may have
    // gone busy meanwhile and the state file may have moved on. Wait, read
    // again and decide again. The wait is a real timer, not a resolved promise:
    // a busy event still on its way is a task of its own and has to run before
    // the second decision, and it is as long as the reader contract's gap so
    // that the read after it is a read and not the cache. A session that went
    // busy meanwhile is not typed into; one that is still (or now properly)
    // clear is, with the question already answered.
    await handoffDelay(HANDOFF_MIN_READ_GAP_MS);
    await handoffRefresh(entry.id);
    const gate = typingGate(handoffInputs(entry.id));
    control = handoffTypingControl(entry.id, which);
    const left = handoffActiveId() !== entry.id || handoffHeaderOff(entry.id);
    const note = handoffNotTypedNote(left, gate, control);
    if (note) {
      handoffSetClickNote(entry, note);
      return;
    }
    blindOk = unreadable;
  }
  handoffSetClickNote(entry, '');
  handoffSendRequest(entry.id, { blindOk });
}

function handoffOnPrimaryClick() {
  const id = handoffActiveId();
  if (!id || handoffHeaderOff(id)) return undefined;
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

// --- The ultracode button ---

// The button as a click finds it NOW, or null when it is not on offer.
// headerOff is added here and not in handoffInputs: with the header off the
// render never gets as far as the model, so a click is its only reader.
function handoffUltracodeControl(id) {
  const input = handoffInputs(id);
  const model = ultracodeModel({ ...input, headerOff: handoffHeaderOff(id) });
  return model.visible ? { ...model, gate: typingGate(input) } : null;
}

// The rows of a session's terminal screen and the cursor's row on it,
// { rows, cursorY }, or null when they cannot be read (no terminal in this
// window). cursorY is null when the buffer gives no number for it. The LIVE
// screen, from the buffer's baseY, and not what is in view
// (TermDiag.viewportRows starts at viewportY): the text goes straight to the
// pty and scrolls nothing. With the view scrolled up the program's line is
// printed below it, and a line of an earlier switch that scrolls into view
// would be counted as this one's.
function handoffScreenRead(id) {
  try {
    const open = window._openSessions ? window._openSessions.get(id) : null;
    const terminal = open ? open.terminal : null;
    const buffer = terminal && terminal.buffer ? terminal.buffer.active : null;
    if (!buffer || typeof buffer.baseY !== 'number' || !(terminal.rows > 0)) return null;
    const rows = [];
    for (let y = 0; y < terminal.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      rows.push(line ? line.translateToString(true) : '');
    }
    return { rows, cursorY: typeof buffer.cursorY === 'number' ? buffer.cursorY : null };
  } catch {
    return null;
  }
}

function handoffScreenRows(id) {
  const read = handoffScreenRead(id);
  return read ? read.rows : null;
}

function handoffScreenState(id) {
  try {
    if (typeof window.PromptScreen === 'undefined' || !window.PromptScreen
      || typeof window.PromptScreen.promptScreen !== 'function') {
      return { state: 'unknown', why: 'prompt-screen.js is not loaded' };
    }
    return window.PromptScreen.promptScreen(handoffScreenRead(id));
  } catch {
    return { state: 'unknown', why: 'the screen check failed' };
  }
}

// One look at the terminal after a typed switch. The hook would say so too,
// but not before the session's next prompt; the program's own line is on the
// screen within the second. Nothing is shown as switched on the click alone:
// without that line the button goes back to the look it had, and the note says
// why.
function handoffUltracodeLook(entry, pending, before, last) {
  if (entry.ultraSwitch !== pending) return;
  const result = ultracodeOutcome(pending.target, before, ultracodeScreen(handoffScreenRows(entry.id)));
  if (result.outcome === 'waiting' && !last) return;
  entry.ultraSwitch = null;
  if (result.outcome === 'confirmed') {
    entry.ultraConfirmed = { value: pending.target === 'on', atMs: Date.now() };
    handoffStoreUltracode(entry);
  } else {
    handoffSetClickNote(entry, result.outcome === 'refused' ? result.reason : ULTRACODE_NOT_CONFIRMED);
  }
  handoffPaint(entry.id);
}

// Types the switch the way handoffSendRequest types its line: the text, then
// Enter as a separate write. The screen is counted BEFORE the text goes in.
function handoffSendUltracode(id, target, opts = {}) {
  if (typeof window.api.sendInput !== 'function') return;
  const entry = handoffEntry(id);
  const before = ultracodeScreen(handoffScreenRows(id));
  const pending = { target, atMs: Date.now() };
  entry.ultraSwitch = pending;
  handoffSetClickNote(entry, '');
  const lastLook = HANDOFF_ULTRACODE_LOOK_MS[HANDOFF_ULTRACODE_LOOK_MS.length - 1];
  handoffTypeLine(entry, ULTRACODE_TEXT[target], {
    blindOk: opts.blindOk,
    onSent: () => {
      for (const delay of HANDOFF_ULTRACODE_LOOK_MS) {
        setTimeout(handoffGuard('ultracode look failed', () => {
          handoffUltracodeLook(entry, pending, before, delay === lastLook);
        }), delay);
      }
    },
    onUnsent: () => {
      if (entry.ultraSwitch !== pending) return;
      entry.ultraSwitch = null;
      handoffSetClickNote(entry, HANDOFF_NOT_SENT);
      handoffPaint(entry.id);
    },
  });
  handoffRenderHeader();
}

async function handoffToggleUltracode(id) {
  const entry = handoffEntry(id);
  let control = handoffUltracodeControl(entry.id);
  if (!control || !control.enabled) return;
  // The direction is the click's: what the button said when it was pressed.
  const target = control.target;
  const unreadable = handoffScreenRead(entry.id) === null;
  let blindOk = false;
  // A busy session is typed into on its turn marker alone, and a turn that
  // starts under a spinner that never went off sends no busy event: read the
  // marker again now and decide again, with no box (part M). One click at a
  // time: a second click while the read is on its way does nothing.
  // The id is taken before the wait: a re-key meanwhile changes entry.id.
  const rereadId = entry.id;
  if (handoffRt.rereading.has(rereadId)) return;
  if (!control.override && handoffInputs(entry.id).busy === true) {
    handoffRt.rereading.add(rereadId);
    try {
      await handoffDelay(HANDOFF_MIN_READ_GAP_MS);
      await handoffRefresh(entry.id);
    } finally {
      handoffRt.rereading.delete(rereadId);
    }
    const gate = typingGate(handoffInputs(entry.id));
    control = handoffUltracodeControl(entry.id);
    const left = handoffActiveId() !== entry.id || handoffHeaderOff(entry.id);
    let note = handoffNotTypedNote(left, gate, control, { boxOpen: false });
    if (!note && control.target !== target) note = 'Not typed. Ultracode is already ' + target + '.';
    if (note) {
      handoffSetClickNote(entry, note);
      return;
    }
  }
  if (control.override) {
    if (!await handoffConfirmTyping(control.gate, ULTRACODE_TEXT[target])) return;
    // As in handoffTypeRequest: the question was open for as long as the user
    // took, so wait, read again and decide again. A value that changed
    // meanwhile is not switched back.
    await handoffDelay(HANDOFF_MIN_READ_GAP_MS);
    await handoffRefresh(entry.id);
    const gate = typingGate(handoffInputs(entry.id));
    control = handoffUltracodeControl(entry.id);
    const left = handoffActiveId() !== entry.id || handoffHeaderOff(entry.id);
    let note = handoffNotTypedNote(left, gate, control);
    if (!note && control.target !== target) note = 'Not typed. Ultracode is already ' + target + '.';
    if (note) {
      handoffSetClickNote(entry, note);
      return;
    }
    blindOk = unreadable;
  }
  handoffSendUltracode(entry.id, target, { blindOk });
}

function handoffOnUltracodeClick() {
  const id = handoffActiveId();
  return id ? handoffToggleUltracode(id) : undefined;
}

// --- The auto handoff switch ---

// A click on the switch: main makes or deletes the session's <id>.off, and
// the switch then shows what main says the file is. Nothing is typed and no
// box opens; a click that came to nothing says so in the header note.
async function handoffSetAuto(id) {
  // The switch as the click finds it NOW (headerOff as in handoffUltracodeControl).
  const input = handoffInputs(id);
  const model = autoHandoffModel({
    ...input, headerOff: handoffHeaderOff(id), off: input.autoOff, env: input.autoEnv,
  });
  if (!model.visible || !model.enabled) return;
  // A visible switch has an entry: its hook files were read (hookSeen).
  const entry = handoffRt.cache.get(id);
  // The id is taken before the wait: a re-key meanwhile changes entry.id.
  const setId = entry.id;
  // One click at a time, also across a re-key: the flag is on the entry.
  if (entry.autoSaving) return;
  entry.autoSaving = true;
  entry.autoSeq += 1;
  handoffRenderHeader();
  let res = null;
  try {
    res = await window.api.setHandoffOff(setId, model.target);
  } catch (err) {
    res = null;
    handoffLogOnce('setHandoffOff failed', err);
  } finally {
    entry.autoSaving = false;
  }
  // The session's entry is gone.
  if (handoffRt.cache.get(entry.id) !== entry) return;
  // Re-keyed meanwhile, and the answer is not for the id the session has now
  // (main answers for the live id, so after one re-key it is).
  if (entry.id !== setId && (!res || res.id !== entry.id)) {
    handoffSetClickNote(entry, AUTO_REKEYED);
    handoffRefresh(entry.id);
    return;
  }
  if (res && typeof res.off === 'boolean') entry.autoOff = res.off;
  if (res && typeof res.env === 'boolean') entry.autoEnv = res.env;
  if (!res || res.ok !== true) {
    const code = res && typeof res.code === 'string' && res.code ? ' (' + res.code + ').' : '.';
    handoffSetClickNote(entry, (model.target ? AUTO_FAILED_OFF : AUTO_FAILED_ON) + code);
  } else if (typeof entry.ultraNote === 'string'
    && (entry.ultraNote.startsWith(AUTO_FAILED_OFF) || entry.ultraNote.startsWith(AUTO_FAILED_ON)
      || entry.ultraNote === AUTO_REKEYED)) {
    handoffSetClickNote(entry, '');
  }
  handoffPaint(entry.id);
}

function handoffOnAutoClick() {
  const id = handoffActiveId();
  return id ? handoffSetAuto(id) : undefined;
}

// --- Triggers ---

// Entries nobody needs: not running, not on screen, no read out, no request
// outstanding, no Continue in progress -- and found so on two passes a minute
// apart, since a fork's new id can lag the running set by a poll. A request
// record in sessionStorage is left alone and comes back with the entry.
function handoffPrune() {
  // Which sessions are running is not known (app.js cannot be read): keep all.
  if (handoffRunningState('') === undefined) return;
  const nowMs = Date.now();
  const active = handoffActiveId();
  const running = new Set(handoffRunningIds());
  for (const [id, entry] of handoffRt.cache) {
    const needed = id === active || running.has(id) || handoffRt.inflight.has(id)
      || entry.request.phase !== 'idle' || nowMs < entry.continueLockUntil || !!entry.ultraSwitch;
    if (needed) {
      entry.pruneMarked = false;
    } else if (!entry.pruneMarked) {
      entry.pruneMarked = true;
    } else {
      handoffRt.cache.delete(id);
    }
  }
  for (const [id, atMs] of handoffRt.lastReadAtMs) {
    if (handoffRt.cache.has(id) || handoffRt.inflight.has(id) || running.has(id)) continue;
    if (nowMs - atMs > HANDOFF_MIN_READ_GAP_MS) handoffRt.lastReadAtMs.delete(id);
  }
}

// One 1 s timer for all the cadences:
//   every tick   move every outstanding request on by the clock, and re-derive
//                the header from the cache (no IPC; the busy and running flags
//                change without telling this file)
//   every 2 s    re-read sessions with a request outstanding
//   every 15 s   re-read each running session, one tick each (pollDue)
//   every 60 s   drop entries nobody needs (handoffPrune)
function handoffTick() {
  handoffRt.tickCount++;
  const tick = handoffRt.tickCount;
  // The header was not there at load: the chips run without it, and the meter
  // and buttons join in if it turns up.
  if (!handoffRt.els) handoffRt.els = handoffBuildHeader();
  for (const entry of handoffRt.cache.values()) handoffApplyOutcome(entry);
  if (tick % 2 === 0) {
    for (const [id, entry] of handoffRt.cache) {
      if (entry.request.phase === 'requested') handoffRefresh(id);
    }
  }
  const running = handoffRunningIds();
  if (running.length) {
    // `primed`: the first poll of activePtyIds lands some time after load, and
    // waiting for each session's own tick would leave the chips blank until
    // then. That one round reads them all.
    const due = handoffRt.primed ? pollDue(tick, running) : running;
    handoffRt.primed = true;
    for (const id of due) handoffRefresh(id);
  }
  if (tick % HANDOFF_PRUNE_EVERY_TICKS === 0) handoffPrune();
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
      // Busy or idle: either way this window now knows which.
      entry.seenBusyEvent = true;
      if (busy) {
        entry.lastBusyAtMs = Date.now();
      } else {
        // Busy and now idle again: a whole turn, watched (staleReading).
        if (entry.lastBusyAtMs !== null && (!entry.turn || entry.turn.busyAtMs !== entry.lastBusyAtMs)) {
          entry.turn = { busyAtMs: entry.lastBusyAtMs, idleAtMs: Date.now() };
        }
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
    api.onSessionForked(handoffGuard('fork listener failed', (oldId, newId, reason, info) => {
      const entry = handoffRt.cache.get(oldId);
      if (entry && typeof newId === 'string') {
        handoffRt.cache.delete(oldId);
        handoffForgetStored(oldId);
        // The entry is the terminal's record, so the SAME object moves for every kind of
        // re-key: the typing path and the looks hold it. A fork or a plan-accept continues
        // the conversation and takes everything along. A /clear starts a new conversation
        // in the same terminal: every field gets its fresh value, and only the terminal's
        // own facts stay (ENTRY_FIELD_CLASS, entryAfterClear).
        if (reason === 'clear') {
          Object.assign(entry, entryAfterClear(entry, newId, { clearedAtMs: info && info.clearedAtMs, nowMs: Date.now() }));
        } else {
          entry.id = newId;
        }
        handoffRt.cache.set(newId, entry);
        handoffStoreRequest(entry);
        handoffStoreUltracode(entry);
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
    freshEntry, ENTRY_FIELD_CLASS, entryAfterClear, CLEAR_WAIT_REASON,
    REQUEST_LINE, WARN_AT, DUE_AT, OVERRIDE_TITLE, OVERRIDE_TITLE_UNSEEN,
    HANDOFF_NOT_LANDED, HANDOFF_NOT_WRITTEN, HANDOFF_SESSION_ENDED,
    HANDOFF_NOT_SENT, ENTER_HOLD,
    REQUEST_EXPIRY_MS, POLL_EVERY_TICKS,
    fmtTokens, chipLevel, deriveCtxDir, meterModel, meterWidth, turnEnded, handoffInfo,
    canContinue, chipState, buttonModel, continuePrompt, requestOutcome, nextRequest,
    parseStoredRequest, pollDue, launchFolder,
    ULTRACODE_TEXT, ULTRACODE_UNKNOWN_TITLE, ULTRACODE_NOT_CONFIRMED, ULTRACODE_NO_WORKFLOWS, ULTRACODE_NO_MODEL,
    STALE_AFTER_MS,
    typingGate, gateText, chooseHeaderNote, ultracodeValue, ultracodeModel, ultracodeScreen, ultracodeOutcome,
    parseStoredUltracode, staleReading, staleTitle,
    autoHandoffModel, AUTO_ON_TITLE, AUTO_OFF_TITLE, AUTO_ENV_TITLE, AUTO_FAILED_OFF, AUTO_FAILED_ON, AUTO_REKEYED,
    handoffChipState, handoffBoltState, onActiveSessionChanged,
  };
}
