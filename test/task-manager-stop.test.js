'use strict';
// PIN (Phase 1b of the relaunch work, written before any fix).
//
// The Tasks runner, task-manager.js: what Stop, "stop all", typed input, a
// resize and a restart do to the processes of running tasks. None of this had
// a test (test/task-config.test.js covers the config and the trust gate).
//
// The crash guard gives the runner its own "kill was sent" flag. The cases
// here are the ones that must come through that unchanged. Two things are left
// open ON PURPOSE, because that flag is expected to change them: what a second
// Stop does while the first kill is still on its way, and whether input or a
// resize still reaches a process between its Stop and its end.
//
// Plain node. The real task-manager.js with createTaskManager({ pty: fake }):
// no process is started, no tasks.json is read, nothing is written to disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const { createTaskManager } = require('../task-manager');

const PROJECT = 'C:\\repo\\tasks-pin';
const OTHER_PROJECT = 'C:\\repo\\tasks-pin-other';
const CWD = os.tmpdir(); // a task's folder must exist; nothing is written to it
const NOT_RUNNING = 'Task is not running';

/** A task that runs one command, as task-config.js hands it over. */
const leaf = (label, more = {}) => ({
  label, type: 'shell', supported: true, dependsOn: [], isBackground: false,
  executable: 'run-' + label, args: [], cwd: CWD, env: {}, commandLine: 'run-' + label, ...more,
});
/** A task that only starts other tasks. */
const compound = (label, dependsOn, dependsOrder = 'parallel') => ({
  label, type: 'compound', supported: true, dependsOn, dependsOrder, isBackground: false, cwd: CWD, commandLine: '',
});

const TASKS = [
  leaf('solo'), leaf('a'), leaf('b'), compound('both', ['a', 'b']),
  leaf('first'), leaf('second'), compound('steps', ['first', 'second'], 'sequence'),
];

/** A node-pty stand-in: every spawn gives a process that counts what is done to it. */
function fakePty() {
  const procs = [];
  return {
    procs,
    spawn(executable, args, options) {
      const proc = {
        command: args[args.length - 1],
        kills: 0, writes: [], resizes: [], resizeThrows: false,
        kill() { proc.kills++; },
        write(data) { proc.writes.push(data); },
        resize(cols, rows) {
          proc.resizes.push([cols, rows]);
          if (proc.resizeThrows) throw new Error('the pty has gone');
        },
        onData(fn) { proc.emitData = fn; },
        onExit(fn) { proc.emitExit = fn; },
        /** The process ends, as node-pty reports it. */
        end(exitCode = 0, signal) { proc.emitExit({ exitCode, signal }); },
      };
      procs.push(proc);
      return proc;
    },
  };
}

function boot() {
  const pty = fakePty();
  const sent = [];
  const manager = createTaskManager({
    pty,
    loadProjectTasks: () => TASKS,
    baseEnv: { PATH: 'C:\\fake\\bin' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    send: (...args) => sent.push(args),
    getShellProfile: () => ({ path: '/bin/sh', args: [] }),
  });
  /** Every process started for this task's command (in any project), oldest first. */
  const procsOf = (label) => pty.procs.filter(p => p.command === 'run-' + label);
  const kills = (...labels) => labels.map(label => procsOf(label).map(p => p.kills));
  return { manager, pty, sent, procsOf, kills };
}

/** The runner starts processes one turn after startTask answers; this lets those turns pass. No waiting on a clock. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Starts a task the way a confirmed click does and waits until its processes exist. */
async function start(manager, label, projectPath = PROJECT) {
  const answer = manager.startTask(projectPath, label, { confirmed: true });
  await settle();
  return answer;
}

const stateOf = (manager, label, projectPath = PROJECT) => manager.getRun(projectPath, label).state;

test('task-manager-stop (pin): Stop kills each running process once, also through stop-all for a compound task; input only reaches running tasks; resize is clamped and never throws; a restarted task can be stopped again', async (t) => {
  await t.test('Stop kills the running process once and answers ok; the task is "stopped" when the process ends', async () => {
    const { manager, pty, sent, procsOf } = boot();
    const started = await start(manager, 'solo');
    assert.equal(started.running, true);
    assert.equal(pty.procs.length, 1, 'one process for one task');
    const proc = procsOf('solo')[0];
    assert.equal(proc.kills, 0);

    const answer = manager.stopTask(PROJECT, 'solo');
    assert.equal(answer.ok, true);
    assert.equal(answer.error, undefined);
    assert.equal(proc.kills, 1, 'killed once');
    const stopping = manager.getRun(PROJECT, 'solo');
    assert.equal(stopping.stopRequested, true);
    assert.equal(stopping.running, true, 'still running until the process ends');

    proc.end(null);
    const ended = manager.getRun(PROJECT, 'solo');
    assert.equal(ended.state, 'stopped');
    assert.equal(ended.running, false);
    assert.equal(ended.stopRequested, true);
    assert.match(ended.output, /\[Task stopped\]/);
    assert.equal(proc.kills, 1, 'the end of the process kills nothing');
    const states = sent.filter(([channel, run]) => channel === 'task-state-changed' && run.label === 'solo').map(([, run]) => run.state);
    assert.equal(states[states.length - 1], 'stopped', 'the window is told the last state');
  });

  await t.test('Stop of a task that is not running answers { ok: false, error } and kills nothing', async () => {
    const { manager, pty, procsOf } = boot();
    // Never started.
    const never = manager.stopTask(PROJECT, 'solo');
    assert.equal(never.ok, false);
    assert.equal(never.error, NOT_RUNNING);
    // A label that is no task at all.
    assert.equal(manager.stopTask(PROJECT, 'no-such-task').error, NOT_RUNNING);
    assert.equal(pty.procs.length, 0);

    // Stopped and ended.
    await start(manager, 'solo');
    const proc = procsOf('solo')[0];
    manager.stopTask(PROJECT, 'solo');
    proc.end(null);
    const again = manager.stopTask(PROJECT, 'solo');
    assert.equal(again.ok, false);
    assert.equal(again.error, NOT_RUNNING);
    assert.equal(proc.kills, 1);

    // Ended on its own.
    await start(manager, 'a');
    const own = procsOf('a')[0];
    own.end(0);
    assert.equal(stateOf(manager, 'a'), 'exited');
    assert.equal(manager.stopTask(PROJECT, 'a').error, NOT_RUNNING);
    assert.equal(own.kills, 0);

    // Running, but in another project.
    await start(manager, 'b');
    assert.equal(manager.stopTask(OTHER_PROJECT, 'b').error, NOT_RUNNING);
    assert.equal(procsOf('b')[0].kills, 0);
  });

  await t.test('Stop before the process exists: nothing is started, nothing is killed, the task is "stopped"', async () => {
    const { manager, pty } = boot();
    const started = manager.startTask(PROJECT, 'solo', { confirmed: true });
    assert.equal(started.running, true);
    assert.equal(pty.procs.length, 0, 'the process is started a turn later');
    assert.equal(manager.stopTask(PROJECT, 'solo').ok, true);
    assert.equal(stateOf(manager, 'solo'), 'stopped');
    await settle();
    assert.equal(pty.procs.length, 0, 'a task stopped before its start starts no process');
    assert.equal(stateOf(manager, 'solo'), 'stopped');
  });

  await t.test('Stop of a compound task kills each running child once', async () => {
    const { manager, pty, procsOf, kills } = boot();
    await start(manager, 'both');
    assert.equal(pty.procs.length, 2, 'one process per child, none for the compound itself');

    assert.equal(manager.stopTask(PROJECT, 'both').ok, true);
    assert.deepEqual(kills('a', 'b'), [[1], [1]]);
    assert.equal(manager.getRun(PROJECT, 'a').stopRequested, true);
    assert.equal(manager.getRun(PROJECT, 'b').stopRequested, true);

    procsOf('a')[0].end(null);
    assert.equal(stateOf(manager, 'both'), 'running', 'one child still runs');
    procsOf('b')[0].end(null);
    assert.equal(stateOf(manager, 'a'), 'stopped');
    assert.equal(stateOf(manager, 'b'), 'stopped');
    assert.equal(stateOf(manager, 'both'), 'stopped');
    assert.deepEqual(kills('a', 'b'), [[1], [1]]);

    // A child that ended on its own before the Stop is not killed.
    await start(manager, 'both');
    const [a2, b2] = [procsOf('a')[1], procsOf('b')[1]];
    a2.end(0);
    manager.stopTask(PROJECT, 'both');
    assert.equal(a2.kills, 0, 'the child that had ended');
    assert.equal(b2.kills, 1, 'the child that still ran');
  });

  await t.test('Stop of a compound that runs its children in sequence kills the running one and starts no later one', async () => {
    const { manager, pty, procsOf, kills } = boot();
    await start(manager, 'steps');
    assert.equal(pty.procs.length, 1, 'only the first step runs');
    assert.equal(procsOf('first').length, 1);

    assert.equal(manager.stopTask(PROJECT, 'steps').ok, true);
    assert.deepEqual(kills('first'), [[1]]);
    procsOf('first')[0].end(null);
    await settle();
    assert.equal(pty.procs.length, 1, 'the second step is never started');
    assert.equal(stateOf(manager, 'steps'), 'stopped');
  });

  await t.test('stop-all kills every running process of the project once, a compound task\'s children included', async () => {
    const { manager, pty, kills } = boot();
    await start(manager, 'both');
    await start(manager, 'solo');
    await start(manager, 'solo', OTHER_PROJECT);
    assert.equal(pty.procs.length, 4);
    const [a, b, solo, far] = pty.procs;
    assert.deepEqual([a.command, b.command, solo.command, far.command], ['run-a', 'run-b', 'run-solo', 'run-solo']);

    const answer = manager.stopAllTasks(PROJECT);
    assert.equal(answer.ok, true);
    assert.equal(answer.stopped, 4, 'the compound, its two children and the single task');
    assert.deepEqual([a.kills, b.kills, solo.kills], [1, 1, 1], 'each once: the children are not killed again when their own runs are visited');
    assert.equal(far.kills, 0, 'another project\'s task is left alone');

    // A second "stop all" while the kills are on their way kills nothing again.
    assert.equal(manager.stopAllTasks(PROJECT).ok, true);
    assert.deepEqual([a.kills, b.kills, solo.kills, far.kills], [1, 1, 1, 0]);

    for (const proc of [a, b, solo]) proc.end(null);
    for (const label of ['a', 'b', 'solo', 'both']) assert.equal(stateOf(manager, label), 'stopped', label);
    assert.equal(stateOf(manager, 'solo', OTHER_PROJECT), 'running');

    // Nothing runs in the project any more.
    const after = manager.stopAllTasks(PROJECT);
    assert.equal(after.ok, true);
    assert.equal(after.stopped, 0);
    assert.deepEqual([a.kills, b.kills, solo.kills, far.kills], [1, 1, 1, 0]);
    assert.deepEqual(kills('a', 'b'), [[1], [1]]);
  });

  await t.test('stop-all after a compound task was stopped does not kill its children a second time', async () => {
    const { manager, pty } = boot();
    await start(manager, 'both');
    const [a, b] = pty.procs;
    manager.stopTask(PROJECT, 'both');
    assert.deepEqual([a.kills, b.kills], [1, 1]);
    assert.equal(manager.stopAllTasks(PROJECT).ok, true);
    assert.deepEqual([a.kills, b.kills], [1, 1], 'the kills are still on their way; stop-all adds none');
  });

  // A child that already runs is adopted by the compound: no second process.
  // Its own run is then older than the compound's, so stop-all meets it in the
  // other order than in the cases above.
  await t.test('stop-all kills a child once when it was started on its own before the compound task', async () => {
    const { manager, pty, procsOf } = boot();
    await start(manager, 'a');
    await start(manager, 'both');
    assert.deepEqual(pty.procs.map(p => p.command), ['run-a', 'run-b'], 'the compound adopts the running child and starts only the other');
    const [a, b] = pty.procs;

    const answer = manager.stopAllTasks(PROJECT);
    assert.equal(answer.ok, true);
    assert.equal(answer.stopped, 3, 'the child, the compound and the other child');
    assert.deepEqual([a.kills, b.kills], [1, 1], 'each once, the child that was started first too');
    for (const label of ['a', 'b', 'both']) assert.equal(manager.getRun(PROJECT, label).stopRequested, true, label);

    // The same with the other child started first, and a second "stop all" on top.
    const again = boot();
    await start(again.manager, 'b');
    await start(again.manager, 'both');
    assert.deepEqual(again.pty.procs.map(p => p.command), ['run-b', 'run-a']);
    assert.equal(again.manager.stopAllTasks(PROJECT).stopped, 3);
    assert.equal(again.manager.stopAllTasks(PROJECT).ok, true);
    assert.deepEqual(again.kills('a', 'b'), [[1], [1]]);

    for (const proc of [a, b]) proc.end(null);
    for (const label of ['a', 'b', 'both']) assert.equal(stateOf(manager, label), 'stopped', label);
    assert.deepEqual([procsOf('a').length, procsOf('b').length], [1, 1], 'nothing was started again');
  });

  await t.test('closing the runner kills each running process once and none that has ended', async () => {
    const { manager, pty } = boot();
    await start(manager, 'both');
    await start(manager, 'solo');
    const [a, b, solo] = pty.procs;
    a.end(0);
    manager.shutdown();
    assert.deepEqual([a.kills, b.kills, solo.kills], [0, 1, 1]);
  });

  await t.test('input reaches a running task, every running child of a compound, and nothing else', async () => {
    const { manager, pty } = boot();
    await start(manager, 'both');
    await start(manager, 'solo');
    const [a, b, solo] = pty.procs;

    manager.sendInput(PROJECT, 'solo', 'ls\r');
    assert.deepEqual(solo.writes, ['ls\r']);
    assert.deepEqual([a.writes, b.writes], [[], []]);

    manager.sendInput(PROJECT, 'both', 'y');
    assert.deepEqual([a.writes, b.writes], [['y'], ['y']], 'each running child of the compound');
    assert.deepEqual(solo.writes, ['ls\r']);

    // No task of that name, a task never started, the same label in another project.
    assert.doesNotThrow(() => manager.sendInput(PROJECT, 'no-such-task', 'x'));
    assert.doesNotThrow(() => manager.sendInput(PROJECT, 'first', 'x'));
    assert.doesNotThrow(() => manager.sendInput(OTHER_PROJECT, 'solo', 'x'));
    assert.deepEqual([a.writes, b.writes, solo.writes], [['y'], ['y'], ['ls\r']]);

    // A child that ended on its own gets nothing; the other still does.
    a.end(0);
    manager.sendInput(PROJECT, 'both', 'n');
    assert.deepEqual([a.writes, b.writes], [['y'], ['y', 'n']]);
    manager.sendInput(PROJECT, 'a', 'direct');
    assert.deepEqual(a.writes, ['y']);

    // A stopped task whose process has ended gets nothing.
    manager.stopTask(PROJECT, 'solo');
    solo.end(null);
    manager.sendInput(PROJECT, 'solo', 'too late\r');
    assert.deepEqual(solo.writes, ['ls\r']);
  });

  await t.test('a resize is passed on with at least 2 columns and 1 row, to a running task and to every running child', async () => {
    const { manager, pty } = boot();
    await start(manager, 'both');
    await start(manager, 'solo');
    const [a, b, solo] = pty.procs;

    manager.resize(PROJECT, 'solo', 0, 0);
    manager.resize(PROJECT, 'solo', 1, -5);
    manager.resize(PROJECT, 'solo', 2, 1);
    manager.resize(PROJECT, 'solo', 200, 50);
    assert.deepEqual(solo.resizes, [[2, 1], [2, 1], [2, 1], [200, 50]]);
    assert.deepEqual([a.resizes, b.resizes], [[], []]);

    manager.resize(PROJECT, 'both', 80, 24);
    manager.resize(PROJECT, 'both', 1, 0);
    assert.deepEqual([a.resizes, b.resizes], [[[80, 24], [2, 1]], [[80, 24], [2, 1]]]);

    // A child that ended on its own, and a stopped task whose process ended, are not resized.
    a.end(0);
    manager.resize(PROJECT, 'both', 90, 30);
    assert.equal(a.resizes.length, 2);
    assert.deepEqual(b.resizes[2], [90, 30]);
    manager.stopTask(PROJECT, 'solo');
    solo.end(null);
    manager.resize(PROJECT, 'solo', 90, 30);
    assert.equal(solo.resizes.length, 4);
  });

  await t.test('a resize never throws: not for a pty that throws, an unknown task or a task that never started', async () => {
    const { manager, pty } = boot();
    await start(manager, 'both');
    const [a, b] = pty.procs;

    a.resizeThrows = true;
    assert.doesNotThrow(() => manager.resize(PROJECT, 'a', 100, 30));
    assert.deepEqual(a.resizes, [[100, 30]], 'the pty was asked, and its error stayed inside');
    // One child that throws does not keep the resize from the next child.
    assert.doesNotThrow(() => manager.resize(PROJECT, 'both', 110, 35));
    assert.deepEqual(a.resizes[1], [110, 35]);
    assert.deepEqual(b.resizes, [[110, 35]]);

    assert.doesNotThrow(() => manager.resize(PROJECT, 'no-such-task', 80, 24));
    assert.doesNotThrow(() => manager.resize(PROJECT, 'solo', 80, 24));
    assert.doesNotThrow(() => manager.resize(OTHER_PROJECT, 'a', 80, 24));
    assert.equal(a.resizes.length, 2);
    assert.equal(b.resizes.length, 1);
  });

  await t.test('a restarted task can be stopped again: the new process is killed once, the old one not again', async () => {
    const { manager, pty, procsOf } = boot();
    await start(manager, 'solo');
    const old = procsOf('solo')[0];

    const answer = manager.restartTask(PROJECT, 'solo');
    assert.equal(answer.ok, true);
    assert.equal(answer.restarting, true);
    assert.equal(old.kills, 1, 'a restart stops the running process first');
    await settle();
    assert.equal(pty.procs.length, 1, 'the new process waits for the old one to end');

    old.end(null);
    await settle();
    assert.equal(pty.procs.length, 2, 'started again once the old process ended');
    const fresh = procsOf('solo')[1];
    const running = manager.getRun(PROJECT, 'solo');
    assert.equal(running.state, 'running');
    assert.equal(running.stopRequested, false, 'the stop mark of the old run is gone');
    assert.equal(fresh.kills, 0);

    // Input and a resize reach the new process, not the old one.
    manager.sendInput(PROJECT, 'solo', 'q');
    manager.resize(PROJECT, 'solo', 0, 0);
    assert.deepEqual([fresh.writes, fresh.resizes], [['q'], [[2, 1]]]);
    assert.deepEqual([old.writes, old.resizes], [[], []]);

    assert.equal(manager.stopTask(PROJECT, 'solo').ok, true);
    assert.equal(fresh.kills, 1, 'the new process is killed once');
    assert.equal(old.kills, 1, 'the old one is not killed again');
    fresh.end(null);
    assert.equal(stateOf(manager, 'solo'), 'stopped');
  });

  await t.test('a task started again after a Stop can be stopped again, alone or through stop-all', async () => {
    const { manager, pty, procsOf } = boot();
    await start(manager, 'solo');
    const first = procsOf('solo')[0];
    manager.stopTask(PROJECT, 'solo');
    first.end(null);
    assert.equal(stateOf(manager, 'solo'), 'stopped');

    await start(manager, 'solo');
    assert.equal(pty.procs.length, 2);
    const second = procsOf('solo')[1];
    assert.equal(manager.getRun(PROJECT, 'solo').stopRequested, false);
    assert.equal(manager.stopTask(PROJECT, 'solo').ok, true);
    assert.deepEqual([first.kills, second.kills], [1, 1]);
    second.end(null);

    await start(manager, 'solo');
    const third = procsOf('solo')[2];
    assert.equal(manager.stopAllTasks(PROJECT).stopped, 1);
    assert.deepEqual([first.kills, second.kills, third.kills], [1, 1, 1]);
  });

  await t.test('a restarted compound task can be stopped again: each new child is killed once', async () => {
    const { manager, pty, procsOf } = boot();
    await start(manager, 'both');
    const [a1, b1] = pty.procs;

    const answer = manager.restartTask(PROJECT, 'both');
    assert.equal(answer.restarting, true);
    assert.deepEqual([a1.kills, b1.kills], [1, 1]);
    a1.end(null);
    await settle();
    assert.equal(pty.procs.length, 2, 'the restart waits for every child to end');
    b1.end(null);
    await settle();
    assert.equal(pty.procs.length, 4, 'both children started again');
    const [a2, b2] = [procsOf('a')[1], procsOf('b')[1]];
    assert.equal(stateOf(manager, 'both'), 'running');

    assert.equal(manager.stopTask(PROJECT, 'both').ok, true);
    assert.deepEqual([a2.kills, b2.kills], [1, 1], 'each new child once');
    assert.deepEqual([a1.kills, b1.kills], [1, 1], 'the old ones not again');
  });
});
