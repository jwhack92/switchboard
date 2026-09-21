// The file panel may only write back a file the MAIN process put in front of
// the user. These tests pin the two halves of that:
//
//   - what counts as surfaced (main's own reads, and the MCP pushes main
//     cannot see because mcp-bridge.js sends them itself), and
//   - that wrapping the window to see those pushes does not disturb them,
//     because MCP diff-saving is an existing working feature and a wrapper
//     that swallowed or reshaped a send would break it silently.
//
// No Electron: `watchWindow` is handed a plain object with the same two members
// mcp-bridge.js uses (`isDestroyed()` and `webContents.send()`), which is
// exactly what it must survive against a real BrowserWindow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPanelPathGuard, PANEL_PUSH_FIELDS, DEFAULT_LIMIT } = require('../save-containment');

// A guard with realpath stubbed to the identity, for the tests that are about
// path handling rather than about symlinks.
function guard(options = {}) {
  return createPanelPathGuard({ realpath: filePath => filePath, ...options });
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    win: {
      id: 42,
      isDestroyed: () => false,
      webContents: { send: (...args) => { sent.push(args); return 'sent'; } },
    },
  };
}

const WIN = path.win32;
const POSIX = path.posix;

// ── the core refusal ─────────────────────────────────────────────────────

test('a path that was never surfaced is refused', () => {
  const g = guard();
  assert.equal(g.allows(path.resolve('anything.txt')), false);
});

test('a path main surfaced is allowed', () => {
  const g = guard();
  g.surface(path.resolve('notes.md'));
  assert.equal(g.allows(path.resolve('notes.md')), true);
});

test('surfacing one file does not unlock its neighbours', () => {
  const g = guard();
  const dir = path.resolve('dir');
  g.surface(path.join(dir, 'safe.txt'));
  assert.equal(g.allows(path.join(dir, 'other.txt')), false);
  assert.equal(g.allows(dir), false);
});

test('nothing is savable through a garbage path', () => {
  const g = guard();
  for (const value of [undefined, null, '', 0, {}, [], Symbol.iterator]) {
    assert.equal(g.surface(value), false, `surface(${String(value)})`);
    assert.equal(g.allows(value), false, `allows(${String(value)})`);
  }
  assert.equal(g.size(), 0);
});

// ── spelling ─────────────────────────────────────────────────────────────

test('the same file spelled differently is still the same file', () => {
  const g = guard();
  const base = path.resolve('proj');
  g.surface(path.join(base, 'src', 'app.js'));
  assert.equal(g.allows(path.join(base, 'src', '..', 'src', 'app.js')), true);
  assert.equal(g.allows(path.join(base, 'src', '.', 'app.js')), true);
});

test('on Windows the comparison folds case, because the filesystem does', () => {
  const g = guard({ platform: 'win32' });
  g.surface(WIN.join('C:\\Users\\Jason', 'Notes.MD'));
  assert.equal(g.allows(WIN.join('c:\\users\\jason', 'notes.md')), true);
});

test('off Windows the comparison does not fold case, because the filesystem does not', () => {
  const g = guard({ platform: 'linux' });
  g.surface('/home/jason/Notes.md');
  assert.equal(g.allows('/home/jason/Notes.md'), true);
  assert.equal(g.allows('/home/jason/notes.md'), false);
});

test('a relative path is resolved before it is compared', () => {
  const g = guard();
  g.surface('rel.txt');
  assert.equal(g.allows(path.resolve('rel.txt')), true);
});

// ── realpath: the browser and the MCP bridge spell the same file differently ──

test('a file surfaced by its link is savable by its real path, and back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-contain-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const real = path.join(dir, 'real.txt');
  fs.writeFileSync(real, 'hello');
  const link = path.join(dir, 'link.txt');
  try {
    fs.symlinkSync(real, link, 'file');
  } catch (err) {
    // Windows without Developer Mode refuses symlinks to unprivileged users.
    t.skip(`symlinks unavailable here: ${err.code}`);
    return;
  }

  const viaLink = createPanelPathGuard();
  viaLink.surface(link);
  assert.equal(viaLink.allows(link), true, 'the spelling that was surfaced');
  assert.equal(viaLink.allows(real), true, 'the same file by its real name');

  const viaReal = createPanelPathGuard();
  viaReal.surface(real);
  assert.equal(viaReal.allows(link), true, 'reached back through the link');
});

test('link and target are the same file, with realpath stubbed so every OS runs it', () => {
  // The same assertion as the symlink test above, minus the privilege needed
  // to make one on Windows.
  const real = path.resolve('real-target.txt');
  const link = path.resolve('a-link.txt');
  const realpath = filePath => (filePath === link ? real : filePath);

  const viaLink = createPanelPathGuard({ realpath });
  viaLink.surface(link);
  assert.equal(viaLink.allows(link), true);
  assert.equal(viaLink.allows(real), true);

  const viaReal = createPanelPathGuard({ realpath });
  viaReal.surface(real);
  assert.equal(viaReal.allows(link), true, 'allows() realpaths the candidate too');
  assert.equal(viaReal.allows(path.resolve('unrelated.txt')), false);
});

test('a realpath that throws is not fatal — the literal spelling still works', () => {
  const g = createPanelPathGuard({
    realpath: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  const p = path.resolve('gone.txt');
  assert.equal(g.surface(p), true);
  assert.equal(g.allows(p), true);
  assert.equal(g.allows(path.resolve('elsewhere.txt')), false);
});

// ── the set is bounded, and bounded in the right direction ───────────────

test('the set is capped, and the oldest entry is the one that goes', () => {
  const g = guard({ limit: 3 });
  const p = n => path.resolve(`f${n}.txt`);
  g.surface(p(1)); g.surface(p(2)); g.surface(p(3));
  assert.equal(g.size(), 3);
  g.surface(p(4));
  assert.equal(g.size(), 3);
  assert.equal(g.allows(p(1)), false, 'the least recently surfaced one was evicted');
  assert.equal(g.allows(p(4)), true);
});

test('re-surfacing a file keeps it out of the eviction queue', () => {
  const g = guard({ limit: 2 });
  const p = n => path.resolve(`g${n}.txt`);
  g.surface(p(1));
  g.surface(p(2));
  g.surface(p(1));      // still open in the panel
  g.surface(p(3));      // evicts the now-oldest, which is p(2)
  assert.equal(g.allows(p(1)), true);
  assert.equal(g.allows(p(2)), false);
  assert.equal(g.allows(p(3)), true);
});

test('the default cap is generous enough that ordinary use never hits it', () => {
  assert.ok(DEFAULT_LIMIT >= 1024, `DEFAULT_LIMIT=${DEFAULT_LIMIT}`);
});

// ── MCP: the pushes main cannot see unless it watches the window ─────────

test('an mcp-open-diff push surfaces the file it is a diff OF', () => {
  const g = guard();
  const { win, sent } = fakeWindow();
  const target = path.resolve('proj', 'edited.js');

  g.watchWindow(win).webContents.send('mcp-open-diff', 'sess-1', 'diff-1', {
    oldFilePath: target, oldContent: 'a', newContent: 'b', tabName: 'edited.js',
  });

  assert.equal(g.allows(target), true, 'the diff save button must work');
  assert.equal(sent.length, 1, 'and the renderer must still receive it');
});

test('an mcp-open-file push surfaces the file it opened', () => {
  const g = guard();
  const { win } = fakeWindow();
  const target = path.resolve('proj', 'README.md');

  g.watchWindow(win).webContents.send('mcp-open-file', 'sess-1', {
    filePath: target, content: '# hi', preview: false,
  });

  assert.equal(g.allows(target), true);
});

test('the push is forwarded byte-for-byte, arguments and return value included', () => {
  const g = guard();
  const { win, sent } = fakeWindow();
  const payload = { oldFilePath: path.resolve('a.js'), oldContent: 'x', newContent: 'y' };

  const result = g.watchWindow(win).webContents.send('mcp-open-diff', 'sess-9', 'diff-9', payload);

  assert.equal(result, 'sent');
  assert.deepEqual(sent, [['mcp-open-diff', 'sess-9', 'diff-9', payload]]);
  assert.equal(sent[0][3], payload, 'the same object, not a copy');
});

test('other channels are forwarded and surface nothing', () => {
  const g = guard();
  const { win, sent } = fakeWindow();
  const watched = g.watchWindow(win);

  watched.webContents.send('terminal-data', 'sess-1', 'ls -la\r\n');
  watched.webContents.send('mcp-close-all-diffs', 'sess-1');
  watched.webContents.send('file-changed', path.resolve('watched.txt'));

  assert.equal(sent.length, 3);
  assert.equal(g.size(), 0);
  assert.equal(g.allows(path.resolve('watched.txt')), false);
});

test('a malformed push cannot throw out of the send', () => {
  const g = guard();
  const { win, sent } = fakeWindow();
  const watched = g.watchWindow(win);

  watched.webContents.send('mcp-open-diff', 'sess-1', 'diff-1', null);
  watched.webContents.send('mcp-open-diff');
  watched.webContents.send('mcp-open-file', 'sess-1', { filePath: 42 });
  watched.webContents.send('mcp-open-file', 'sess-1', { filePath: '' });

  assert.equal(sent.length, 4, 'every send still went out');
  assert.equal(g.size(), 0, 'and nothing bogus was recorded');
});

test('mcp-bridge.js:207-221, executed verbatim against the stand-in', () => {
  // The literal shape of the bridge's send, because that is what has to keep
  // working: a null check, a destroyed check, then a send through whatever
  // object main handed it as `entry.mainWindow`.
  const g = guard();
  const { win, sent } = fakeWindow();
  const entry = { sessionId: 'sess-1', mainWindow: g.watchWindow(win) };
  const oldFilePath = path.resolve('proj', 'src', 'index.js');

  const target = entry.mainWindow && !entry.mainWindow.isDestroyed() ? entry.mainWindow : null;
  assert.ok(target, 'a live window must not look destroyed through the stand-in');
  target.webContents.send('mcp-open-diff', entry.sessionId, 'diff-1', {
    oldFilePath,
    oldContent: 'before',
    newContent: 'after',
    tabName: 'index.js',
  });

  assert.equal(sent.length, 1);
  // file-panel.js stores data.oldFilePath as tab.filePath and hands exactly
  // that back to save-file-for-panel, which resolves it first.
  assert.equal(g.allows(path.resolve(oldFilePath)), true);
});

test('the channel-to-field map is the one mcp-bridge.js actually sends', () => {
  // mcp-bridge.js:216 sends { oldFilePath, ... }; :259 sends { filePath, ... }.
  assert.deepEqual(PANEL_PUSH_FIELDS, {
    'mcp-open-file': 'filePath',
    'mcp-open-diff': 'oldFilePath',
  });
});

// ── the wrapper must behave like the window it stands in for ─────────────

test('everything except the recording is the real window', () => {
  const g = guard();
  const { win } = fakeWindow();
  let destroyed = false;
  win.isDestroyed = () => destroyed;

  const watched = g.watchWindow(win);
  assert.equal(watched.id, 42);
  assert.equal(watched.isDestroyed(), false);
  destroyed = true;
  assert.equal(watched.isDestroyed(), true, 'reads through to the live window, not a snapshot');
});

test('wrapping is idempotent and stable, so identity comparisons survive', () => {
  const g = guard();
  const { win } = fakeWindow();
  const once = g.watchWindow(win);
  assert.equal(g.watchWindow(win), once, 'same window, same stand-in');
  assert.equal(g.watchWindow(once), once, 'wrapping a stand-in returns it unchanged');
  assert.equal(once.webContents, once.webContents, 'webContents identity is stable');
});

test('a missing window is passed through rather than wrapped', () => {
  const g = guard();
  assert.equal(g.watchWindow(null), null);
  assert.equal(g.watchWindow(undefined), undefined);
});

test('two guards do not share a set', () => {
  const a = guard();
  const b = guard();
  a.surface(path.resolve('a.txt'));
  assert.equal(b.allows(path.resolve('a.txt')), false);
});

// ── the shape main.js relies on ──────────────────────────────────────────

test('a POSIX absolute path on a POSIX guard round-trips unchanged', () => {
  const g = createPanelPathGuard({ platform: 'linux', realpath: p => p });
  const target = POSIX.join('/home/jason/proj', 'src', 'index.js');
  g.surface(target);
  assert.equal(g.allows(target), true);
  assert.equal(g._keys()[0], target);
});
