// --- Terminal management ---
// Key bindings, write buffering, xterm instance lifecycle, drag-and-drop.
//
// Depends on globals: openSessions, activeSessionId, TERMINAL_THEME, terminalsEl,
// gridViewActive, gridCards, gridViewerCount, placeholder, terminalHeader,
// sessionMap, activePtyIds (app.js)
// Depends on: toggleGridView, isSessionNavKey, handleSessionNavKey, focusGridCard,
// wrapInGridCard, showGridView (grid-view.js)
// Depends on: shellEscape (utils.js)

// --- Terminal key bindings ---
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
const isMac = typeof window !== 'undefined' && window.api && window.api.platform === 'darwin';

// True when a keydown is being consumed by an IME (e.g. Korean/Japanese/Chinese)
// to compose a character. Chromium reports keyCode 229 for such keydowns, and
// sets isComposing while a composition is active. xterm's own _keyDown defers to
// its composition helper in this state — but only if our custom handler lets the
// event through (returns true) instead of intercepting it.
function isImeComposing(e) {
  return e.isComposing === true || e.keyCode === 229;
}

// Whether a Space keydown should be written straight to the PTY (the push-to-talk
// key-repeat path from #22) rather than left to xterm. It must NOT fire during IME
// composition: preventDefault-ing the Space there drops the in-progress syllable
// (e.g. Korean "녕 " came out as " 녕" or lost the syllable entirely).
function shouldSendSpaceDirectly(e) {
  return e.key === ' '
    && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    && !isImeComposing(e);
}

// Decode an OSC 52 payload into the text the program wants on the clipboard.
// Payload is "<selection>;<base64>", e.g. "c;aGVsbG8=".
//
// Returns null when there is nothing to write — an empty payload, or a read-back
// query ("<selection>;?"). The read-back case is a deliberate refusal, not a gap:
// answering it would write the user's clipboard contents back into the terminal,
// letting any program running in the session exfiltrate whatever they last
// copied. We consume the sequence and stay silent. Do not "finish" this by
// implementing the query response.
//
// Throws on malformed base64 (atob), which the caller reports as unhandled.
function decodeOsc52Payload(payload) {
  const sep = payload.indexOf(';');
  const b64 = sep === -1 ? payload : payload.slice(sep + 1);
  if (!b64 || b64 === '?') return null;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function setupTerminalKeyBindings(terminal, container, getSessionId, { onFind } = {}) {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Cmd/Ctrl+Shift+G → toggle grid view
    if (e.key === 'g' && (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey) {
      if (e.type === 'keydown') { e._handled = true; toggleGridView(); }
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // On Windows/Linux, Ctrl+V is captured by xterm as a control character (0x16)
    // instead of triggering a paste. Return false to block xterm's key pipeline and
    // let Electron's Edit menu { role: 'paste' } handle the actual clipboard paste.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          window.api.writeClipboard(terminal.getSelection());
        }
        return false;
      }
    }

    // Space → send directly on keydown (including key-repeat) to ensure reliable
    // delivery to the PTY. xterm.js's evaluateKeyboardEvent does not handle plain
    // Space in keydown (keyCode 32 < 48 threshold) and instead relies on the
    // deprecated 'keypress' event, which Electron/Chromium may not fire reliably
    // for key-repeat events. This fixes Claude Code's "Hold Space to record"
    // push-to-talk voice feature, which depends on rapid key-repeat characters
    // arriving at stdin to detect a held key.
    // Skips IME composition (isImeComposing): during Korean/Japanese/Chinese
    // composition, Space commits the pending syllable, so it must fall through
    // to xterm's composition helper instead of being sent raw.
    if (shouldSendSpaceDirectly(e)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.api.sendInput(getSessionId(), ' ');
      }
      return false;
    }

    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
function isAtBottom(terminal) {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// Fit terminal to container, then verify the last row actually fits.
//
// FitAddon.proposeDimensions() derives rows from the container's *computed*
// height and subtracts the padding it finds on the `.xterm` element. Our padding
// lives on `.terminal-container` instead, and that container is 5px taller than
// its visible area (`inset: -5px 20px 0 0`) while clipping at its border box
// (`overflow: hidden`). When those disagree the final row straddles the clip
// edge and renders as a half-height sliver — which is what cut the Claude Code
// status line ("bypass permissions on (shift+tab to cycle) …") in half.
//
// The old comment here claimed it subtracted a row to avoid exactly this, but
// the code never did. Rather than assume which way the arithmetic errs, measure
// what actually rendered and hand a row back only if it overflows: a no-op when
// the geometry already lines up, and it can never add a clipped row.
// A pane that just became visible can take a frame to lay out. Look again a
// few times, then stop — a pane that is still unmeasurable is genuinely hidden
// and does not need fitting.
const MAX_FIT_RETRIES = 3;

function safeFit(entry, _isRetry) {
  const dims = entry.fitAddon.proposeDimensions();
  if (!dims || !(dims.rows > 1)) {
    entry.fitAddon.fit();
    return;
  }

  const { rows, measured } = measurePaneRows(entry, dims.rows);

  if (!measured) {
    // We cannot see the pane, so we do not know what fits — and applying
    // proposeDimensions() on a guess is exactly what clips the last row, since
    // that is the overshooting number and nothing afterwards corrects it.
    // Switching sessions hits this: the incoming pane was display:none an
    // instant ago. Leave the size alone and look again.
    if (!_isRetry) entry._fitRetries = 0;   // a fresh attempt gets a fresh budget
    scheduleFitRetry(entry);
    return;
  }

  entry._fitRetries = 0;
  // xterm no-ops a resize to identical dimensions, so a fit that changes nothing
  // costs nothing — no PTY resize, no SIGWINCH, no repaint.
  entry.terminal.resize(dims.cols, rows);
}

function scheduleFitRetry(entry) {
  entry._fitRetries = (entry._fitRetries || 0) + 1;
  if (entry._fitRetries > MAX_FIT_RETRIES || entry._fitRetryQueued) return;
  entry._fitRetryQueued = true;
  requestAnimationFrame(() => {
    entry._fitRetryQueued = false;
    if (!entry.closed) safeFit(entry, true);
  });
}

/**
 * How many rows fit in the space the user can actually see.
 *
 * FitAddon.proposeDimensions() derives rows from the container's computed
 * height, and for `.terminal-container` that overshoots: the element carries
 * 8px of vertical padding and is pulled 5px above its parent by a negative top
 * inset (`inset: -5px 20px 0 0`), while `overflow: hidden` clips at its border
 * box. The last row then straddles the clip edge and renders as a half-height
 * sliver — which is what cut the "bypass permissions on …" status line in half.
 *
 * This measures the visible band directly instead of trying to model why the
 * proposal is wrong, so it stays correct regardless of the exact box-model
 * reasoning. Crucially it is SYNCHRONOUS and idempotent.
 *
 * The previous version corrected after the fact inside a requestAnimationFrame,
 * which looked equivalent but was not: proposeDimensions() kept returning the
 * uncorrected number, so every fit grew the terminal by a row and then shrank it
 * back. That is two PTY resizes and two full-screen TUI repaints per fit, on a
 * pane whose size had not changed — and with the WebGL renderer the repaints
 * could leave stale cells behind, which shows up as overlays (the slash-command
 * menu) drawn over remnants of earlier output.
 */
function measurePaneRows(entry, proposedRows) {
  const unmeasured = { rows: proposedRows, measured: false };

  const el = entry.terminal.element;
  const screen = el && el.querySelector('.xterm-screen');
  const clip = el && el.closest('.terminal-container');
  if (!screen || !clip) return unmeasured;

  const currentRows = entry.terminal.rows;
  const screenRect = screen.getBoundingClientRect();
  const cellHeight = currentRows > 0 ? screenRect.height / currentRows : 0;
  if (!(cellHeight > 0)) return unmeasured;        // not rendered yet

  // The screen's top edge does not move with the row count; the clip edge is the
  // container's border box, where overflow:hidden cuts.
  const visible = clip.getBoundingClientRect().bottom - screenRect.top;
  if (!(visible > 0)) return unmeasured;           // pane is hidden

  const maxRows = Math.floor(visible / cellHeight);
  return { rows: Math.max(2, Math.min(proposedRows, maxRows)), measured: true };
}

/** The row count alone. Kept as a named helper for tests and readability. */
function rowsThatActuallyFit(entry, proposedRows) {
  return measurePaneRows(entry, proposedRows).rows;
}

// Fit a terminal that just became visible (from display:none or reparent).
// Defers to requestAnimationFrame so the container has dimensions.
function fitAndScroll(entry) {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// --- Terminal write buffering ---
// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
const ESC_SYNC_START = '\x1b[?2026h';
const ESC_SYNC_END = '\x1b[?2026l';
const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
const terminalWriteBuffers = new Map(); // sessionId → { chunks, syncDepth, rafId, timerId }

function flushTerminalBuffer(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  const entry = openSessions.get(sessionId);
  if (!entry) return;

  const data = buf.chunks.join('');
  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    if (sessionId !== activeSessionId) return;
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    } else {
      // Restore scroll position so redraws don't yank the user away
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
  });
}

function scheduleFlush(sessionId, buf) {
  cancelAnimationFrame(buf.rafId);
  buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
}

// --- Terminal lifecycle helpers ---

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
function createTerminalEntry(session) {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: 10000,
    convertEol: true,
    allowProposedApi: true,
    // A TUI that turns on full mouse tracking (CSI ?1003h) makes xterm forward every
    // drag to the application, so normal text selection is dead. Terminal.app and
    // iTerm2 let you hold Option to override that; xterm.js requires opting in.
    // Without this, selecting (and therefore copying) inside such a session is
    // impossible on macOS and Cmd+C silently leaves the previous clipboard contents
    // in place. Windows/Linux get the same escape hatch via Shift, which needs no flag.
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do.
  // Route through the main process — see writeClipboard — because the renderer clipboard
  // is unreliable on Wayland.
  terminal.parser.registerOscHandler(52, (payload) => {
    let text;
    try {
      text = decodeOsc52Payload(payload);
    } catch {
      return false;
    }
    // null = read-back query or empty payload: consumed, and deliberately not
    // answered. See decodeOsc52Payload.
    if (text === null) return true;
    window.api.writeClipboard(text).catch(() => {});
    return true;
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  // Used to hand a session's full scrollback to another window when it is torn
  // off. Main's own replay buffer is a 256KB tail, so relying on it would
  // visibly truncate history on every move.
  const serializeAddon = new SerializeAddon.SerializeAddon();
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;

  // GPU-accelerated rendering via WebGL — drops renderer+compositor CPU ~50-70%.
  // Must be loaded after terminal.open() (needs attached DOM). Fails silently on
  // machines without WebGL support; xterm falls back to the default DOM renderer.
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch (e) {
    console.warn('[terminal] WebGL addon failed, falling back to DOM renderer', e);
  }

  // --- Terminal search bar (Cmd/Ctrl+F) ---
  const searchBar = document.createElement('div');
  searchBar.className = 'terminal-search-bar';
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  container.appendChild(searchBar);
  const searchInput = searchBar.querySelector('.terminal-search-input');
  const searchCount = searchBar.querySelector('.terminal-search-count');
  const searchOpts = { decorations: { matchBackground: '#515C6A', activeMatchBackground: '#EAA549', matchOverviewRuler: '#515C6A', activeMatchColorOverviewRuler: '#EAA549' } };

  function openSearchBar() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    const sel = terminal.getSelection();
    if (sel) { searchInput.value = sel; searchAddon.findNext(sel, searchOpts); }
  }
  function closeSearchBar() {
    searchBar.style.display = 'none';
    searchAddon.clearDecorations();
    searchInput.value = '';
    searchCount.textContent = '';
    terminal.focus();
  }
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (q) { searchAddon.findNext(q, searchOpts); } else { searchAddon.clearDecorations(); searchCount.textContent = ''; }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearchBar(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { searchAddon.findPrevious(searchInput.value, searchOpts); e.preventDefault(); }
    else if (e.key === 'Enter') { searchAddon.findNext(searchInput.value, searchOpts); e.preventDefault(); }
  });
  searchBar.querySelector('.terminal-search-next').addEventListener('click', () => searchAddon.findNext(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-prev').addEventListener('click', () => searchAddon.findPrevious(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-close').addEventListener('click', closeSearchBar);

  const entry = { terminal, element: container, fitAddon, searchAddon, serializeAddon, openSearchBar, closeSearchBar, session, closed: false };

  // Refit whenever the pane's box actually changes, instead of trying to guess
  // the right moment to measure.
  //
  // The callers that fit on demand — showSession, the file panel, the window
  // resize handler — all measure at a moment they hope is settled, and around a
  // session switch it is not. #terminal-header changes height when the PTY-title
  // span appears (onTitleChange arrives asynchronously), #terminals moves with
  // it, and a fit that lands while the header is short computes one row too
  // many. Measured live: the same window produced 46, 47 and 48 rows from
  // consecutive fits, and the final layout change happened after the last fit,
  // so the extra row stayed and its text was clipped by overflow:hidden.
  //
  // No feedback loop: the container is `position: absolute` with `inset`, so it
  // is sized by its offset parent, never by the terminal inside it. Resizing the
  // terminal cannot resize the container and re-trigger this.
  if (typeof ResizeObserver === 'function') {
    entry.resizeObserver = new ResizeObserver(() => {
      if (entry.closed) return;
      // Coalesce to one fit per frame; a drag emits a burst of these.
      if (entry._roFrame) cancelAnimationFrame(entry._roFrame);
      entry._roFrame = requestAnimationFrame(() => {
        entry._roFrame = null;
        if (!entry.closed) safeFit(entry);
      });
    });
    entry.resizeObserver.observe(container);
  }
  openSessions.set(sessionId, entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  return entry;
}

// The grid card count was written from four places with two different sources
// and not written at all by destroySession. One helper, one source of truth.
function updateGridCount() {
  if (typeof gridViewerCount === 'undefined' || !gridViewerCount) return;
  const n = gridCards.size;
  gridViewerCount.textContent = n + ' session' + (n !== 1 ? 's' : '');
}

// Drop this window's view of a session without touching the session itself.
//
// This is NOT destroySession: that sends close-terminal, which detaches the
// session in the main process. During a tear-off the destination window is
// already attached, so detaching here would pull the session out from under it.
// (main's close-terminal is owner-guarded too, but the source window should not
// be sending it at all.)
function teardownSessionView(sessionId, { notifyMain }) {
  const entry = openSessions.get(sessionId);
  if (!entry) return false;

  // A queued rAF/timeout flush would write into a disposed terminal, and its
  // buffered chunks would be lost either way. Drop it deliberately.
  const buf = terminalWriteBuffers.get(sessionId);
  if (buf) {
    clearTimeout(buf.timerId);
    cancelAnimationFrame(buf.rafId);
    terminalWriteBuffers.delete(sessionId);
  }

  if (notifyMain) window.api.closeTerminal(sessionId);

  // Put the container back where it belongs before removing it, so grid teardown
  // does not leave an orphaned card wrapper behind.
  const card = gridCards.get(sessionId);
  if (card) {
    if (card.parentNode && entry.element.parentNode === card) {
      card.parentNode.insertBefore(entry.element, card);
    }
    card.remove();
    gridCards.delete(sessionId);
  }

  // Stop observing before the element goes, or the observer keeps the detached
  // container (and the whole entry) alive.
  if (entry.resizeObserver) {
    try { entry.resizeObserver.disconnect(); } catch {}
    entry.resizeObserver = null;
  }
  if (entry._roFrame) { cancelAnimationFrame(entry._roFrame); entry._roFrame = null; }

  try { entry.terminal.dispose(); } catch {}
  entry.element.remove();
  openSessions.delete(sessionId);
  updateGridCount();
  return true;
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
function destroySession(sessionId) {
  return teardownSessionView(sessionId, { notifyMain: true });
}

// Hand this session's view over: same teardown, but the session stays attached
// (to whichever window is taking it).
function releaseSessionView(sessionId) {
  return teardownSessionView(sessionId, { notifyMain: false });
}

/**
 * The session's full xterm buffer as escape sequences, for replay in another
 * window. Returns '' when there is nothing to hand over, which the destination
 * treats as "fall back to main's replay buffer".
 */
function serializeSession(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry || !entry.serializeAddon) return '';
  try {
    // Flush anything buffered first, or the last chunk of output is missing
    // from the snapshot.
    flushTerminalBuffer(sessionId);
    return entry.serializeAddon.serialize();
  } catch (e) {
    console.warn('[tearoff] serialize failed, falling back to main replay', e);
    return '';
  }
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
function showSession(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);

  if (gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // New entry not yet in grid — wrap and focus
      wrapInGridCard(sessionId);
      fitAndScroll(entry);
      requestAnimationFrame(() => focusGridCard(sessionId));
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
  } else {
    // Single terminal view
    document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
    placeholder.style.display = 'none';
    hidePlanViewer();
    if (session) showTerminalHeader(session);
    if (entry) {
      entry.element.classList.add('visible');
      entry.terminal.focus();
      fitAndScroll(entry);
    }
  }
}

function setupDragAndDrop(container, getSessionId) {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const paths = Array.from(files).map(f => shellEscape(window.api.getPathForFile(f)));
    window.api.sendInput(getSessionId(), paths.join(' '));
  });
}

// Expose pure key-handling predicates to Node for unit testing. No-op in the
// browser, where this file is loaded as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isImeComposing, shouldSendSpaceDirectly, decodeOsc52Payload,
    safeFit, rowsThatActuallyFit };
}
