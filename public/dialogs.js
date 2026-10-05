// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const options = {};
  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }
  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;
  return options;
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  launchNewSession(project, options);
}

async function launchScheduleCreator(project) {
  const options = await resolveDefaultSessionOptions(project);
  // Pre-create a JSONL session with the schedule creation prompt, then resume into it
  const result = await window.api.createScheduleSession(project.projectPath);
  if (!result || !result.sessionId) return;

  const session = {
    sessionId: result.sessionId,
    summary: 'Create scheduled task',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 1,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Inject into sidebar
  const folder = encodeProjectPath(project.projectPath);
  pendingSessions.set(result.sessionId, { session, projectPath: project.projectPath, folder });
  sessionMap.set(result.sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === project.projectPath);
    if (!proj) {
      proj = { folder, projectPath: project.projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);
  // Resume the pre-seeded session. createScheduleSession has already written
  // the transcript, so say so: the seed carries no user message, which means it
  // never lands in the session cache, and main.js would otherwise read "not
  // cached" as "never got going" and launch --session-id against a file that
  // exists — which the CLI rejects with "Session ID … is already in use".
  options.hasTranscript = true;
  options.appendSystemPrompt = result.systemPrompt;
  const openResult = await window.api.openTerminal(result.sessionId, project.projectPath, false, options);
  if (!openResult.ok) {
    entry.terminal.write(`\r\nError: ${openResult.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(result.sessionId, !!openResult.mcpActive);
  showSession(result.sessionId);
  pollActiveSessions();
}

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  const claudeBtn = document.createElement('button');
  claudeBtn.className = 'popover-option';
  claudeBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude';
  claudeBtn.onclick = async () => { popover.remove(); launchNewSession(project, await resolveDefaultSessionOptions(project)); };

  const claudeOptsBtn = document.createElement('button');
  claudeOptsBtn.className = 'popover-option';
  claudeOptsBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude (Configure...)';
  claudeOptsBtn.onclick = () => { popover.remove(); showNewSessionDialog(project); };

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg> Terminal';
  termBtn.onclick = () => { popover.remove(); launchTerminalSession(project); };

  popover.appendChild(claudeBtn);
  popover.appendChild(claudeOptsBtn);
  popover.appendChild(termBtn);

  // Position relative to anchor, flip upward if it would overflow
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = rect.left + 'px';

  // Close on click outside
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

async function launchTerminalSession(project) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'Terminal',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
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

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'terminal' });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

/**
 * Mount the shared session-config form, or fall back to reporting why it
 * could not be mounted.
 *
 * SessionConfigForm.mount() can THROW, which the hand-rolled markup it
 * replaces could not: it runs the folder defaults through
 * SessionConfig.resolveOptions, and a stored value the registry does not
 * recognise — an old permissionMode left behind by a previous version, say —
 * raises "Invalid Permission Mode" before a single field is rendered. Letting
 * that escape would leave an empty dialog with a dead Start button, so the
 * message is shown and the dialog still opens.
 */
function mountSessionConfig(dialog, defaults) {
  const host = dialog.querySelector('.session-config-fields');
  const errorEl = dialog.querySelector('.session-config-error');
  try {
    return SessionConfigForm.mount(host, { runtime: 'claude', defaults });
  } catch (err) {
    errorEl.textContent = `Could not read these settings: ${err.message}`;
    return null;
  }
}

/**
 * Read the form, or show why it will not launch and return null.
 *
 * getOptions() validates, so this is a real failure path — a control
 * character pasted into Allowed Tools throws here. The old code could not
 * throw at all, so without the catch a bad value would kill the click handler
 * and the button would simply stop responding.
 */
function readSessionConfig(form, dialog) {
  const errorEl = dialog.querySelector('.session-config-error');
  errorEl.textContent = '';
  if (!form) return null;
  try {
    return form.getOptions();
  } catch (err) {
    errorEl.textContent = err.message;
    return null;
  }
}

async function showNewSessionDialog(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  dialog.innerHTML = `
    <h3>New Session — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error"></div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const form = mountSessionConfig(dialog, effective);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function start() {
    const options = readSessionConfig(form, dialog);
    if (!options) return;
    // Deliberately NOT filtered. getOptions() returns every registry key,
    // including permissionMode:null, model:'', worktreeName:'' and
    // mcpEmulation:false; main.js and buildLaunchArgs each guard on
    // truthiness, so the falsy ones emit no flag. Filtering here would only
    // put back the "missing or merely falsy?" ambiguity the registry removed.
    close();
    launchNewSession(project, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard support
  function onKey(e) {
    if (e.key === 'Escape') close();
    // textarea is new here: Additional System Prompt is multi-line, and Enter
    // inside it must insert a newline rather than launch the session.
    if (e.key === 'Enter' && !e.target.matches('input, textarea')) start();
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Resume Session — ${escapeHtml(sessionName)}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error"></div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Resume</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const form = mountSessionConfig(dialog, effective);
  // Resuming an existing session cannot move it into a fresh worktree — the
  // old dialog offered no worktree control for exactly that reason, and the
  // shared registry has no per-dialog field list. Hiding the rows keeps the
  // one registry while still not offering a setting that does nothing here.
  for (const key of ['worktree', 'worktreeName']) {
    const row = dialog.querySelector(`[data-config-field="${key}"]`);
    if (row) row.hidden = true;
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function resume() {
    const options = readSessionConfig(form, dialog);
    if (!options) return;
    // Whatever the registry resolved for the hidden worktree rows is dropped
    // rather than sent: a resume must not create one.
    delete options.worktree;
    delete options.worktreeName;
    close();
    openSession(session, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input, textarea')) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

// --- A new project opens with a session in it ---
// Jason: "When you start a new project a session should automatically open in
// that project". Both ways of making one end in openFirstSession: Add project
// on the sidebar (below) and New project on the Projects tab (projects-view.js).
//
// Whether an Add made a NEW project is main's answer (`created` in the
// add-project reply), not something worked out here. The first version looked
// the folder up in the reloaded project list and called it new when it was not
// found or had no sessions; a hidden project typed in another spelling, a path
// with a trailing slash and a known folder with no sessions all passed for new
// and got a session.

/**
 * Start Claude in `target` with the folder's default settings: what "Claude"
 * on a project's + menu does. Never throws and resolves to whether the launch
 * was handed over: the project exists either way, and a session that could
 * not be started must not look like a failed Add.
 */
async function openFirstSession(target, { runtime = null } = {}) {
  try {
    const options = await resolveDefaultSessionOptions(target);
    if (runtime) options.runtime = runtime;
    await launchNewSession(target, options);
    return true;
  } catch (err) {
    console.error('[auto-open] no session was started in the new project:', err);
    return false;
  }
}

function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Project</h3>
    <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + on its project header.</div>
    <div class="folder-input-row">
      <input type="text" id="add-project-path" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
      <button class="add-project-browse-btn">Browse</button>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = dialog.querySelector('#add-project-path');
  const errorEl = dialog.querySelector('#add-project-error');
  const addBtn = dialog.querySelector('.add-project-add-btn');
  pathInput.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  // Cancel, Escape and a click outside the dialog go through dismiss(): the
  // user sent the dialog away. While the request is out that cannot take the
  // Add back (main has it, and the project is made), but it does mean no
  // session: before, the reply opened one after the user had cancelled. Found
  // in review; Jason: "Fix both now". The dialog closing itself after a good
  // reply calls close(), which is not a dismissal.
  let dismissed = false;
  function dismiss() {
    dismissed = true;
    close();
  }

  // One Add at a time. The dialog and its Enter listener stay up until main
  // has answered, so a second Enter or click in that gap sent the request again
  // and, now that an Add opens a session, started two. The flag is what stops
  // it (Enter does not go through the button); the disabled button shows it.
  // It is given back only when the dialog stays open for another try.
  let adding = false;

  async function addProject() {
    if (adding) return;
    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      errorEl.textContent = 'Please enter a folder path.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    adding = true;
    addBtn.disabled = true;
    let result;
    try {
      result = await window.api.addProject(projectPath);
    } catch (err) {
      // A rejected call must give the flag back too, or the dialog is dead.
      result = { error: err.message };
    }
    if (!result || result.error) {
      adding = false;
      addBtn.disabled = false;
      errorEl.textContent = result?.error || 'Could not add the project.';
      errorEl.style.display = 'block';
      return;
    }
    close();

    await loadProjects();
    // Only a project this Add created opens with a session in it, under the
    // path main settled on (the typed one with its slashes and any trailing
    // separator put right). Jason, on a folder Switchboard already knows,
    // listed or hidden, with or without sessions: "No session". That one is
    // only shown again. An Add the user dismissed while the request was out
    // gets no session either: the project is in the list just reloaded, and
    // that is all.
    if (result.created === true && !dismissed) await openFirstSession({ projectPath: result.projectPath });
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    // A native folder picker is about to open: a marker for the focus watch.
    try { window.TermDiag && window.TermDiag.focusMark('browse-folder'); } catch {}
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  dialog.querySelector('.add-project-cancel-btn').onclick = dismiss;
  addBtn.onclick = addProject;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

  function onKey(e) {
    if (e.key === 'Escape') dismiss();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}

// --- In-page confirm and alert ---
// Nothing in the renderer opens a native confirm() or alert() box any more.
// On Windows, closing one can leave this Electron (41.0.3) window in a state
// where key-down still arrives but typed characters are dropped, until the
// window is deactivated and activated again. Electron PR 54380 describes it;
// its fix went to the 43, 44 and 45 lines only. Jason, the third time in one
// day: "can't edit session names again, need a permanent fix for this".
//
// Two differences from the native boxes that every caller has to know:
//   - confirmDialog() does not block; it returns a Promise, and a Promise is
//     truthy. `if (!confirmDialog(...)) return` would stop, delete or archive
//     without asking. Every call is `await confirmDialog(...)`, and
//     test/in-page-dialogs.test.js scans public/ for one that is not.
//   - alert() returns at once (it is replaced at the end of this section). A
//     caller whose next step has to wait until the message was dismissed uses
//     `await alertDialog(...)`.
//
// The look is the add-project dialog's (same classes); style.css adds only
// the layer, the message text, the danger button and the focus ring.

/** Requests waiting for their turn; the one on screen is not in here. */
const appDialogQueue = [];
let appDialogShowing = false;

// A click this soon after the box opened is not an answer to it. The second
// click of a double-click lands on the backdrop, or on a button that happens
// to be under the pointer, before the box has even been seen.
//
// Keys are held back for as long only when a key went down just before the box
// opened. That is a box the user did not see coming: the next one in the
// queue, opened by the Enter that answered the one before it, or one that
// appeared by itself (a reply came back) while they were typing in a terminal.
// Its focus is on the confirm button, which may be "Remove anyway". A box
// opened with the mouse answers its first key: "click Stop, press Enter" is
// meant to be fast.
const APP_DIALOG_GUARD_MS = 350;

// Nor is a click this soon after the last box was answered. Two boxes that
// follow each other put their buttons in the same place, so the second click
// of a slow double-click on "Detach" would land on "Remove checkout". It has
// to outlast a double-click, which the guard above does not, and it counts
// from the answer and not from the opening: the next box may come at once or
// after a reply from main. Keys are not held back by it: a key pressed after
// a click is a second decision, not the tail of the first.
const APP_DIALOG_AFTER_ANSWER_MS = 700;

/** When a box was last answered, with the mouse or a key. */
let appDialogLastAnswerAt = -Infinity;

/** When a key last went down anywhere in the window, box or no box. */
let appDialogLastKeyAt = -Infinity;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { appDialogLastKeyAt = performance.now(); }, true);
}

/**
 * Ask a yes/no question in the page. Resolves true for the confirm button,
 * false for Cancel, Escape and a click on the backdrop.
 *   confirm   the confirm button's label: the action's own verb ('Stop')
 *   danger    true where the action destroys or stops something
 */
function confirmDialog(message, { title, confirm = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return queueAppDialog({ message, title, confirm, cancel, danger });
}

/** Show a message in the page. Resolves, with nothing, once it is closed. */
function alertDialog(message, { title, ok = 'OK' } = {}) {
  return queueAppDialog({ message, title, confirm: ok, cancel: null, danger: false }).then(() => {});
}

// One box at a time, first in first out. Two failures can arrive together (a
// loop over worktrees, a reply landing while a question is open), and two
// stacked boxes would put the answer to the second on the keys meant for the
// first.
function queueAppDialog(request) {
  return new Promise((resolve) => {
    appDialogQueue.push({ ...request, resolve });
    showNextAppDialog();
  });
}

function showNextAppDialog() {
  if (appDialogShowing || !appDialogQueue.length) return;
  const request = appDialogQueue.shift();
  appDialogShowing = true;
  try {
    openAppDialog(request, (result) => {
      appDialogShowing = false;
      request.resolve(result);
      showNextAppDialog();
    });
  } catch (err) {
    // A box that could not be built is a "no": nothing was confirmed. Without
    // this the flag would stay up and every later question would wait forever.
    console.error('[dialog] could not show an in-page dialog:', err);
    appDialogShowing = false;
    request.resolve(false);
    showNextAppDialog();
  }
}

function openAppDialog(request, done) {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay app-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog app-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-describedby', 'app-dialog-message');

  // Text, never markup: messages carry session, project and file names.
  if (request.title) {
    const heading = document.createElement('h3');
    heading.textContent = String(request.title);
    dialog.appendChild(heading);
  }
  const text = document.createElement('div');
  text.className = 'app-dialog-message';
  text.id = 'app-dialog-message';
  text.textContent = String(request.message);
  dialog.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'add-project-actions';
  const makeButton = (className, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = String(label);
    actions.appendChild(btn);
    return btn;
  };
  // Cancel first, the action last, as in every other dialog here. An alert
  // has the one button.
  const cancelBtn = request.cancel === null ? null : makeButton('add-project-cancel-btn', request.cancel);
  const confirmBtn = makeButton('add-project-add-btn' + (request.danger ? ' app-dialog-danger' : ''), request.confirm);
  const buttons = cancelBtn ? [cancelBtn, confirmBtn] : [confirmBtn];
  dialog.appendChild(actions);
  overlay.appendChild(dialog);

  // Where the user was. For a terminal this is xterm's hidden textarea, and
  // going back to it is what lets typing carry on after the box.
  const previous = document.activeElement;
  const openedAt = performance.now();
  const tooSoon = () => performance.now() - openedAt < APP_DIALOG_GUARD_MS;
  const tooSoonToClick = () => tooSoon() || performance.now() - appDialogLastAnswerAt < APP_DIALOG_AFTER_ANSWER_MS;
  const openedWhileTyping = openedAt - appDialogLastKeyAt < APP_DIALOG_GUARD_MS;
  const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
  let finished = false;

  function finish(result) {
    if (finished) return;
    finished = true;
    appDialogLastAnswerAt = performance.now();
    for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
    overlay.remove();
    // Only if it is still on the page: the row or menu that asked may be gone.
    // preventScroll, as xterm itself focuses its textarea: that textarea sits
    // far off to the left until it is moved to the cursor, and a plain focus()
    // would scroll the terminal sideways to bring it into view.
    if (previous && previous !== document.body && previous.isConnected && typeof previous.focus === 'function') {
      try { previous.focus({ preventScroll: true }); } catch {}
    }
    done(result);
  }

  // On the window, in the capture phase: ahead of xterm, of the other dialogs'
  // document listeners (Enter in the add-project dialog adds the project) and
  // of the app's shortcuts. stopPropagation() and not the immediate kind, so
  // the diagnostics recorder, also a capture listener on the window, still
  // sees every key and Ctrl+Shift+D still works with a box open.
  function onKey(e) {
    e.stopPropagation();
    const active = document.activeElement;
    if (active && active !== document.body && !dialog.contains(active)) {
      // Something behind the box took the focus (code did: the backdrop keeps
      // the pointer out). Stopping the event is not enough there: the key's
      // default would still type or paste into it. Take the focus back, and
      // do not let this key answer the box either.
      e.preventDefault();
      confirmBtn.focus();
      if (e.key !== 'Escape') return;
    }
    // Alt+Space is the window menu; a Ctrl or Meta chord is somebody's shortcut.
    if (e.type !== 'keydown' || e.ctrlKey || e.altKey || e.metaKey) return;
    // Escape too: it would close an alert nobody has read, and its text is
    // kept nowhere else. A repeat is a key still held down, from before the
    // box or from answering the one before it: never an answer, however long
    // it is held.
    const answers = e.key === 'Escape' || e.key === 'Enter' || e.key === ' ';
    if (answers && (e.repeat || (openedWhileTyping && tooSoon()))) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const at = buttons.indexOf(document.activeElement);
      const next = at < 0 ? buttons.length - 1 : (at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
      buttons[next].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      // Enter presses the button that shows the focus ring, and only that: with
      // the focus on no button (after a click on the text), the first press
      // puts the ring back and the second one answers.
      const pressed = buttons.find((btn) => btn === document.activeElement);
      if (pressed) finish(pressed === confirmBtn);
      else confirmBtn.focus();
    }
  }

  for (const btn of buttons) {
    btn.addEventListener('click', () => { if (!tooSoonToClick()) finish(btn === confirmBtn); });
  }
  // The backdrop is a way out here, unlike in the dialogs that hold typed
  // work: there is nothing in this box to lose. Only a click that began on it,
  // though: dragging across the message to select it and letting go past the
  // edge of the box is also reported as a click on the backdrop.
  let pressedOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (pressedOnBackdrop && e.target === overlay && !tooSoonToClick()) finish(false); });

  // The box first: if it cannot be put on the page, no key listener is left
  // behind to swallow every key in the window.
  document.body.appendChild(overlay);
  for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
  // On the confirm button, as in the native box.
  confirmBtn.focus();
}

// alert() from anywhere in the renderer, including a caller nobody has listed,
// opens the in-page box. `inPage` is how the focus watch tells this function
// from the native one (terminal-diagnostics.js initFocusWatch), whichever of
// the two files gets to window.alert first. window.confirm is left native on
// purpose: nothing calls it any more, and the focus watch still wraps it, so a
// native confirm that comes back is recorded as a suspect.
function inPageAlert(message) {
  alertDialog(arguments.length ? String(message) : '');
}
inPageAlert.inPage = true;
if (typeof window !== 'undefined') window.alert = inPageAlert;
