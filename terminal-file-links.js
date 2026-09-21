// Validates the file references the renderer finds in terminal output, so a
// click can open a real file. The renderer only pattern-matches text; nothing
// is treated as a file until this module has parsed it and seen it on disk.
//
// Two rules hold the whole design together:
//
//   1. Only absolute paths, `~` paths, `file:` URLs and a short list of editor
//      URIs are accepted. A relative name is never resolved against anything —
//      not the process cwd, not the session's launch folder. A session's launch
//      folder is not necessarily its current directory (the user can `cd`), and
//      resolving `plan.md` against the wrong root opens an unrelated file that
//      looks right. Refusing is the only honest answer.
//   2. A reference is a path to stat, never a string to hand to a shell. The
//      main process resolves it and hands a plain path back; the URI itself
//      never reaches `shell.openExternal` or a command line.
//
// Harness-neutral: nothing here reads a session, a harness id or a project
// root — `resolveTerminalFiles` takes strings and returns targets.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const EDITOR_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'windsurf:']);

/** Split a trailing `:line[:col]` or `#Lline[Ccol]` citation off a reference. */
function splitFileLocation(value) {
  const match = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)$/i);
  if (!match) return { path: value };
  const line = Number(match[1] || match[3]);
  const column = Number(match[2] || match[4] || 1);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return { path: value };
  return { path: value.slice(0, match.index), line, column };
}

/** Parse only local files and known editor URIs; never send a URI to a shell.
 *  Returns the candidate targets to try, most literal first, or [] for
 *  anything that is not a local file reference. */
function parseTerminalFileReference(reference, { platform = process.platform, home = os.homedir() } = {}) {
  if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\x00-\x1f\x7f]/.test(reference)) return [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let value = reference;
  let uriLocation = {};
  const scheme = value.match(/^([a-z][a-z\d+.-]*:)/i)?.[1].toLowerCase();
  // A drive letter is a path, not a URI scheme.
  if (scheme && !/^[a-z]:[/\\]/i.test(value)) {
    if (scheme !== 'file:' && !EDITOR_SCHEMES.has(scheme)) return [];
    let url;
    try { url = new URL(value); } catch { return []; }
    if (url.username || url.password || url.port) return [];
    uriLocation = splitFileLocation(url.hash).line ? splitFileLocation(url.hash) : {};
    if (url.search) return [];
    url.hash = '';
    try {
      if (scheme === 'file:') {
        if (!/^file:\/\/(?:localhost)?\//i.test(reference)) return [];
        if (url.hostname && url.hostname !== 'localhost') return [];
        // The `windows` option only matters when a caller overrides `platform`
        // (the cross-platform tests); in the app it equals the default.
        value = fileURLToPath(url, { windows: platform === 'win32' });
      } else {
        if (url.hostname !== 'file') return [];
        value = decodeURIComponent(url.pathname);
        if (platform === 'win32') value = value.replace(/^\/([a-z]:[/\\])/i, '$1');
      }
    } catch { return []; }
  }
  if (/[\x00-\x1f\x7f]/.test(value) || /^[/\\]{2}/.test(value)) return [];
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) value = paths.join(home, value.slice(2));
  const location = splitFileLocation(value);
  // Prefer an existing literal filename, e.g. "notes#L10", over interpreting
  // its suffix as a location. The second candidate handles actual citations.
  const candidates = [{ path: value }, ...(location.path !== value ? [location] : [])];
  return candidates.flatMap(candidate => {
    if (!candidate.path) return [];
    if (platform !== 'win32' && /^[a-z]:[/\\]/i.test(candidate.path)) return [];
    if (platform === 'win32' && /^[a-z]:[^/\\]/i.test(candidate.path)) return [];
    // A session's launch folder is not necessarily its current directory.
    // Require a full target; never guess where a relative filename belongs.
    if (!paths.isAbsolute(candidate.path)) return [];
    if (platform === 'win32' && !/^[a-z]:[/\\]/i.test(candidate.path)) return [];
    const filePath = paths.normalize(candidate.path);
    // UNC: a terminal link must not make the app reach onto the network.
    if (/^[/\\]{2}/.test(filePath)) return [];
    return [{ filePath, ...(candidate.line ? { line: candidate.line, column: candidate.column } : {}),
      ...(uriLocation.line ? { line: uriLocation.line, column: uriLocation.column } : {}) }];
  });
}

/** Resolve a batch of references against disk. The result has the same length
 *  as the input; an entry is null when nothing about it named an existing file. */
async function resolveTerminalFiles(references) {
  if (!Array.isArray(references) || references.length > 32) return [];
  return Promise.all(references.map(async reference => {
    for (const candidate of parseTerminalFileReference(reference)) {
      try {
        // A directory is not an openable target — isFile(), not exists.
        if ((await fs.promises.stat(candidate.filePath)).isFile()) return candidate;
      } catch {}
    }
    return null;
  }));
}

module.exports = { splitFileLocation, parseTerminalFileReference, resolveTerminalFiles };
