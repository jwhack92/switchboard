'use strict';
// memory-read.js: what `read-memory` may hand the window.
//
// The handler used to read any path that ended in .md and existed ("Allow
// paths under ~/.claude/ or any .md file that exists"). A renderer bug, or
// anything that gets to run script in the renderer, such as a rendered
// preview, could then read every CLAUDE.md, plan and note on the machine.
// Its write twin `save-memory` was already contained to memoryPaths, the set
// main seeds from its own Memory scan (main.js, collectAndIndexMemories); the
// read now asks the same set. Only the Memory tab calls it (openMemory, whose
// items come from that scan); the Projects view's side cards read through
// `read-project-file`, by project id.
//
// Pure: no Electron, no other module of the app, no side effect on load. The
// guard is handed in, so main passes memoryPaths.allows and tests a stub.

const fs = require('fs');
const path = require('path');

/**
 * readMemoryFile(filePath, { allows, readFile, log }) -> string
 *   The file's text, or '' when it is not a .md the guard allows, or cannot
 *   be read. A refusal writes one warn naming the resolved path. Never throws.
 */
function readMemoryFile(filePath, { allows, readFile = (p) => fs.readFileSync(p, 'utf8'), log } = {}) {
  if (typeof filePath !== 'string' || !filePath) return '';
  let resolved;
  try { resolved = path.resolve(filePath); } catch { return ''; }
  if (!resolved.endsWith('.md')) return '';
  if (!allows(resolved)) {
    try { log.warn(`[memory] refused a read of a file the memory list does not hold: ${resolved}`); } catch { /* a log that fails must not fail the read */ }
    return '';
  }
  try {
    return readFile(resolved);
  } catch {
    return '';
  }
}

module.exports = { readMemoryFile };
