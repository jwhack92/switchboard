const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');

// The warm summarizer holds one long-lived `claude` process and feeds it prompts
// over stream-json. These pin the lifecycle rules that make that safe: it is
// reused, it is recycled before context grows without bound, it does not outlive
// idleness, and a HALT or a death never leaves a caller hanging or a pid
// unregistered.
//
// A fake child stands in for the CLI, so nothing spawns and nothing is billed.

function loadModule({ halted = false } = {}) {
  const modPath = require.resolve('../speech-ipc');
  const cpPath = require.resolve('child_process');
  const electronPath = require.resolve('electron');

  const spawned = [];
  const custodyCalls = { register: [], unregister: [], killTree: [] };
  const events = [];

  class FakeChild extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.written = [];
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = { write: (d) => { this.written.push(d); return true; }, end() {} };
    }
    /** Emit the stream-json a real turn produces. */
    reply(text) {
      this.stdout.emit('data', Buffer.from(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
      ));
      this.stdout.emit('data', Buffer.from(
        JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 }) + '\n'
      ));
    }
  }

  const realCp = require.cache[cpPath];
  const realElectron = require.cache[electronPath];
  let nextPid = 1000;

  require.cache[cpPath] = {
    id: cpPath, filename: cpPath, loaded: true,
    exports: {
      ...require('child_process'),
      spawn: (bin, args) => {
        const c = new FakeChild(nextPid++);
        spawned.push({ bin, args, child: c });
        return c;
      },
    },
  };
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle() {} } },
  };

  delete require.cache[modPath];
  const mod = require(modPath);

  let isHalted = halted;
  mod.init({
    log: { info() {}, warn() {}, error() {} },
    cleanEnv: {},
    PROJECTS_DIR: path.join(__dirname, 'nowhere'),
    getCachedFolder: () => 'folder',
    driverStore: {
      isHalted: () => (isHalted ? { halted: true, reason: 'test stop' } : { halted: false }),
      appendEvent: (t, d) => events.push({ type: t, data: d }),
    },
    custody: {
      register: (r) => custodyCalls.register.push(r.pid),
      unregister: (pid) => custodyCalls.unregister.push(pid),
      killTree: (pid) => custodyCalls.killTree.push(pid),
    },
  });

  if (realCp) require.cache[cpPath] = realCp; else delete require.cache[cpPath];
  if (realElectron) require.cache[electronPath] = realElectron; else delete require.cache[electronPath];

  return {
    mod, spawned, custodyCalls, events,
    setHalted: (v) => { isHalted = v; },
    last: () => spawned[spawned.length - 1].child,
  };
}

/** Let the pending promise chain advance before asserting. */
const tick = () => new Promise(r => setImmediate(r));

test('a second summary reuses the running process instead of spawning another', async () => {
  const h = loadModule();
  const p1 = h.mod.summarize('first reply text', 40);
  await tick();
  h.last().reply('first summary');
  assert.equal((await p1).summary, 'first summary');

  const p2 = h.mod.summarize('second reply text', 40);
  await tick();
  h.last().reply('second summary');
  assert.equal((await p2).summary, 'second summary');

  assert.equal(h.spawned.length, 1, 'one process served both turns');
  assert.equal(h.custodyCalls.register.length, 1, 'registered once');
});

test('the process is launched with tools off', async () => {
  const h = loadModule();
  const p = h.mod.summarize('text', 40);
  await tick();
  h.last().reply('ok');
  await p;

  const args = h.spawned[0].args;
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands',
                      '--no-session-persistence', '--allowed-tools', '--verbose']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  // Variadic: anything after it would be swallowed as a tool name.
  assert.equal(args[args.length - 2], '--allowed-tools');
  assert.equal(args[args.length - 1], '');
});

test('context growth is bounded by recycling after RECYCLE_AFTER turns', async () => {
  const h = loadModule();
  const n = h.mod.RECYCLE_AFTER;
  for (let i = 0; i < n; i++) {
    const p = h.mod.summarize('reply ' + i, 40);
    await tick();
    h.last().reply('summary ' + i);
    await p;
  }
  assert.equal(h.spawned.length, 1, 'still the first process');

  const p = h.mod.summarize('one too many', 40);
  await tick();
  h.last().reply('after recycle');
  await p;

  assert.equal(h.spawned.length, 2, 'the next turn restarts rather than growing context');
  assert.ok(h.custodyCalls.killTree.includes(1000), 'the old process was killed');
  assert.ok(h.custodyCalls.unregister.includes(1000), 'and unregistered');
});

test('a child that dies mid-request fails that request and the next one restarts', async () => {
  const h = loadModule();
  const p = h.mod.summarize('text', 40);
  await tick();
  h.last().emit('exit', 1);

  const r = await p;
  assert.equal(r.error, 'process-died', 'the caller is answered, never left hanging');
  assert.ok(h.custodyCalls.unregister.includes(1000));

  const p2 = h.mod.summarize('again', 40);
  await tick();
  h.last().reply('recovered');
  assert.equal((await p2).summary, 'recovered');
  assert.equal(h.spawned.length, 2);
});

test('HALT engaged before a summary refuses and spawns nothing', async () => {
  const h = loadModule({ halted: true });
  const r = await h.mod.summarize('text', 40);
  assert.equal(r.error, 'halted');
  assert.equal(r.reason, 'test stop');
  assert.equal(h.spawned.length, 0, 'nothing was started');
  assert.ok(h.events.some(e => e.type === 'SPAWN_VETOED'));
});

test('HALT engaged after the process is up kills it on the next summary', async () => {
  const h = loadModule();
  const p = h.mod.summarize('text', 40);
  await tick();
  h.last().reply('fine');
  await p;
  assert.equal(h.spawned.length, 1);

  h.setHalted(true);
  const r = await h.mod.summarize('text again', 40);
  assert.equal(r.error, 'halted');
  assert.ok(h.custodyCalls.killTree.includes(1000), 'the resident process is killed, not just ignored');
});

test('shutting down explicitly kills and unregisters', async () => {
  const h = loadModule();
  const p = h.mod.summarize('text', 40);
  await tick();
  h.last().reply('fine');
  await p;

  h.mod.warm.stop('requested');
  assert.ok(h.custodyCalls.killTree.includes(1000));
  assert.ok(h.custodyCalls.unregister.includes(1000));
  assert.equal(h.mod.warm.isRunning(), false);
});

test('concurrent summaries serialize rather than interleaving', async () => {
  const h = loadModule();
  const p1 = h.mod.summarize('first', 40);
  const p2 = h.mod.summarize('second', 40);
  await tick();

  // Only the first turn is in flight; the second is queued behind it.
  assert.equal(h.last().written.length, 1, 'one prompt written so far');
  h.last().reply('one');
  assert.equal((await p1).summary, 'one');

  await tick();
  assert.equal(h.last().written.length, 2, 'the queued turn goes out only after the first finished');
  h.last().reply('two');
  assert.equal((await p2).summary, 'two');
});

test('after repeated failures it gives up so the caller falls back to extractive', async () => {
  const h = loadModule();
  for (let i = 0; i < h.mod.MAX_CONSECUTIVE_FAILURES; i++) {
    const p = h.mod.summarize('text', 40);
    await tick();
    h.last().emit('exit', 1);
    await p;
  }
  const r = await h.mod.summarize('text', 40);
  assert.equal(r.error, 'giving-up');
});

test('a successful turn clears the failure count', async () => {
  const h = loadModule();
  const p1 = h.mod.summarize('text', 40);
  await tick();
  h.last().emit('exit', 1);
  await p1;
  assert.equal(h.mod.warm.failures, 1);

  const p2 = h.mod.summarize('text', 40);
  await tick();
  h.last().reply('recovered');
  await p2;
  assert.equal(h.mod.warm.failures, 0, 'one bad turn must not creep toward giving up');
});

test('an empty reply or a nonsense budget never reaches the process', async () => {
  const h = loadModule();
  assert.equal((await h.mod.summarize('', 40)).error, 'empty');
  assert.equal((await h.mod.summarize('text', 0)).error, 'bad-budget');
  assert.equal(h.spawned.length, 0);
});
