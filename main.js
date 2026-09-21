const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, setMcpWindow, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage, transformUsageResponse } = require('./claude-auth');
const { runStatsCommand, refreshStatsCache } = require('./stats-refresh');
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

// Environment for PTY children — Electron internals stripped, inherited Claude
// Code session markers stripped, and a UTF-8 LC_CTYPE guaranteed when the
// parent handed us no locale. See pty-env.js for why each of those matters;
// the Claude-marker strip in particular is ours and has no upstream equivalent.
const { buildPtyEnv } = require('./pty-env');

const cleanPtyEnv = buildPtyEnv(process.env);

// Shell profiles → shell-profiles.js
const { resolveEffectiveSettings } = require('./resolve-effective-settings');
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
// The old file-based cron loop (`startScheduler`) is GONE — projects.js owns
// scheduling now, and two tickers would each fire every schedule-*.md task.
// What survives is `scanSchedules`, the reader for those files: it feeds
// projects.importLegacySchedules once per launch, which turns each file into
// a folder schedule in the DB. schedule-ipc.js also survives (see its init
// below) — it has no timer of its own, only the user-pressed "run now" and
// the /create-schedule slash command, so it cannot double-fire anything.
const { scanSchedules } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');

// Which CLI drives a session, and what its output and its launch flags mean.
// This fork is Claude-only, so the one harness is resolved once here instead of
// per session — see harnesses/index.js for the shape.
//
// Required AFTER the electron-reloader line above, deliberately. The reloader
// freezes module.children at that instant, so a module required BEFORE it
// relaunches the app on every save — and a relaunch kills every PTY and every
// Claude session running in one. harnesses/ therefore sits on the same side as
// db.js, session-cache.js, shell-profiles.js and pty-env.js: the cost is that
// an edit under harnesses/ needs a manual restart before it is in effect (its
// unit tests still run without the app), which is the trade this file already
// makes for every other module of its kind.
const { getHarness, DEFAULT_HARNESS, allHarnesses } = require('./harnesses');
const claudeHarness = getHarness(DEFAULT_HARNESS);

// Ported-feature modules, all deliberately on THIS side of the reloader line
// for the same reason harnesses/ is (see the comment above). task-manager owns
// live task PTYs and preview-assets owns the token→folder map behind every open
// preview: an auto-relaunch triggered by editing one of them would kill running
// tasks and dead-link every preview URL already handed to the renderer. The
// cost is the usual one — editing any of these needs a manual restart before it
// is in effect.
const { resolveTerminalFiles } = require('./terminal-file-links');
const { readProjectFile, readPreviewFile, isViewableFile, resolveProjectEntry } = require('./project-files');
const { manageProjectEntry } = require('./file-management');
const { PREVIEW_SCHEME, PREVIEW_SCHEMES, handlePreviewAssetRequest } = require('./preview-assets');
const { createTaskManager } = require('./task-manager');
const { createPanelPathGuard } = require('./save-containment');

// MUST run at module scope, before the app is ready: registering the scheme
// inside whenReady is too late and it silently loses standard/secure/fetch/CORS
// privileges, which is the difference between an HTML preview that renders and
// one that is blank. protocol.handle() for the same scheme is in whenReady.
protocol.registerSchemesAsPrivileged(PREVIEW_SCHEMES);

// The file panel writes back only what main itself surfaced. See
// save-containment.js — `panelPaths.watchWindow` is why the MCP bridge's own
// pushes count as surfaced.
const panelPaths = createPanelPathGuard({ log });

// The same containment for the memory editor, which has the same hole:
// `save-memory` used to write ANY .md that existed anywhere on disk, and a .md
// is exactly the kind of file an agent reads as instructions -- a CLAUDE.md, an
// agents.md, a slash command. S3 closed this for `save-file-for-panel` and left
// its sibling open.
//
// A SEPARATE set, deliberately: previewing a .md in the file browser must not
// make it a memory file, and a memory file must not become panel-savable. The
// only seeder is collectAndIndexMemories -- main's own scan of the memory
// locations -- so "savable" means "the Memory tab listed this", which is
// precisely the set of files the editor can open.
//
// NOT seeded from `read-memory`: that handler reads any .md that exists, so
// recording what it read would let the renderer launder a path of its choosing
// into this set with a read of its choosing. That is the hole, not the fix.
//
// The limit is far above any plausible memory-file count and deliberately not
// the default 4096: one scan seeds the whole set in one go, and a scan that
// overflowed the cache would evict its own earliest entries -- the global
// ~/.claude files, which are surfaced first -- leaving the user unable to save
// a file the list had just offered them.
const memoryPaths = createPanelPathGuard({ log, limit: 50000 });


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
// The module object as well as the names: the project handlers below reach
// for db functions that are only needed in one place (getTrack,
// setSessionAssignment, rekeyScheduleSession), and projects.init wants the
// whole module.
const dbModule = require('./db');
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, searchSessionIds, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, mergeSetting, deleteSetting,
  // A session whose id changes (fork / plan-accept) has to take its filing
  // with it. Upstream also destructures `moveSessionAssignment`, for the
  // temp-id launch of a harness that only learns its id from its
  // transcript; this fork is Claude-only and passes --session-id, so the
  // id is real from the first byte and that path does not exist here.
  // These two and dbModule.rekeyScheduleSession are handed to
  // session-transitions.js, which owns the one rekey point we do have.
  copySessionAssignment, rekeyPlanLinks,
  closeDb,
} = dbModule;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();

/**
 * Find a live session by an id that may be STALE.
 *
 * A fork or a plan-accept re-keys a live session and deletes its old key
 * (session-transitions.js), so `activeSessions.get(oldId)` returning nothing
 * does NOT mean the session died — it may be alive, still billing, under a new
 * id. Anything that reads a missing key as death gets this wrong, and the
 * expensive version of getting it wrong is telling a window its session ended
 * and then resuming the old id alongside the process that is still running.
 *
 * Returns { id, session } with the id the session actually lives under now, or
 * { id, session: null } when it really is gone. Direct hit first; the scan is
 * over live sessions only, which is a handful.
 */
function resolveLiveSession(sessionId) {
  const direct = activeSessions.get(sessionId);
  if (direct) return { id: sessionId, session: direct };
  for (const [liveId, session] of activeSessions) {
    if (session.priorIds && session.priorIds.includes(sessionId)) {
      return { id: liveId, session };
    }
  }
  return { id: sessionId, session: null };
}

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
    //
    // Liveness is re-checked HERE, not at tear-off time, because this send is
    // the far side of a real gap: session-move flips ownership synchronously,
    // but did-finish-load lands whole window-creation later. A session that
    // exits inside that gap broadcasts 'process-exited' to every registered
    // window, and this window IS already registered (registry.register at
    // main.js:303 runs before loadFile at :310) — but its renderer has not
    // loaded, so no listener is attached and the message is simply dropped.
    // The adopting renderer is therefore the one participant that never
    // hears it. (Registering later would not help: then it would miss the
    // broadcast for the other reason.) Without this check it then adopts a
    // session main has already forgotten (activeSessions.delete in onExit),
    // which no longer takes the reattach branch in 'open-terminal' and so
    // falls through to the spawn path: a brand-new billed process the user
    // never asked for, in a window they believe is just showing a moved
    // session. Sending exited:true keeps the torn-off scrollback visible
    // behind the normal exit banner instead.
    if (opts.adopt && opts.adopt.sessionId) {
      // A missing key does NOT prove the session died. A fork or a plan-accept
      // re-keys a LIVE session and deletes the old key
      // (session-transitions.js), so follow the re-key before concluding
      // anything — otherwise the window is told "session exited during move"
      // about a session that is alive and still billing, and clicking that
      // corpse would resume the old id alongside the process still running.
      const { id: adoptId, session: adopted } = resolveLiveSession(opts.adopt.sessionId);
      win.webContents.send('adopt-session', {
        sessionId: adoptId,
        serialized: opts.adopt.serialized || '',
        projectPath: opts.adopt.projectPath,
        isPlainTerminal: !!opts.adopt.isPlainTerminal,
        exited: !adopted || !!adopted.exited,
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
        // Reload the renderer without restarting the app. PTYs live in the main
        // process, so sessions survive this and re-attach with their scrollback
        // — which is what makes it safe to offer as a normal menu item.
        //
        // Worth having explicitly: electron-reloader hot-reloads renderer files
        // in dev, but there was no way to reload by hand, and Ctrl+R is not
        // bound on its own once a custom application menu replaces the default.
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
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
    deleteCachedFolder, getCachedByFolder, getCachedSession, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, reconcileCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;

// --- Projects (a piece of work with a folder on disk) ---
//
// Deliberately required HERE, below the electron-reloader line at the top of
// this file, for the same reason db.js / harnesses/ / task-manager are: the
// reloader froze module.children at that point, so anything required ABOVE it
// relaunches the whole app when it is saved — and a relaunch kills every PTY,
// every running Claude session and every task. projects.js is exactly the
// wrong module to have that property: it holds fs.watch handles for each
// project's plan tracker AND the in-memory half of the schedule double-fire
// guard (projects.js `firedSlots` / `lastTickMs`), which a relaunch would
// silently empty mid-hour. The cost is the usual one this file already pays
// everywhere else: editing projects.js needs a manual restart to take effect.
const projects = require('./projects');
projects.init({
  db: dbModule,
  log,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  // The whole of decision D5 (Claude only) inside projects.js is this one
  // function. It must come from the harness registry, never `() => true`:
  // that default is for tests, and here it would let a track name any CLI id
  // and then fail at launch with nothing to run it.
  isHarnessId: (id) => allHarnesses().some(h => h.id === id),
  plansDir: PLANS_DIR,
});
// An upgrade can change the working rules in the brief. Bring every project's
// managed blocks up to date once at startup; unchanged files are not written.
projects.syncAllProjectBriefs().catch(err => log.error('[projects] brief sync failed:', err?.message || String(err)));
// Watch every project's plan-tracker.md and todos.md so a tick made by a
// session is credited to it and the page refreshes. `project-plan-changed` is
// state every window renders, so it broadcasts — upstream sends it at its
// single mainWindow, which this fork does not have.
projects.initPlanWatch({
  activeSessions,
  send: (channel, ...args) => registry.broadcast(channel, ...args),
});

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
    // It must NOT contain a user message. The Claude harness parser takes the first
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

// --- IPC: projects ---
// Every mutating handler notifies the renderer itself (projects.js calls
// notifyRendererProjectsChanged, which broadcasts), so both the Sessions and
// the Projects tab refresh from one event.
//
// `guarded` is not decoration: several of these THROW rather than returning
// { error } -- folderGitStatus, projectGitInfo and projectGitDiff all throw on
// a missing project -- and an uncaught throw inside an ipcMain.handle rejects
// the renderer's promise with a stringified stack, which is what the project
// page would then render in place of the tab.
function guarded(fn) {
  return async (_event, ...args) => {
    try { return await fn(...args); } catch (err) {
      log.error('[projects]', err);
      return { error: err.message };
    }
  };
}
ipcMain.handle('get-project-tree', guarded((showArchived) => {
  // Mirrors get-projects: until the cache is populated there is nothing to
  // file, and the renderer is told via projects-changed once there is.
  if (!isCachePopulated() || !isSearchIndexPopulated()) return { projects: [] };
  return projects.buildProjectTree(!!showArchived);
}));
ipcMain.handle('create-project', guarded((spec) => projects.createProject(spec || {})));
ipcMain.handle('update-project', guarded((id, patch) => projects.updateProject(id, patch || {})));
ipcMain.handle('delete-project', guarded((id) => projects.deleteProject(id)));
ipcMain.handle('attach-project-folder', guarded((id, spec) => projects.attachFolder(id, spec || {})));
ipcMain.handle('detach-project-folder', guarded((id, folderPath, opts) => projects.detachFolder(id, folderPath, opts || {})));
ipcMain.handle('set-session-assignment', guarded((sessionId, projectId, trackId) => {
  const cleanProjectId = projectId || null;
  const cleanTrackId = trackId || null;
  const result = projects.assignSession(sessionId, cleanProjectId, cleanTrackId);
  // Raw terminals have no transcript to rehydrate this relationship from.
  // Keep the live PTY metadata aligned with the durable row so a renderer
  // reload cannot put a moved terminal back in its old location.
  if (!result?.error) {
    const session = activeSessions.get(sessionId);
    if (session?.isPlainTerminal) {
      session.projectId = cleanProjectId;
      session.trackId = cleanProjectId ? cleanTrackId : null;
    }
  }
  return result;
}));
ipcMain.handle('create-track', guarded((projectId, spec) => projects.createTrack(projectId, spec || {})));
ipcMain.handle('update-track', guarded((id, patch) => projects.updateTrack(id, patch || {})));
ipcMain.handle('delete-track', guarded((id, options = {}) => {
  const track = dbModule.getTrack(id);
  if (!track) return { error: 'Track not found' };
  const archiveSessions = options.archiveSessions === true;
  // Raw terminals have no transcript row, but participate in track deletion.
  for (const [sid, session] of activeSessions) {
    if (session.trackId === id && session.isPlainTerminal) dbModule.setSessionAssignment(sid, track.projectId, id);
  }
  const result = projects.deleteTrack(id, { archiveSessions });
  if (result.error) return result;
  const affected = new Set(result.sessionIds);
  for (const [sid, session] of activeSessions) {
    if (session.trackId !== id && !affected.has(sid)) continue;
    session.trackId = null;
    session.formerTrackName = track.name;
    if (archiveSessions && !session.exited) {
      session.stopRequested = true;
      try { session.pty.kill(); } catch (error) { log.error('[delete-track] stop failed', error); }
    }
  }
  return result;
}));
ipcMain.handle('get-projects-root', guarded(() => projects.projectsRoot()));
ipcMain.handle('get-project-git-status', guarded((id, opts) => projects.folderGitStatus(id, opts || {})));
ipcMain.handle('get-project-git-info', guarded((id) => projects.projectGitInfo(id)));
ipcMain.handle('get-project-git-diff', guarded((id, folderPath, filePath) => projects.projectGitDiff(id, folderPath, filePath)));
ipcMain.handle('get-folder-git-status', guarded((folderPath) => projects.folderGitInfo(String(folderPath || ''))));
// The .env files a folder has, and the ones the dialog ticks by default,
// so a new worktree can be offered its repository's local environment.
ipcMain.handle('list-env-files', guarded((folderPath) => ({
  ok: true,
  files: projects.listEnvFiles(String(folderPath || '')),
  defaults: projects.defaultEnvSelection(String(folderPath || '')),
})));
ipcMain.handle('save-project-brief', guarded((id, content) => projects.saveBrief(id, content)));
ipcMain.handle('create-project-file', guarded((id, name, content) => projects.createProjectFile(id, name, content)));
// Open folder / reveal / rename / move-to-trash for an entry in the file
// browser. NOT wrapped in guarded(): that helper drops the event, and both the
// containment check and the confirmation dialog need it.
//
// Containment is file-management.js's own, via project-files.js's
// resolveProjectEntry - it resolves the PARENT rather than the leaf, so
// renaming or trashing a symlink acts on the link and not on whatever it
// points at, and both still have to land inside the project root. This is the
// constrained shape Phase 4 asked for when it deleted the unconstrained
// openFileExternally (a bare shell.openPath on any resolvable path, with no
// caller). Restoring the capability this way is the point; reverting that
// deletion would not have been.
//
// Diverges from upstream in one place: upstream parents the trash confirmation
// to a `mainWindow` singleton (upstream/main:main.js:555). This fork is
// multi-window, so the dialog is parented to the window that actually asked,
// matching the pattern already used at main.js:544. Getting this wrong puts a
// modal on a window the user is not looking at.
ipcMain.handle('manage-project-entry', async (event, projectPath, relativePath, action, newName) => {
  try {
    const result = await manageProjectEntry(projectPath, relativePath, action, newName, {
      shell,
      confirmTrash: async (filePath, isDirectory) => {
        const destination = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
        const choice = await dialog.showMessageBox(registry.windowOf(event), {
          type: 'question',
          message: `Move "${path.basename(filePath)}" to the ${destination}?`,
          detail: `${isDirectory ? 'The folder and its contents' : 'The file'} can be restored from the ${destination}. Open previews of this item will close; unsaved edits will be discarded.`,
          buttons: ['Cancel', `Move to ${destination}`], defaultId: 0, cancelId: 0,
          noLink: true,
        });
        return choice.response === 1;
      },
    });
    return { ok: true, ...result };
  } catch (err) {
    log.error('[file-management]', err);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('add-project-files', guarded((id, sourcePaths) => projects.addProjectFiles(id, sourcePaths)));
ipcMain.handle('list-recent-project-files', guarded((id) => projects.listRecentProjectFiles(id)));
ipcMain.handle('get-project-plan', guarded((id) => projects.readProjectPlan(id)));
ipcMain.handle('set-plan-item', guarded((id, kind, line, done) => projects.setPlanItem(id, kind, line, done)));
ipcMain.handle('append-plan-item', guarded((id, kind, text) => projects.appendPlanItem(id, kind, text)));
ipcMain.handle('edit-plan-item', guarded((id, kind, line, text) => projects.editPlanItem(id, kind, line, text)));
ipcMain.handle('adopt-plan', guarded((id, filename, opts) => projects.adoptPlan(id, filename, opts || {})));
ipcMain.handle('list-templates', guarded(() => projects.listTemplates()));

// --- IPC: scheduled tasks ---
// The rows only; the tick that fires them is startScheduleTicker, further down.
ipcMain.handle('list-schedules', guarded(() => projects.listSchedules()));
ipcMain.handle('create-schedule', guarded((spec) => projects.createSchedule(spec || {})));
ipcMain.handle('update-schedule', guarded((id, patch) => projects.updateSchedule(id, patch || {})));
ipcMain.handle('delete-schedule', guarded((id) => projects.deleteSchedule(id)));
ipcMain.handle('resolve-schedule-launch', guarded((id) => projects.resolveScheduleLaunch(id)));
// Takes a DIALOG SPEC (what the user has picked so far), not a saved row.
ipcMain.handle('get-schedule-context', guarded((spec) => projects.resolveScheduleContext(spec || {})));

// --- IPC: harnesses --- (which CLIs this build can drive)
// `enabled` is always true here: upstream reads a global `disabledHarnesses`
// setting, which this fork does not have because it registers exactly one
// harness (D5) and switching that one off would leave nothing to run.
// public/schedules.js treats a row without `enabled` as on, so the shape is
// upstream's either way.
ipcMain.handle('get-harnesses', () => allHarnesses()
  .filter(h => h.buildLaunchArgs)
  .map(h => ({ id: h.id, label: h.label, enabled: true })));

// Reveal a folder in the OS file manager. Only existing directories, so a
// renderer value can never launch a file.
ipcMain.handle('open-path', async (_event, target) => {
  try {
    const resolved = path.resolve(String(target || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { error: 'Not a folder' };
    const err = await shell.openPath(resolved);
    return err ? { error: err } : { ok: true };
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

// --- IPC: terminal file links ---
// fs.stat only. The reference is a path to check, never a string handed to a
// shell — see terminal-file-links.js.
ipcMain.handle('resolve-terminal-files', (_event, references) => resolveTerminalFiles(references));

// --- IPC: project file browser + panel previews ---

// A folder listing is per-file work, and project-files.js did all of it
// synchronously inside one IPC call: a reviewer measured ~10 seconds on a
// 5,000-entry folder, and for those 10 seconds every window, every PTY write
// and every other IPC in the app was stopped dead. The main process has one
// thread and readdirSync/lstatSync/readSync own it while they run.
//
// So the enumeration happens here instead, and it has two properties the sync
// one did not:
//
//   It yields. Every entry's lstat is awaited, so the event loop runs between
//   entries: a big folder now takes a while to list instead of freezing the
//   app while it does.
//
//   It is bounded. MAX_BROWSER_ENTRIES caps how many entries are statted and
//   returned, and the response carries `total` and `truncated` so the panel
//   can say the folder is bigger than the list rather than quietly showing a
//   prefix of it as if it were the whole thing.
//
// WHAT it may read is unchanged and still project-files.js's call:
// resolveProjectEntry does the same realpath + containment check, and
// isViewableFile makes the same viewability decision, so a file that lists as
// viewable is exactly one readProjectFile will open. Only the reading moved.
//
// One field is gone: the per-entry `previewType`. project-files.js computed it
// with a helper it does not export, and nothing read it -- the panel takes
// previewType off readPreviewFile's result instead (public/file-panel.js:313,
// :648). Wanting it back means exporting previewType from project-files.js.
const MAX_BROWSER_ENTRIES = 2000;
const BROWSER_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function listProjectDirectoryAsync(projectPath, relativePath) {
  const fsp = fs.promises;
  // Containment first, and unchanged: throws for a non-absolute project root,
  // for an absolute or escaping relative path, and for a symlink that lands
  // outside the project.
  const { root, resolved } = resolveProjectEntry(projectPath, relativePath);
  const directoryStat = await fsp.lstat(resolved);
  if (!directoryStat.isDirectory()) throw new Error('Path is not a directory');

  const dirents = await fsp.readdir(resolved, { withFileTypes: true });

  // Sorted BEFORE the cap so a truncated listing is the first N of the list the
  // user would have seen, not an arbitrary N of them re-sorted. readdir's own
  // types are lstat's (a symlink is neither file nor directory here, same as
  // the old per-entry lstatSync), so this is the same order for the same tree.
  // A REUSED collator, not String.localeCompare. localeCompare builds a fresh
  // ICU collator on every call, which dominates the sort and reintroduces the
  // main-process freeze this function was made async to remove: measured on
  // this machine, 2,000 entries 105ms, 20,000 entries 1.5s, 100,000 entries
  // 11.0s — as bad as the synchronous lstat loop it replaced. One shared
  // collator gives byte-identical ordering at 6ms / 84ms / 530ms.
  const byName = (a, b) => BROWSER_COLLATOR.compare(a, b);
  dirents.sort((a, b) => {
    const aDir = a.isDirectory(), bDir = b.isDirectory();
    if (aDir !== bDir) return aDir ? -1 : 1;
    return byName(a.name, b.name);
  });
  const kept = dirents.slice(0, MAX_BROWSER_ENTRIES);

  const entries = [];
  for (const dirent of kept) {
    const absolutePath = path.join(resolved, dirent.name);
    let stat;
    try {
      stat = await fsp.lstat(absolutePath);
    } catch {
      // Gone between readdir and lstat. The sync version failed the entire
      // listing on that; dropping the one entry that no longer exists is
      // closer to what the folder actually holds.
      continue;
    }
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let viewable = false;
    // project-files.js's own check, so `viewable` keeps meaning exactly what
    // the preview read will accept. It samples the head of a text file
    // synchronously; that is one small read between two awaits, not a whole
    // folder's worth of them back to back.
    if (type === 'file') {
      try { viewable = isViewableFile(absolutePath, stat); } catch {}
    }
    entries.push({
      name: dirent.name,
      relativePath: path.relative(root, absolutePath),
      type,
      size: stat.size,
      viewable,
    });
  }

  // Re-sorted on the type lstat actually reported. The dirent sort above chose
  // WHICH entries survive the cap; this one fixes the order on a filesystem
  // that hands readdir an unknown d_type (some network mounts), where the
  // dirent said 'not a directory' about everything.
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return byName(a.name, b.name);
  });

  return { entries, total: dirents.length, truncated: dirents.length > kept.length };
}

ipcMain.handle('list-project-directory', async (_event, projectPath, relativePath) => {
  try {
    return { ok: true, ...await listProjectDirectoryAsync(projectPath, relativePath) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('read-project-file', async (_event, projectPath, relativePath) => {
  try {
    const result = readProjectFile(projectPath, relativePath);
    // Main read it and is about to show it, so the panel may write it back.
    panelPaths.surface(result.filePath);
    return { ok: true, ...result };
  } catch (err) {
    // err.code carries PREVIEW_UNAVAILABLE, which means "a real file, just not
    // previewable" — the UI shows a placeholder for that, not a failure.
    return { ok: false, error: err.message, code: err.code };
  }
});

// Was a bare readFileSync(utf8): no size cap, no binary sniff, and no way to
// preview an image, a PDF or sandboxed HTML. readPreviewFile still returns
// `content` for text, which is all the existing callers read.
ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const result = readPreviewFile(filePath);
    panelPaths.surface(result.filePath);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

// Containment (audit prerequisite S3). The renderer may only save back a file
// the main process itself put in the panel: an MCP diff/file push, a preview
// read, or a browser read. Everything else — any path a renderer bug or a
// rendered preview could name — is refused here rather than written.
ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    if (typeof content !== 'string') return { ok: false, error: 'Nothing to save' };
    const resolved = path.resolve(filePath);
    if (!panelPaths.allows(resolved)) {
      log.warn(`[panel] refused a save to a path Switchboard never opened: ${resolved}`);
      return { ok: false, error: 'Switchboard did not open this file, so it will not save it.' };
    }
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

// --- IPC: refresh-stats (run /stats via PTY, fetch rate limits via API) ---
//
// The driving logic lives in stats-refresh.js, ported from upstream
// doctly/switchboard 6285ad9. Two things it does that the previous inline
// version did not:
//
//   It answers the folder-trust prompt deterministically. This PTY runs in the
//   home directory, which is not a trusted folder here, so /stats sat on that
//   prompt until the timeout and the cache never advanced. The driver reads
//   which option is selected, moves to Yes only if No is selected, and NEVER
//   confirms a selection it could not read.
//
//   It reports when the cache did not advance. Previously a failed refresh fell
//   back to whatever was on disk and rendered it without comment, which is how
//   the stats page showed April data for five months without complaining.
//
// NOTE: accepting the trust prompt writes a persistent decision into
// ~/.claude.json for the directory it runs in. That is a real state change and
// was taken deliberately.
let statsRefreshInFlight = null;
ipcMain.handle('refresh-stats', async () => {
  if (statsRefreshInFlight) return statsRefreshInFlight;

  statsRefreshInFlight = (async () => {
    const usagePromise = fetchAndTransformUsage().catch(() => ({}));
    const result = await refreshStatsCache(STATS_CACHE_PATH, () => {
      const globalSettings = getSetting('global') || {};
      const profile = resolveShell(globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile);
      return runStatsCommand({
        spawn: (...args) => pty.spawn(...args),
        shell: profile.path,
        args: shellArgs(profile.path, 'claude "/stats"', profile.args || []),
        options: {
          name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(),
          env: {
            ...cleanPtyEnv,
            TERM: 'xterm-256color', COLORTERM: 'truecolor',
            TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6',
            FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          },
        },
      });
    });
    if (result.statsError) log.warn('Error refreshing stats:', result.statsError);
    return { ...result, usage: await usagePromise || {} };
  })();
  try { return await statsRefreshInFlight; }
  finally { statsRefreshInFlight = null; }
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

/**
 * Scan every memory/notes file and rebuild the FTS index from it.
 *
 * Called from three places, which is the point: the Memory tab (so it is
 * fresh when read), app startup (so files written while the app was closed
 * are findable), and the projects watcher (so files written while it is open
 * are too). It used to be called from the tab alone, which made the index a
 * snapshot of the last time someone happened to look at it.
 */
function collectAndIndexMemories() {
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

  // Every file this scan found is one main is about to offer the user in the
  // Memory tab, so it is one the memory editor may write back. Nothing else is:
  // see memoryPaths above, and `save-memory`.
  //
  // Recording must never cost the scan (save-containment.js makes the same
  // call for its own recording): a throw here would reject `get-memories` and
  // leave the tab empty, where not recording only degrades to a refused save.
  try {
    for (const f of globalFiles) memoryPaths.surface(f.filePath);
    for (const p of projects) for (const f of p.files) memoryPaths.surface(f.filePath);
  } catch (err) {
    log.warn('[memory] could not record the scanned files as savable: ' + err.message);
  }

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
}

ipcMain.handle('get-memories', () => collectAndIndexMemories());

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
// Contained to the files the Memory tab itself listed (memoryPaths, seeded by
// collectAndIndexMemories). The extension check stays, but it was never the
// protection it looked like: "ends in .md and exists" is true of every CLAUDE.md
// on the machine, which is the one kind of file worth overwriting if you can get
// script into the renderer.
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    if (typeof content !== 'string') return { ok: false, error: 'nothing to save' };
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!memoryPaths.allows(resolved)) {
      log.warn(`[memory] refused a save to a file the memory list does not hold: ${resolved}`);
      return { ok: false, error: 'Switchboard did not list this as a memory file, so it will not save it.' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
// Project-scoped search: which of THESE session ids match. A separate
// channel rather than a 5th parameter on `search`, deliberately -- upstream
// grew `searchByType(type, query, limit, titleOnly, sessionIds)` but no
// caller on either side passes the 5th argument, so the unscoped path below
// stays byte-for-byte what it was.
ipcMain.handle('search-session-ids', (_event, query, sessionIds) => {
  if (typeof query !== 'string' || !Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) return [];
  return searchSessionIds(query, sessionIds);
});

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
const speechIpc = require('./speech-ipc');
speechIpc.init({
  log,
  cleanEnv: cleanPtyEnv,
  PROJECTS_DIR,
  getCachedFolder,
  driverStore,
  custody,
});

const SETTING_DEFAULTS = {
  // Spoken output. speakReplies: 'off' | 'focused' — whether the focused
  // session's reply is read aloud. speakAlerts covers background sessions.
  // Both default ON: the status-bar toggle is the master switch, and a toggle
  // you turn on that then does nothing is indistinguishable from a broken one.
  speakReplies: 'focused',
  speakAlerts: true,
  speechVoice: '',
  speechRate: 1,
  speechWindowSec: 30,
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
  return resolveEffectiveSettings(SETTING_DEFAULTS, global, project);
});

/**
 * Which shell profile a process launched for `projectPath` should use.
 *
 * Extracted verbatim from the session-launch path (open-terminal below, which
 * now calls this) so task PTYs and session PTYs cannot drift apart. It is NOT
 * resolveEffectiveSettings: this one treats an explicit `null` at a scope as
 * "not set" and keeps looking outward, which for shellProfile is the existing
 * behaviour and the one the settings panel's project rows depend on.
 */
function effectiveShellProfileId(projectPath) {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  let profileId = SETTING_DEFAULTS.shellProfile;
  if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
  if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
  return profileId;
}

// --- Project tasks (.vscode/tasks.json) ---
//
// Task PTYs live outside `activeSessions` on purpose: a dev server is not an AI
// session, and stopping or restarting it must not touch one. Everything the
// manager emits goes to EVERY window (registry.broadcast), because tasks belong
// to a project rather than to a session — upstream could push at its single
// mainWindow, this fork cannot.
const taskManager = createTaskManager({
  // NOT process.env: pty-env.js strips the inherited CLAUDE_CODE_* session
  // markers, and a task that runs `claude` with them set writes its transcript
  // into the parent session's channel instead of its own.
  baseEnv: cleanPtyEnv,
  getShellProfile: (projectPath) => resolveShell(effectiveShellProfileId(projectPath)),
  // A project worktree inherits its source repo's tasks.json. Without this a
  // worktree falls back to task-config's own `.claude/worktrees/<name>`
  // inference (task-config.js:573), which a project-managed worktree living
  // under the projects root does not match.
  resolveWorktreeParent: (projectPath) => projects.worktreeParentFor(projectPath),
  log,
  send: (channel, ...args) => registry.broadcast(channel, ...args),
  // (c) The confirmation survives a restart, per (project, label, fingerprint).
  readTrust: () => getSetting('taskTrust') || {},
  writeTrust: (store) => setSetting('taskTrust', store),
});

ipcMain.handle('list-project-tasks', (_event, projectPath) => taskManager.listTasks(projectPath));
ipcMain.handle('list-tasks-for-projects', (_event, projectPaths) => taskManager.listTasksForProjects(projectPaths));
ipcMain.handle('get-task-run', (_event, projectPath, label) => taskManager.getRun(projectPath, label));
// `options` carries { confirmed, fingerprint } from the (c) dialog. Dropping it
// would make every run re-prompt forever, since the grant could never arrive.
ipcMain.handle('start-task', (_event, projectPath, label, options) => taskManager.startTask(projectPath, label, options));
ipcMain.handle('restart-task', (_event, projectPath, label, options) => taskManager.restartTask(projectPath, label, options));
ipcMain.handle('stop-task', (_event, projectPath, label) => taskManager.stopTask(projectPath, label));
ipcMain.handle('stop-all-tasks', (_event, projectPath) => taskManager.stopAllTasks(projectPath));
// Exported for a renderer that wants to show the command before the first run.
ipcMain.handle('get-task-confirmation', (_event, projectPath, label) => taskManager.getTaskConfirmation(projectPath, label));
ipcMain.handle('trust-task', (_event, projectPath, label, fingerprint) => taskManager.trustTask(projectPath, label, fingerprint));
ipcMain.on('task-input', (_event, projectPath, label, data) => taskManager.sendInput(projectPath, label, data));
ipcMain.on('task-resize', (_event, projectPath, label, cols, rows) => taskManager.resize(projectPath, label, cols, rows));

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
  session.stopRequested = true;
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

// The text of the last thing the assistant actually said, for the project
// page's turn preview. Tool calls and thinking blocks are skipped: the hover
// is a preview of the reply, not of the work.
//
// Upstream keeps this rule in its own module (session-preview.js,
// `lastAssistantMessage`) which this fork has not ported. It is inlined here
// rather than left unimplemented because the call site
// (public/projects-view.js:169) swallows a missing channel in a bare
// `catch { return; }` -- the preview would simply never appear, with nothing
// anywhere saying why. If session-preview.js is ever ported, delete this and
// require it: two copies of one rule is how they drift.
const LAST_MESSAGE_MAX = 4000;
ipcMain.handle('get-session-last-message', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  try {
    const content = fs.readFileSync(path.join(PROJECTS_DIR, folder, sessionId + '.jsonl'), 'utf-8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (!entry || (entry.type !== 'assistant' && entry.message?.role !== 'assistant')) continue;
      const body = entry.message?.content;
      let text = '';
      if (typeof body === 'string') text = body;
      else if (Array.isArray(body)) {
        text = body.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n');
      }
      text = text.replace(/\r\n?/g, '\n').trim();
      if (!text) continue;
      if (text.length <= LAST_MESSAGE_MAX) return { text, truncated: false };
      return { text: text.slice(0, LAST_MESSAGE_MAX).trimEnd(), truncated: true };
    }
    return { text: '', truncated: false };
  } catch (err) {
    return { error: err.message };
  }
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

  // An adopt that lost its session must never become a spawn. `adopt` means
  // "attach to something that already exists" — if it no longer exists,
  // launching a replacement is never the right answer, and silently starting
  // a billed process is the worst of the wrong answers. This is the
  // authoritative guard: the delivery-time check in createWindow closes the
  // common case, but it cannot close the gap between that check and this
  // call, and only main knows the truth here.
  //
  // Keyed on `adopt`, NOT on skipReplay. skipReplay only means "I brought my
  // own scrollback", and an adopt brings none whenever the moving window was
  // not displaying the session — serializeSession returns '' with no local
  // entry (public/terminal-manager.js:774), and dragging a session that
  // another window owns is an ordinary supported gesture (the handle is on
  // every row, public/sidebar.js:941; canDrag needs only a live pty,
  // public/session-drag.js:55). An earlier version of this guard keyed on
  // skipReplay and left exactly that path still falling through to pty.spawn.
  if (sessionOptions && sessionOptions.adopt) {
    const { id: liveId, session: adoptTarget } = resolveLiveSession(sessionId);
    if (!adoptTarget || adoptTarget.exited) {
      return { ok: false, error: 'session ended before it could be adopted', exited: true };
    }
    // Alive, but re-keyed since the adopt payload was built. Attaching under
    // the id the caller asked for would bind buffers and ownership to a key
    // nothing else uses, so hand back the new id and let the renderer adopt
    // that instead. Refusing outright would paint a corpse for a live session.
    if (liveId !== sessionId) {
      return { ok: false, error: 'session was re-keyed during the move', rekeyedTo: liveId };
    }
  }

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
    // watchWindow: the bridge sends its diff/file pushes through this object
    // itself, so wrapping it is the only way main learns which files it has put
    // in the panel — which is what makes saving them back legal. Everything
    // else about the window is forwarded untouched (save-containment.js).
    setMcpWindow(session.realSessionId || sessionId, panelPaths.watchWindow(win));

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

  // A session that belongs to a project starts with that project's root and
  // every attached folder as extra directories, so the brief loads wherever
  // it starts and the agent can edit the repos. A new session says which
  // project in its options; a resumed one is looked up by its assignment.
  let projectEnv = {};
  // A fork of a project session belongs to the same project and track, even
  // when it is started from the Sessions tab where no project is in play.
  if (!isPlainTerminal && sessionOptions?.forkFrom && !sessionOptions.projectId) {
    const source = getMeta(sessionOptions.forkFrom);
    if (source?.projectId) sessionOptions = { ...sessionOptions, projectId: source.projectId, trackId: source.trackId || null };
  }
  if (!isPlainTerminal) {
    const launchProjectId = sessionOptions?.projectId || getMeta(sessionId)?.projectId || null;
    if (launchProjectId) {
      try {
        const ctx = projects.launchContext(launchProjectId, projectPath);
        if (ctx && ctx.addDirs.length) {
          sessionOptions = { ...(sessionOptions || {}), addDirs: projects.mergeAddDirs(sessionOptions?.addDirs, ctx.addDirs) };
          projectEnv = ctx.env;
        }
        // A project worktree is already the isolated checkout; asking Claude
        // for another one on top of it would nest worktrees.
        if (ctx?.worktree && sessionOptions?.worktree) {
          sessionOptions = { ...sessionOptions };
          delete sessionOptions.worktree;
          delete sessionOptions.worktreeName;
        }
      } catch (err) {
        log.error('[projects] launch context failed', err);
      }
    }
  }

  // A session that never wrote a transcript cannot be resumed — the CLI has no
  // record of the id, and asking it to resume one produces an error the user
  // can do nothing about ("No saved session found with ID ..."). Start it
  // fresh instead, which is what re-opening a session that never got going
  // means in practice.
  //
  // The cache stands in for "has a transcript", and for one caller that stand-in
  // is wrong in the other direction: the schedule creator WRITES a transcript
  // itself (schedule-ipc.js create-schedule-session) and then resumes into it.
  // That seed holds one assistant message and no user message, so readSessionFile
  // rejects it (`!st.summary` → null, harnesses/claude.js) and it is never
  // cached — on every invocation, permanently. Without hasTranscript the launch
  // therefore fell through to --session-id against a file that already exists,
  // which the CLI refuses outright: "Session ID <id> is already in use."
  // (verified against claude 2.x on this machine). A caller that knows it laid
  // the transcript down says so, and --resume is used instead.
  let startFresh = isNew;
  if (!isNew && !isPlainTerminal && !sessionOptions?.hasTranscript && !getCachedSession(sessionId)) {
    log.info(`[open-terminal] ${sessionId} has no transcript; starting a new session instead of resuming`);
    startFresh = true;
  }

  // Resolve shell profile from effective settings
  const effectiveProfileId = effectiveShellProfileId(projectPath);
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
    if (!startFresh) {
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
      // Argv is built by the harness and quoted here, so a value can never be
      // spliced into the command line as shell syntax.
      //
      // BOTH flags are passed, because they answer different questions and this
      // fork can disagree about them. Upstream has a single `isNew` and hands it
      // `startFresh`; doing that here would silently re-enable --worktree on a
      // recovery start (see startFresh above), and a second --worktree for a
      // session that already made one breaks the launch.
      //   startFresh — begin a NEW CONVERSATION: --session-id over --resume.
      //   isNew      — created by THIS launch: the only gate on --worktree.
      const claudeArgs = claudeHarness.buildLaunchArgs({
        sessionId, isNew, startFresh, options: sessionOptions,
      });

      let claudeCmd = claudeHarness.binary + ' ' + quoteArgvForShell(shell, claudeArgs);

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
          // panelPaths.watchWindow for the same reason as the reattach path
          // above: the bridge's own pushes are what make an MCP diff savable.
          mcpServer = await startMcpServer(sessionId, [projectPath], panelPaths.watchWindow(win), log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
        // Empty unless this is a project session with extra directories;
        // then it is what makes each added directory's CLAUDE.md load.
        ...projectEnv,
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

  // A session launched from a project is filed there. `session.projectId` is
  // not decoration: projects.js reads it off activeSessions to decide which
  // running session gets credit for a plan item someone just ticked
  // (projects.js runningProjectSession).
  if (startFresh && !isPlainTerminal && sessionOptions?.projectId) {
    try {
      const assignment = projects.recordLaunchAssignment(sessionId, sessionOptions);
      if (assignment) {
        session.projectId = assignment.projectId;
        session.trackId = assignment.trackId;
        // Started from a phase or a todo on the project page.
        const item = sessionOptions.planItem;
        if (item?.itemText) projects.recordPlanLink(assignment.projectId, item.file, item.itemText, sessionId, 'started');
      }
    } catch (err) {
      log.error('[projects] could not record launch assignment', err);
    }
  }
  // Started by a schedule: the session remembers which, the schedule
  // remembers the run. Folder schedules have no project, so this is separate
  // from the assignment above -- and it is required for CORRECTNESS, not
  // just for display: `lastRunAt` is the durable half of the double-fire
  // guard (projects.js dueSchedules), and the in-memory half does not
  // survive a restart. Without this write, a restart inside the catch-up
  // window replays a run that already happened.
  if (startFresh && !isPlainTerminal && sessionOptions?.scheduleId) {
    try { projects.recordScheduleRun(sessionOptions.scheduleId, sessionId); } catch (err) {
      log.error('[schedule] could not record the run', err);
    }
  }
  // A resumed project session is a project session too, for the plan watcher.
  if (!isPlainTerminal && !session.projectId) {
    const meta = getMeta(session.realSessionId || sessionId);
    if (meta?.projectId) { session.projectId = meta.projectId; session.trackId = meta.trackId || null; }
  }

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
          // What a title means is the harness's business: Claude prefixes a
          // working session's title with a spinner frame (braille through
          // 2.1.227, the half-circles U+25D0-U+25D3 from 2.1.228) and an idle
          // one with U+2733. See harnesses/claude.js parseTitleState.
          const titleState = claudeHarness.parseTitleState(payload);
          // Remembered for the OSC 9;4 handler below, which trusts the title
          // over a progress report from any process in the PTY. Only a title
          // that actually says something updates it — a plain title (null)
          // leaves the last real reading standing rather than reading as idle.
          if (titleState) session._titleBusy = titleState === 'busy';
          const isBusy = titleState === 'busy';
          const isIdle = titleState === 'idle';
          // Keep the raw codepoint in the log. A glyph the harness does not
          // recognise reads as state=none, which is indistinguishable from a
          // plain title — and it was exactly this field that caught Claude
          // 2.1.228 moving the spinner from braille to half-circles.
          const firstChar = payload.trim()[0];
          const cp = firstChar ? 'U+' + firstChar.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : 'none';
          log.debug(`[OSC 0] session=${currentId} char=${cp} state=${titleState || 'none'} wasBusy=${!!session._cliBusy}`);
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
          // 4;0 is NOT treated as idle here, deliberately — upstream's
          // progressBusyState() vetoes it with the terminal title, and that veto
          // does not work for this fork.
          //
          // For a Claude session _titleBusy is true in exactly the states
          // _cliBusy is, so the clear can never fire: the change is inert.
          // For a PLAIN TERMINAL nothing ever sets _titleBusy, so the veto is
          // permanently false and any child emitting OSC 9;4 progress — curl,
          // npm, git clone — would go busy on 4;1 and idle on 4;0. That reaches
          // setActivity() in the renderer, which calls
          // window.speech.announceFinished(). The app would talk at you because
          // a download finished.
          //
          // So: no benefit where it would be safe, an audible regression where
          // it would fire. Revisit only if a title-busy signal exists for plain
          // terminals, which would need something other than Claude's OSC 0.
          if (level === '0') continue;
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

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    // The renderer needs to tell "the user ended this" from "this died" to
    // decide whether to tear the terminal down or leave it up with a banner.
    // A signal kill reports exitCode 0, so pass the signal and the
    // stop-session flag along rather than making it guess from the code.
    const stopRequested = !!session.stopRequested;
    // The owning window needs to render the exit banner. Every OTHER window
    // needs it too, because they all show this session as "running" in their
    // sidebar (activePtyIds is app-wide by design), so they must stop.
    registry.broadcast('process-exited', realId, exitCode, signal, stopRequested);
    // If a fork/plan-accept transition re-keyed this session under realId
    // but the PTY exited before transition detection ran, also notify the
    // renderer for the original sessionId so it doesn't stay stuck as "Running".
    if (realId !== sessionId && activeSessions.has(sessionId)) {
      registry.broadcast('process-exited', sessionId, exitCode, signal, stopRequested);
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
  // Follow a re-key rather than reporting null: a caller holding an id from
  // before a fork or plan-accept is asking about a session that is alive under
  // a new id, and answering "no such session" makes it paint a corpse for a
  // process that is still running. `sessionId` in the reply is the id the
  // session lives under NOW, which may differ from the one asked about.
  const { id: liveId, session } = resolveLiveSession(sessionId);
  if (!session) return null;
  return {
    sessionId: liveId,
    rekeyedFrom: liveId === sessionId ? undefined : sessionId,
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
  // ...and so must everything that names the session by id. A fork or a
  // plan-accept is the ONLY place in this fork where a session's id changes
  // (Claude is launched with --session-id, so there is no temp id to
  // resolve), which makes this the one place all three have to be applied:
  //   copySessionAssignment  the new id belongs to the same project/track
  //   rekeyPlanLinks         a plan item says which session is working it
  //   rekeyScheduleSession   schedule.lastSessionId is what the ticker asks
  //                          isSessionBusy about -- left on the dead id, a
  //                          still-working scheduled run stops blocking the
  //                          next occurrence and the schedule doubles up.
  copySessionAssignment,
  rekeyPlanLinks,
  rekeyScheduleSession: dbModule.rekeyScheduleSession,
});
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  // Memory files do not affect the session cache, so they are tracked
  // separately from the folders queued for re-indexing.
  let memoryDirty = false;
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

    if (memoryDirty) {
      memoryDirty = false;
      // Rebuilt whole rather than per-file: there are ~130 small files, and a
      // partial update would have to track deletions across five scan roots.
      // The debounce above already collapses a burst into one rebuild.
      try {
        collectAndIndexMemories();
      } catch (err) {
        log.error('[memory] reindex failed:', err.message);
      }
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
      } else if (basename.endsWith('.md')) {
        // A memory or notes file. No folder is queued — the session cache is
        // unaffected — but the memory index now needs rebuilding.
        memoryDirty = true;
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

// --- Scheduled task ticker ---
//
// Main owns the clock. A renderer timer is throttled the moment its window is
// hidden or backgrounded, and a schedule has to fire at the minute it names.
// Each fire is one 'schedule-due' event and the RENDERER starts the session,
// because the terminal lives there.
let scheduleTickerStop = null;

// "Still working" is the CLI being busy, not the PTY being open: an
// interactive session sits at its prompt until someone closes it, and a
// schedule must not be blocked forever by its own last run having a terminal
// left open. `_cliBusy` is maintained by the OSC 0 / OSC 9;4 handlers above.
function isSessionBusy(sessionId) {
  const session = activeSessions.get(sessionId);
  return !!session && !session.exited && !!session._cliBusy;
}

/**
 * The one window a due schedule is launched in.
 *
 * NOT registry.broadcast. 'schedule-due' is an instruction to start a session,
 * not state for every window to render: broadcast it and each window starts
 * its own copy — N windows, N Claude sessions, N times the money, for one
 * schedule. Upstream cannot make this mistake because it has a single
 * mainWindow; this fork has to choose, and choosing wrong is invisible until
 * someone opens a second window.
 *
 * Not sendToOwner either — the session does not exist yet, so nothing owns it.
 * Lowest window id rather than "whichever is focused" so a schedule's sessions
 * keep landing in the same window run after run instead of following the
 * user's attention around.
 *
 * A window that is still LOADING does not count. ipcRenderer.on is not
 * buffered: a 'schedule-due' sent before public/schedules.js has run is
 * simply gone, and the slot behind it has already been burned. On this
 * machine the renderer can take a while, so "a window exists" is not the
 * same question as "something can receive this".
 */
function scheduleHostWindow() {
  const windows = registry.allWindows().filter(w => {
    // A crashed renderer leaves the BrowserWindow alive with a dead
    // webContents; anything sent at it is dropped in silence.
    try { return !w.webContents.isDestroyed() && !w.webContents.isLoading(); } catch { return false; }
  });
  if (!windows.length) return null;
  return windows.reduce((lowest, w) => (w.id < lowest.id ? w : lowest));
}

function fireSchedules(ids, reason) {
  if (!ids.length) return;
  const win = scheduleHostWindow();
  if (!win) return;

  // The global stop has to keep reaching scheduled runs, and after this slice
  // it no longer does on its own. The old path spawned the run from main
  // through runScheduleCommand, which vetoes synchronously immediately before
  // the spawn; the new path hands the launch to the renderer, which comes back
  // through open-terminal like any user action and never passes that gate.
  // So the gate is here too. Like the old one this DROPS the run rather than
  // queueing it -- projects.dueSchedules has already burned the slot by the
  // time we are called, which is the same "vetoed means missed" the old
  // runCommand had.
  const gate = driverStore.isHalted();
  if (gate.halted) {
    for (const id of ids) {
      log.warn(`[schedule] VETOED ${id} - global stop in force: ${gate.reason}`);
      try { driverStore.appendEvent('SPAWN_VETOED', { name: `schedule:${id}`, reason: gate.reason }); } catch {}
    }
    return;
  }

  for (const id of ids) {
    const launch = projects.resolveScheduleLaunch(id);
    if (launch.error) { log.warn(`[schedule] ${id}: ${launch.error}`); continue; }
    log.info(`[schedule] ${reason}: ${launch.schedule.name}`);
    registry.sendTo(win.id, 'schedule-due', launch);
  }
}

function startScheduleTicker() {
  if (scheduleTickerStop) return;
  let timer = null;
  let stopped = false;

  function armNextTick() {
    // Re-aimed at the next wall-clock minute after EVERY tick, rather than a
    // fixed-period setInterval started from one aligned point (which is what
    // upstream does). This machine is CPU-constrained and a tick can arrive
    // minutes late; a periodic timer that fires late stays late, and every
    // later run inherits the drift, so a 09:00 schedule creeps to 09:04 and
    // stays there until restart. Recomputing the delay from the clock puts
    // the next tick back on :00.
    //
    // This is NOT a second gate and NOT a shorter interval. Due-ness is still
    // decided in exactly one place, projects.dueSchedules, over
    // (its previous call, now] -- that window is what makes a late tick
    // survivable, and re-aiming only decides when we next ask.
    const now = new Date();
    const delay = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    timer = setTimeout(tick, Math.max(1, delay));
  }

  function tick() {
    try {
      // No window means nothing can launch. Returning BEFORE dueSchedules is
      // the whole point of the check: that call burns each due slot whether
      // or not the fire lands, so asking it now would silently consume runs
      // nobody could start. Left unasked, the next tick's window still covers
      // those minutes, clamped by schedule-time's MAX_TICK_CATCHUP_MINUTES.
      if (!scheduleHostWindow()) return;
      // EXACTLY TWO ARGUMENTS. The [lastTick, now] window is projects.js's own
      // state; a `since` passed from here would be a second clock, and the
      // slot one path burns would not be the slot the other reads.
      fireSchedules(projects.dueSchedules(new Date(), isSessionBusy), 'due');
    } catch (err) {
      log.error('[schedule] tick failed', err);
    } finally {
      // The chain re-arms even when the body threw. A setInterval survives a
      // throwing callback for free; a self-aiming chain does not, and a chain
      // that dies stops every schedule silently forever.
      if (!stopped) armNextTick();
    }
  }

  armNextTick();

  // Catch-up runs, for the schedules that asked for one, once the renderer
  // has loaded. "Missed while the app was closed" means missed since the last
  // recorded run. This shares projects.js's fire memo with the tick above --
  // missedSchedules burns the slot of everything it returns -- so the
  // catch-up and the first real tick cannot both fire the same occurrence.
  //
  // Upstream fires this on a bare 20s timer. Here it waits for a window that
  // can actually receive it and retries until one does, because 20s is not a
  // safe assumption on this machine and firing early is not harmless: the
  // event lands nowhere AND the slots are spent, so the run is lost rather
  // than delayed.
  const CATCHUP_RETRY_MS = 5 * 1000;
  const catchUpDeadline = Date.now() + 5 * 60 * 1000;
  let catchUp = null;
  function tryCatchUp() {
    if (stopped) return;
    if (!scheduleHostWindow()) {
      if (Date.now() >= catchUpDeadline) {
        log.warn('[schedule] catch-up abandoned - no window finished loading in time');
        return;
      }
      catchUp = setTimeout(tryCatchUp, CATCHUP_RETRY_MS);
      return;
    }
    try { fireSchedules(projects.missedSchedules(new Date(), isSessionBusy), 'catch-up'); } catch (err) {
      log.error('[schedule] catch-up failed', err);
    }
  }
  catchUp = setTimeout(tryCatchUp, 20 * 1000);

  scheduleTickerStop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(catchUp);
    scheduleTickerStop = null;
  };
}

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
    // First: a window created below can ask for a preview asset immediately,
    // and without a handler every switchboard-preview:// URL fails and an HTML
    // preview renders blank. The scheme itself was registered at module scope.
    protocol.handle(PREVIEW_SCHEME, handlePreviewAssetRequest);

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

    // Memory written while the app was closed would otherwise stay out of
    // search until someone opened the Memory tab.
    try {
      collectAndIndexMemories();
    } catch (err) {
      log.error('[memory] startup index failed:', err.message);
    }
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

    // schedule-ipc.js survives the move to DB-backed schedules: it owns no
    // timer, only the user-pressed "run now" (public/plans-memory-view.js)
    // and the /create-schedule slash command (public/dialogs.js). Neither
    // can double-fire anything, because neither fires on its own.
    scheduleIpc.init(log, runScheduleCommand);

    // Retry the legacy import each launch: each schedule-*.md that lands
    // becomes a folder schedule and is remembered in the DB's import ledger
    // (including after the schedule is deleted, so a retry cannot resurrect
    // it), while a folder that was missing this time can still be picked up
    // next time. schedule-runner.js is kept for exactly this: scanSchedules
    // reads those files. Its `startScheduler` cron loop is NOT started and
    // no longer imported -- two tickers would each fire every one of them.
    try {
      const imported = projects.importLegacySchedules(scanSchedules(log));
      if (imported) log.info(`[schedule] Imported ${imported} schedule file(s) as folder schedules`);
    } catch (err) { log.error('[schedule] legacy import failed', err); }

    // The driver lock, honoured rather than merely logged. The old
    // startScheduler ran whatever `lock.ok` said, which made the warning
    // above untrue: a second instance did schedule. A scheduled run is a
    // Claude session, so two instances ticking is two of every run.
    if (lock.ok) startScheduleTicker();
    else log.warn('[schedule] ticker not started - another instance holds the driver lock');

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

  // Task PTYs are not in activeSessions, so the loop below never reaches them.
  // This also closes the tasks.json watchers.
  try { taskManager.shutdown(); } catch (err) {
    log.error('[task] shutdown failed:', err.message);
  }

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

  // The plan-tracker watchers are projects.js's, not projectsWatcher's.
  try { projects.stopPlanWatchers(); } catch (err) {
    log.error('[projects] plan watcher shutdown failed:', err.message);
  }

  // A DUE schedule now starts an ordinary PTY session, so the loop above did
  // reach those. What it did not reach is a legacy "run now", which is still
  // a separate child process. Stop the tick first, then kill what custody is
  // holding.
  try { if (scheduleTickerStop) scheduleTickerStop(); } catch {}
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
