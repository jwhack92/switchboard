// Spawns and tracks the tasks task-config.js resolved.
//
// Every task runs in its own PTY so its output is a real terminal (colors,
// progress bars, an interactive prompt), and the PTY lives in the main process
// so a renderer reload reattaches to a still-running server instead of
// orphaning it.
//
// Ported from upstream d4a51aa. Three differences, each because something this
// fork owns is not what upstream assumed:
//
//   1. TRUST GATE (security (c)). startTask refuses to spawn a (project, label)
//      pair the user has not explicitly confirmed, and returns the resolved
//      command graph for the renderer to show. The confirmation is bound to a
//      fingerprint of what actually runs, not to the label, so a trusted
//      "build" that becomes `curl | sh` after a git pull asks again.
//
//   2. baseEnv defaults to buildPtyEnv(process.env), not to process.env.
//      Upstream has no pty-env module. This fork's pty-env.js strips
//      ELECTRON_*, NODE_OPTIONS and the inherited CLAUDE_CODE_* session markers
//      (CLAUDE_CODE_MESSAGING_SOCKET/TOKEN, CLAUDE_CODE_CHILD_SESSION, ...)
//      from anything it spawns. Handing raw process.env to a task PTY would
//      point a task that runs `claude` at the PARENT session's IPC channel and
//      make its transcript silently not save -- the exact failure pty-env.js
//      exists to prevent, reintroduced through a second spawn path. The host
//      should still pass its own `baseEnv` (main.js already has cleanPtyEnv at
//      main.js:65); this default only makes the module safe on its own.
//
//   3. node-pty is required lazily, so requiring this module in a plain
//      `node --test` process does not pull in the native addon.
//
// Renderer-facing serialization deliberately drops `env`: the values can be
// secrets read out of a project's own .env. Names travel as `envKeys`.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  describeTaskRun,
  isTaskTrusted,
  loadProjectTasks,
  recordTaskTrust,
  resolveTaskGraph,
  taskFileForWorkspace,
  taskRunFingerprint,
} = require('./task-config');
const { buildPtyEnv } = require('./pty-env');
const {
  isWslShell,
  quoteArgForShell,
  quoteArgvForShell,
  resolveShell,
  shellArgs,
  windowsToWslPath,
} = require('./shell-profiles');

const MAX_BUFFER_SIZE = 256 * 1024;

let nodePty = null;
function defaultPty() {
  if (!nodePty) nodePty = require('node-pty');
  return nodePty;
}

function taskKey(projectPath, label) {
  return `${projectPath}\0${label}`;
}

function createTaskManager(options = {}) {
  const runs = new Map();
  const watchers = new Map();
  const spawnPty = options.pty || null;
  const loadTasks = options.loadProjectTasks || loadProjectTasks;
  const baseEnv = options.baseEnv || buildPtyEnv(process.env);
  const logger = options.log || console;
  const send = options.send || (() => {});
  const getShellProfile = options.getShellProfile || (() => resolveShell('auto'));
  // Project worktrees live under <project>/repos/<name>, which the path-shape
  // inference in task-config cannot see; the caller looks their parent up.
  const resolveParent = options.resolveWorktreeParent || (() => null);

  // (c) Trust store. In-memory unless the host injects persistence, which is
  // the safe default: with no store, every task asks on its first run of the
  // session rather than silently inheriting someone else's answer.
  let memoryTrust = options.initialTrust ? { ...options.initialTrust } : {};
  const readTrust = options.readTrust || (() => memoryTrust);
  const writeTrust = options.writeTrust || (store => { memoryTrust = store; });

  function serializeRun(run, includeOutput = false) {
    if (!run) return null;
    const result = {
      projectPath: run.projectPath,
      label: run.label,
      type: run.type,
      state: run.state,
      running: run.state === 'running',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
      stopRequested: !!run.stopRequested,
      virtual: !!run.virtual,
    };
    if (includeOutput) result.output = run.outputBuffer.join('');
    return result;
  }

  function emitState(run) {
    send('task-state-changed', serializeRun(run));
  }

  function trimBuffer(run) {
    while (run.outputBufferSize > MAX_BUFFER_SIZE && run.outputBuffer.length > 1) {
      run.outputBufferSize -= Buffer.byteLength(run.outputBuffer.shift());
    }
  }

  function appendOutput(run, data, visited = new Set()) {
    if (!run || visited.has(run.key)) return;
    visited.add(run.key);
    const text = String(data);
    run.outputBuffer.push(text);
    run.outputBufferSize += Buffer.byteLength(text);
    trimBuffer(run);
    send('task-output', run.projectPath, run.label, text);
    for (const subscriberKey of run.subscribers) {
      appendOutput(runs.get(subscriberKey), text, visited);
    }
  }

  function createRun(projectPath, task) {
    const key = taskKey(projectPath, task.label);
    let run = runs.get(key);
    if (!run) {
      run = {
        key,
        projectPath,
        label: task.label,
        type: task.type,
        state: 'idle',
        outputBuffer: [],
        outputBufferSize: 0,
        subscribers: new Set(),
        children: new Set(),
      };
      runs.set(key, run);
    }
    run.type = task.type;
    return run;
  }

  function resetRun(run, { virtual = false } = {}) {
    run.state = 'running';
    run.virtual = virtual;
    run.startedAt = Date.now();
    run.endedAt = null;
    run.exitCode = null;
    run.signal = null;
    run.error = null;
    run.stopRequested = false;
    run.outputBuffer = [];
    run.outputBufferSize = 0;
    run.children = new Set();
    run.orchestrationPending = virtual;
    run.process = null;
    emitState(run);
  }

  function effectiveEnv(task) {
    const env = {
      ...baseEnv,
      TERM: baseEnv.TERM || 'xterm-256color',
      COLORTERM: baseEnv.COLORTERM || 'truecolor',
      FORCE_COLOR: baseEnv.FORCE_COLOR || '1',
      ...(task.env || {}),
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === null) delete env[name];
      else if (value !== undefined) env[name] = String(value);
    }
    return env;
  }

  function spawnSpec(task, projectPath) {
    if (!fs.existsSync(task.cwd)) throw new Error(`Task working directory does not exist: ${task.cwd}`);

    // Always launch tasks through the selected login shell. Packaged desktop
    // apps inherit a minimal environment from LaunchServices, while the login
    // shell restores the user's PATH (Homebrew, nvm, pyenv, and similar).
    // Process-task executables and arguments remain individually quoted below,
    // so they do not gain shell-expression semantics.
    const profile = getShellProfile(projectPath);
    const shell = profile.path;
    const extraArgs = [...(profile.args || [])];
    let cwd = task.cwd;
    if (isWslShell(shell)) {
      extraArgs.unshift('--cd', windowsToWslPath(cwd));
      // wsl.exe itself needs a Windows cwd.
      cwd = projectPath;
    }
    const command = task.type === 'shell'
      ? `${task.executable}${task.args.length ? ` ${quoteArgvForShell(shell, task.args)}` : ''}`
      : `${quoteArgForShell(shell, task.executable)}${task.args.length ? ` ${quoteArgvForShell(shell, task.args)}` : ''}`;
    return { executable: shell, args: shellArgs(shell, command, extraArgs), cwd };
  }

  function syncCompound(run) {
    if (!run?.virtual || run.state !== 'running' || run.orchestrationPending) return;
    const children = [...run.children].map(key => runs.get(key)).filter(Boolean);
    if (children.some(child => child.state === 'running')) return;
    run.endedAt = Date.now();
    if (run.stopRequested || children.some(child => child.state === 'stopped')) run.state = 'stopped';
    else if (children.some(child => child.state === 'failed' || (child.exitCode ?? 0) !== 0)) run.state = 'failed';
    else run.state = 'exited';
    emitState(run);
  }

  function finishRun(run, exitCode, signal) {
    const exitDescription = run.stopRequested
      ? 'Task stopped'
      : `Task exited${exitCode == null ? '' : ` with code ${exitCode}`}${signal ? ` (signal ${signal})` : ''}`;
    appendOutput(run, `\r\n[${exitDescription}]\r\n`);
    run.endedAt = Date.now();
    run.exitCode = exitCode;
    run.signal = signal;
    run.process = null;
    run.state = run.stopRequested ? 'stopped' : (exitCode === 0 ? 'exited' : 'failed');
    emitState(run);
    if (run.resolveExit) run.resolveExit(run);
    run.resolveExit = null;
    for (const subscriberKey of run.subscribers) syncCompound(runs.get(subscriberKey));
  }

  function spawnLeaf(run, task) {
    if (run.state === 'running' && run.process) return run;
    resetRun(run);
    try {
      const spec = spawnSpec(task, run.projectPath);
      logger.info(`[task] ${task.label}: ${spec.executable} ${spec.args.join(' ')}`);
      run.process = (spawnPty || defaultPty()).spawn(spec.executable, spec.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: spec.cwd,
        env: effectiveEnv(task),
      });
    } catch (error) {
      run.error = error.message;
      appendOutput(run, `\r\nTask failed to start: ${error.message}\r\n`);
      finishRun(run, null, null);
      throw error;
    }
    run.exitPromise = new Promise(resolve => { run.resolveExit = resolve; });
    run.process.onData(data => appendOutput(run, data));
    run.process.onExit(({ exitCode, signal }) => finishRun(run, exitCode, signal));
    return run;
  }

  async function launchNode(node, rootRun, isRoot = false) {
    if (rootRun.stopRequested) return rootRun;
    const { task, dependencies } = node;
    if (task.type !== 'compound') {
      const run = isRoot ? rootRun : createRun(rootRun.projectPath, task);
      if (!isRoot) {
        run.subscribers.add(rootRun.key);
        rootRun.children.add(run.key);
        if (run.state === 'running' && run.outputBuffer.length) {
          appendOutput(rootRun, run.outputBuffer.join(''));
        }
      }
      return spawnLeaf(run, task);
    }

    const launchDependency = dependency => launchNode(dependency, rootRun, false);
    if (task.dependsOrder === 'sequence') {
      for (const dependency of dependencies) {
        if (rootRun.stopRequested) break;
        const child = await launchDependency(dependency);
        if (!dependency.task.isBackground && child.exitPromise) await child.exitPromise;
      }
    } else {
      await Promise.all(dependencies.map(launchDependency));
    }
    return rootRun;
  }

  // (a)+(c) Everything a human needs to decide, and the fingerprint that
  // decision is bound to. Never carries an env VALUE.
  function describeRun(projectPath, label, tasks) {
    const description = describeTaskRun(tasks, label);
    return { ...description, projectPath, fingerprint: taskRunFingerprint(description, tasks) };
  }

  function taskConfirmation(projectPath, label) {
    try {
      const tasks = loadTasks(projectPath, { parentPath: resolveParent(projectPath) });
      const description = describeRun(projectPath, label, tasks);
      return {
        ...description,
        trusted: isTaskTrusted(readTrust(), projectPath, label, description.fingerprint),
        error: null,
      };
    } catch (error) {
      return { projectPath, label, steps: [], fingerprint: null, trusted: false, error: error.message };
    }
  }

  function trustTask(projectPath, label, fingerprint) {
    const current = taskConfirmation(projectPath, label);
    // Only ever record the fingerprint we just recomputed from disk. Accepting
    // the renderer's copy would let a stale dialog authorize a command the file
    // no longer contains.
    if (current.error || !current.fingerprint) return { ok: false, error: current.error || 'Task could not be resolved' };
    if (fingerprint && fingerprint !== current.fingerprint) {
      return { ok: false, error: 'The task changed since it was shown. Review it again.', confirmation: current };
    }
    writeTrust(recordTaskTrust(readTrust(), projectPath, label, current.fingerprint));
    return { ok: true, fingerprint: current.fingerprint };
  }

  function startTask(projectPath, label, runOptions = {}) {
    const existing = runs.get(taskKey(projectPath, label));
    if (existing?.state === 'running') return serializeRun(existing, true);
    let tasks;
    try {
      // Use the same source lookup as the menu, including inherited worktree tasks.
      tasks = loadTasks(projectPath, { parentPath: resolveParent(projectPath) });
      const graph = resolveTaskGraph(tasks, label);

      // (c) The gate. It sits ahead of createRun so a refused task leaves no
      // run record behind, and ahead of every spawn including a compound's
      // dependencies -- confirming "dev" confirms the whole graph it launches.
      const description = describeRun(projectPath, label, tasks);
      if (!isTaskTrusted(readTrust(), projectPath, label, description.fingerprint)) {
        if (!runOptions.confirmed) {
          return {
            projectPath,
            label,
            state: 'idle',
            running: false,
            needsConfirmation: true,
            confirmation: { ...description, trusted: false, error: null },
          };
        }
        if (runOptions.fingerprint && runOptions.fingerprint !== description.fingerprint) {
          // The file changed between the dialog and the click. Re-ask rather
          // than run something the user was never shown.
          return {
            projectPath,
            label,
            state: 'idle',
            running: false,
            needsConfirmation: true,
            confirmation: { ...description, trusted: false, error: 'The task changed since it was shown. Review it again.' },
          };
        }
        writeTrust(recordTaskTrust(readTrust(), projectPath, label, description.fingerprint));
      }

      const rootRun = createRun(projectPath, graph.task);
      resetRun(rootRun, { virtual: graph.task.type === 'compound' });
      Promise.resolve()
        .then(() => launchNode(graph, rootRun, true))
        .catch(error => {
          // A root spawn failure was already recorded by spawnLeaf.
          if (rootRun.state === 'failed') return;
          rootRun.error = error.message;
          appendOutput(rootRun, `\r\nTask failed: ${error.message}\r\n`);
          rootRun.state = 'failed';
          rootRun.endedAt = Date.now();
          emitState(rootRun);
        })
        .finally(() => {
          rootRun.orchestrationPending = false;
          syncCompound(rootRun);
        });
      return serializeRun(rootRun, true);
    } catch (error) {
      // Configuration and dependency errors happen before spawning. Retain them
      // just like process output so View log works after the menu is reopened.
      const task = tasks?.find(item => item.label === label) || { label, type: 'shell' };
      const run = createRun(projectPath, task);
      resetRun(run, { virtual: task.type === 'compound' });
      run.orchestrationPending = false;
      run.error = error.message;
      appendOutput(run, `\r\nTask failed to start: ${error.message}\r\n`);
      finishRun(run, null, null);
      return serializeRun(run, true);
    }
  }

  function stopTask(projectPath, label) {
    const run = runs.get(taskKey(projectPath, label));
    if (!run || run.state !== 'running') return { ok: false, error: 'Task is not running' };
    run.stopRequested = true;
    const targets = run.virtual ? [...run.children].map(key => runs.get(key)) : [run];
    for (const target of targets) {
      if (target?.state !== 'running') continue;
      target.stopRequested = true;
      try { target.process?.kill(); } catch (error) { logger.warn(`[task] stop ${target.label}: ${error.message}`); }
    }
    if (!run.virtual && !run.process) {
      run.state = 'stopped';
      run.endedAt = Date.now();
    }
    if (run.virtual && !targets.some(target => target?.state === 'running')) {
      run.orchestrationPending = false;
      syncCompound(run);
    }
    emitState(run);
    return { ok: true };
  }

  function restartTask(projectPath, label, runOptions = {}) {
    const run = runs.get(taskKey(projectPath, label));
    if (run?.state === 'running') {
      // A restart re-reads tasks.json, so it goes through the same gate as a
      // start. Check it BEFORE stopping: refusing after the kill would leave a
      // running server dead and nothing put back.
      const gate = taskConfirmation(projectPath, label);
      if (!runOptions.confirmed && !gate.error && !gate.trusted) {
        return { projectPath, label, state: run.state, running: true, needsConfirmation: true, confirmation: gate };
      }
      stopTask(projectPath, label);
      const waitForExit = run.virtual
        ? Promise.all([...run.children].map(key => runs.get(key)?.exitPromise).filter(Boolean))
        : run.exitPromise;
      Promise.resolve(waitForExit).finally(() => startTask(projectPath, label, runOptions));
      return { ok: true, restarting: true };
    }
    return startTask(projectPath, label, runOptions);
  }

  function stopAllTasks(projectPath) {
    const activeRuns = [...runs.values()]
      .filter(run => run.projectPath === projectPath && run.state === 'running')
      .sort((a, b) => Number(b.virtual) - Number(a.virtual));
    for (const run of activeRuns) {
      // Stopping a compound marks its children too, so do not kill the same
      // process a second time when those child runs are visited below.
      if (!run.stopRequested && run.state === 'running') stopTask(projectPath, run.label);
    }
    return { ok: true, stopped: activeRuns.length };
  }

  function sendInput(projectPath, label, data) {
    const run = runs.get(taskKey(projectPath, label));
    const targets = run?.virtual ? [...run.children].map(key => runs.get(key)) : [run];
    for (const target of targets) {
      if (target?.state === 'running') target.process?.write(data);
    }
  }

  function resize(projectPath, label, cols, rows) {
    const run = runs.get(taskKey(projectPath, label));
    const targets = run?.virtual ? [...run.children].map(key => runs.get(key)) : [run];
    for (const target of targets) {
      if (target?.state !== 'running') continue;
      try { target.process?.resize(Math.max(2, cols), Math.max(1, rows)); } catch {}
    }
  }

  function getRun(projectPath, label) {
    return serializeRun(runs.get(taskKey(projectPath, label)), true);
  }

  function ensureWatch(projectPath) {
    if (watchers.has(projectPath)) return;
    const projectWatchers = [];
    if (!fs.existsSync(projectPath)) {
      watchers.set(projectPath, projectWatchers);
      return;
    }
    let timer = null;
    let watchesVscodeDirectory = false;
    const changed = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send('project-tasks-changed', projectPath);
      }, 150);
    };
    const vscodeDir = path.join(projectPath, '.vscode');
    const watchVscodeDirectory = () => {
      if (watchesVscodeDirectory || !fs.existsSync(vscodeDir)) return;
      try {
        projectWatchers.push(fs.watch(vscodeDir, (_event, filename) => {
          if (!filename || String(filename) === 'tasks.json') changed();
        }));
        watchesVscodeDirectory = true;
      } catch (error) {
        logger.debug?.(`[task] could not watch ${vscodeDir}: ${error.message}`);
      }
    };
    try {
      projectWatchers.push(fs.watch(projectPath, (_event, filename) => {
        if (!filename || String(filename) === '.vscode') {
          watchVscodeDirectory();
          changed();
        }
      }));
      watchVscodeDirectory();
      const taskSource = taskFileForWorkspace(projectPath, fs.existsSync, resolveParent(projectPath));
      if (taskSource?.inherited) {
        projectWatchers.push(fs.watch(path.dirname(taskSource.filePath), (_event, filename) => {
          if (!filename || String(filename) === 'tasks.json') changed();
        }));
      }
    } catch (error) {
      logger.debug?.(`[task] could not watch ${projectPath}: ${error.message}`);
    }
    watchers.set(projectPath, projectWatchers);
  }

  function listTasks(projectPath) {
    ensureWatch(projectPath);
    const parentPath = resolveParent(projectPath);
    const taskSource = taskFileForWorkspace(projectPath, fs.existsSync, parentPath);
    try {
      const tasks = loadTasks(projectPath, { parentPath });
      const trust = readTrust();
      return {
        tasks: tasks.map(task => {
          let fingerprint = null;
          // An unsupported or cyclic task has no runnable graph; it cannot be
          // trusted and does not need to be, because it will never spawn.
          try { fingerprint = describeRun(projectPath, task.label, tasks).fingerprint; } catch {}
          return {
            ...task,
            taskSource,
            // (a) commandLine / cwd / envFile / envKeys stay ON the row: the
            // popover has to show what runs without a second round trip.
            // `env` does not -- its values can be secrets from the project's
            // own .env, and the renderer has no use for them.
            env: undefined,
            fingerprint,
            trusted: isTaskTrusted(trust, projectPath, task.label, fingerprint),
            run: serializeRun(runs.get(taskKey(projectPath, task.label))),
          };
        }),
        error: null,
        hasTaskFile: !!taskSource,
      };
    } catch (error) {
      return { tasks: [], error: error.message, hasTaskFile: !!taskSource };
    }
  }

  function listTasksForProjects(projectPaths) {
    return Object.fromEntries(projectPaths.map(projectPath => [projectPath, listTasks(projectPath)]));
  }

  function shutdown() {
    for (const run of runs.values()) {
      if (run.state === 'running' && run.process) {
        try { run.process.kill(); } catch {}
      }
    }
    for (const projectWatchers of watchers.values()) {
      for (const watcher of projectWatchers) watcher.close();
    }
    watchers.clear();
  }

  return {
    getRun,
    getTaskConfirmation: taskConfirmation,
    listTasks,
    listTasksForProjects,
    resize,
    restartTask,
    sendInput,
    shutdown,
    startTask,
    stopAllTasks,
    stopTask,
    trustTask,
  };
}

module.exports = { createTaskManager, taskKey };
