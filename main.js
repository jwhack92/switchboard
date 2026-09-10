const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, setMcpWindow, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage, transformUsageResponse } = require('./claude-auth');
const usageSource = require('./usage-source');
const driverStore = require('./driver-store');
const custody = require('./driver-custody');
const registry = require('./window-registry');
const dragProxy = require('./drag-proxy');
const sessionMove = require('./session-move');

// SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
// db.js puts switchboard.db under it, and pointing userData there gives the
// instance its own single-instance lock (requestSingleInstanceLock keys on
// userData), so both can run side by side.
if (process.env.SWITCHBOARD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

// Windows taskbar identity. Without this an unpackaged Electron app is grouped
// and iconed as "Electron", so a pinned shortcut shows Electron's icon and a
// separate taskbar button from the running window. electron-builder sets this
// for packaged builds from build.appId; dev runs need it explicitly.
if (process.platform === 'win32') {
  app.setAppUserModelId('ai.doctly.switchboard');
}

// A dead stdout must never kill the app.
//
// electron-log's console transport writes to stdout/stderr on every log call. If
// whatever launched us handed Electron a pipe and then exited, that write fails
// with EPIPE — and with no 'error' listener Node re-throws it as an uncaught
// exception in the main process, so the whole app dies with a modal
// "A JavaScript error occurred in the main process" dialog, triggered by
// something as ordinary as clicking a session.
//
// The file transport is the log that matters (%APPDATA%/switchboard/logs);
// console output is a convenience. Losing it must be silent.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
    // Anything else is worth knowing about, but still must not throw.
    try { log.transports.file.level && log.error('[stdio]', err && err.message); } catch {}
  });
}

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Environment a running Claude Code session stamps onto everything it spawns.
//
// If Switchboard is itself started from inside a Claude Code session — a
// terminal, a task runner, an agent — these are inherited by the Electron
// process and then handed straight to every PTY it opens. The CLI sees
// CLAUDE_CODE_CHILD_SESSION, decides it is a nested child, and prints:
//
//   Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
//
// which is self-defeating here: sessions started from Switchboard are never
// written to ~/.claude/projects, so they never appear in Switchboard.
//
// The messaging socket/token and session id are worse than useless downstream —
// they point the new session at the PARENT session's IPC channel.
// Note: Switchboard sets CLAUDECODE=1 itself for PLAIN terminals (see the
// claudeShim below) to explain that sessions start from the + button. Stripping
// it here is still correct — that assignment happens after this spread, so the
// deliberate one survives and only an inherited one is removed.
const CLAUDE_SESSION_VARS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction, plus any inherited
// Claude Code session markers (see above).
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    !CLAUDE_SESSION_VARS.includes(k) &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');


// --- Auto-updater (only in packaged builds) ---
let autoUpdater = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    // Every window shows the update toast.
    registry.broadcast('updater-event', type, data);
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    registry.broadcast('updater-event', 'error', { message: err?.message || String(err) });
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, mergeSetting, deleteSetting,
  closeDb,
} = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();

registry.init({ log });

// Window geometry is persisted as a LIST, written by one debounced snapshotter
// for all windows at once. Per-window writes to the shared `global` settings row
// would race: every writer does read → mutate → write-whole-blob, so two windows
// saving bounds at the same moment lose one of the updates.
let layoutTimer = null;
function saveWindowLayout() {
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    layoutTimer = null;
    const layout = registry.allWindows()
      .filter(w => !w.isMinimized())
      .map(w => {
        const b = w.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      });
    if (layout.length) mergeSetting('global', { windowLayout: layout });
  }, 500);
}

function flushWindowLayout() {
  if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
  const layout = registry.allWindows()
    .filter(w => !w.isMinimized())
    .map(w => {
      const b = w.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
  if (layout.length) mergeSetting('global', { windowLayout: layout });
}

function isOnSomeDisplay(x, y) {
  return screen.getAllDisplays().some(d => {
    const b = d.bounds;
    return x >= b.x - 100 && x < b.x + b.width && y >= b.y - 100 && y < b.y + b.height;
  });
}

/** Bounds for a window we are creating with no explicit position. */
function nextWindowBounds() {
  const global = getSetting('global') || {};
  const layout = Array.isArray(global.windowLayout) ? global.windowLayout : [];
  // Legacy single-slot key from before multi-window.
  const legacy = global.windowBounds ? [global.windowBounds] : [];
  const saved = (layout.length ? layout : legacy)[registry.windowCount()];

  if (saved && saved.width && saved.height) {
    const bounds = { width: saved.width, height: saved.height };
    if (saved.x != null && saved.y != null && isOnSomeDisplay(saved.x, saved.y)) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
    return bounds;
  }

  // No saved slot for this index: cascade off the focused window so a new
  // window never lands exactly on top of an existing one.
  const anchor = registry.allWindows().find(w => w.isFocused()) || registry.allWindows()[0];
  if (anchor) {
    const b = anchor.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    return {
      x: Math.min(b.x + 40, wa.x + wa.width - 900),
      y: Math.min(b.y + 40, wa.y + wa.height - 600),
      width: b.width,
      height: b.height,
    };
  }
  return { width: 1400, height: 900 };
}

/**
 * Create an app window.
 *
 * Every handler below closes over the local `win`, never a module-level
 * singleton. That was a latent bug even with one window: `will-navigate`,
 * `did-finish-load` and the bounds handlers all read `mainWindow`, so the moment
 * a second window existed, window A's handlers operated on window B.
 *
 * @param {object} [opts]
 * @param {object} [opts.bounds] explicit geometry (a tear-off drop point)
 * @param {object} [opts.adopt]  { sessionId, serialized, projectPath } to take
 *                               over as soon as the renderer is ready
 */
function createWindow(opts = {}) {
  const bounds = opts.bounds || nextWindowBounds();
  const hasPosition = bounds.x != null && bounds.y != null;

  const win = new BrowserWindow({
    width: bounds.width || 1400,
    height: bounds.height || 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  registry.register(win);

  // Set position after creation to prevent macOS from clamping size
  if (hasPosition) {
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }

  win.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `).catch(() => {});

    // A torn-off window is told what to adopt only once its renderer exists.
    // Ownership was already flipped to this window by session-move, so the
    // source window's release cannot detach it from under us.
    if (opts.adopt && opts.adopt.sessionId) {
      win.webContents.send('adopt-session', {
        sessionId: opts.adopt.sessionId,
        serialized: opts.adopt.serialized || '',
        projectPath: opts.adopt.projectPath,
      });
      opts.adopt = null;
    }
  });

  // Surface renderer errors in the main log. Renderer console output otherwise
  // goes nowhere you can see without DevTools, which makes a multi-window bug
  // (where the interesting window is not the focused one) very hard to chase.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      // Electron changed this signature: older builds pass
      // (event, level, message, line, sourceId); newer ones pass one event
      // object with string levels. Handle both.
      const first = args[0];
      let level, message, line, sourceId;
      if (first && typeof first === 'object' && 'message' in first) {
        level = first.level; message = first.message;
        line = first.lineNumber; sourceId = first.sourceId;
      } else {
        [, level, message, line, sourceId] = args;
      }
      if (level === 'error' || level === 3 || level === 'warning' || level === 2) {
        log.error(`[renderer:${win.id}] ${message} (${sourceId}:${line})`);
      }
    });
  }

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  win.on('resize', saveWindowLayout);
  win.on('move', saveWindowLayout);
  win.on('close', flushWindowLayout);

  win.on('closed', () => {
    // Sessions this window was showing keep running with no view; any window can
    // adopt them by clicking them. PTYs are killed only in 'before-quit' — the
    // old code killed every session in the app here, which with more than one
    // window would destroy the other windows' work.
    registry.releaseWindow(win.id);
    releaseFileWatchers(win.id);
    // Tell the survivors, so their sidebars stop showing this window as a
    // "move to" target and re-render the released sessions as unowned.
    registry.broadcast('windows-changed', registry.describeWindows());
  });

  registry.broadcast('windows-changed', registry.describeWindows());
  return win;
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  broadcast: registry.broadcast,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, reconcileCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;

// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async (event) => {
  const global = getSetting('global') || {};
  // Explicit setting wins; otherwise fall back to wherever a project was last
  // added from, which makes the picker self-tuning with no configuration.
  const candidates = [global.projectBaseDir, global.lastProjectBrowseDir, os.homedir()];
  let defaultPath;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) { defaultPath = c; break; }
  }

  // Parent the dialog to the window that asked, not to whichever window a
  // singleton happened to point at.
  const result = await dialog.showOpenDialog(registry.windowOf(event), {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (result.canceled || !result.filePaths.length) return null;

  // Remember the PARENT: after adding tools/my-thing, the useful place to land
  // next time is tools, not my-thing. Only when no explicit base is configured,
  // so an explicit setting is never quietly overwritten.
  if (!global.projectBaseDir) {
    const parent = path.dirname(result.filePaths[0]);
    if (parent && parent !== result.filePaths[0]) {
      mergeSetting('global', { lastProjectBrowseDir: parent });
    }
  }
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd. The folder
    // name is a lossy slug of the path, so this file is the only durable record
    // of which directory the folder belongs to - cache_meta holds the same
    // mapping but is wiped by schema migrations.
    //
    // It must NOT contain a user message. read-session-file.js takes the first
    // user message as the session title, so a seed shaped like one appeared in
    // the sidebar as a session called "New project"; clicking it resumed that
    // id, so the real conversation was appended to the seed file and kept the
    // fabricated title for good. Carrying only `cwd` keeps deriveProjectPath
    // working while readSessionFile correctly yields no session.
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedFile = path.join(folderPath, require('crypto').randomUUID() + '.jsonl');
      const line = JSON.stringify({
        type: 'project-seed',
        cwd: projectPath,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
// Refcounted per window. Viewer panels are per-window UI, so two windows can
// watch the same file: the watcher is shared, the subscriber set is not. Without
// this, the second window's watch-file was a silent no-op and either window's
// unwatch-file killed the other's notifications.
const fileWatchers = new Map(); // filePath → { watcher, windows:Set<number> }

ipcMain.handle('watch-file', (event, filePath) => {
  const resolved = path.resolve(filePath);
  const windowId = registry.windowIdOf(event);
  if (windowId == null) return { ok: false, error: 'no window' };

  const existing = fileWatchers.get(resolved);
  if (existing) {
    existing.windows.add(windowId);
    return { ok: true };
  }
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const entry = fileWatchers.get(resolved);
        if (!entry) return;
        for (const id of entry.windows) registry.sendTo(id, 'file-changed', resolved);
      }, 300);
    });
    fileWatchers.set(resolved, { watcher, windows: new Set([windowId]) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (event, filePath) => {
  const resolved = path.resolve(filePath);
  const windowId = registry.windowIdOf(event);
  const entry = fileWatchers.get(resolved);
  if (entry) {
    if (windowId != null) entry.windows.delete(windowId);
    // Only the last interested window tears the watcher down.
    if (entry.windows.size === 0) {
      entry.watcher.close();
      fileWatchers.delete(resolved);
    }
  }
  return { ok: true };
});

/** Drop a closed window's file subscriptions. */
function releaseFileWatchers(windowId) {
  for (const [resolved, entry] of [...fileWatchers]) {
    entry.windows.delete(windowId);
    if (entry.windows.size === 0) {
      try { entry.watcher.close(); } catch {}
      fileWatchers.delete(resolved);
    }
  }
}

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    const plans = [];
    for (const file of files) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);

    // Read refreshed stats cache
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  try {
    // One shared, cached read for every window (was: one poll per window every
    // 5 min). The legacy keys are rebuilt from the same response body so
    // existing readers — public/app.js's gauge and public/stats-view.js's
    // error branch — keep working unchanged.
    const v = await usageSource.read();
    const legacy = v.raw ? transformUsageResponse(v.raw) : {};

    if (v.kind === 'unknown') {
      // Deliberately NOT flattened to {}: a caller must be able to tell
      // "I don't know" from "0% used".
      return {
        ...legacy,
        _error: v.reason !== 'http_429',
        _rateLimited: v.reason === 'http_429',
        retryAfterSeconds: v.retryAfterMs ? Math.ceil(v.retryAfterMs / 1000) : undefined,
        _verdict: 'unknown',
        _reason: v.reason,
        tokenExpiresAtMs: v.tokenExpiresAtMs || null,
      };
    }

    return {
      ...legacy,
      _verdict: v.kind,
      _reason: v.reason || null,
      // The billing state claude-auth.js fetched and discarded. On an account
      // whose member dashboard is unavailable, this is the only place it shows.
      billing: v.billing,
      schemaChanged: !!v.schemaChanged,
      tokenExpiresAtMs: v.tokenExpiresAtMs || null,
      ageMs: v.ageMs,
      halted: driverStore.isHalted(),
    };
  } catch (err) {
    log.error('Error fetching usage:', err);
    return { _error: true, _verdict: 'unknown', _reason: 'exception' };
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        // Splits on both separators — `cwd` is backslash-separated on Windows,
        // where splitting on '/' alone left the whole path as one segment.
        const shortName = projectPath
          ? projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Allow paths under ~/.claude/ or any .md file that exists
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(CLAUDE_DIR) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// Atomic read-modify-write of one settings row.
//
// `set-setting` replaces the whole row, so the renderer's
// getSetting -> spread -> setSetting sequence in settings-panel.js loses any
// key a second window wrote in between — the lost-update race db.js:403-410
// already warns about. mergeSetting does the same merge inside a transaction.
ipcMain.handle('merge-setting', (_event, key, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch must be an object' };
  }
  return { ok: true, value: mergeSetting(key, patch) };
});

// --- IPC: global stop -------------------------------------------------
// A file-backed kill switch. Reachable when the UI is responsive (these
// handlers), when it is not (write the HALT file by any means), and it survives
// a restart because it lives on disk rather than in memory.
ipcMain.handle('driver-status', () => {
  const halted = driverStore.isHalted();
  return {
    halted,
    children: custody.list(),
    dir: driverStore.paths().dir,
    events: driverStore.readEvents({ limit: 50 }),
  };
});

ipcMain.handle('driver-halt', (_event, reason) => {
  const report = custody.haltAndReap(String(reason || 'stopped from the UI'));
  log.warn('[halt] global stop engaged:', reason, 'degraded:', report.degraded);
  registry.broadcast('driver-halted', {
    halted: driverStore.isHalted(),
    degraded: report.degraded,
    survivors: report.survivors,
  });
  return { ok: true, degraded: report.degraded, survivors: report.survivors };
});

ipcMain.handle('driver-clear-halt', () => {
  driverStore.clearHalt();
  registry.broadcast('driver-halted', { halted: driverStore.isHalted(), degraded: false, survivors: [] });
  return { ok: true, halted: driverStore.isHalted() };
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');
// Hoisted so the quit handler can stop the cron loop before reaping.
let stopScheduler = null;

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  // Whole-renderer zoom. Reading research puts angular character size among the
  // few parameters with a large, replicated effect — and the optimum is
  // per-person, so it belongs in the user's hands rather than in a stylesheet.
  uiScale: 1,
  // Where the "Add project" folder picker opens. Empty means "remember the last
  // place a project was added from".
  projectBaseDir: '',
  mcpEmulation: false,
  shellProfile: 'auto',
};

// The settings panel needs the app's real defaults so it never renders — and
// then stores — a value the app itself would not have used.
ipcMain.handle('get-setting-defaults', () => ({ ...SETTING_DEFAULTS }));

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
// Deliberately app-wide, not per-window: every sidebar shows a green dot for
// anything running anywhere, which is what makes a session in another window
// discoverable and clickable.
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-session-owners --- sessionId → windowId (null = displayed nowhere)
ipcMain.handle('get-session-owners', () => {
  const out = {};
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) out[sessionId] = registry.ownerId(sessionId);
  }
  return out;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
// ownerWindowId lets a window restore only the terminals it is actually
// displaying, instead of every window claiming all of them on boot.
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({
        sessionId,
        projectPath: session.projectPath,
        ownerWindowId: registry.ownerId(sessionId),
      });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (event, sessionId, projectPath, isNew, sessionOptions) => {
  const win = registry.windowOf(event);
  if (!win) return { ok: false, error: 'no window' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // Claim it for the asking window. If another window was showing it, that
    // window is told to drop its view — this is what makes a session visible in
    // exactly one place, so two renderers can never fight over the PTY size.
    const previousOwner = registry.setOwner(sessionId, win.id);
    if (previousOwner != null) {
      registry.sendTo(previousOwner, 'release-session', sessionId);
    }
    // MCP diffs must follow the session, not the window that spawned it.
    setMcpWindow(session.realSessionId || sessionId, win);

    // A window that brought its own serialized scrollback (a tear-off) does not
    // want main's 256KB tail replayed on top of it — that would duplicate the
    // most recent output. It still needs the alt-screen re-entry below.
    const skipReplay = !!(sessionOptions && sessionOptions.skipReplay);

    // If TUI is in alternate screen mode, send escape to switch into it.
    // Skipped when the caller brought its own serialized buffer: that buffer
    // already contains the mode switch, and doing it twice can leave the TUI
    // painting over a saved screen.
    if (session.altScreen && !session.isPlainTerminal && !skipReplay) {
      win.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    if (!skipReplay) {
      // Send buffered output for reattach
      for (const chunk of session.outputBuffer) {
        win.webContents.send('terminal-data', sessionId, chunk);
      }
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      win.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    registry.broadcast('session-owner-changed', { sessionId, windowId: win.id });
    return { ok: true, reattached: true, mcpActive: !!session.mcpServer, skippedReplay: skipReplay };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // Resolve shell profile from effective settings
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command, using array to prevent accidental shell injection
      const claudeArgs = [];
      if (sessionOptions?.forkFrom) {
        claudeArgs.push('--resume', String(sessionOptions.forkFrom), '--fork-session');
      } else if (isNew) {
        claudeArgs.push('--session-id', String(sessionId));
      } else {
        claudeArgs.push('--resume', String(sessionId));
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeArgs.push('--dangerously-skip-permissions');
        } else if (sessionOptions.permissionMode) {
          claudeArgs.push('--permission-mode', String(sessionOptions.permissionMode));
        }
        // --worktree only applies when STARTING a session — it creates a fresh
        // isolated git worktree. Resuming (isNew === false) must reuse the
        // session's existing directory, so ignore the worktree option on resume
        // regardless of which call site supplied it (sidebar click, schedule
        // creator, fork, …). Otherwise a resume tries to spin up a new worktree
        // and fails to attach.
        if (isNew && sessionOptions.worktree) {
          claudeArgs.push('--worktree');
          if (sessionOptions.worktreeName) {
            claudeArgs.push(String(sessionOptions.worktreeName));
          }
        }
        if (sessionOptions.chrome) {
          claudeArgs.push('--chrome');
        }
        if (sessionOptions.addDirs) {
          const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeArgs.push('--add-dir', dir);
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        claudeArgs.push('--append-system-prompt', String(sessionOptions.appendSystemPrompt));
      }

      let claudeCmd = 'claude ' + quoteArgvForShell(shell, claudeArgs);

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], win, log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);
  // The window that spawned it owns it. Without this a brand-new session has no
  // owner, and since every push goes through sendToOwner that means its PTY
  // output is delivered nowhere — the terminal opens and stays blank.
  registry.setOwner(sessionId, win.id);
  registry.broadcast('session-owner-changed', { sessionId, windowId: win.id });

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            registry.sendToOwner(currentId, 'cli-busy-state', currentId, true);
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            registry.sendToOwner(currentId, 'cli-busy-state', currentId, false);
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            registry.sendToOwner(currentId, 'cli-busy-state', currentId, true);
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          registry.sendToOwner(currentId, 'terminal-notification', currentId, payload);
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    // Only the window displaying this session receives its output.
    registry.sendToOwner(currentId, 'terminal-data', currentId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    // The owning window needs to render the exit banner. Every OTHER window
    // needs it too, because they all show this session as "running" in their
    // sidebar (activePtyIds is app-wide by design), so they must stop.
    registry.broadcast('process-exited', realId, exitCode);
    // If a fork/plan-accept transition re-keyed this session under realId
    // but the PTY exited before transition detection ran, also notify the
    // renderer for the original sessionId so it doesn't stay stuck as "Running".
    if (realId !== sessionId && activeSessions.has(sessionId)) {
      registry.broadcast('process-exited', sessionId, exitCode);
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
    registry.clearOwner(realId);
    registry.clearOwner(sessionId);
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// ── Multi-window + session tear-off ──────────────────────────────────

// Who am I? The renderer needs its own window id to know whether a session is
// "mine", and to be the source of a drag.
ipcMain.handle('get-window-info', (event) => {
  const win = registry.windowOf(event);
  return {
    windowId: win ? win.id : null,
    windowCount: registry.windowCount(),
    windows: registry.describeWindows(),
  };
});

ipcMain.handle('list-windows', () => registry.describeWindows());

ipcMain.handle('new-window', () => {
  const win = createWindow();
  return { ok: true, windowId: win.id };
});

// Metadata a destination window needs to build a view for a session it may
// never have had in its own sidebar.
ipcMain.handle('get-session-meta', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId,
    projectPath: session.projectPath,
    isPlainTerminal: !!session.isPlainTerminal,
    exited: !!session.exited,
    ownerWindowId: registry.ownerId(sessionId),
    mcpActive: !!session.mcpServer,
  };
});

// Move without dragging: the context-menu / keyboard path. targetWindowId null
// means "tear off into a new window".
ipcMain.handle('move-session', (event, { sessionId, targetWindowId, serialized }) => {
  const sourceWindowId = registry.windowIdOf(event);
  if (sourceWindowId == null) return { ok: false, error: 'no window' };
  return sessionMove.moveSession({
    sessionId,
    targetWindowId: targetWindowId == null ? null : targetWindowId,
    serialized: serialized || '',
    sourceWindowId,
  });
});

// The drag gesture. HTML5 drag-and-drop cannot cross BrowserWindows, so the
// renderer only reports pointer down/up and the main process owns the rest:
// cursor tracking, the floating ghost, and hit-testing which window is under it.
ipcMain.handle('session-drag-start', (event, { sessionId, label, subtitle }) => {
  const sourceWindowId = registry.windowIdOf(event);
  if (sourceWindowId == null) return { ok: false, error: 'no window' };
  if (!activeSessions.has(sessionId)) return { ok: false, error: 'session is not running' };
  return sessionMove.dragStart({ sessionId, sourceWindowId, label, subtitle });
});

ipcMain.handle('session-drag-end', (_event, { serialized } = {}) =>
  sessionMove.dragEnd({ serialized: serialized || '' }));

ipcMain.handle('session-drag-cancel', () => sessionMove.dragCancel());

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return;
  // Only the owning window may drive the PTY. A window that has just handed a
  // session over can still have in-flight keystrokes; accepting them would type
  // into a session the user is now looking at somewhere else.
  const windowId = registry.windowIdOf(event);
  if (registry.ownerId(sessionId) != null && !registry.isOwner(sessionId, windowId)) return;
  session.pty.write(data);
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  // A PTY has exactly one size. Letting a non-owner resize it is how two
  // windows corrupt each other's rendering, so non-owners are ignored outright.
  const windowId = registry.windowIdOf(event);
  if (registry.ownerId(sessionId) != null && !registry.isOwner(sessionId, windowId)) return;
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (event, sessionId) => {
  const windowId = registry.windowIdOf(event);
  // Owner-guarded: during a tear-off the source window tears its view down
  // while the destination already owns the session. An unguarded detach here
  // would mark the session detached out from under the window displaying it.
  const wasOwner = registry.clearOwner(sessionId, windowId);
  const session = activeSessions.get(sessionId);
  if (session) {
    if (wasOwner) session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
  if (wasOwner) registry.broadcast('session-owner-changed', { sessionId, windowId: null });
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({
  PROJECTS_DIR, activeSessions, log, rekeyMcpServer,
  // A fork re-keys the session; ownership and the MCP window must follow it.
  sendToOwner: registry.sendToOwner,
  rekeyOwner: registry.rekeyOwner,
});
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one instance runs at a time. The second
// launch quits immediately; the first brings its window to the front.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    const win = registry.allWindows().find(w => w.isFocused()) || registry.allWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    sessionMove.init({
      registry,
      dragProxy,
      log,
      createWindow,
      getSessionMeta: (sessionId) => {
        const session = activeSessions.get(sessionId);
        if (!session || session.exited) return null;
        return { projectPath: session.projectPath, isPlainTerminal: !!session.isPlainTerminal };
      },
    });
    log.info(`[startup] Switchboard ${app.getVersion()} — multi-window build`);
    buildMenu();
    createWindow();
    startProjectsWatcher();
    scheduleIpc.ensureScheduleCreatorCommand();

    // Shared runCommand for cron scheduler and "run now" — takes argv, not a shell string
    const { spawn: cpSpawn } = require('child_process');
    function runScheduleCommand(claudeArgv, cwd, name, onDone) {
      const globalSettings = getSetting('global') || {};
      const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
      const profile = resolveShell(profileId);
      const shell = profile.path;
      const cmd = 'claude ' + quoteArgvForShell(shell, claudeArgv);
      const args = shellArgs(shell, cmd, profile.args || []);

      // THE single gate. Both spawn paths reach this function — the cron loop
      // in schedule-runner.js and `run-schedule-now` in schedule-ipc.js — so
      // checking here means there is no second route to a spawn. Checked
      // synchronously, immediately before spawning, because an async check
      // would leave a window open between the check and the spawn.
      const gate = driverStore.isHalted();
      if (gate.halted) {
        log.warn(`[schedule] VETOED ${name} — global stop in force: ${gate.reason}`);
        driverStore.appendEvent('SPAWN_VETOED', { name, reason: gate.reason });
        if (onDone) onDone();   // never leave the task marked as running
        return;
      }

      log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
      const startedAtMs = Date.now();
      const child = cpSpawn(shell, args, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
      });

      // Take custody BEFORE anything else. Until this write lands there is no
      // record of the child, so nothing could stop it: the registry is what
      // makes a halt real rather than cosmetic. A failed write is fatal to the
      // run by design — if we cannot record it, we must not keep it.
      try {
        custody.register({
          pid: child.pid,
          startedAtMs,
          cwd,
          tag: name,
          cmdlineNeedle: 'claude',
        });
      } catch (err) {
        log.error(`[schedule] could not take custody of pid ${child.pid}; killing it:`, err.message);
        try { custody.killTree(child.pid); } catch {}
        if (onDone) onDone();
        return;
      }

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('exit', (code) => {
        custody.unregister(child.pid);
        if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
        log.info(`[schedule] ${name} finished (exit ${code})`);
        if (onDone) onDone();
      });

      child.on('error', (err) => {
        custody.unregister(child.pid);
        log.error(`[schedule] ${name} error:`, err.message);
        if (onDone) onDone();
      });
    }

    // --- Global stop, process custody, shared usage poll -------------
    // Ordered deliberately: reap BEFORE the scheduler can fire, so a child
    // orphaned by a crash or by electron-reloader's app.exit(0) (which emits
    // neither before-quit nor will-quit) is dealt with before new work starts.
    driverStore.init({ log });
    custody.init({ log, store: driverStore });
    usageSource.init({ log });

    const reaped = custody.reap();
    if (reaped.results.length) {
      log.warn(`[custody] reaped ${reaped.results.length} orphan record(s) from a previous run`);
    }
    if (reaped.degraded) {
      // A process we could not kill is the one case that must be loud: the app
      // would otherwise present a clean slate while something still runs.
      log.error('[custody] SURVIVORS after reap:', JSON.stringify(reaped.survivors));
      driverStore.halt('orphan survived reap — investigate before scheduling again');
    }

    const lock = driverStore.acquireLock(custody.isPidAlive);
    if (!lock.ok) {
      log.warn(`[custody] another instance holds the driver lock (${lock.reason}); this one will not schedule`);
    }

    const startupHalt = driverStore.isHalted();
    if (startupHalt.halted) {
      log.warn(`[schedule] global stop is in force: ${startupHalt.reason} — scheduled tasks will be vetoed`);
    }

    scheduleIpc.init(log, runScheduleCommand);
    stopScheduler = startScheduler(log, runScheduleCommand);

    // Re-index search if FTS table was recreated (e.g. tokenizer config change)
    if (searchFtsRecreated) populateCacheViaWorker();

    // Check for updates after launch
    if (autoUpdater) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
      // Re-check every 4 hours for long-running sessions
      setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Shut down all MCP servers
  shutdownAllMcp();

  // The drag ghost is a BrowserWindow with closable:false; it must be destroyed
  // explicitly or the app will not exit.
  sessionMove.dragCancel();
  dragProxy.destroy();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }

  // Scheduled runs are separate processes, not PTYs, so the loop above never
  // touched them. Stop the timer, then kill what we are holding.
  try { if (stopScheduler) stopScheduler(); } catch {}
  try {
    const report = custody.reap();
    if (report.degraded) {
      log.error('[custody] survivors at quit:', JSON.stringify(report.survivors));
    }
  } catch (err) {
    log.error('[custody] reap at quit failed:', err.message);
  }
  try { driverStore.releaseLock(); } catch {}
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
