// Moving a live session from one window to another, and the drag gesture that
// triggers it.
//
// The PTY never moves. It is owned by the main process, and a "move" is purely a
// change of which renderer is allowed to see and drive it. What makes that safe
// is ORDER — get it wrong and you either lose the session's output or end up
// with two windows writing one PTY's cols/rows:
//
//   1. registry.setOwner(session → target)      ownership flips FIRST, so the
//                                               source's teardown is a no-op
//                                               (clearOwner is owner-guarded)
//   2. target renderer: 'adopt-session'         builds a fresh xterm, writes the
//                                               serialized scrollback, then
//                                               attaches with skipReplay
//   3. source renderer: 'release-session'       disposes its xterm WITHOUT
//                                               sending close-terminal
//
// A DOM node cannot cross BrowserWindows, so the terminal is genuinely rebuilt
// in the destination. Continuity comes from the source serializing its xterm
// buffer (all 10k lines of scrollback) and handing it over — main's own
// outputBuffer is a 256KB tail and would visibly truncate history.

const { screen } = require('electron');

const POLL_MS = 30;

let registry = null;
let dragProxy = null;
let log = console;
let createWindow = null;
let getSessionMeta = null;

// The in-flight drag, or null. Only one at a time — a second pointer-down
// while dragging is ignored by the renderer, and defensively here too.
let drag = null;
let pollTimer = null;

function init(ctx) {
  registry = ctx.registry;
  dragProxy = ctx.dragProxy;
  log = ctx.log || console;
  createWindow = ctx.createWindow;
  getSessionMeta = ctx.getSessionMeta;
}

// --- the move itself -----------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.sessionId
 * @param {number|null} p.targetWindowId  null → tear off into a new window
 * @param {string} p.serialized           xterm buffer from the source window
 * @param {number} p.sourceWindowId
 * @param {{x:number,y:number}} [p.point] cursor position, to place a new window
 */
function moveSession({ sessionId, targetWindowId, serialized, sourceWindowId, point }) {
  const meta = getSessionMeta ? getSessionMeta(sessionId) : null;
  if (!meta) return { ok: false, error: 'session is not running' };

  let target = targetWindowId == null ? null : registry.windowById(targetWindowId);

  if (target && target.id === sourceWindowId) {
    return { ok: false, error: 'already in that window', noop: true };
  }

  if (!target) {
    // Tear off: a new window, positioned where it was dropped so it lands under
    // the cursor rather than on top of the window it came from.
    target = createWindow({
      bounds: newWindowBoundsAt(point),
      // isPlainTerminal is captured HERE, while the session is still alive.
      // If it dies before the adopt is delivered main can no longer answer
      // what kind of session it was, and the destination needs that to know
      // whether relaunching it means `claude` or a bare shell.
      adopt: { sessionId, serialized, projectPath: meta.projectPath, isPlainTerminal: !!meta.isPlainTerminal },
    });
    if (!target) return { ok: false, error: 'could not create a window' };
    // Ownership flips now; the adopt payload is delivered on did-finish-load.
    registry.setOwner(sessionId, target.id);
    registry.sendTo(sourceWindowId, 'release-session', sessionId);
    log.info(`[move] ${sessionId}: window ${sourceWindowId} → new window ${target.id}`);
    return { ok: true, targetWindowId: target.id, created: true };
  }

  // Existing window. Flip ownership before telling anyone, so the source's
  // release cannot detach a session the target is about to display.
  registry.setOwner(sessionId, target.id);
  registry.sendTo(target.id, 'adopt-session', {
    sessionId,
    serialized: serialized || '',
    projectPath: meta.projectPath,
    isPlainTerminal: !!meta.isPlainTerminal,
  });
  registry.sendTo(sourceWindowId, 'release-session', sessionId);
  if (target.isMinimized()) target.restore();
  target.focus();
  log.info(`[move] ${sessionId}: window ${sourceWindowId} → window ${target.id}`);
  return { ok: true, targetWindowId: target.id, created: false };
}

/** Centre a new window on the drop point, clamped to that display's work area. */
function newWindowBoundsAt(point) {
  const width = 1100;
  const height = 760;
  if (!point) return { width, height };
  const wa = screen.getDisplayNearestPoint(point).workArea;
  const x = Math.min(Math.max(Math.round(point.x - width / 2), wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(Math.round(point.y - 40), wa.y), wa.y + wa.height - height);
  return { x, y, width: Math.min(width, wa.width), height: Math.min(height, wa.height) };
}

// --- the drag gesture ----------------------------------------------------

function dragStart({ sessionId, sourceWindowId, label, subtitle }) {
  if (drag) dragCancel();
  const point = screen.getCursorScreenPoint();
  drag = { sessionId, sourceWindowId, label, subtitle, hoverWindowId: null };
  dragProxy.show(label, subtitle, point);
  tick();
  pollTimer = setInterval(tick, POLL_MS);
  return { ok: true };
}

function tick() {
  if (!drag) return;
  const point = screen.getCursorScreenPoint();
  dragProxy.move(point);

  const hovered = registry.windowAtPoint(point);
  const hoverWindowId = hovered ? hovered.id : null;

  // 'new' when released over empty desktop, 'none' over the window it came
  // from (releasing there does nothing), 'move' over any other window.
  const mode = hoverWindowId == null ? 'new'
    : hoverWindowId === drag.sourceWindowId ? 'none'
    : 'move';
  dragProxy.setMode(mode);

  if (hoverWindowId !== drag.hoverWindowId) {
    drag.hoverWindowId = hoverWindowId;
    // Every window needs this: the one being hovered lights up, the others
    // must clear a highlight they may still be showing.
    registry.broadcast('session-drag-hover', {
      sessionId: drag.sessionId,
      hoverWindowId,
      sourceWindowId: drag.sourceWindowId,
      mode,
    });
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  dragProxy.hide();
}

function dragCancel() {
  if (!drag) return { ok: true };
  stopPolling();
  registry.broadcast('session-drag-hover', { sessionId: drag.sessionId, hoverWindowId: null, mode: 'none' });
  drag = null;
  return { ok: true };
}

/**
 * Pointer released. `serialized` is the source window's xterm buffer, captured
 * at release rather than at drag start so nothing printed mid-drag is lost.
 */
function dragEnd({ serialized }) {
  if (!drag) return { ok: false, error: 'no drag in progress' };
  const { sessionId, sourceWindowId, hoverWindowId } = drag;
  const point = screen.getCursorScreenPoint();
  stopPolling();
  registry.broadcast('session-drag-hover', { sessionId, hoverWindowId: null, mode: 'none' });
  drag = null;

  // Dropped back on its own window: nothing to do.
  if (hoverWindowId === sourceWindowId) return { ok: true, noop: true };

  return moveSession({
    sessionId,
    targetWindowId: hoverWindowId,
    serialized,
    sourceWindowId,
    point,
  });
}

function isDragging() {
  return !!drag;
}

module.exports = { init, moveSession, dragStart, dragEnd, dragCancel, isDragging, newWindowBoundsAt };
