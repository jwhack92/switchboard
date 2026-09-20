const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  // Atomic merge — use this, not setSetting, for any partial update, or a
  // concurrent save from another window silently reverts your keys.
  mergeSetting: (key, patch) => ipcRenderer.invoke('merge-setting', key, patch),
  // Global stop
  getDriverStatus: () => ipcRenderer.invoke('driver-status'),
  haltDriver: (reason) => ipcRenderer.invoke('driver-halt', reason),
  clearDriverHalt: () => ipcRenderer.invoke('driver-clear-halt'),
  onDriverHalted: (cb) => ipcRenderer.on('driver-halted', (_e, payload) => cb(payload)),
  // Spoken output
  speechNewText: (sessionId, sinceBytes) => ipcRenderer.invoke('speech-new-text', sessionId, sinceBytes),
  speechSummarize: (text, maxWords) => ipcRenderer.invoke('speech-summarize', text, maxWords),
  getSettingDefaults: () => ipcRenderer.invoke('get-setting-defaults'),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode) => callback(sessionId, exitCode));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message) => callback(sessionId, message));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', () => callback());
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },

  // ── Multi-window + session tear-off ──────────────────────────────────
  getWindowInfo: () => ipcRenderer.invoke('get-window-info'),
  listWindows: () => ipcRenderer.invoke('list-windows'),
  newWindow: () => ipcRenderer.invoke('new-window'),
  getSessionOwners: () => ipcRenderer.invoke('get-session-owners'),
  getSessionMeta: (sessionId) => ipcRenderer.invoke('get-session-meta', sessionId),
  // targetWindowId null → tear off into a new window.
  moveSession: (sessionId, targetWindowId, serialized) =>
    ipcRenderer.invoke('move-session', { sessionId, targetWindowId, serialized }),
  // The drag is driven from main (cursor tracking + a floating ghost window),
  // because HTML5 drag-and-drop cannot cross BrowserWindows.
  sessionDragStart: (sessionId, label, subtitle) =>
    ipcRenderer.invoke('session-drag-start', { sessionId, label, subtitle }),
  sessionDragEnd: (serialized) => ipcRenderer.invoke('session-drag-end', { serialized }),
  sessionDragCancel: () => ipcRenderer.invoke('session-drag-cancel'),

  // Take over a session another window (or no window) is holding.
  onAdoptSession: (callback) => {
    ipcRenderer.on('adopt-session', (_event, payload) => callback(payload));
  },
  // Drop this session's view — it now lives somewhere else. Must NOT trigger
  // close-terminal: the new owner is already attached.
  onReleaseSession: (callback) => {
    ipcRenderer.on('release-session', (_event, sessionId) => callback(sessionId));
  },
  onSessionDragHover: (callback) => {
    ipcRenderer.on('session-drag-hover', (_event, payload) => callback(payload));
  },
  onWindowsChanged: (callback) => {
    ipcRenderer.on('windows-changed', (_event, windows) => callback(windows));
  },
  onSessionOwnerChanged: (callback) => {
    ipcRenderer.on('session-owner-changed', (_event, payload) => callback(payload));
  },

  // Renderer zoom — the UI scale control. Scales text, spacing and icons
  // together, so dense layouts stay intact at any size.
  setZoomFactor: (f) => webFrame.setZoomFactor(f),
  getZoomFactor: () => webFrame.getZoomFactor(),

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
