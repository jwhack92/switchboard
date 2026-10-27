'use strict';
// pty-close.js: a ConPTY terminal is closed without node-pty's console-list
// fork. Plain node, fake terminals, a hand-made timer; the last two tests read
// the installed node-pty and the pins, because the fast path rests on two of
// node-pty's private names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { closePty, FORCE_END_MS } = require('../pty-close');

/** A timer that only runs when the test calls fn(). */
function timers() {
  const made = [];
  return {
    made,
    setTimer(fn, ms) {
      const timer = { fn, ms, unrefs: 0, unref() { timer.unrefs++; return timer; } };
      made.push(timer);
      return timer;
    },
  };
}

/** A node-pty terminal on Windows ConPTY: kill() asks the agent for its console list, as node-pty 1.1.0 does. */
function conptyTerminal(agentFields = {}) {
  const original = function () { throw new Error('forked'); };
  const term = {
    _agent: { _useConpty: true, _useConptyDll: false, _innerPid: 42, _getConsoleProcessList: original, ...agentFields },
    kills: 0,
    list: null,
    kill() { this.kills++; this.list = this._agent._getConsoleProcessList(); },
  };
  return { term, original };
}

const pendingOrValue = (promise) => Promise.race([promise, Promise.resolve('pending')]);

test('win32 ConPTY: kill runs once and nothing is forked', () => {
  const t = timers();
  const { term, original } = conptyTerminal();
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(term.kills, 1);
  assert.ok(term.list instanceof Promise);
  assert.notEqual(term._agent._getConsoleProcessList, original);
});

test('the console list is the shell pid, after 5000 ms on an unref\'d timer', async () => {
  const t = timers();
  const { term } = conptyTerminal();
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(FORCE_END_MS, 5000);
  assert.equal(t.made.length, 1);
  assert.equal(t.made[0].ms, 5000);
  assert.equal(t.made[0].unrefs, 1);
  assert.equal(await pendingOrValue(term.list), 'pending');
  t.made[0].fn();
  assert.deepEqual(await term.list, [42]);
});

test('a kill queued before the terminal is ready still skips the fork', async () => {
  const t = timers();
  const { term, original } = conptyTerminal();
  const deferreds = [];
  term.kill = function () { deferreds.push(() => { this.kills++; this.list = this._agent._getConsoleProcessList(); }); };
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(deferreds.length, 1);
  deferreds[0]();
  assert.notEqual(term._agent._getConsoleProcessList, original);
  assert.ok(term.list instanceof Promise);
  t.made[0].fn();
  assert.deepEqual(await term.list, [42]);
});

test('not win32: a plain kill, the agent untouched', () => {
  const t = timers();
  const { term, original } = conptyTerminal();
  term.kill = function () { this.kills++; };
  closePty(term, { setTimer: t.setTimer, platform: 'linux' });
  assert.equal(term.kills, 1);
  assert.equal(term._agent._getConsoleProcessList, original);
  assert.equal(t.made.length, 0);
});

test('useConptyDll: a plain kill, the agent untouched', () => {
  const t = timers();
  const { term, original } = conptyTerminal({ _useConptyDll: true });
  term.kill = function () { this.kills++; };
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(term.kills, 1);
  assert.equal(term._agent._getConsoleProcessList, original);
});

test('winpty (_useConpty false): a plain kill, the agent untouched', () => {
  const t = timers();
  const { term, original } = conptyTerminal({ _useConpty: false });
  term.kill = function () { this.kills++; };
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(term.kills, 1);
  assert.equal(term._agent._getConsoleProcessList, original);
});

test('no _agent, or no _getConsoleProcessList function: a plain kill and no throw', () => {
  const t = timers();
  const bare = { kills: 0, kill() { this.kills++; } };
  closePty(bare, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(bare.kills, 1);
  const { term } = conptyTerminal({ _getConsoleProcessList: undefined });
  term.kill = function () { this.kills++; };
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  assert.equal(term.kills, 1);
  assert.equal(term._agent._getConsoleProcessList, undefined);
  assert.equal(t.made.length, 0);
});

test('a kill that throws: the same error comes out', () => {
  const t = timers();
  const { term } = conptyTerminal();
  const boom = new Error('kill failed');
  term.kill = () => { throw boom; };
  assert.throws(() => closePty(term, { setTimer: t.setTimer, platform: 'win32' }), (err) => err === boom);
});

test('the shell already gone: the timer firing twice adds no throw', async () => {
  const t = timers();
  const { term } = conptyTerminal();
  closePty(term, { setTimer: t.setTimer, platform: 'win32' });
  t.made[0].fn();
  assert.doesNotThrow(() => t.made[0].fn());
  assert.deepEqual(await term.list, [42]);
});

test('node-pty shape (installed): the private names the fast path rests on are there', () => {
  const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.1.0');
  const agent = fs.readFileSync(path.join(root, 'lib', 'windowsPtyAgent.js'), 'utf8');
  assert.ok(agent.includes('WindowsPtyAgent.prototype._getConsoleProcessList = '));
  const killStart = agent.indexOf('WindowsPtyAgent.prototype.kill = ');
  assert.ok(killStart >= 0);
  const killText = agent.slice(killStart, agent.indexOf('WindowsPtyAgent.prototype.', killStart + 1));
  assert.ok(killText.includes('this._getConsoleProcessList().then('));
  const terminal = fs.readFileSync(path.join(root, 'lib', 'windowsTerminal.js'), 'utf8');
  const termKillStart = terminal.indexOf('WindowsTerminal.prototype.kill = ');
  assert.ok(termKillStart >= 0);
  const termKillText = terminal.slice(termKillStart, terminal.indexOf('WindowsTerminal.prototype.', termKillStart + 1));
  assert.ok(termKillText.includes('_this._agent.kill();'));
});

test('node-pty is pinned to exactly 1.1.0 in package.json and package-lock.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['node-pty'], '1.1.0');
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies['node-pty'], '1.1.0');
});
