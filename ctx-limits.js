// ctx-limits.js -- the ctx-handoff hook's per-project limits, <ctx dir>/limits.json.
//
// The hook (~/.claude/hooks/ctx-handoff/ctx_handoff.py) asks a session for a
// handoff when its context passes the project's limit, and again `rearm`
// tokens past each handoff. Both numbers come from this file, read by the hook
// at every event:
//
//   {"version": 1,
//    "default":  {"limit": 400000, "rearm": 150000},
//    "projects": {"<project slug>": {"limit": 500000, "rearm": 150000}}}
//
// The slug is Claude Code's project folder name (the hook's project_slug(),
// encodeProjectPath here). A key absent from a project entry is the default's;
// an invalid value, a bad file or no file is the built-in 400000 / 150000 for
// that value. Booleans are not integers (Number.isInteger(true) is false).
//
// Main is the only writer (the Project Settings panel through
// 'write-ctx-limits'): one project's entry is changed, every other key in the
// file -- other projects, unknown keys, unknown keys inside an entry -- is
// written back as it was, and the write is a temp file in the same folder
// renamed over the old one, so the hook never reads half a file. A file that
// is there but is not a JSON object is refused rather than overwritten: what
// it held would be lost.
//
// No Electron here: main.js and token-usage-queries.js require it, and the
// tests run it under plain Node with a temp folder.

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 400000;
const DEFAULT_REARM = 150000;
const LIMIT_MIN = 100000;
const LIMIT_MAX = 950000;
const REARM_MIN = 25000;
const REARM_MAX = 500000;
const LIMITS_FILE = 'limits.json';
// Claude Code's folder names are [A-Za-z0-9-] (encodeProjectPath), and the
// long-path form adds a dash and a base-36 hash. The slug is only ever a JSON
// key, never a path, but nothing else should be stored as one.
const SLUG_RE = /^[A-Za-z0-9-]{1,240}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validLimit = (v) => Number.isInteger(v) && v >= LIMIT_MIN && v <= LIMIT_MAX;
const validRearm = (v) => Number.isInteger(v) && v >= REARM_MIN && v <= REARM_MAX;

function limitsPath(ctxDir) {
  return path.join(ctxDir, LIMITS_FILE);
}

// → { doc, code }: doc is the parsed object or null; code null = read,
// 'ENOENT' = no file (normal), 'EPARSE' = not JSON, 'ESHAPE' = JSON but not an
// object, else the read error's code.
function readLimitsDoc(ctxDir, fsMod = fs) {
  let text;
  try { text = fsMod.readFileSync(limitsPath(ctxDir), 'utf8'); }
  catch (err) { return { doc: null, code: err && err.code === 'ENOENT' ? 'ENOENT' : (err && err.code) || 'EREAD' }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { doc: null, code: 'EPARSE' }; }
  if (!isPlainObject(doc)) return { doc: null, code: 'ESHAPE' };
  return { doc, code: null };
}

// The numbers the hook uses for one project, by the rules at the top.
// source says where the limit came from: 'project', 'default' or 'builtin'.
function effectiveLimits(doc, slug) {
  const def = isPlainObject(doc) && isPlainObject(doc.default) ? doc.default : {};
  const projects = isPlainObject(doc) && isPlainObject(doc.projects) ? doc.projects : {};
  const entry = typeof slug === 'string' && Object.prototype.hasOwnProperty.call(projects, slug) && isPlainObject(projects[slug])
    ? projects[slug] : {};
  const pick = (key, valid, builtin) => {
    if (key in entry) return valid(entry[key]) ? [entry[key], 'project'] : [builtin, 'builtin'];
    if (key in def) return valid(def[key]) ? [def[key], 'default'] : [builtin, 'builtin'];
    return [builtin, 'builtin'];
  };
  const [limit, source] = pick('limit', validLimit, DEFAULT_LIMIT);
  const [rearm, rearmSource] = pick('rearm', validRearm, DEFAULT_REARM);
  return { limit, rearm, source, rearmSource };
}

// What the settings panel shows for one project: its own stored values (null =
// blank, the default's) and what the hook will use.
function readProjectLimits(ctxDir, slug, fsMod = fs) {
  const { doc, code } = readLimitsDoc(ctxDir, fsMod);
  const projects = doc && isPlainObject(doc.projects) ? doc.projects : {};
  const entry = typeof slug === 'string' && Object.prototype.hasOwnProperty.call(projects, slug) && isPlainObject(projects[slug])
    ? projects[slug] : {};
  const def = effectiveLimits(doc, null);
  return {
    slug,
    own: { limit: validLimit(entry.limit) ? entry.limit : null, rearm: validRearm(entry.rearm) ? entry.rearm : null },
    effective: effectiveLimits(doc, slug),
    defaults: { limit: def.limit, rearm: def.rearm },
    code: code === 'ENOENT' ? null : code,
  };
}

// null/undefined = blank (the key is removed: the default's). Anything else
// must be a valid integer. → an error message, or '' when it is acceptable.
function validationError(limit, rearm) {
  if (limit != null && !validLimit(limit)) return 'The limit must be a whole number of tokens from 100K to 950K.';
  if (rearm != null && !validRearm(rearm)) return 'The re-arm step must be a whole number of tokens from 25K to 500K.';
  return '';
}

// Sets (or clears) one project's limit and re-arm step. → { ok: true, ... } or
// { ok: false, error }. Nothing is written unless ok.
function writeProjectLimits(ctxDir, slug, limit, rearm, fsMod = fs) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { ok: false, error: 'Not a project folder name.' };
  const bad = validationError(limit, rearm);
  if (bad) return { ok: false, error: bad };
  const read = readLimitsDoc(ctxDir, fsMod);
  if (read.code && read.code !== 'ENOENT') {
    return { ok: false, error: 'limits.json could not be read (' + read.code + '); it was left as it is.' };
  }
  const doc = read.doc || { version: 1 };
  if ('projects' in doc && !isPlainObject(doc.projects)) {
    return { ok: false, error: 'limits.json has a "projects" that is not an object; it was left as it is.' };
  }
  const projects = isPlainObject(doc.projects) ? doc.projects : {};
  const entry = isPlainObject(projects[slug]) ? { ...projects[slug] } : {};
  if (limit == null) delete entry.limit; else entry.limit = limit;
  if (rearm == null) delete entry.rearm; else entry.rearm = rearm;
  if (Object.keys(entry).length) projects[slug] = entry; else delete projects[slug];
  doc.projects = projects;
  if (!('version' in doc)) doc.version = 1;

  const target = limitsPath(ctxDir);
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fsMod.mkdirSync(ctxDir, { recursive: true });
    fsMod.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fsMod.renameSync(tmp, target);
  } catch (err) {
    try { fsMod.unlinkSync(tmp); } catch {}
    return { ok: false, error: 'limits.json could not be written (' + ((err && err.code) || 'EWRITE') + ').' };
  }
  return { ok: true, ...readProjectLimits(ctxDir, slug, fsMod) };
}

module.exports = {
  DEFAULT_LIMIT, DEFAULT_REARM, LIMIT_MIN, LIMIT_MAX, REARM_MIN, REARM_MAX, LIMITS_FILE, SLUG_RE,
  validLimit, validRearm, limitsPath, readLimitsDoc, effectiveLimits, readProjectLimits,
  validationError, writeProjectLimits,
};
