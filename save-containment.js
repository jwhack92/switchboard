// What the file panel is allowed to write back.
//
// `save-file-for-panel` used to write any path the renderer named that happened
// to exist. That was survivable while the only way a path reached the panel was
// an MCP push the CLI had already chosen, but the project file browser makes
// every file in every project one click away, and a terminal link makes an
// arbitrary absolute path one click away. A renderer bug -- or anything that
// gets to run script in the renderer, such as a rendered preview -- could then
// overwrite ~/.ssh/config or a shell profile with content of its choosing.
//
// The containment: main keeps the set of paths it has ITSELF put in front of
// the user, and refuses a save to anything else. Two rules make that honest:
//
//   1. Only main seeds the set. Nothing the renderer sends can add to it; the
//      renderer can only ask main to read a file, and it is main's successful
//      read that records the path. So "savable" always means "Switchboard
//      showed you this file", never "the renderer asserted it had".
//
//   2. A path is recorded under BOTH its resolved spelling and its realpath,
//      and a save is allowed if either matches. The browser hands back
//      realpath()ed paths (project-files.js resolveProjectEntry) while the MCP
//      bridge and the terminal links hand back the literal path, and the two
//      can be the same file. Refusing that mismatch would break saving with no
//      security gain -- the file was surfaced either way.
//
// The MCP bridge is the awkward seeder, and the reason `watchWindow` exists:
// mcp-bridge.js sends `mcp-open-diff` / `mcp-open-file` straight at the window
// main handed it (mcp-bridge.js:216, :259), so main never sees those paths. It
// is main that chooses the window (main.js setMcpWindow / startMcpServer), so
// main wraps it: a send of one of those two channels records the file path and
// is then forwarded untouched. Break that and MCP diff-saving breaks with it,
// which is why the forwarding has a test of its own.
//
// Deliberately NOT contained: reading. The browser exists to read, and
// project-files.js already confines its reads to a project root. This module is
// about the one operation that destroys data.

'use strict';

const fs = require('fs');
const path = require('path');

// Channels the main process uses to put a file in the panel, and the field of
// the payload naming it. Kept here rather than in mcp-bridge.js so the guard
// stays one file: if a third channel ever surfaces a savable file, it is added
// here and the save path needs no change.
const PANEL_PUSH_FIELDS = {
  'mcp-open-file': 'filePath',
  'mcp-open-diff': 'oldFilePath',
};

// Enough for any plausible session (the panel shows one tab at a time), small
// enough that a file browser walked over a huge tree cannot grow without bound.
const DEFAULT_LIMIT = 4096;

const WRAPPED = Symbol('switchboard.panelPathGuard.wrapped');

function createPanelPathGuard(options = {}) {
  const platform = options.platform || process.platform;
  const limit = options.limit || DEFAULT_LIMIT;
  const realpath = options.realpath || (filePath => fs.realpathSync(filePath));
  const logger = options.log || null;

  // key -> the spelling it was recorded under. Insertion-ordered, so the first
  // key is the least recently surfaced one and eviction is a shift.
  const surfaced = new Map();
  const wrappedWindows = new WeakMap();
  const wrappedContents = new WeakMap();

  // In the app this is `path`; naming it explicitly is what lets a test pin a
  // platform other than the host's and still resolve the way that platform
  // would.
  const paths = platform === 'win32' ? path.win32 : path.posix;

  // Windows compares paths case-insensitively, so keying on the exact spelling
  // would refuse a save of the same file reached through a different casing.
  // Elsewhere the case is significant and folding it would widen the set.
  function canonical(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    let resolved;
    try { resolved = paths.resolve(filePath); } catch { return null; }
    if (!resolved) return null;
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function remember(key, spelling) {
    if (!key) return;
    // Re-inserting refreshes recency, so a file kept open in the panel is never
    // the one evicted.
    if (surfaced.has(key)) surfaced.delete(key);
    surfaced.set(key, spelling);
    while (surfaced.size > limit) {
      const oldest = surfaced.keys().next().value;
      surfaced.delete(oldest);
    }
  }

  /** Record a file main has just shown in the panel. Returns false for a value
   *  that is not a usable path, so a caller can tell nothing was recorded. */
  function surface(filePath) {
    const key = canonical(filePath);
    if (!key) return false;
    remember(key, filePath);
    let real = null;
    try { real = realpath(filePath); } catch { /* not on disk yet, or gone */ }
    if (typeof real === 'string' && real && real !== filePath) remember(canonical(real), real);
    return true;
  }

  /** May the panel write this path back? */
  function allows(filePath) {
    const key = canonical(filePath);
    if (!key) return false;
    if (surfaced.has(key)) return true;
    let real = null;
    try { real = realpath(filePath); } catch { return false; }
    const realKey = canonical(real);
    return !!realKey && surfaced.has(realKey);
  }

  function recordPush(channel, args) {
    const field = PANEL_PUSH_FIELDS[channel];
    if (!field) return;
    for (const arg of args) {
      if (arg && typeof arg === 'object' && typeof arg[field] === 'string' && arg[field]) {
        surface(arg[field]);
        return;
      }
    }
  }

  function wrapWebContents(contents) {
    if (!contents || typeof contents !== 'object') return contents;
    const cached = wrappedContents.get(contents);
    if (cached) return cached;
    const proxy = new Proxy(contents, {
      get(target, property) {
        if (property === 'send') {
          return (channel, ...args) => {
            // Recording must never cost the send: the panel not knowing about a
            // path degrades to "cannot save it", while a throw here would lose
            // the diff itself and hang the CLI waiting for an answer.
            try {
              recordPush(channel, args);
            } catch (err) {
              logger?.debug?.(`[panel] could not record ${channel}: ${err.message}`);
            }
            return target.send(channel, ...args);
          };
        }
        const value = Reflect.get(target, property);
        // Bound to the real object: an Electron method called with a Proxy as
        // its receiver is not guaranteed to work.
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    wrappedContents.set(contents, proxy);
    return proxy;
  }

  /** A stand-in for `win` that records the panel pushes sent through it.
   *  Everything else is forwarded to the real window unchanged. */
  function watchWindow(win) {
    if (!win || typeof win !== 'object') return win;
    if (win[WRAPPED]) return win;
    const cached = wrappedWindows.get(win);
    if (cached) return cached;
    const proxy = new Proxy(win, {
      get(target, property) {
        if (property === WRAPPED) return true;
        if (property === 'webContents') return wrapWebContents(target.webContents);
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    wrappedWindows.set(win, proxy);
    return proxy;
  }

  return {
    allows,
    surface,
    watchWindow,
    size: () => surfaced.size,
    // Test/diagnostic seam only; the app never reads this.
    _keys: () => [...surfaced.keys()],
  };
}

module.exports = { createPanelPathGuard, PANEL_PUSH_FIELDS, DEFAULT_LIMIT };
