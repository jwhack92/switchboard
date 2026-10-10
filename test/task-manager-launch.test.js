'use strict';
// Task L (launch without Git Bash), part c: how task-manager.js starts a task on
// Windows. A process task whose program is an .exe or .com starts directly; an
// .cmd, .bat or a program that is not found, and npm and shell tasks, go through
// the project's shell, and for PowerShell with the guarded exit. Off Windows, and
// for a shell that is not PowerShell, the spawn is what it was before.
//
// Plain node. The real task-manager.js with createTaskManager({ platform, fs,
// pty: fake }): no process is started, no tasks.json is read, nothing is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { createTaskManager } = require('../task-manager');
const { windowsCommandLine, EXIT_SUFFIX } = require('../launch-plan');

const PROJECT = 'C:\\repo\\tasks-launch';
const CWD = os.tmpdir(); // a task's folder must exist; nothing is written to it
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const AUTO_PWSH = { id: 'auto', name: 'Auto', path: PWSH, args: [] };
const BASE_ENV = { Path: 'C:\\nodejs;C:\\Windows\\System32' };

/** A task as task-config.js hands it over. */
const task = (label, more = {}) => ({
  label, type: 'process', supported: true, dependsOn: [], isBackground: false,
  executable: 'node', args: [], cwd: CWD, env: {}, commandLine: label, ...more,
});

/** A fs stand-in: only the files in `files` exist (for the PATH search). */
function fakeFs(files = []) {
  const set = new Set(files);
  return { existsSync: (p) => set.has(p), lstatSync: () => undefined };
}

/** A node-pty stand-in that records every spawn. */
function fakePty() {
  const calls = [];
  return {
    calls,
    spawn(executable, args, options) {
      const proc = {
        kill() {}, write() {}, resize() {},
        onData() {}, onExit() {},
      };
      calls.push({ executable, args, options });
      return proc;
    },
  };
}

function boot({ platform = 'win32', files = [], profile = AUTO_PWSH, baseEnv = BASE_ENV, tasks }) {
  const pty = fakePty();
  const infos = [];
  const manager = createTaskManager({
    platform,
    fs: fakeFs(files),
    pty,
    loadProjectTasks: () => tasks,
    baseEnv,
    log: { info: (line) => infos.push(line), warn() {}, error() {}, debug() {} },
    send: () => {},
    getShellProfile: () => profile,
  });
  return { manager, pty, infos };
}

/** The runner starts processes one turn after startTask answers; this lets those turns pass. No waiting on a clock. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Starts a task the way a confirmed click does; answers the one spawn it made. */
async function launch(setup, label) {
  const { manager, pty, infos } = boot(setup);
  manager.startTask(PROJECT, label, { confirmed: true });
  await settle();
  assert.equal(pty.calls.length, 1, 'one spawn');
  return { call: pty.calls[0], infos, manager };
}

const pathKeys = (env) => Object.keys(env).filter(key => key.toLowerCase() === 'path');

test('task-manager-launch: on Windows a process task whose program is an .exe starts that file directly, with a windowsCommandLine string', async () => {
  const args = ['-e', 'say "hi"', 'C:\\dir\\', 'a b'];
  const tasks = [task('run-node', { args })];
  const { call } = await launch({ files: ['C:\\nodejs\\node.exe'], tasks }, 'run-node');
  assert.equal(call.executable, 'C:\\nodejs\\node.exe');
  assert.equal(typeof call.args, 'string', 'node-pty appends a string as it is');
  assert.equal(call.args, windowsCommandLine(args));
  assert.equal(call.options.cwd, CWD);

  const plain = await launch({ files: ['C:\\nodejs\\node.exe'], tasks: [task('run-node', { args: ['-e', 'x y'] })] }, 'run-node');
  assert.equal(plain.call.args, '"-e" "x y"');

  const none = await launch({ files: ['C:\\nodejs\\node.exe'], tasks: [task('run-node')] }, 'run-node');
  assert.equal(none.call.executable, 'C:\\nodejs\\node.exe');
  assert.equal(none.call.args, '', 'no arguments: an empty string');
});

test('task-manager-launch: a program named with a folder (./tool.exe) is searched from the task folder', async () => {
  const tool = path.win32.join(CWD, 'tool.exe');
  const tasks = [task('tool', { executable: './tool.exe', args: ['--go'] })];
  const { call } = await launch({ files: [tool], tasks }, 'tool');
  assert.equal(call.executable, tool);
  assert.equal(call.args, '"--go"');
});

test('task-manager-launch: a task whose env sets PATH finds its own program, and the env handed to the pty holds ONE PATH key with the task value', async () => {
  const tasks = [task('own-node', { env: { PATH: 'C:\\mine' } })];
  const { call } = await launch({ files: ['C:\\nodejs\\node.exe', 'C:\\mine\\node.exe'], tasks }, 'own-node');
  assert.equal(call.executable, 'C:\\mine\\node.exe', 'the task PATH is searched, not the base Path');
  assert.deepEqual(pathKeys(call.options.env), ['PATH']);
  assert.equal(call.options.env.PATH, 'C:\\mine');
});

test('task-manager-launch: on Windows keys that differ only in case collapse to one, the last value wins (D11)', async () => {
  const tasks = [task('dups')];
  const { call } = await launch({ files: ['C:\\b\\node.exe'], baseEnv: { Path: 'C:\\a', PATH: 'C:\\b' }, tasks }, 'dups');
  assert.deepEqual(pathKeys(call.options.env), ['PATH']);
  assert.equal(call.options.env.PATH, 'C:\\b');
  assert.equal(call.executable, 'C:\\b\\node.exe');
});

test('task-manager-launch: a process task found as .cmd or .bat goes through pwsh -NoLogo -NoProfile -Command with & \'<path>\' and the guarded exit', async () => {
  const tasks = [task('cmd-task', { executable: 'tool', args: ['a b'] })];
  const cmd = await launch({ files: ['C:\\nodejs\\tool.cmd'], tasks }, 'cmd-task');
  assert.equal(cmd.call.executable, PWSH);
  assert.equal(typeof cmd.call.args, 'string');
  assert.equal(cmd.call.args, windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', "& 'C:\\nodejs\\tool.cmd' 'a b'; " + EXIT_SUFFIX]));

  const bat = await launch({ files: ['C:\\nodejs\\tool.bat'], tasks }, 'cmd-task');
  assert.equal(bat.call.args, windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', "& 'C:\\nodejs\\tool.bat' 'a b'; " + EXIT_SUFFIX]));
});

test('task-manager-launch: a process task whose program is not found goes through the shell, with the guarded exit', async () => {
  const tasks = [task('ghost', { executable: 'ghost-tool', args: ['x'] })];
  const { call } = await launch({ files: [], tasks }, 'ghost');
  assert.equal(call.executable, PWSH);
  assert.equal(call.args, windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', "& 'ghost-tool' 'x'; " + EXIT_SUFFIX]));
});

test('task-manager-launch: an npm task under pwsh is & \'npm.cmd\' \'run\' \'x\' with the guarded exit', async () => {
  const tasks = [task('npm-x', { type: 'npm', executable: 'npm.cmd', args: ['run', 'x'], useShell: true })];
  const { call } = await launch({ files: ['C:\\nodejs\\npm.cmd'], tasks }, 'npm-x');
  assert.equal(call.executable, PWSH);
  assert.equal(call.args, windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', "& 'npm.cmd' 'run' 'x'; " + EXIT_SUFFIX]));
});

test('task-manager-launch: a shell task under pwsh is its raw text, a newline, then the guarded exit', async () => {
  const text = windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', 'echo hello # note\n' + EXIT_SUFFIX]);
  const plain = await launch({ tasks: [task('sh-task', { type: 'shell', executable: 'echo hello # note', useShell: true })] }, 'sh-task');
  assert.equal(plain.call.executable, PWSH);
  assert.equal(plain.call.args, text);

  const withArgs = await launch({ tasks: [task('sh-args', { type: 'shell', executable: 'Get-ChildItem', args: ['a b'], useShell: true })] }, 'sh-args');
  assert.equal(withArgs.call.args, windowsCommandLine(['-NoLogo', '-NoProfile', '-Command', "Get-ChildItem 'a b'\n" + EXIT_SUFFIX]));
});

test('task-manager-launch: the log line prints a string args as it is, an array joined', async () => {
  const direct = await launch({ files: ['C:\\nodejs\\node.exe'], tasks: [task('log-direct', { args: ['-e', 'x y'] })] }, 'log-direct');
  assert.deepEqual(direct.infos, ['[task] log-direct: C:\\nodejs\\node.exe "-e" "x y"']);

  const bash = await launch({ profile: { id: 'git-bash', name: 'Git Bash', path: GIT_BASH }, tasks: [task('log-bash', { type: 'shell', executable: 'echo hi' })] }, 'log-bash');
  assert.deepEqual(bash.infos, ['[task] log-bash: ' + GIT_BASH + ' -l -i -c echo hi']);
});

test('task-manager-launch: with a picked Git Bash the npm, shell and process tasks keep today\'s arrays on Windows', async () => {
  const profile = { id: 'git-bash', name: 'Git Bash', path: GIT_BASH };
  const npm = await launch({ profile, files: ['C:\\nodejs\\npm.cmd'], tasks: [task('npm-x', { type: 'npm', executable: 'npm.cmd', args: ['run', 'x'], useShell: true })] }, 'npm-x');
  assert.equal(npm.call.executable, GIT_BASH);
  assert.deepEqual(npm.call.args, ['-l', '-i', '-c', "'npm.cmd' 'run' 'x'"]);

  const shell = await launch({ profile, tasks: [task('sh-task', { type: 'shell', executable: 'echo hello', useShell: true })] }, 'sh-task');
  assert.deepEqual(shell.call.args, ['-l', '-i', '-c', 'echo hello']);

  const proc = await launch({ profile, files: ['C:\\nodejs\\node.exe'], tasks: [task('node-x', { args: ['-e', 'x y'] })] }, 'node-x');
  assert.equal(proc.call.executable, GIT_BASH, 'a shell that is not PowerShell: today\'s spawn, found .exe or not');
  assert.deepEqual(proc.call.args, ['-l', '-i', '-c', "'node' '-e' 'x y'"]);
});

test('task-manager-launch: darwin and linux spawn exactly what they spawned before: the shell, its arrays, both env keys kept', async () => {
  for (const platform of ['darwin', 'linux']) {
    const env = { Path: '/a', PATH: '/b' };
    const expectedEnv = { Path: '/a', PATH: '/b', TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' };

    const zsh = await launch({ platform, files: ['C:\\nodejs\\node.exe'], baseEnv: env, profile: { id: 'auto', name: 'Auto', path: '/bin/zsh', args: [] }, tasks: [task('node-x', { args: ['-e', 'x y'] })] }, 'node-x');
    assert.equal(zsh.call.executable, '/bin/zsh', platform);
    assert.deepEqual(zsh.call.args, ['-l', '-i', '-c', "'node' '-e' 'x y'"], platform);
    assert.equal(zsh.call.options.cwd, CWD, platform);
    assert.deepEqual(zsh.call.options.env, expectedEnv, platform);

    const pwsh = await launch({ platform, baseEnv: env, profile: { id: 'pwsh', name: 'PowerShell 7', path: '/usr/local/bin/pwsh', args: [] }, tasks: [task('npm-x', { type: 'npm', executable: 'npm', args: ['run', 'x'], useShell: true })] }, 'npm-x');
    assert.equal(pwsh.call.executable, '/usr/local/bin/pwsh', platform);
    assert.deepEqual(pwsh.call.args, ['-NoLogo', '-Command', "'npm' 'run' 'x'"], platform);
    assert.deepEqual(pwsh.call.options.env, expectedEnv, platform);
  }
});
