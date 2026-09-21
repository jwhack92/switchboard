/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge.
 *
 * For files: delegates to a ViewerPanel instance (shared component).
 * For diffs: uses its own MergeView rendering with accept/reject.
 *
 * Globals expected: window.api, window.ViewerPanel,
 *   window.createMergeViewer, window.createUnifiedMergeViewer,
 *   window.createViewerToolbar, openSessions (from app.js)
 */

// ── Per-Session State ───────────────────────────────────────────────

const filePanelState = new Map();

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelContentEl = null;  // container for ViewerPanel or diff content
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;

// ViewerPanel instance for file-type tabs
let fpViewerPanel = null;

// Diff-specific DOM
let diffToolbarEl = null;
let diffBodyEl = null;
let diffActionsEl = null;
let diffToggleBtn = null;

// Project file browser DOM
let browserToolbar = null;
let browserListEl = null;
let filesToggleEl = null;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

// ── Initialization ──────────────────────────────────────────────────

function initFilePanel() {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  // Content container — holds either ViewerPanel or diff UI
  filePanelContentEl = document.createElement('div');
  filePanelContentEl.id = 'file-panel-content';
  filePanelEl.appendChild(filePanelContentEl);

  // ── ViewerPanel for file-type tabs ──
  const vpContainer = document.createElement('div');
  vpContainer.id = 'file-panel-viewer';
  vpContainer.style.display = 'none';
  filePanelContentEl.appendChild(vpContainer);

  fpViewerPanel = new ViewerPanel(vpContainer, {
    language: 'auto',
    onSave: (filePath, content) => window.api.saveFileForPanel(filePath, content),
    onClose: handleClose,
  });

  // ── Project file browser ──
  const browserContainer = document.createElement('div');
  browserContainer.id = 'file-panel-browser';
  browserContainer.className = 'file-browser';
  browserContainer.style.display = 'none';
  filePanelContentEl.appendChild(browserContainer);

  browserToolbar = window.createViewerToolbar({ close: true });
  browserToolbar.setTitle('Files');
  browserToolbar.closeBtn.addEventListener('click', handleClose);
  browserContainer.appendChild(browserToolbar.el);

  browserListEl = document.createElement('div');
  browserListEl.className = 'file-browser-list';
  browserListEl.addEventListener('click', handleBrowserClick);
  browserContainer.appendChild(browserListEl);

  // ── Diff-specific UI ──
  const diffContainer = document.createElement('div');
  diffContainer.id = 'file-panel-diff';
  diffContainer.style.display = 'none';
  filePanelContentEl.appendChild(diffContainer);

  // Diff toolbar
  diffToolbarEl = document.createElement('div');
  diffToolbarEl.className = 'viewer-toolbar';

  const diffInfo = document.createElement('div');
  diffInfo.className = 'viewer-toolbar-info';
  diffInfo.innerHTML = '<span class="viewer-toolbar-title" id="diff-title"></span><span class="viewer-toolbar-path" id="diff-path"></span>';
  diffToolbarEl.appendChild(diffInfo);

  const diffControls = document.createElement('div');
  diffControls.className = 'viewer-toolbar-controls';

  diffToggleBtn = document.createElement('button');
  diffToggleBtn.className = 'fp-toolbar-btn';
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
  diffToggleBtn.addEventListener('click', handleDiffModeToggle);
  diffControls.appendChild(diffToggleBtn);

  const diffSaveBtn = document.createElement('button');
  diffSaveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
  diffSaveBtn.title = 'Save changes';
  diffSaveBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';
  diffSaveBtn.addEventListener('click', handleDiffSave);
  diffControls.appendChild(diffSaveBtn);

  const diffCloseBtn = document.createElement('button');
  diffCloseBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  diffCloseBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
  diffCloseBtn.title = 'Close panel';
  diffCloseBtn.addEventListener('click', handleClose);
  diffControls.appendChild(diffCloseBtn);

  diffToolbarEl.appendChild(diffControls);
  diffContainer.appendChild(diffToolbarEl);

  diffBodyEl = document.createElement('div');
  diffBodyEl.id = 'file-panel-body';
  diffContainer.appendChild(diffBodyEl);

  diffActionsEl = document.createElement('div');
  diffActionsEl.id = 'file-panel-actions';
  diffActionsEl.style.display = 'none';
  diffContainer.appendChild(diffActionsEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

function handleClose() {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;

  if (tab) {
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
    if (tab.type === 'file') {
      fpViewerPanel.destroy();
    }
    state.currentTab = null;
  }

  state.panelVisible = false;
  hidePanel();
}

async function handleDiffSave() {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;

  let content;
  if (tab._diffMode === 'inline') {
    content = tab.editorView.state.doc.toString();
  } else if (tab.editorView.b) {
    content = tab.editorView.b.state.doc.toString();
  }
  if (content == null) return;

  const result = await window.api.saveFileForPanel(tab.filePath, content);
  if (result.ok) {
    const btn = diffToolbarEl.querySelector('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';

  if (currentPanelSessionId) {
    const state = getSessionState(currentPanelSessionId);
    const tab = state.currentTab;
    if (tab && tab.type === 'diff') {
      if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
      renderTabContent(currentPanelSessionId, tab);
    }
  }
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners() {
  window.api.onMcpOpenDiff((sessionId, diffId, data) => {
    openDiffTab(sessionId, diffId, data);
  });

  window.api.onMcpOpenFile((sessionId, data) => {
    openFileTab(sessionId, data);
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
  });
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId) {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      currentTab: null,
      panelVisible: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      mcpActive: false,
    });
  }
  return filePanelState.get(sessionId);
}

function setSessionMcpActive(sessionId, active) {
  const state = getSessionState(sessionId);
  state.mcpActive = active;
  if (currentPanelSessionId === sessionId) updateMcpIndicator();
}

function rekeyFilePanelState(oldId, newId) {
  const state = filePanelState.get(oldId);
  if (state) {
    filePanelState.delete(oldId);
    filePanelState.set(newId, state);
  }
}

// ── Tab Operations ──────────────────────────────────────────────────

function openDiffTab(sessionId, diffId, data) {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'file',
    label: basename(data.filePath),
    filePath: data.filePath,
    content: data.content,
    // The rest of project-files.js's readPreviewFile shape. Carried verbatim
    // so renderTabContent can hand it to ViewerPanel without re-reading.
    previewType: data.previewType,
    mimeType: data.mimeType,
    base64: data.base64,
    previewUrl: data.previewUrl,
    unavailable: data.unavailable,
    // Where to land: { line, column } from a terminal link or the file tree.
    target: data.target,
    // The folder to reopen the browser at, when this file came from it.
    browserPath: data.browserPath,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function destroyCurrentTab(state) {
  const tab = state.currentTab;
  if (!tab) return;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    // Clear stale search/goto-line bar references
    if (diffBodyEl) {
      delete diffBodyEl._cmSearchBar;
      delete diffBodyEl._cmGotoLine;
    }
  }
  if (tab.type === 'file') {
    fpViewerPanel.destroy();
  }
}

/**
 * Open an absolute path in the panel.
 *
 * @param {string} sessionId
 * @param {string} filePath  absolute
 * @param {Object} [target]  { line, column } — where to put the cursor. The
 *   terminal link provider passes its resolved target here as the third
 *   argument (public/terminal-links.js:121), which is how a click on
 *   `main.js:523` lands on line 523 instead of at the top of the file.
 */
async function openFileInPanel(sessionId, filePath, target) {
  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) {
    // PREVIEW_UNAVAILABLE means "a real file, just not one we can show" —
    // a placeholder, not a failure. Anything else is a genuine error and the
    // panel stays shut rather than opening onto nothing.
    if (result.code !== 'PREVIEW_UNAVAILABLE') return;
    openFileTab(sessionId, { filePath, unavailable: result.error });
    return;
  }
  openFileTab(sessionId, { ...result, filePath: result.filePath || filePath, target });
}

// ── Project File Browser ────────────────────────────────────────────
//
// Session-scoped: the root is the session's own project path, and every path
// crossing IPC is RELATIVE to it. project-files.js resolves and re-checks it
// against that root (resolveProjectEntry), so a `..` or a symlink out of the
// tree is refused in the main process rather than trusted from here.

/**
 * The project root for a session, or '' if it has none yet.
 *
 * try/catch rather than `typeof sessionMap === 'undefined'`: sessionMap is a
 * top-level `const` in app.js (app.js:902), and `typeof` on a const still in
 * its temporal dead zone THROWS a ReferenceError instead of answering
 * 'undefined'. Today initFilePanel() is invoked at app.js:1837, below that
 * declaration, so the window never opens — but that is a fact about the line
 * order of a file this one does not own.
 */
function sessionProjectPath(sessionId) {
  try {
    const session = sessionMap.get(sessionId);
    return (session && session.projectPath) || '';
  } catch {
    return '';
  }
}

async function openFileBrowser(sessionId, relativePath = '') {
  const projectPath = sessionProjectPath(sessionId);
  if (!projectPath) return;

  const state = getSessionState(sessionId);
  destroyCurrentTab(state);
  state.currentTab = { type: 'browser', relativePath, projectPath };
  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

async function renderBrowserContent(sessionId, tab) {
  browserToolbar.setTitle(basename(tab.projectPath));
  // '' is the project root, which reads better as the folder's own name.
  browserToolbar.setPath(tab.relativePath || '.');
  browserListEl.innerHTML = '';

  const result = await window.api.listProjectDirectory(tab.projectPath, tab.relativePath);

  // The panel may have moved on while the read was in flight.
  const current = getSessionState(sessionId).currentTab;
  if (current !== tab || currentPanelSessionId !== sessionId) return;

  if (!result.ok) {
    const error = document.createElement('div');
    error.className = 'file-browser-error';
    error.textContent = result.error || 'Could not read this folder.';
    browserListEl.appendChild(error);
    return;
  }

  if (tab.relativePath) {
    browserListEl.appendChild(browserRow({
      name: '..',
      // One level up, or back to the root. Computed here rather than sent as
      // '..' so the main process never has to reason about a traversal.
      relativePath: parentRelativePath(tab.relativePath),
      type: 'directory',
      viewable: true,
    }, true));
  }

  if (!result.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'file-browser-empty';
    empty.textContent = 'This folder is empty.';
    browserListEl.appendChild(empty);
    return;
  }

  // Already sorted directories-first, then natural order by name
  // (main.js listProjectDirectoryAsync). Do not re-sort.
  for (const entry of result.entries) browserListEl.appendChild(browserRow(entry, false));

  // main caps a listing at MAX_BROWSER_ENTRIES so an enormous folder cannot
  // block its process. Say so: showing the first N of a folder with no notice
  // is indistinguishable from showing all of it, and the file you came for may
  // simply not be on screen.
  if (result.truncated) {
    const note = document.createElement('div');
    note.className = 'file-browser-truncated';
    note.textContent = `Showing the first ${result.entries.length} of ${result.total} entries.`;
    note.title = 'This folder is too large to list in full. Open it in your editor or file manager to see everything.';
    browserListEl.appendChild(note);
  }
}

function browserRow(entry, isUp) {
  const row = document.createElement('div');
  row.className = 'file-browser-row ' + entry.type
    + (entry.type === 'file' && !entry.viewable ? ' unviewable' : '')
    + (isUp ? ' file-browser-up' : '');
  row.dataset.path = entry.relativePath;
  row.dataset.type = entry.type;
  row.dataset.viewable = entry.viewable ? '1' : '';

  const icon = document.createElement('span');
  icon.className = 'file-browser-icon';
  icon.textContent = entry.type === 'directory' ? '\u{1F4C1}' : '\u{1F4C4}';
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'file-browser-name';
  // textContent, never innerHTML: a file name is attacker-chosen in any repo
  // that was cloned rather than written.
  name.textContent = entry.name;
  row.appendChild(name);

  if (entry.type === 'file') {
    const size = document.createElement('span');
    size.className = 'file-browser-size';
    size.textContent = formatBytes(entry.size);
    row.appendChild(size);
  }
  return row;
}

function handleBrowserClick(e) {
  const row = e.target.closest('.file-browser-row');
  if (!row || !currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;
  if (!tab || tab.type !== 'browser') return;

  if (row.dataset.type === 'directory') {
    openFileBrowser(currentPanelSessionId, row.dataset.path);
    return;
  }
  if (row.dataset.type !== 'file') return;   // a socket, a fifo: nothing to open
  openProjectFile(currentPanelSessionId, tab.projectPath, row.dataset.path);
}

async function openProjectFile(sessionId, projectPath, relativePath) {
  const result = await window.api.readProjectFile(projectPath, relativePath);
  if (!result.ok) {
    if (result.code !== 'PREVIEW_UNAVAILABLE') return;
    // A real file that cannot be shown: a placeholder, not a toast. The user
    // asked for it by clicking it, so answering with nothing is worse.
    openFileTab(sessionId, {
      filePath: relativePath,
      unavailable: result.error,
      browserPath: parentRelativePath(relativePath),
    });
    return;
  }
  openFileTab(sessionId, { ...result, browserPath: parentRelativePath(relativePath) });
}

function parentRelativePath(relativePath) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[unit];
}

function closeAllDiffs(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state) return;

  if (state.currentTab?.type === 'diff') {
    destroyCurrentTab(state);
    state.currentTab = null;
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
  }
}

function closeDiffByDiffId(sessionId, diffId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  destroyCurrentTab(state);
  state.currentTab = null;
  state.panelVisible = false;
  if (currentPanelSessionId === sessionId) hidePanel();
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  if (state.panelVisible && state.currentTab) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

function updateMcpIndicator() {
  // The Files button is only meaningful for a session that has a project
  // root to browse — a bare terminal session has none.
  if (filesToggleEl) {
    filesToggleEl.style.display = (currentPanelSessionId && sessionProjectPath(currentPanelSessionId))
      ? '' : 'none';
  }
  if (!mcpIndicatorEl) return;
  if (!currentPanelSessionId) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  const state = filePanelState.get(currentPanelSessionId);
  mcpIndicatorEl.style.display = (state && state.mcpActive) ? '' : 'none';
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  renderTabContent(sessionId, state.currentTab);
}

function renderTabContent(sessionId, tab) {
  const vpContainer = document.getElementById('file-panel-viewer');
  const diffContainer = document.getElementById('file-panel-diff');
  const browserContainer = document.getElementById('file-panel-browser');

  if (!tab) {
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'none';
    browserContainer.style.display = 'none';
    return;
  }

  if (tab.type === 'browser') {
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'none';
    browserContainer.style.display = 'flex';
    renderBrowserContent(sessionId, tab);
    return;
  }
  browserContainer.style.display = 'none';

  if (tab.type === 'file') {
    // Use ViewerPanel
    diffContainer.style.display = 'none';
    vpContainer.style.display = 'flex';
    fpViewerPanel.open(tab.label, tab.filePath, tab.content || '', {
      previewType: tab.previewType,
      mimeType: tab.mimeType,
      base64: tab.base64,
      previewUrl: tab.previewUrl,
      unavailable: tab.unavailable,
      target: tab.target,
    });
    // One-shot: re-rendering the same tab (a resize, a session switch back)
    // must not yank the cursor back to where the link pointed.
    tab.target = null;
  } else {
    // Diff mode
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'flex';
    renderDiffContent(sessionId, tab);
  }
}

function renderDiffContent(sessionId, tab) {
  diffBodyEl.innerHTML = '';

  // Update diff toolbar info
  const titleEl = diffToolbarEl.querySelector('#diff-title');
  const pathEl = diffToolbarEl.querySelector('#diff-path');
  if (titleEl) titleEl.textContent = tab.label;
  if (pathEl) pathEl.textContent = tab.filePath || '';

  if (!tab.editorView) {
    if (diffMode === 'inline') {
      tab.editorView = window.createUnifiedMergeViewer(
        diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
      );
      tab._diffMode = 'inline';
    } else {
      tab.editorView = window.createMergeViewer(
        diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
      );
      tab._diffMode = 'side-by-side';
    }
    tab.editorView.dom.addEventListener('click', () => tab.editorView.dom.focus());
  } else {
    diffBodyEl.appendChild(tab.editorView.dom);
  }

  // Accept/reject buttons
  if (!tab.resolved) {
    diffActionsEl.style.display = 'flex';
    diffActionsEl.innerHTML = '';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'file-panel-accept-btn';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'accept'));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'file-panel-reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'reject'));

    diffActionsEl.appendChild(acceptBtn);
    diffActionsEl.appendChild(rejectBtn);
  } else {
    diffActionsEl.style.display = 'none';
  }
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(sessionId, tab, action) {
  if (tab.resolved) return;
  tab.resolved = true;

  if (action === 'accept') {
    let editedContent = null;
    if (tab.editorView) {
      if (tab._diffMode === 'inline') {
        editedContent = tab.editorView.state.doc.toString();
      } else if (tab.editorView.b) {
        editedContent = tab.editorView.b.state.doc.toString();
      }
    }

    if (editedContent && editedContent !== tab.newContent) {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  diffActionsEl.style.display = 'none';
}

// ── IDE Emulation Indicator ─────────────────────────────────────────

let mcpIndicatorEl = null;

function addMcpToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  // Entry point for the project file browser. Nothing else opens it — the
  // panel is otherwise only ever pushed open by the MCP bridge.
  filesToggleEl = document.createElement('button');
  filesToggleEl.className = 'fp-toolbar-btn fp-files-btn';
  filesToggleEl.title = 'Browse project files';
  filesToggleEl.textContent = 'Files';
  filesToggleEl.addEventListener('click', () => {
    if (!currentPanelSessionId) return;
    const tab = getSessionState(currentPanelSessionId).currentTab;
    if (tab && tab.type === 'browser') { handleClose(); return; }
    // Reopen where the user last was: the folder of the file on screen, or
    // the project root.
    openFileBrowser(currentPanelSessionId, (tab && tab.browserPath) || '');
  });
  controls.appendChild(filesToggleEl);

  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.className = 'mcp-toggle enabled';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpIndicatorEl, stopBtn);
  } else {
    controls.appendChild(mcpIndicatorEl);
  }
}

// ── Resize Handle ───────────────────────────────────────────────────

function setupPanelResizeHandle() {
  if (!filePanelResizeHandle) return;

  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = filePanelEl.offsetWidth;
    filePanelResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const delta = startX - e.clientX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth + delta);
    filePanelEl.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    filePanelResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const w = filePanelEl.offsetWidth;
    localStorage.setItem(PANEL_WIDTH_KEY, w);
    if (currentPanelSessionId) {
      const state = getSessionState(currentPanelSessionId);
      state.panelWidth = w;
    }

    refitActiveTerminal();
  }

  filePanelResizeHandle.addEventListener('mousedown', onMouseDown);
}

// ── Terminal Refit ──────────────────────────────────────────────────

function refitActiveTerminal() {
  requestAnimationFrame(() => {
    if (typeof openSessions !== 'undefined' && currentPanelSessionId) {
      const entry = openSessions.get(currentPanelSessionId);
      if (!entry) return;
      // Must go through safeFit, never fitAddon.fit() directly.
      //
      // FitAddon.fit() applies proposeDimensions() verbatim, and that number
      // overshoots for `.terminal-container`: it is measured from the border
      // box, which includes 8px of padding and the 5px the element is pulled up
      // by its negative top inset, while overflow:hidden clips at that border
      // box. The last row then straddles the clip edge and renders as a
      // half-height sliver.
      //
      // This ran on every session switch — switchPanel() calls showPanel() or
      // hidePanel(), both of which land here — one frame after showSession()
      // had already fitted correctly, silently overwriting the good value with
      // the bad one. Symptom: the bottom line cut in half after switching
      // sessions, and staying that way until the window was resized (which goes
      // through safeFit and repairs it).
      // No fallback to fitAddon.fit() on purpose: if safeFit is somehow not
      // there, leaving the pane alone is better than sizing it wrongly.
      try { if (typeof safeFit === 'function') safeFit(entry); } catch {}
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function basename(filePath) {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
