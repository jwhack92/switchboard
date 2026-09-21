const statusBarInfo = document.getElementById('status-bar-info');
const statusBarActivity = document.getElementById('status-bar-activity');
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
const plansContent = document.getElementById('plans-content');
const placeholder = document.getElementById('placeholder');
const archiveToggle = document.getElementById('archive-toggle');
const starToggle = document.getElementById('star-toggle');
const searchInput = document.getElementById('search-input');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const planViewer = document.getElementById('plan-viewer');
const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.savePlan(filePath, content),
});

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const memoryContent = document.getElementById('memory-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const memoryViewer = document.getElementById('memory-viewer');
const memoryPanel = new ViewerPanel(memoryViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.saveMemory(filePath, content),
});
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const resortBtn = document.getElementById('resort-btn');
const jsonlViewer = document.getElementById('jsonl-viewer');
const jsonlViewerTitle = document.getElementById('jsonl-viewer-title');
const jsonlViewerSessionId = document.getElementById('jsonl-viewer-session-id');
const jsonlViewerBody = document.getElementById('jsonl-viewer-body');
const gridViewer = document.getElementById('grid-viewer');
const gridViewerCount = document.getElementById('grid-viewer-count');
// sessionStorage: per-window. localStorage is shared across every window on
// this origin, so it made view mode a single app-wide flag.
let gridViewActive = sessionStorage.getItem('gridViewActive') === '1';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  // A session and a task log are two modes of the SAME pane, and
  // #terminal-stop-btn carries one handler per mode: this file's, guarded by
  // activeSessionId, and task-runner.js's, guarded by activeTaskView. That is
  // sound only while the two flags are mutually exclusive, so every route into
  // session mode has to clear the task one. showSession() does it for itself,
  // but it is not the only route: focusGridCard() (grid-view.js) makes a session
  // active straight from showGridView's rAF, from navigateGrid and from a click
  // on a grid card, and reaches this function without going through showSession.
  // Doing it here covers all of them. leaveTaskLogView is idempotent, so the
  // showSession path — which already called it — pays nothing.
  //
  // Only a REAL session id leaves the task view: showTaskLog sets activeTaskView
  // and then calls setActiveSession(null), which must not undo what it just set.
  if (id && typeof activeTaskView !== 'undefined' && activeTaskView) leaveTaskLogView();
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}
// Persist slug group expand state across reloads
function getExpandedSlugs() {
  try { return new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]')); } catch { return new Set(); }
}
function saveExpandedSlugs() {
  const expanded = [];
  document.querySelectorAll('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  sessionStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

// --- Multi-window state ---
// myWindowId is this renderer's BrowserWindow id. sessionOwners mirrors main's
// ownership map so the sidebar can show which sessions live in another window
// (and so a click there is understood as "bring it here", not "open a second
// view of it" — main enforces exclusivity either way).
let myWindowId = null;
let knownWindows = [];
const sessionOwners = new Map(); // sessionId → windowId | null

function ownerOf(sessionId) {
  const id = sessionOwners.get(sessionId);
  return id === undefined ? null : id;
}
function isOwnedElsewhere(sessionId) {
  const owner = ownerOf(sessionId);
  return owner != null && myWindowId != null && owner !== myWindowId;
}
window._isOwnedElsewhere = isOwnedElsewhere;
window._getMyWindowId = () => myWindowId;
window._getKnownWindows = () => knownWindows;

// Bridge functions for settings-panel.js
window._setVisibleSessionCount = (v) => { visibleSessionCount = v; };
window._setSessionMaxAge = (v) => { sessionMaxAgeDays = v; };
window._applyTerminalTheme = (themeName) => {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
};
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let searchMatchProjectPaths = null; // Set<string> of project paths matched by name

// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)

// Central activity dispatcher
function setActivity(sessionId, active) {
  // response-ready normally stays latched until the user looks at the session.
  // A fresh busy signal is stronger evidence, though: the session is plainly
  // working again, so it must be able to go straight back to running.
  //
  // This mattered only once the OSC 0 spinner range was fixed (main.js). While
  // busy never fired, nothing could reach the latch; now that it does, without
  // this a session that finished a turn, latched response-ready, and then
  // started working again would sit showing "response ready" the whole time.
  if (active && responseReadySessions.has(sessionId)) {
    responseReadySessions.delete(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.remove('response-ready');
  }

  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  // Idle → busy on the focused session: start the summarizer now so its ~4s
  // startup overlaps the work rather than delaying the spoken reply.
  if (!wasActive && active && sessionId === activeSessionId && window.speech) {
    window.speech.warmUp();
  }

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      responseReadySessions.add(sessionId);
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
      // A session you are not looking at gets a short alert.
      if (window.speech) window.speech.announceFinished(sessionId, speechNameFor(sessionId));
    } else if (window.speech) {
      // The focused session gets the reply itself, read from the transcript.
      window.speech.speakReply(sessionId);
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('response-ready');
  }
}

// User-initiated: put a session back into the response-ready state, as if
// Claude had just finished a turn the user hasn't looked at yet. Mirrors the
// busy→idle transition in setActivity so the sidebar re-renders consistently.
function markUnread(sessionId) {
  if (responseReadySessions.has(sessionId)) return;
  responseReadySessions.add(sessionId);
  sessionBusyState.set(sessionId, false);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('cli-busy');
    item.classList.add('response-ready');
  }
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);
    recordRaw(sessionId, data);   // no-op unless __rawStart() was called

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) buf.syncDepth++;
    if (data.includes(ESC_SYNC_END)) buf.syncDepth = Math.max(0, buf.syncDepth - 1);

    if (buf.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(buf.rafId);
      if (!buf.timerId) {
        buf.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(buf.timerId);
      buf.timerId = 0;
      scheduleFlush(sessionId, buf);
    }
  }
});

// A session's id can change under us (fork, plan-accept). Several maps are
// keyed by it, and gridCards / terminalWriteBuffers were being missed — leaving
// an orphan card that showed "Stopped" with no Stop button and could not be
// destroyed, plus a write buffer whose queued flush wrote nowhere.
function rekeySessionMaps(oldId, newId) {
  if (oldId === newId) return;
  const card = gridCards.get(oldId);
  if (card) {
    card.dataset.sessionId = newId;
    gridCards.delete(oldId);
    gridCards.set(newId, card);
  }
  const buf = terminalWriteBuffers.get(oldId);
  if (buf) {
    terminalWriteBuffers.delete(oldId);
    terminalWriteBuffers.set(newId, buf);
  }
  if (sessionOwners.has(oldId)) {
    sessionOwners.set(newId, sessionOwners.get(oldId));
    sessionOwners.delete(oldId);
  }
  for (const set of [attentionSessions, responseReadySessions]) {
    if (set.has(oldId)) { set.delete(oldId); set.add(newId); }
  }
  if (sessionBusyState.has(oldId)) {
    sessionBusyState.set(newId, sessionBusyState.get(oldId));
    sessionBusyState.delete(oldId);
  }
  if (gridFocusedSessionId === oldId) gridFocusedSessionId = newId;
}

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);
  rekeySessionMaps(tempId, realId);

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);
  rekeySessionMaps(oldId, newId);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode, signal, userStopped) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) entry.closed = true;

  const intentional = wasIntentionalExit({ exitCode, signal, userStopped });

  // A Claude session that died stays mounted behind an exit banner so the user
  // can read the error it printed (claude / devbox / shell stderr) — without
  // this, a fast-failing pre-launch command tears the terminal down before the
  // error is readable. Cleanup is deferred to openSession, which destroys the
  // closed entry when the user re-clicks the session. The sidebar row stays
  // put too, so there's somewhere to relaunch from.
  if (session?.type !== 'terminal' && !intentional) {
    if (entry) {
      try {
        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        entry.terminal.write(`\r\n\x1b[33m── session exited (${reason}) ──\x1b[0m\r\n`);
      } catch {}
    }
    // A pending session that died never wrote a .jsonl, so loadProjects keeps
    // re-injecting it. Mark it dead so it stops sorting as a running session.
    const pending = pendingSessions.get(sessionId);
    if (pending) pending.exited = true;
    if (gridViewActive) updateGridCount();
    pollActiveSessions();
    return;
  }

  // Everything else — plain terminals (always ephemeral) and Claude sessions
  // the user ended themselves — goes away.
  if (entry) destroySession(sessionId);
  if (gridViewActive) {
    updateGridCount();
  } else if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }

  // Drop the sidebar row for sessions with nothing to reopen: plain terminals,
  // and Claude sessions still pending (no .jsonl was ever written). A session
  // that produced real data keeps its row and reloads from the DB.
  if (session?.type === 'terminal' || pendingSessions.has(sessionId)) {
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    // The pending marker can outlive the .jsonl by a beat (reconciliation only
    // runs in loadProjects), so re-sync: a session that did write real data
    // gets its row back from the DB rather than vanishing until the next watch.
    if (session?.type !== 'terminal') loadProjects();
  }

  pollActiveSessions();
});

// ── Session tear-off (see session-drag.js for the gesture) ──────────────

// This window is taking over a session. The PTY never moved — only the view. A
// live xterm cannot cross BrowserWindows, so we build a fresh one and paint it
// from the serialized buffer the source window handed over, then attach with
// skipReplay so main does not also replay its 256KB tail on top.
window.api.onAdoptSession(async ({ sessionId, serialized, projectPath }) => {
  try {
    // The session may not be in this window's sidebar at all, so resolve its
    // metadata from main rather than from the local sessionMap.
    let session = sessionMap.get(sessionId);
    if (!session) {
      const meta = await window.api.getSessionMeta(sessionId);
      if (!meta) return;
      session = {
        sessionId,
        projectPath: meta.projectPath || projectPath,
        type: meta.isPlainTerminal ? 'terminal' : undefined,
        modified: new Date().toISOString(),
        summary: '',
      };
      sessionMap.set(sessionId, session);
    }

    if (openSessions.has(sessionId)) releaseSessionView(sessionId);

    const entry = createTerminalEntry(session);
    if (serialized) {
      // Written before attaching so the live stream lands after the history.
      try { entry.terminal.write(serialized); } catch (e) { console.warn('[tearoff] replay failed', e); }
    }

    const result = await window.api.openTerminal(
      sessionId, session.projectPath, false, { skipReplay: !!serialized });
    if (!result || !result.ok) {
      entry.terminal.write(`\r\nError adopting session: ${result && result.error}\r\n`);
      entry.closed = true;
      return;
    }
    if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

    sessionOwners.set(sessionId, myWindowId);
    showSession(sessionId);
    // The session is probably not in this window's sidebar yet.
    loadProjects();
    pollActiveSessions();
  } catch (e) {
    console.error('[tearoff] adopt failed', e);
  }
});

// Another window has taken this session. Drop our view WITHOUT close-terminal —
// the new owner is already attached, and detaching would pull it out from under
// them.
window.api.onReleaseSession((sessionId) => {
  if (!openSessions.has(sessionId)) return;
  const wasActive = activeSessionId === sessionId;
  releaseSessionView(sessionId);
  sessionOwners.delete(sessionId);
  if (wasActive) {
    setActiveSession(null);
    if (!gridViewActive) {
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
  }
  refreshSidebar();
  updateRunningIndicators();
});

window.api.onSessionOwnerChanged(({ sessionId, windowId }) => {
  if (windowId == null) sessionOwners.delete(sessionId);
  else sessionOwners.set(sessionId, windowId);
  updateRunningIndicators();
});

window.api.onWindowsChanged((windows) => {
  knownWindows = Array.isArray(windows) ? windows : [];
});

// Highlight this window as a drop target while a session is dragged over it.
window.api.onSessionDragHover(({ hoverWindowId, sourceWindowId, mode }) => {
  const isTarget = hoverWindowId != null && hoverWindowId === myWindowId && myWindowId !== sourceWindowId;
  document.body.classList.toggle('session-drop-target', !!isTarget);
  if (mode === 'none' || hoverWindowId == null) {
    // Nothing to show here.
  }
});

// --- Speech: naming and the status-bar toggle ---

// What a session is called out loud. The sidebar title identifies a session best
// ("Review Pass"), the slug identifies its project ("pr-review"); prefer the
// title and fall back to the slug. Capped because a session that was never
// renamed is titled with its whole first prompt, and reading that aloud is not
// an announcement.
const SPOKEN_NAME_MAX = 48;
function speechNameFor(sessionId) {
  const session = sessionMap.get(sessionId);
  if (!session) return 'a session';
  const raw = cleanDisplayName(session.name || session.aiTitle || session.summary) || session.slug;
  if (!raw) return 'a session';
  const name = String(raw).trim();
  if (name.length <= SPOKEN_NAME_MAX) return name;
  const cut = name.slice(0, SPOKEN_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 16 ? cut.slice(0, lastSpace) : cut).trim();
}

const speechEl = document.getElementById('status-bar-speech');

function renderSpeechControl() {
  if (!speechEl) return;
  const available = !!(window.tts && window.tts.isAvailable());
  const on = available && window.speech && window.speech.isEnabled();

  const btn = document.createElement('button');
  btn.className = 'stop-btn' + (on ? ' speech-on' : '');
  btn.textContent = on ? 'Voice on' : 'Voice off';
  btn.title = available
    ? (on ? 'Speaking alerts for background sessions. Click to silence.'
          : 'Click to speak alerts for background sessions.')
    : 'Speech synthesis is unavailable in this build';
  btn.disabled = !available;
  btn.addEventListener('click', () => {
    if (!window.speech) return;
    window.speech.setEnabled(!window.speech.isEnabled());
    renderSpeechControl();
    if (typeof refreshSidebar === 'function') refreshSidebar();
  });
  speechEl.replaceChildren(btn);
}

// Voices arrive about a second after load and the button's enabled state depends
// on them, so render once now and again once the list settles.
if (window.tts) {
  renderSpeechControl();
  window.tts.loadVoices().then(renderSpeechControl).catch(() => {});
}

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
    if (window.speech) window.speech.announceAttention(sessionId, speechNameFor(sessionId), message);
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  if (searchMatchIds !== null) {
    projects = projects.map(p => {
      const hasMatchingSessions = p.sessions.some(s => searchMatchIds.has(s.sessionId));
      const projectMatched = searchMatchProjectPaths && searchMatchProjectPaths.has(p.projectPath);
      if (!hasMatchingSessions && !projectMatched) return null;
      return {
        ...p,
        sessions: hasMatchingSessions ? p.sessions.filter(s => searchMatchIds.has(s.sessionId)) : [],
        _projectMatchedOnly: projectMatched && !hasMatchingSessions,
      };
    }).filter(Boolean);
  }

  renderProjects(projects, resort);
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  refreshSidebar({ resort: true });
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  if (showStarredOnly) { showRunningOnly = false; runningToggle.classList.remove('active'); }
  starToggle.classList.toggle('active', showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  showRunningOnly = !showRunningOnly;
  if (showRunningOnly) { showStarredOnly = false; starToggle.classList.remove('active'); }
  runningToggle.classList.toggle('active', showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  showTodayOnly = !showTodayOnly;
  todayToggle.classList.toggle('active', showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Global settings gear button ---
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', () => {
  openSettingsViewer('global');
});

// --- Add project button ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

// --- Search (debounced, per-tab FTS) ---
let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');
const searchTitlesToggle = document.getElementById('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  // Toggle clear button visibility
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    try {
      if (activeTab === 'sessions') {
        const results = await window.api.search('session', query, searchTitlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        // When title-only, also match project names
        searchMatchProjectPaths = null;
        if (searchTitlesOnly) {
          const lowerQ = query.toLowerCase();
          for (const p of cachedAllProjects) {
            const shortName = shortProjectPath(p.projectPath);
            if (shortName.toLowerCase().includes(lowerQ)) {
              if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
              searchMatchProjectPaths.add(p.projectPath);
            }
          }
        }
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'memory') {
        const results = await window.api.search('memory', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (activeTab === 'sessions') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
/**
 * A row for a session that never produced a transcript, and is not running.
 *
 * These exist so a session that died on launch can be relaunched or read, but
 * nothing on disk backs them — so nothing else can ever clear them, and without
 * a way out they sit in the sidebar for good.
 */
function isDismissibleSession(sessionId) {
  return pendingSessions.has(sessionId) && !activePtyIds.has(sessionId);
}

/**
 * Drop such a row. Purely renderer state, so it cannot come back.
 *
 * Fork note: this window only. With multi-window tear-off another window still
 * shows the row until its own sidebar is refreshed — cosmetic, since nothing on
 * disk backs it either way, but upstream never had to consider it.
 */
function dismissSession(sessionId) {
  pendingSessions.delete(sessionId);
  sessionMap.delete(sessionId);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    for (const proj of projList) {
      proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
    }
  }
  if (openSessions.has(sessionId)) destroySession(sessionId);
  if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  attentionSessions.delete(sessionId);
  responseReadySessions.delete(sessionId);
  refreshSidebar();
}

async function confirmAndStopSession(sessionId) {
  if (!confirm('Stop this session?')) return;
  await window.api.stopSession(sessionId);
  activePtyIds.delete(sessionId);
  if (!gridViewActive && activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  refreshSidebar();
}

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
// Adaptive cadence: poll fast (3s) only while PTYs are running; when idle, back
// off to 30s. Every renderer path that starts a session (launchNewSession,
// openSession, launchTerminalSession, onSessionDetected/Forked) calls
// pollActiveSessions() explicitly, which re-arms the fast cadence immediately.
// The 30s idle floor still catches sessions started outside the renderer
// (scheduler-spawned PTYs, other windows) within at most 30s.
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;
let pollTimer = null;

function scheduleActiveSessionsPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(pollActiveSessions, delay);
}

async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
  scheduleActiveSessionsPoll();
}

function updateRunningIndicators() {
  document.querySelectorAll('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    const running = activePtyIds.has(id);
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
      attentionSessions.delete(id);
      responseReadySessions.delete(id);
      sessionBusyState.delete(id);
    }
    const dot = item.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  });
  // Update slug group running dots
  document.querySelectorAll('.slug-group').forEach(group => {
    const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
    const dot = group.querySelector('.slug-group-dot');
    if (dot) dot.classList.toggle('running', hasRunning);
  });
  // Update grid card dots and status text
  for (const [sid, card] of gridCards) {
    const running = activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const dot = card.querySelector('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : (running ? 'running' : 'stopped'));
    const footer = card.querySelector('.grid-card-footer');
    if (footer) footer.children[0].textContent = running ? 'Running' : 'Stopped';
    const stopBtn = card.querySelector('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');

function updatePtyTitle() {
  if (!activeSessionId || !terminalHeaderPtyTitle) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  terminalHeaderPtyTitle.textContent = title;
  terminalHeaderPtyTitle.style.display = title ? '' : 'none';
}

scheduleActiveSessionsPoll();

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  for (const [sessionId, session] of sessionMap) {
    if (!session.modified) continue;
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const timeEl = item.querySelector('.session-time');
    if (!timeEl) continue;
    const msgSuffix = session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    timeEl.textContent = formatDate(new Date(session.modified)) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects({ resort = false } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty) {
    loadingStatus.textContent = 'Loading\u2026';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  // task-runner.js builds each project's task button out of project.tasks /
  // .taskError / .hasTaskFile, and only hydrateProjectTasks ever sets them. It
  // has to run BEFORE the render, not after: renderProjects reads those fields
  // synchronously while building the header, and a later hydration would leave
  // the badge stale until the next unrelated refresh. Both lists are passed
  // because getProjects(false) and getProjects(true) return distinct project
  // objects (dedup() shares sessions between them, not the projects).
  // It swallows its own IPC failure, so a missing handler costs the task
  // buttons their data and never the sidebar.
  if (typeof hydrateProjectTasks === 'function') await hydrateProjectTasks([cachedProjects, cachedAllProjects]);
  refreshSidebar({ resort });
  renderDefaultStatus();
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

async function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  terminalHeaderName.textContent = displayName;
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Show active shell profile
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      terminalHeaderShell.style.display = 'none';
    } else {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      terminalHeaderShell.textContent = profile ? profile.name : profileId;
      terminalHeaderShell.style.display = '';
    }
  } catch {
    terminalHeaderShell.style.display = 'none';
  }
}

// Every call into the task runner from this file and from sidebar.js is
// typeof-guarded, because task-runner.js is a separate classic script
// (index.html:154) and a sidebar that throws mid-render is worse than a missing
// button. The cost of that is that the feature can go quietly inert again —
// which is exactly how it shipped in the first place, reachable from nowhere.
// So check the entry points once, at load, and say so if they are gone. Top-
// level function declarations in a classic script land on `window`, so this
// sees them; it runs after task-runner.js has been evaluated.
for (const entryPoint of ['createProjectTaskButton', 'showTaskPopover', 'hydrateProjectTasks', 'restoreActiveTaskView', 'leaveTaskLogView']) {
  if (typeof window[entryPoint] !== 'function') {
    console.error(`[task] ${entryPoint}() is missing — the project task runner is not wired up`);
  }
}

// The extension point showTaskLog() calls (`if (typeof onTaskLogShown ===
// 'function')`, task-runner.js). A task log is a single full-width pane, but
// showTaskLog only hides #grid-viewer — it leaves #terminals in .grid-layout, so
// in grid mode the log would be laid out as one more cell beside the very
// sessions it is meant to replace, at whatever width the column happens to be.
// hideGridView() unwraps the cards and drops the layout class. The reverse
// direction needs nothing here: showGridView() already removes .visible from
// every .terminal-container, the task log's container included.
function onTaskLogShown() {
  if (gridViewActive) hideGridView();
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function openSession(session, customOptions) {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = customOptions || await resolveDefaultSessionOptions({ projectPath });
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  // Relaunching a session that had died clears the dead marker on its pending entry
  const pending = pendingSessions.get(sessionId);
  if (pending) pending.exited = false;

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    safeFit(entry);
  }
});

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (tabName === activeTab) return;
    activeTab = tabName;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;
    searchMatchProjectPaths = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      // Restore terminal area
      hideAllViewers();
      if (gridViewActive) {
        // Grid is still set up — just re-show it and refit
        placeholder.style.display = 'none';
        terminalHeader.style.display = 'none';
        gridViewer.style.display = 'block';
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search plans...';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'memory') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search agent files...';
      memoryContent.style.display = '';
      loadMemories();
    }
  });
});

// Plans & viewer helpers → plans-memory-view.js


// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();

// JSONL viewer (renderJsonlText, formatDuration, makeCollapsible, renderJsonlEntry, showJsonlViewer) → jsonl-viewer.js

// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Memory viewer → plans-memory-view.js


// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// --- Sidebar toggle ---
{
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');

  collapseBtn.addEventListener('click', () => sidebar.classList.add('collapsed'));
  expandBtn.addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

// --- Sidebar resize ---
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      safeFit(entry);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// --- Grid view toggle button (next to resort button in sidebar filters) ---
{
  const gridToggleBtn = document.createElement('button');
  gridToggleBtn.id = 'grid-toggle-btn';
  gridToggleBtn.title = 'Session overview';
  gridToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
  gridToggleBtn.addEventListener('click', toggleGridView);
  // Insert next to the resort button
  resortBtn.parentElement.insertBefore(gridToggleBtn, resortBtn);

  const newWindowBtn = document.createElement('button');
  newWindowBtn.id = 'new-window-btn';
  newWindowBtn.title = 'New window (Ctrl/Cmd+Shift+N)';
  newWindowBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="13" height="12" rx="2"></rect><path d="M8 21h11a2 2 0 0 0 2-2V9"></path></svg>';
  newWindowBtn.addEventListener('click', () => window.api.newWindow());
  resortBtn.parentElement.insertBefore(newWindowBtn, gridToggleBtn);

  // Global keyboard shortcuts (covers non-terminal focus)
  // When a terminal is focused, xterm's customKeyEventHandler fires first and sets
  // e._handled to prevent the document listener from double-firing the same action.
  document.addEventListener('keydown', (e) => {
    if (e._handled) return;
    // Cmd/Ctrl+Shift+G → toggle grid view
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleGridView();
      return;
    }
    // Cmd/Ctrl+Shift+N → new window
    if (e.key === 'n' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      window.api.newWindow();
      return;
    }
    // Cmd/Ctrl+Shift+O → tear the active session off into its own window
    if (e.key === 'o' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (activeSessionId && openSessions.has(activeSessionId)) {
        const serialized = serializeSession(activeSessionId);
        window.api.moveSession(activeSessionId, null, serialized);
      }
      return;
    }
    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    handleSessionNavKey(e);
  });
}

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon.FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting('global');
  if (global) {
    if (global.sidebarWidth) {
      document.getElementById('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.uiScale && typeof window.api.setZoomFactor === 'function') {
      window.api.setZoomFactor(global.uiScale);
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
  }
})();

// Learn our own window id before anything that depends on ownership renders.
// A window that does not know its own id cannot tell "my session" from "a
// session another window is showing", and would happily steal it back.
const windowIdentityReady = (async () => {
  try {
    const info = await window.api.getWindowInfo();
    myWindowId = info && info.windowId != null ? info.windowId : null;
    knownWindows = (info && info.windows) || [];
    const owners = await window.api.getSessionOwners();
    for (const [sid, wid] of Object.entries(owners || {})) sessionOwners.set(sid, wid);
  } catch (e) {
    console.warn('[windows] could not resolve window identity', e);
  }
})();

initSessionDrag();

Promise.all([loadProjects(), windowIdentityReady]).then(() => {
  updateRunningIndicators();
  // Restore grid view preference before opening sessions so they enter grid mode
  if (sessionStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
  // Restore active session after reload — but never one another window is
  // currently displaying, or a reload here would silently steal it from there.
  if (activeSessionId && !openSessions.has(activeSessionId)) {
    if (isOwnedElsewhere(activeSessionId)) {
      setActiveSession(null);
    } else {
      const session = sessionMap.get(activeSessionId);
      if (session) openSession(session);
    }
  }
  // Reattach to the task log this window was showing before the reload. It runs
  // after the session restore above and returns early when activeSessionId is
  // set, so a restored session always wins the pane; it also needs the task
  // hydration loadProjects() just awaited, or findProject() would not know the
  // saved label and it would silently decline to restore anything.
  if (typeof restoreActiveTaskView === 'function') {
    Promise.resolve(restoreActiveTaskView()).catch(e => console.warn('[task] could not restore task log', e));
  }
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    loadProjects();
  }, 300);
});

// Status bar
let activityTimer = null;

function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  statusBarInfo.textContent = parts.join(' \u00b7 ');
}

window.api.onStatusUpdate((text, type) => {
  if (activityTimer) clearTimeout(activityTimer);
  statusBarActivity.textContent = text;
  statusBarActivity.className = type === 'done' ? 'status-done' : '';
  if (!text || type === 'done') {
    activityTimer = setTimeout(() => {
      statusBarActivity.textContent = '';
      statusBarActivity.className = '';
    }, type === 'done' ? 3000 : 0);
  }
});

// --- Auto-update status + toast ---
const statusBarUpdater = document.getElementById('status-bar-updater');
let updaterStatusTimer = null;
function setUpdaterStatus(text, duration) {
  if (updaterStatusTimer) clearTimeout(updaterStatusTimer);
  statusBarUpdater.textContent = text;
  if (duration) {
    updaterStatusTimer = setTimeout(() => { statusBarUpdater.textContent = ''; }, duration);
  }
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Downloading v${data.version}…`);
      break;
    case 'update-not-available':
      setUpdaterStatus('Up to date', 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = document.getElementById('update-toast');
      const msg = document.getElementById('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/doctly/switchboard/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
      toast.classList.remove('hidden');
      document.getElementById('update-restart-btn').onclick = () => window.api.updaterInstall();
      document.getElementById('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version);
      };
      break;
    }
    case 'error':
      setUpdaterStatus('Update check failed', 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Quota gauges in status bar ---
// One bar per limit window the usage API reports — a 5-hour session window, a
// weekly all-models window, and a weekly window per model. Which one bites
// first varies, and the 5-hour is usually the emptiest while resetting within
// the day, so showing a single window would read as "plenty left" while a
// weekly one is the one actually running out. Rows come from the API
// self-describing, so a newly launched model gets a bar without a code change.
const quotaGaugeEl = document.getElementById('status-bar-quota');

// Full labels ("Week (all models)") are too long for a status bar; the tooltip
// carries them in full.
function shortQuotaLabel(row) {
  if (row.kind === 'session') return '5h';
  if (row.kind === 'weekly_all') return 'Week';
  return row.model || 'Week';
}

function buildQuotaBar(row) {
  const wrap = document.createElement('span');
  wrap.className = 'quota-item';

  const label = document.createElement('span');
  label.className = 'quota-label';
  label.textContent = shortQuotaLabel(row);
  wrap.appendChild(label);

  const track = document.createElement('span');
  track.className = 'quota-track';
  const fill = document.createElement('span');
  const pct = row.percent;
  fill.className = 'quota-fill' + (pct >= 80 ? ' quota-high' : pct >= 60 ? ' quota-mid' : '');
  fill.style.width = Math.min(Math.max(pct, 1), 100) + '%';
  track.appendChild(fill);
  wrap.appendChild(track);

  const pctEl = document.createElement('span');
  pctEl.className = 'quota-pct';
  pctEl.textContent = pct + '%';
  wrap.appendChild(pctEl);

  wrap.title = `${row.label}: ${pct}%` + (row.reset ? ` \u2014 resets ${row.reset}` : '');
  return wrap;
}

// Non-quota chips that sit alongside the bars: things the account cannot be
// seen anywhere else on this machine when the member dashboard is unavailable.
function buildStateChip({ text, title, tone }) {
  const el = document.createElement('span');
  el.className = 'quota-chip' + (tone ? ' quota-chip-' + tone : '');
  el.textContent = text;
  el.title = title || text;
  return el;
}

function billingChips(usage) {
  const chips = [];
  const b = usage && usage.billing;

  if (usage && usage._verdict === 'unknown') {
    chips.push(buildStateChip({
      text: usage._reason === 'http_429' ? 'usage: rate limited' : 'usage: unknown',
      title: `Usage could not be read (${usage._reason || 'unknown'}). `
        + 'Treated as unknown, never as 0% used.',
      tone: 'warn',
    }));
  }

  if (b && b.canBill) {
    // extra_usage.is_enabled === true means crossing the plan limit bills
    // rather than blocking. Worth stating plainly and permanently.
    chips.push(buildStateChip({
      text: b.capVisible ? 'overage: capped' : 'overage: uncapped',
      title: b.capVisible
        ? `Extra usage is on, with a visible limit (${b.caps.join(', ')}).`
        : 'Extra usage is ON and no spend limit is visible on this account, so '
          + 'crossing the plan limit bills rather than blocking. '
          + (b.canToggle ? '' : 'This member cannot turn it off. ')
          + (b.dashboardAvailable ? '' : 'This member cannot see what was billed.'),
      tone: b.capVisible ? 'ok' : 'bad',
    }));
  }

  if (usage && usage.tokenExpiresAtMs) {
    const leftMs = usage.tokenExpiresAtMs - Date.now();
    if (leftMs < 45 * 60 * 1000) {
      chips.push(buildStateChip({
        text: leftMs <= 0 ? 'token expired' : `token ${Math.max(1, Math.round(leftMs / 60000))}m`,
        title: leftMs <= 0
          ? 'The Claude credentials on this machine have expired; usage cannot be read '
            + 'until the CLI refreshes them.'
          : 'Time left on the current access token. Usage reads stop working when it expires.',
        tone: leftMs <= 0 ? 'bad' : 'warn',
      }));
    }
  }

  if (usage && usage.schemaChanged) {
    chips.push(buildStateChip({
      text: 'usage schema changed',
      title: 'The usage response changed shape. Percentages may refer to different '
        + 'limits than before — worth a look before trusting them.',
      tone: 'warn',
    }));
  }

  return chips;
}

async function refreshQuotaGauge() {
  try {
    const usage = await window.api.getUsage();
    // Prefer the API's self-describing rows; fall back to the flat 5-hour keys.
    const rows = Array.isArray(usage?.limits) && usage.limits.length
      ? usage.limits
      : (usage?.session !== undefined
        ? [{ kind: 'session', label: 'Current session', percent: usage.session, reset: usage.sessionReset }]
        : []);
    const chips = billingChips(usage);

    // get-usage deliberately reports "I don't know" rather than "0% used", and
    // the renderer used to throw that away and hide the whole bar. A rate limit
    // then looked exactly like a broken feature — which is how it was reported.
    if (usage && usage._verdict === 'unknown') {
      showQuotaUnavailable(usage);
      return;
    }

    if (!rows.length && !chips.length) { quotaGaugeEl.style.display = 'none'; return; }

    quotaGaugeEl.replaceChildren(...rows.map(buildQuotaBar), ...chips);
    quotaGaugeEl.style.display = '';
  } catch (err) {
    // Never fail silently here. A status bar that simply vanishes is
    // indistinguishable from one that broke.
    showQuotaUnavailable({ _reason: 'exception', _detail: err && err.message });
  }
}

// Why the numbers are missing, in the few words a status bar has room for.
function quotaUnavailableText(usage) {
  switch (usage && usage._reason) {
    case 'http_429': return 'usage rate limited';
    case 'http_401': return 'usage sign-in expired';
    case 'no_token': return 'usage no credentials';
    case 'network':  return 'usage offline';
    default:         return 'usage unavailable';
  }
}

function showQuotaUnavailable(usage) {
  if (!quotaGaugeEl) return;
  const retry = usage && usage.retryAfterSeconds;
  const title = [
    'Usage could not be read, so no number is shown rather than a stale one.',
    usage && usage._reason ? 'Reason: ' + usage._reason + '.' : '',
    usage && usage._detail ? usage._detail + '.' : '',
    retry ? 'Retrying in about ' + retry + 's.' : 'Retries every 5 minutes.',
  ].filter(Boolean).join(' ');

  quotaGaugeEl.replaceChildren(buildStateChip({
    text: quotaUnavailableText(usage),
    title,
    tone: 'warn',
  }));
  quotaGaugeEl.style.display = '';
}
refreshQuotaGauge();
setInterval(refreshQuotaGauge, 5 * 60 * 1000);

// --- Global stop control -------------------------------------------------
//
// Stops every scheduled Claude task and kills any that are running. The state
// lives in a file (%LOCALAPPDATA%\switchboard-driver\HALT), so it survives a
// restart and can be set by something other than this button — a script, or a
// synced folder from a phone. That is the point of a kill switch: it must not
// depend on this window being responsive.
const stopEl = document.getElementById('status-bar-stop');

let stopState = { halted: { halted: false, reason: null }, degraded: false, survivors: [] };
// A short-lived line describing what the last action actually did. Without
// this, pressing Stop with nothing running produces no visible effect beyond
// the banner, which reads as an unresponsive control.
let stopOutcome = null;   // { text, tone, untilMs }
let stopOutcomeTimer = null;

function setStopOutcome(text, tone) {
  stopOutcome = { text, tone, untilMs: Date.now() + 7000 };
  if (stopOutcomeTimer) clearTimeout(stopOutcomeTimer);
  stopOutcomeTimer = setTimeout(() => { stopOutcome = null; renderStopControl(); }, 7000);
}

function renderStopControl() {
  if (!stopEl) return;
  const halted = !!(stopState.halted && stopState.halted.halted);
  stopEl.replaceChildren();
  stopEl.classList.toggle('is-stopped', halted);

  const outcome = (stopOutcome && stopOutcome.untilMs > Date.now()) ? stopOutcome : null;

  if (!halted) {
    // Deliberately quiet. It is always available, but it is not the thing you
    // should be looking at when nothing is wrong.
    const btn = document.createElement('button');
    btn.id = 'stop-tasks-btn';
    btn.className = 'stop-btn';
    btn.textContent = 'Stop tasks';
    btn.title = 'Stop all scheduled Claude tasks and kill any that are running.\n'
      + 'Survives a restart until you resume it.';
    btn.addEventListener('click', engageStop);
    stopEl.appendChild(btn);
    if (outcome) stopEl.appendChild(buildStopOutcome(outcome));
    return;
  }

  const label = document.createElement('span');
  label.className = 'stop-banner';
  label.textContent = 'Scheduled tasks stopped';
  // Say *why* on the surface. A stop that outlives the session that set it is
  // otherwise a mystery on the next launch.
  if (stopState.halted.reason && stopState.halted.reason !== 'stopped from the status bar') {
    label.textContent += ` \u00b7 ${stopState.halted.reason}`;
  }
  label.title = stopState.halted.reason
    ? `Reason: ${stopState.halted.reason}`
    : 'A global stop is in force.';
  stopEl.appendChild(label);

  // A process we could not kill is the one case that has to be loud — the
  // alternative is reporting a clean stop while something is still running.
  if (stopState.degraded && (stopState.survivors || []).length) {
    const warn = document.createElement('span');
    warn.className = 'stop-banner stop-banner-degraded';
    warn.textContent = `${stopState.survivors.length} survived`;
    warn.title = 'These processes did not die and are still running:\n'
      + stopState.survivors.map(s => `pid ${s.pid}${s.commandLine ? ' — ' + s.commandLine : ''}`).join('\n');
    stopEl.appendChild(warn);
  }

  const resume = document.createElement('button');
  resume.className = 'stop-btn stop-btn-resume';
  resume.textContent = 'Resume';
  resume.title = 'Let scheduled tasks run again.';
  resume.addEventListener('click', clearStop);
  stopEl.appendChild(resume);

  if (outcome) stopEl.appendChild(buildStopOutcome(outcome));
}

function buildStopOutcome(outcome) {
  const el = document.createElement('span');
  el.className = 'stop-outcome' + (outcome.tone ? ' stop-outcome-' + outcome.tone : '');
  el.textContent = outcome.text;
  el.title = outcome.text;
  return el;
}

async function engageStop() {
  // No confirmation on the way in. A stop control that asks "are you sure" is a
  // worse stop control, and the action is recoverable via Resume.
  const btn = document.getElementById('stop-tasks-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping\u2026'; }

  // Read the registry immediately before halting, so the outcome line can be
  // specific about what was actually killed rather than guessing from a cached
  // count. One extra round-trip on a click nobody makes often.
  let wasRunning = 0;
  try {
    const pre = await window.api.getDriverStatus();
    wasRunning = (pre && pre.children ? pre.children : []).length;
  } catch { wasRunning = -1; }

  let res;
  try {
    res = await window.api.haltDriver('stopped from the status bar');
    if (res && res.degraded) {
      stopState = { ...stopState, degraded: true, survivors: res.survivors || [] };
    }
  } catch (err) {
    console.error('[stop] halt failed:', err);
    setStopOutcome('stop failed \u2014 see console', 'bad');
    if (btn) { btn.disabled = false; btn.textContent = 'Stop tasks'; }
    renderStopControl();
    return;
  }

  const survivors = (res && res.survivors ? res.survivors : []).length;
  if (survivors) {
    setStopOutcome(`${survivors} process(es) would not die`, 'bad');
  } else if (wasRunning < 0) {
    setStopOutcome('stopped', 'ok');
  } else if (wasRunning === 0) {
    // The common case, and the one that previously looked like a no-op.
    setStopOutcome('stopped \u2014 nothing was running', 'ok');
  } else {
    setStopOutcome(`stopped \u2014 ${wasRunning} killed`, 'ok');
  }

  await refreshStopState();
}

async function clearStop() {
  // Confirmation belongs on the way OUT. Engaging a stop is the safe direction;
  // lifting one is not, so it should not be a single stray click.
  const reason = stopState.halted && stopState.halted.reason;
  const msg = 'Let scheduled tasks run again?'
    + (reason ? `\n\nCurrent stop reason:\n${reason}` : '')
    + ((stopState.survivors || []).length
      ? `\n\n${stopState.survivors.length} process(es) from the last stop were never confirmed dead.`
      : '');
  if (!confirm(msg)) return;
  try {
    await window.api.clearDriverHalt();
    setStopOutcome('scheduled tasks may run again', 'ok');
  } catch (err) {
    console.error('[stop] clear failed:', err);
    setStopOutcome('resume failed \u2014 see console', 'bad');
  }
  await refreshStopState();
}

async function refreshStopState() {
  try {
    const s = await window.api.getDriverStatus();
    stopState = {
      halted: s.halted || { halted: false, reason: null },
      // A fresh status read cannot know about survivors from a previous halt in
      // another window, so keep what the broadcast told us while still halted.
      degraded: s.halted && s.halted.halted ? stopState.degraded : false,
      survivors: s.halted && s.halted.halted ? stopState.survivors : [],
      children: s.children || [],
    };
  } catch {
    // Leave the last known state rather than implying "not stopped".
  }
  renderStopControl();
}

// Instant across every window: main broadcasts on halt and on clear.
if (typeof window.api.onDriverHalted === 'function') {
  window.api.onDriverHalted(payload => {
    if (payload) {
      stopState = {
        halted: payload.halted || { halted: false, reason: null },
        degraded: !!payload.degraded,
        survivors: payload.survivors || [],
      };
    }
    renderStopControl();
    // A process you deliberately stopped should not still be running.
    if (stopState.halted && stopState.halted.halted && window.api.speechShutdown) {
      window.api.speechShutdown().catch(() => {});
    }
  });
}

renderStopControl();
refreshStopState();
// Catches a HALT file written by something other than this UI. Slower than the
// broadcast on purpose — this is a fallback, not the primary path.
setInterval(refreshStopState, 60 * 1000);
quotaGaugeEl.addEventListener('click', () => {
  document.querySelector('.sidebar-tab[data-tab="stats"]')?.click();
});

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
