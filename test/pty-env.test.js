const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPtyEnv, CLAUDE_SESSION_VARS } = require('../pty-env');

test('strips Electron internals that break nested Electron / node-pty', () => {
  const env = buildPtyEnv({
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_API_KEY: 'secret',
    NODE_OPTIONS: '--inspect',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LC_CTYPE', 'PATH']);
});

test('sets a UTF-8 LC_CTYPE when the parent env has no locale at all', () => {
  // The macOS Finder/Dock launch case: launchd sets no LANG, so pbcopy would
  // fall back to Mac OS Roman and mangle UTF-8 on the way to the clipboard.
  assert.equal(buildPtyEnv({ PATH: '/usr/bin' }).LC_CTYPE, 'UTF-8');
});

test('an inherited locale wins — we do not override the user', () => {
  for (const inherited of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8' }, { LC_CTYPE: 'fr_FR.ISO8859-1' }]) {
    const env = buildPtyEnv({ ...inherited });
    assert.deepEqual(env, inherited);
  }
});

test('an empty locale value counts as absent', () => {
  // launchctl reports LANG as empty rather than unset on some macOS setups;
  // an empty string gives pbcopy nothing to work with either.
  assert.equal(buildPtyEnv({ LANG: '' }).LC_CTYPE, 'UTF-8');
});

// --- fork-only: inherited Claude Code session markers ----------------------
//
// Upstream's pty-env.js has no equivalent of this, so importing their file
// wholesale would delete it. The failure it prevents is not a crash: with
// CLAUDE_CODE_CHILD_SESSION inherited, the nested CLI decides it is a child,
// prints "Transcript saving is off", and writes no transcript — so the session
// never appears in Switchboard at all. A session that silently does not exist
// is not something anyone traces back to an env filter, which is exactly why
// this is pinned rather than left to review.

test('every inherited Claude Code session marker is stripped', () => {
  const source = { PATH: '/usr/bin' };
  for (const k of CLAUDE_SESSION_VARS) source[k] = 'inherited';
  const env = buildPtyEnv(source);
  for (const k of CLAUDE_SESSION_VARS) {
    assert.equal(env[k], undefined, `${k} survived into the PTY env`);
  }
  assert.equal(env.PATH, '/usr/bin');
});

test('the marker list still covers the ones that actively break a session', () => {
  // Named individually so that removing one from the list fails here rather
  // than silently shrinking the guarantee.
  for (const k of [
    'CLAUDE_CODE_CHILD_SESSION',      // suppresses transcript writing
    'CLAUDE_CODE_MESSAGING_SOCKET',   // points the child at the parent's IPC
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    assert.ok(CLAUDE_SESSION_VARS.includes(k), `${k} missing from CLAUDE_SESSION_VARS`);
  }
});
