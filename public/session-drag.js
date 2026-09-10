// --- Dragging a session between windows ---
//
// Why this is hand-rolled instead of HTML5 drag-and-drop:
//
//  1. HTML5 DnD does not cross BrowserWindows. There is no shared dataTransfer
//     between two OS windows, so a drop in window B can never see what window A
//     picked up.
//  2. .terminal-container already owns dragenter/dragover/drop for FILE drops
//     (terminal-manager.js setupDragAndDrop). An HTML5 session drag would light
//     up every terminal it passed over and then be swallowed by that handler's
//     `if (!files.length) return`.
//
// So: pointer events + setPointerCapture here, and the main process owns cursor
// tracking, the floating ghost, and hit-testing which window is underneath
// (session-move.js). This renderer only says "a drag started" and "it ended,
// here is my scrollback".
//
// Pointer capture is what makes releasing over another window work: while a
// button is held and captured, Chromium keeps delivering pointer events to the
// capturing element even when the cursor is outside the window. The existing
// sidebar-resize handle relies on the same behaviour.
//
// Depends on globals: openSessions, sessionMap, activeSessionId, activePtyIds
// Depends on: serializeSession (terminal-manager.js), cleanDisplayName,
//             shortProjectPath (utils.js / sidebar.js)

const DRAG_THRESHOLD_PX = 6;
// How long after a drag a click on the same row is swallowed. The row's
// click-to-open is an on-property (sidebar.js rebindSidebarEvents), so it cannot
// be unwrapped — it has to be suppressed in the capture phase.
const CLICK_SUPPRESS_MS = 350;

let pending = null;   // pointer down, not yet past the threshold
let active = null;    // a real drag in flight
let lastDragEndedAt = 0;

function sessionLabel(sessionId) {
  const session = sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session;
  if (!session) return { label: sessionId.split('-')[0], subtitle: '' };
  const name = (typeof cleanDisplayName === 'function'
    ? cleanDisplayName(session.name || session.aiTitle || session.summary)
    : (session.name || session.summary)) || sessionId.split('-')[0];
  const subtitle = session.projectPath && typeof shortProjectPath === 'function'
    ? shortProjectPath(session.projectPath) : '';
  return { label: name, subtitle };
}

function rowFor(sessionId) {
  return document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
}

function canDrag(sessionId) {
  // Only a live session can be handed over: a dead one has no PTY to re-attach
  // and its view is just a transcript this window can rebuild on its own.
  return !!sessionId && activePtyIds.has(sessionId);
}

function beginPending(e, sessionId) {
  if (active || !sessionId) return;
  if (e.button !== 0) return;
  if (!canDrag(sessionId)) return;
  pending = {
    sessionId,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    target: e.currentTarget || e.target,
  };
}

async function promote() {
  const { sessionId, target, pointerId } = pending;
  pending = null;
  active = { sessionId, pointerId, target };

  try { target.setPointerCapture(pointerId); } catch {}

  document.body.classList.add('session-dragging');
  // The sidebar row has no user-select:none of its own, so a pointer drag would
  // otherwise select the summary text.
  document.body.style.userSelect = 'none';
  const row = rowFor(sessionId);
  if (row) row.classList.add('dragging');

  const { label, subtitle } = sessionLabel(sessionId);
  const res = await window.api.sessionDragStart(sessionId, label, subtitle);
  if (!res || !res.ok) finish({ cancelled: true });
}

function onPointerMove(e) {
  if (pending) {
    if (e.pointerId !== pending.pointerId) return;
    const dx = Math.abs(e.clientX - pending.startX);
    const dy = Math.abs(e.clientY - pending.startY);
    if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) promote();
    return;
  }
  // Nothing to do while dragging: the ghost and hit-testing live in the main
  // process, because they have to work outside this window's bounds.
}

async function onPointerUp(e) {
  if (pending && e.pointerId === pending.pointerId) {
    pending = null;
    return;
  }
  if (!active || e.pointerId !== active.pointerId) return;

  const { sessionId } = active;
  // Serialized at RELEASE, not at drag start, so anything the session printed
  // mid-drag comes across too.
  let serialized = '';
  try {
    serialized = typeof serializeSession === 'function' ? serializeSession(sessionId) : '';
  } catch (err) {
    console.warn('[tearoff] could not serialize, main will replay its buffer', err);
  }

  finish({});
  try {
    await window.api.sessionDragEnd(serialized);
  } catch (err) {
    console.error('[tearoff] drag-end failed', err);
  }
}

function onPointerCancel(e) {
  if (pending && e.pointerId === pending.pointerId) { pending = null; return; }
  if (!active || e.pointerId !== active.pointerId) return;
  finish({ cancelled: true });
  window.api.sessionDragCancel().catch(() => {});
}

function finish({ cancelled }) {
  if (active) {
    try { active.target.releasePointerCapture(active.pointerId); } catch {}
    const row = rowFor(active.sessionId);
    if (row) row.classList.remove('dragging');
  }
  active = null;
  pending = null;
  lastDragEndedAt = Date.now();
  document.body.classList.remove('session-dragging', 'session-drop-target');
  document.body.style.userSelect = '';
  if (cancelled) lastDragEndedAt = 0; // a cancelled drag should not eat the click
}

// --- "Move to window…" menu (right-click the handle) ----------------------

let menuEl = null;

function closeMoveMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener('mousedown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuOutside(e) {
  if (menuEl && !menuEl.contains(e.target)) closeMoveMenu();
}
function onMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeMoveMenu(); }
}

async function openMoveMenu(sessionId, x, y) {
  closeMoveMenu();
  const myId = typeof window._getMyWindowId === 'function' ? window._getMyWindowId() : null;
  let windows = [];
  try { windows = await window.api.listWindows(); } catch {}

  menuEl = document.createElement('div');
  menuEl.className = 'session-move-menu';

  const title = document.createElement('div');
  title.className = 'session-move-menu-title';
  title.textContent = 'Move session to';
  menuEl.appendChild(title);

  const add = (label, hint, onClick, disabled) => {
    const b = document.createElement('button');
    b.className = 'session-move-menu-item';
    b.disabled = !!disabled;
    b.innerHTML = `<span>${escapeHtml(label)}</span>${hint ? `<em>${escapeHtml(hint)}</em>` : ''}`;
    if (!disabled) b.onclick = () => { closeMoveMenu(); onClick(); };
    menuEl.appendChild(b);
    return b;
  };

  const others = windows.filter(w => w.id !== myId);
  for (const w of others) {
    const n = w.sessionCount;
    add(`Window ${w.id}`, n ? `${n} session${n === 1 ? '' : 's'}` : 'empty', () => {
      const serialized = typeof serializeSession === 'function' ? serializeSession(sessionId) : '';
      window.api.moveSession(sessionId, w.id, serialized);
    });
  }
  if (!others.length) add('No other windows', '', () => {}, true);

  const sep = document.createElement('div');
  sep.className = 'session-move-menu-sep';
  menuEl.appendChild(sep);
  add('New window', 'tear off', () => {
    const serialized = typeof serializeSession === 'function' ? serializeSession(sessionId) : '';
    window.api.moveSession(sessionId, null, serialized);
  });

  document.body.appendChild(menuEl);
  // Keep it on screen.
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  document.addEventListener('mousedown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
}

// --- wiring --------------------------------------------------------------

function sessionIdFromEvent(e) {
  const handle = e.target.closest && e.target.closest('.session-drag-handle');
  if (handle) {
    const item = handle.closest('.session-item[data-session-id]');
    return item ? item.dataset.sessionId : null;
  }
  // Dragging the header of a grid card, or the single-view terminal header,
  // moves the session it belongs to.
  const card = e.target.closest && e.target.closest('.grid-card-header');
  if (card) {
    const wrapper = card.closest('.grid-card[data-session-id]');
    return wrapper ? wrapper.dataset.sessionId : null;
  }
  const header = e.target.closest && e.target.closest('#terminal-header-info');
  if (header) return activeSessionId;
  return null;
}

function initSessionDrag() {
  document.addEventListener('pointerdown', (e) => {
    const sessionId = sessionIdFromEvent(e);
    if (!sessionId) return;
    beginPending(e, sessionId);
  }, true);

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);

  // Escape aborts an in-flight drag.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault();
      finish({ cancelled: true });
      window.api.sessionDragCancel().catch(() => {});
    }
  }, true);

  // Swallow the click that follows a drag. Capture phase, because the row's
  // handler is an on-property that cannot be intercepted by another bubble
  // listener on the same node.
  document.addEventListener('click', (e) => {
    if (Date.now() - lastDragEndedAt > CLICK_SUPPRESS_MS) return;
    if (!e.target.closest) return;
    if (e.target.closest('.session-item, .grid-card-header, #terminal-header-info')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Never let the handle itself start a text selection or a native drag.
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest && e.target.closest('.session-drag-handle')) e.preventDefault();
  }, true);

  document.addEventListener('contextmenu', (e) => {
    const handle = e.target.closest && e.target.closest('.session-drag-handle');
    if (!handle) return;
    const item = handle.closest('.session-item[data-session-id]');
    if (!item) return;
    const sessionId = item.dataset.sessionId;
    if (!canDrag(sessionId)) return;
    e.preventDefault();
    openMoveMenu(sessionId, e.clientX, e.clientY);
  }, true);
}
