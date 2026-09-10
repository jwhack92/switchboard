// Window registry, session ownership, and main→renderer routing.
//
// Switchboard used to hold exactly one `mainWindow` and push every message at
// it. Multi-window changes the question from "send it" to "send it WHERE", and
// there are only three honest answers:
//
//   sendToOwner(sessionId, …)  the one window currently showing that session —
//                              terminal data, exit, busy state, notifications,
//                              MCP diffs. Sending these anywhere else is wrong,
//                              not just wasteful: two windows writing one PTY's
//                              cols/rows corrupts the TUI.
//   broadcast(…)               state every window renders — the project list,
//                              status line, file-change pings, updater events.
//   the sender's own window    replies to something that window asked for.
//
// Ownership is exclusive by construction. A session has at most one owner, and
// `setOwner` returns the window it was taken from so the caller can tell that
// window to drop its view. That is what makes "two windows fighting over one
// PTY" unrepresentable rather than merely discouraged.
//
// Nothing here holds a BrowserWindow reference for longer than a function call:
// ids are stored and resolved through BrowserWindow.fromId on use, so a closed
// window cannot be written to through a stale capture. That was the bug class
// behind mcp-bridge's `entry.mainWindow`.

const { BrowserWindow } = require('electron');

// sessionId → BrowserWindow id. Absent means "running but not displayed
// anywhere", which is a legal, useful state: the PTY keeps going and any
// window can adopt it.
const owners = new Map();

// Which BrowserWindows are actual app windows. The drag ghost is also a
// BrowserWindow, so BrowserWindow.getAllWindows() is NOT a safe definition of
// "our windows" — an unregistered helper window would otherwise receive
// broadcasts, show up in the "move to window" list, and win drag hit-testing.
const appWindowIds = new Set();

let log = console;

function init(ctx = {}) {
  if (ctx.log) log = ctx.log;
}

// --- window lookup -------------------------------------------------------

/** Call once per app window, right after construction. */
function register(win) {
  appWindowIds.add(win.id);
  return win;
}

function unregister(windowId) {
  appWindowIds.delete(windowId);
}

function isAppWindow(win) {
  return !!win && !win.isDestroyed() && appWindowIds.has(win.id);
}

function allWindows() {
  return BrowserWindow.getAllWindows().filter(isAppWindow);
}

function windowById(id) {
  if (id == null) return null;
  const w = BrowserWindow.fromId(id);
  return isAppWindow(w) ? w : null;
}

function windowOf(event) {
  if (!event) return null;
  const w = BrowserWindow.fromWebContents(event.sender);
  return isAppWindow(w) ? w : null;
}

function windowIdOf(event) {
  const w = windowOf(event);
  return w ? w.id : null;
}

function windowCount() {
  return allWindows().length;
}

// --- routing -------------------------------------------------------------

function broadcast(channel, ...args) {
  for (const w of allWindows()) {
    try { w.webContents.send(channel, ...args); } catch {}
  }
}

function sendTo(windowId, channel, ...args) {
  const w = windowById(windowId);
  if (!w) return false;
  try { w.webContents.send(channel, ...args); return true; } catch { return false; }
}

/**
 * Push to the single window displaying this session. Returns false when nobody
 * owns it — callers that must not silently drop (MCP diffs, which block the
 * Claude CLI on a promise) have to handle that.
 */
function sendToOwner(sessionId, channel, ...args) {
  return sendTo(owners.get(sessionId), channel, ...args);
}

// --- ownership -----------------------------------------------------------

function ownerId(sessionId) {
  const id = owners.get(sessionId);
  return id == null ? null : id;
}

function ownerWindow(sessionId) {
  return windowById(owners.get(sessionId));
}

/**
 * Claim a session for a window. Returns the id of the window it was taken from
 * (null if it was unowned or already this window's) so the caller can tell the
 * loser to release its view.
 */
function setOwner(sessionId, windowId) {
  const previous = owners.get(sessionId);
  owners.set(sessionId, windowId);
  if (previous == null || previous === windowId) return null;
  log.info(`[windows] session ${sessionId} moved from window ${previous} to ${windowId}`);
  return previous;
}

/**
 * Give up a session. `onlyIfWindowId` guards the tear-off race: the source
 * window's teardown must not detach a session the destination has already
 * claimed, so a non-owner's release is ignored.
 */
function clearOwner(sessionId, onlyIfWindowId = null) {
  const current = owners.get(sessionId);
  if (current == null) return false;
  if (onlyIfWindowId != null && current !== onlyIfWindowId) return false;
  owners.delete(sessionId);
  return true;
}

function isOwner(sessionId, windowId) {
  return owners.get(sessionId) === windowId;
}

/** Follow a session whose id changed (fork / plan-accept). */
function rekeyOwner(oldId, newId) {
  if (oldId === newId) return;
  if (!owners.has(oldId)) return;
  owners.set(newId, owners.get(oldId));
  owners.delete(oldId);
}

function sessionsOwnedBy(windowId) {
  const out = [];
  for (const [sessionId, id] of owners) {
    if (id === windowId) out.push(sessionId);
  }
  return out;
}

/**
 * A window is gone. Its sessions keep running — they simply have no view.
 * Returns the session ids that were released so the caller can log or re-home
 * them. Deliberately does NOT kill PTYs: that is `before-quit`'s job, and
 * conflating the two is why closing one window used to kill every session.
 */
function releaseWindow(windowId) {
  const released = sessionsOwnedBy(windowId);
  for (const sessionId of released) owners.delete(sessionId);
  appWindowIds.delete(windowId);
  if (released.length) {
    log.info(`[windows] window ${windowId} closed, released ${released.length} session(s): ${released.join(', ')}`);
  }
  return released;
}

/** Snapshot for the "move to window…" menu and for drag hit-testing. */
function describeWindows() {
  return allWindows().map(w => ({
    id: w.id,
    bounds: w.getBounds(),
    focused: w.isFocused(),
    minimized: w.isMinimized(),
    sessionCount: sessionsOwnedBy(w.id).length,
  }));
}

/**
 * Which window is under a screen point? Electron exposes no z-order, so a
 * focused window wins over an unfocused one when they overlap — that matches
 * what the user sees, since they must have clicked the window they are dragging
 * from or over. Minimized windows are never targets.
 */
function windowAtPoint(point) {
  const candidates = allWindows().filter(w => {
    if (w.isMinimized()) return false;
    const b = w.getBounds();
    return point.x >= b.x && point.x < b.x + b.width &&
           point.y >= b.y && point.y < b.y + b.height;
  });
  if (!candidates.length) return null;
  const focused = candidates.find(w => w.isFocused());
  return focused || candidates[candidates.length - 1];
}

module.exports = {
  init,
  register, unregister, isAppWindow,
  allWindows, windowById, windowOf, windowIdOf, windowCount,
  broadcast, sendTo, sendToOwner,
  ownerId, ownerWindow, setOwner, clearOwner, isOwner, rekeyOwner,
  sessionsOwnedBy, releaseWindow,
  describeWindows, windowAtPoint,
  _owners: owners,
};
