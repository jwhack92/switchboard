// The thing you actually see while dragging a session between windows.
//
// A DOM ghost cannot leave the BrowserWindow that created it, and HTML5
// drag-and-drop does not cross BrowserWindows at all. So the drag is driven from
// the main process: a poll on screen.getCursorScreenPoint() moves a small
// frameless always-on-top window under the cursor, and the same tick decides
// which window (if any) is being hovered.
//
// focusable:false is the load-bearing option — without it the proxy steals focus
// on every move and the source window's pointer capture dies mid-drag.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 300;
const HEIGHT = 46;
// Offset from the cursor so the ghost never sits under the pointer, which would
// make it the window found by windowAtPoint hit-testing.
const OFFSET_X = 14;
const OFFSET_Y = 12;

let proxy = null;

function ensureProxy() {
  if (proxy && !proxy.isDestroyed()) return proxy;
  proxy = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,          // must not take focus — see header
    alwaysOnTop: true,
    acceptFirstMouse: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  proxy.setIgnoreMouseEvents(true);
  proxy.setAlwaysOnTop(true, 'screen-saver');
  proxy.loadFile(path.join(__dirname, 'public', 'drag-proxy.html'));
  return proxy;
}

function place(point) {
  if (!proxy || proxy.isDestroyed()) return;
  // Keep the ghost on whichever display the cursor is on.
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  const x = Math.min(Math.max(point.x + OFFSET_X, wa.x), wa.x + wa.width - WIDTH);
  const y = Math.min(Math.max(point.y + OFFSET_Y, wa.y), wa.y + wa.height - HEIGHT);
  proxy.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT });
}

// The proxy page has no preload, so under contextIsolation it cannot receive
// IPC. It exposes __setLabel/__setMode instead and we call them directly.
function run(win, expr) {
  const go = () => { win.webContents.executeJavaScript(expr).catch(() => {}); };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', go);
  } else {
    go();
  }
}

function show(label, subtitle, point) {
  const win = ensureProxy();
  run(win, `window.__setLabel(${JSON.stringify(String(label ?? ''))}, ${JSON.stringify(String(subtitle ?? ''))})`);
  place(point);
  if (!win.isVisible()) win.showInactive();
}

/** Tint the ghost to say what a release right now would do. */
function setMode(mode) {
  if (!proxy || proxy.isDestroyed()) return;
  run(proxy, `window.__setMode(${JSON.stringify(String(mode ?? ''))})`);
}

function move(point) {
  place(point);
}

function hide() {
  if (proxy && !proxy.isDestroyed() && proxy.isVisible()) proxy.hide();
}

function destroy() {
  if (proxy && !proxy.isDestroyed()) {
    proxy.destroy();
  }
  proxy = null;
}

module.exports = { show, move, setMode, hide, destroy };
