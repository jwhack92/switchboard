// ─────────────────────────────────────────────────────────────────────────
// Ported verbatim from upstream d4a51aa:public/file-actions.js (99 lines).
// The body below is byte-identical to upstream; only this header is added,
// because nothing in the logic is fork-specific — but two things in its
// ENVIRONMENT are, and both are somebody else's file to fix:
//
//   1. ONE window.api entry this file calls does not exist in this tree's
//      preload.js: openFileExternally(filePath, projectRoot) ->
//      'open-file-externally' (upstream preload.js:175). It was removed on
//      purpose in Phase 4; see the note further down before restoring it.
//      manageProjectEntry was the other one, and it HAS since been ported:
//      ./file-management.js plus the 'manage-project-entry' handler in
//      main.js and the preload entry beside readProjectFile.
//      window.api.openPath (preload.js:125) is NOT a substitute: main.js:740
//      rejects anything that is not an existing directory, on purpose.
//      Until those land: the two Copy rows still work (writeClipboard
//      exists), "Open in editor / preview" still works for a viewable file
//      because that row calls back into projects-view.js and never touches
//      either missing entry, and the other four -- Open folder, Reveal,
//      Rename, Move to Trash, plus "Open in default application" for an
//      unviewable file -- reject with a TypeError. Every one of those is
//      already inside a try/catch (run() and openUnsupportedFile()), so the
//      user gets an alert, not a broken page.
//      NOTE for whoever ports it: upstream's 'manage-project-entry' handler
//      (main.js:549-560) parents its trash confirmation on `mainWindow`.
//      This fork is multi-window, so that dialog has to be parented on the
//      window the request came from, not on a module-level mainWindow.
//
//   2. canManageBrowserEntry and applyBrowserFileAction are the session file
//      browser's half of this menu (upstream file-panel.js:800 and :806) and
//      are absent from this tree. Both call sites below already test
//      `typeof x === 'function'` first, so their absence is silent and safe:
//      the project Files tab refreshes through applyProjectFileAction
//      (projects-view.js:2107) and no diff-guard blocks a rename or a trash.
//
// The two window.api entries this file needs that DO exist: platform
// (preload.js:204) and writeClipboard (preload.js:126). Every other global
// it reaches for is resolved at call time, not at load: PICONS
// (projects-view.js:277), showContextMenu (:3037), showPromptDialog (:3290),
// applyProjectFileAction (:2107) — which is why index.html:228 can load this
// file well before projects-view.js. Consumer: projects-view.js:2170.
// ─────────────────────────────────────────────────────────────────────────
// Shared context menu for the project Files tab and the session file browser.
// Uses the app's context menu and prompt components from projects-view.js.
function projectEntryPath(root, relativePath = '') {
  const separator = window.api.platform === 'win32' ? '\\' : '/';
  return root.replace(/[\\/]$/, '') + (relativePath ? separator + relativePath : '');
}

function remapFileActionPath(value, change) {
  if (!value) return value;
  const normalize = path => {
    const normalized = path.replace(/\\/g, '/');
    return window.api.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const sources = [
    [projectEntryPath(change.projectPath, change.relativePath), change.newRelativePath && projectEntryPath(change.projectPath, change.newRelativePath)],
    [change.filePath, change.newFilePath],
  ];
  for (const [from, to] of sources) {
    const key = normalize(from);
    if (normalize(value) === key || normalize(value).startsWith(key + '/')) {
      return to ? to + value.slice(from.length) : null;
    }
  }
  return value;
}

function remapFileActionRelative(root, relativePath, change) {
  if (!relativePath) return relativePath;
  const original = projectEntryPath(root, relativePath);
  const mapped = remapFileActionPath(original, change);
  return mapped === original ? relativePath : mapped === null ? null : mapped.slice(projectEntryPath(root).length + 1);
}

// A preview read stays side-effect free; only user-initiated open flows call
// this fallback after their stale-request checks. Preserve the current editor.
async function openUnsupportedFile(result, filePath, projectRoot) {
  if (result?.code !== 'PREVIEW_UNAVAILABLE') return false;
  try {
    const opened = await window.api.openFileExternally(filePath, projectRoot);
    if (!opened?.ok) throw new Error(opened?.error || 'Could not open the file in its default application.');
  } catch (error) {
    alert(error.message || 'Could not open the file in its default application.');
  }
  return true;
}

function fileEntryMenuItems(root, entry, open) {
  const manager = window.api.platform === 'darwin' ? 'Finder' : window.api.platform === 'win32' ? 'Explorer' : 'File Manager';
  const trash = window.api.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const run = action => async () => {
    try {
      let name;
      if (action === 'rename' || action === 'trash') {
        if (typeof canManageBrowserEntry === 'function' && !canManageBrowserEntry(root, entry.relativePath)) {
          alert('Resolve or close the open diff for this item before changing it.');
          return;
        }
      }
      if (action === 'rename') {
        name = await showPromptDialog({ title: 'Rename ' + entry.name, label: 'Name', value: entry.name, confirm: 'Rename' });
        if (!name || name === entry.name) return;
      }
      const result = await window.api.manageProjectEntry(root, entry.relativePath, action, name);
      if (!result?.ok) throw new Error(result?.error || 'Could not complete the file action.');
      if (result.cancelled || (action !== 'rename' && action !== 'trash')) return;
      if (typeof applyProjectFileAction === 'function') await applyProjectFileAction(result);
      if (typeof applyBrowserFileAction === 'function') await applyBrowserFileAction(result);
    } catch (err) {
      alert(err.message || 'Could not complete the file action.');
    }
  };
  // Only offer what this tree can actually do.
  //
  // manageProjectEntry (open-folder / reveal / rename / trash) IS available
  // now: ./file-management.js was ported and wired at main.js's
  // 'manage-project-entry' handler, with containment coming from
  // project-files.js's resolveProjectEntry — the parent is resolved rather
  // than the leaf, so renaming or trashing a symlink acts on the link, and
  // both still have to land inside the project root.
  //
  // openFileExternally is still absent, deliberately. It was REMOVED in the
  // Phase 4 security pass: it exposed unconstrained shell.openPath on any
  // absolute path over contextBridge, with no extension allowlist and — at
  // that time — no caller. This file is that caller arriving one phase later,
  // which is a reason to restore the capability properly, not to revert the
  // deletion. Restoring it means re-adding it WITH the path containment that
  // removal was about; save-containment.js already has the shape.
  //
  // The gates below stay regardless. Rendering a row that throws into an alert
  // is worse than not rendering it: it tells the user the app can do something
  // it cannot. Each row is gated on the API it needs actually existing, so the
  // menu degrades instead of lying.
  const canManage = typeof window.api.manageProjectEntry === 'function';
  const canOpenExternally = typeof window.api.openFileExternally === 'function';

  const rows = [{ head: entry.name }];
  if (entry.type === 'directory') {
    if (canManage) rows.push({ label: 'Open folder', icon: PICONS.folder(14), onClick: run('open-folder') });
  } else if (entry.viewable || canOpenExternally) {
    rows.push({
      label: entry.viewable ? 'Open in editor / preview' : 'Open in default application',
      icon: PICONS.file(14), disabled: entry.type !== 'file', onClick: open,
    });
  }
  if (canManage) rows.push({ label: 'Reveal in ' + manager, icon: PICONS.open(14), onClick: run('reveal') });
  rows.push({ sep: true });
  rows.push({ label: 'Copy path', onClick: () => window.api.writeClipboard(projectEntryPath(root, entry.relativePath)) });
  rows.push({ label: 'Copy relative path', onClick: () => window.api.writeClipboard(entry.relativePath) });
  if (canManage) {
    rows.push({ sep: true });
    rows.push({ label: 'Rename…', icon: PICONS.pencil(14), onClick: run('rename') });
    rows.push({ label: 'Move to ' + trash + '…', icon: PICONS.trash(14), danger: true, onClick: run('trash') });
  }
  return rows;
}

function bindFileEntryMenu(row, root, entry, open) {
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(fileEntryMenuItems(root, entry, open), { x: event.clientX, y: event.clientY });
  });
  row.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(fileEntryMenuItems(root, entry, open), { anchor: row });
  });
}
