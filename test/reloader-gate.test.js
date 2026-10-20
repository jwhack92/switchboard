'use strict';
// Hot reload is opt-in. electron-reloader relaunches the app (app.relaunch();
// app.exit(0)) when main.js or a module loaded before it changes, and a
// relaunch kills every session: on 2026-10-20 a merge into the live checkout
// did exactly that. So main.js loads the reloader only when the app is started
// with SWITCHBOARD_HOT_RELOAD=1.
//
// main.js cannot be loaded in a test (it needs Electron), so the gate is cut
// out of the source by its markers and run here, in a vm context, against a
// fake require, a fake process.env and a fake log (the style of
// main-token-wiring.test.js). The source scan then pins that no other tracked
// file loads the reloader around the gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

function between(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, 'marker not found in main.js: ' + start);
  assert.equal(SRC.indexOf(start, a + 1), -1, 'marker is not unique in main.js: ' + start);
  const b = SRC.indexOf(end, a);
  assert.ok(b > a, 'end marker not found after it: ' + end);
  return SRC.slice(a, b);
}

const GATE_BLOCK = between("if (process.env.SWITCHBOARD_HOT_RELOAD === '1')", "// The crash guard's fault list");

function fakeLog() {
  const lines = [];
  const at = (level) => (...args) => { lines.push(level + ' ' + args.map(String).join(' ')); };
  return { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

function runGate(env, opts = {}) {
  const required = [];
  const calls = [];
  const fakeRequire = (id) => {
    required.push(id);
    return (...args) => {
      calls.push(args);
      if (opts.reloaderThrows) throw new Error('reloader is broken');
    };
  };
  const log = fakeLog();
  const fakeModule = { id: 'main.js' };
  const context = vm.createContext({ require: fakeRequire, process: { env }, log, module: fakeModule });
  vm.runInContext(GATE_BLOCK, context);
  return { required, calls, log, fakeModule };
}

test('reloader gate: the cut-out block holds the require and the log line', () => {
  assert.ok(GATE_BLOCK.includes("require('electron-reloader')"));
  assert.ok(GATE_BLOCK.includes('[hot-reload] on') && GATE_BLOCK.includes('[hot-reload] off'));
});

test('reloader gate: SWITCHBOARD_HOT_RELOAD unset -> the reloader is not required, "off" is logged', () => {
  const r = runGate({});
  assert.deepEqual(r.required, []);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.log.lines, ['info [hot-reload] off']);
});

test("reloader gate: SWITCHBOARD_HOT_RELOAD='1' -> required once, called once with (module, { watchRenderer: true }), \"on\" is logged", () => {
  const r = runGate({ SWITCHBOARD_HOT_RELOAD: '1' });
  assert.deepEqual(r.required, ['electron-reloader']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].length, 2);
  assert.equal(r.calls[0][0], r.fakeModule, 'the first argument is main.js\'s module');
  assert.deepEqual({ ...r.calls[0][1] }, { watchRenderer: true });
  assert.deepEqual(r.log.lines, ['info [hot-reload] on']);
});

test("reloader gate: '0', 'true' and '' do not turn it on", () => {
  for (const value of ['0', 'true', '']) {
    const r = runGate({ SWITCHBOARD_HOT_RELOAD: value });
    assert.deepEqual(r.required, [], JSON.stringify(value));
    assert.deepEqual(r.calls, [], JSON.stringify(value));
    assert.deepEqual(r.log.lines, ['info [hot-reload] off'], JSON.stringify(value));
  }
});

test('reloader gate: a reloader that throws does not throw out of the gate', () => {
  let r;
  assert.doesNotThrow(() => { r = runGate({ SWITCHBOARD_HOT_RELOAD: '1' }, { reloaderThrows: true }); });
  assert.equal(r.calls.length, 1);
});

test('reloader gate: a require of electron-reloader that throws does not throw out of the gate', () => {
  const log = fakeLog();
  const context = vm.createContext({
    require: () => { throw new Error("Cannot find module 'electron-reloader'"); },
    process: { env: { SWITCHBOARD_HOT_RELOAD: '1' } }, log, module: {},
  });
  assert.doesNotThrow(() => vm.runInContext(GATE_BLOCK, context));
});

// --- Source scan: the gated line in main.js is the only place that loads it ---

const RELOADER_REQUIRE = /require\(\s*['"`]electron-reloader['"`]\s*\)/;

test('source scan: across tracked .js outside node_modules/ and test/, electron-reloader is required once, on the gated line of main.js', () => {
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((f) => f.trim()).filter(Boolean)
    .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('test/') && !f.endsWith('.test.js'));
  assert.ok(files.includes('main.js'), 'git ls-files listed main.js');
  const hits = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (RELOADER_REQUIRE.test(line)) hits.push({ file, line: i + 1, text: line });
    });
  }
  assert.equal(hits.length, 1, 'exactly one require of electron-reloader: ' + JSON.stringify(hits));
  const [hit] = hits;
  assert.equal(hit.file, 'main.js');
  const gate = hit.text.indexOf("process.env.SWITCHBOARD_HOT_RELOAD === '1'");
  const req = hit.text.search(RELOADER_REQUIRE);
  assert.ok(gate >= 0 && gate < req, 'the require sits behind the SWITCHBOARD_HOT_RELOAD gate on the same line: ' + hit.text);
});
