const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// newTextSince is the part worth pinning: it decides what gets spoken, and the
// expensive mistake is speaking an entire session's history the first time the
// feature is switched on.

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-speech-'));
  const folder = 'C--fake-project';
  fs.mkdirSync(path.join(root, folder));
  return { root, folder };
}

// init() registers ipcMain handlers, which needs a real Electron main process.
// The module reads its dependencies from module-scope bindings that init sets,
// so for tests we drive it through a tiny shim that sets the same bindings.
function wire({ root, folder }) {
  // Re-require a fresh copy so tests do not share module state.
  const p = require.resolve('../speech-ipc');
  delete require.cache[p];
  const mod = require(p);
  // init() would call ipcMain.handle, which is undefined outside Electron.
  // Everything else it does is plain assignment, so stub the registration.
  const electronPath = require.resolve('electron');
  const originalElectron = require.cache[electronPath];
  const handlers = {};
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } },
  };
  delete require.cache[p];
  const fresh = require(p);
  fresh.init({
    log: { info() {}, warn() {}, error() {} },
    cleanEnv: {},
    PROJECTS_DIR: root,
    getCachedFolder: (id) => (id === 'missing' ? null : folder),
    driverStore: { isHalted: () => ({ halted: false }), appendEvent() {} },
    custody: { register() {}, unregister() {}, killTree() {} },
  });
  if (originalElectron) require.cache[electronPath] = originalElectron;
  else delete require.cache[electronPath];
  return { mod: fresh, handlers };
}

const line = (o) => JSON.stringify(o) + '\n';
const assistantText = (s) => line({ type: 'assistant', message: { content: [{ type: 'text', text: s }] } });
const assistantTool = () => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const turnEnd = () => line({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });

function writeTranscript(root, folder, id, body) {
  const p = path.join(root, folder, id + '.jsonl');
  fs.writeFileSync(p, body);
  return p;
}

test('first call establishes a baseline instead of reading the whole history', () => {
  const h = harness();
  const { mod } = wire(h);
  const file = writeTranscript(h.root, h.folder, 's1',
    assistantText('Ancient history nobody wants read aloud.') + turnEnd());

  const r = mod.newTextSince('s1', undefined);
  assert.equal(r.text, '', 'nothing from before the feature was switched on');
  assert.equal(r.baseline, true);
  assert.equal(r.bytes, fs.statSync(file).size, 'baseline is the current size');
});

test('only text appended since the offset is returned', () => {
  const h = harness();
  const { mod } = wire(h);
  const head = assistantText('Old turn.') + turnEnd();
  const file = writeTranscript(h.root, h.folder, 's2', head);
  const base = mod.newTextSince('s2', undefined).bytes;

  fs.appendFileSync(file, assistantTool() + assistantText('The new answer.') + turnEnd());
  const r = mod.newTextSince('s2', base);
  assert.equal(r.text, 'The new answer.', 'tool blocks and prior turns excluded');
  assert.equal(r.bytes, fs.statSync(file).size);
});

test('an unchanged file yields nothing and holds its offset', () => {
  const h = harness();
  const { mod } = wire(h);
  const file = writeTranscript(h.root, h.folder, 's3', assistantText('Only turn.') + turnEnd());
  const size = fs.statSync(file).size;
  const r = mod.newTextSince('s3', size);
  assert.equal(r.text, '');
  assert.equal(r.bytes, size);
});

test('a partial trailing line is not banked, so it is not skipped later', () => {
  const h = harness();
  const { mod } = wire(h);
  const head = assistantText('First.') + turnEnd();
  const file = writeTranscript(h.root, h.folder, 's4', head);
  const base = mod.newTextSince('s4', undefined).bytes;

  // A write caught mid-flush: a complete JSON value with no newline.
  const partial = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second.' }] } });
  fs.appendFileSync(file, partial);

  const r = mod.newTextSince('s4', base);
  assert.equal(r.bytes, base, 'offset must not advance past an incomplete line');

  fs.appendFileSync(file, '\n');
  const r2 = mod.newTextSince('s4', r.bytes);
  assert.equal(r2.text, 'Second.', 'the completed line is picked up, exactly once');
});

test('an offset past the end of the file re-baselines rather than throwing', () => {
  const h = harness();
  const { mod } = wire(h);
  const file = writeTranscript(h.root, h.folder, 's5', assistantText('Short.') + turnEnd());
  const r = mod.newTextSince('s5', 999999);
  assert.equal(r.baseline, true, 'a truncated or replaced file starts over');
  assert.equal(r.bytes, fs.statSync(file).size);
});

test('an unknown session reports rather than throwing', () => {
  const h = harness();
  const { mod } = wire(h);
  const r = mod.newTextSince('missing', 0);
  assert.equal(r.error, 'unknown-session');
  assert.equal(r.text, '');
});

test('a session with no transcript on disk reports rather than throwing', () => {
  const h = harness();
  const { mod } = wire(h);
  const r = mod.newTextSince('never-written', 0);
  assert.equal(r.error, 'no-transcript');
});

test('the summarizer refuses to spawn while HALT is engaged', async () => {
  const h = harness();
  const p = require.resolve('../speech-ipc');
  delete require.cache[p];
  const mod = require(p);

  const events = [];
  const electronPath = require.resolve('electron');
  const original = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle() {} } },
  };
  delete require.cache[p];
  const fresh = require(p);
  fresh.init({
    log: { info() {}, warn() {}, error() {} },
    cleanEnv: {},
    PROJECTS_DIR: h.root,
    getCachedFolder: () => h.folder,
    driverStore: {
      isHalted: () => ({ halted: true, reason: 'test stop' }),
      appendEvent: (type, data) => events.push({ type, data }),
    },
    custody: {
      register() { throw new Error('must not be reached — nothing should spawn'); },
      unregister() {}, killTree() {},
    },
  });
  if (original) require.cache[electronPath] = original; else delete require.cache[electronPath];

  const r = await fresh.summarize('some long reply text', 75);
  assert.equal(r.error, 'halted');
  assert.equal(r.reason, 'test stop');
  assert.ok(events.some(e => e.type === 'SPAWN_VETOED'), 'the veto is recorded in the event log');
});

test('the summarizer rejects an empty reply or a nonsense budget without spawning', async () => {
  const h = harness();
  const { mod } = wire(h);
  assert.equal((await mod.summarize('', 75)).error, 'empty');
  assert.equal((await mod.summarize('   ', 75)).error, 'empty');
  assert.equal((await mod.summarize('real text', 0)).error, 'bad-budget');
  assert.equal((await mod.summarize('real text', NaN)).error, 'bad-budget');
});

test('the prompt carries the word budget and the reply, and asks for plain speech', () => {
  const h = harness();
  const { mod } = wire(h);
  const prompt = mod.buildPrompt('The reply body.', 75);
  assert.ok(prompt.includes('at most 75 words'));
  assert.ok(prompt.includes('The reply body.'));
  assert.ok(/no markdown/i.test(prompt));
});
