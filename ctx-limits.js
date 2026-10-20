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
// the transcript's folder; slugForProject here). The hook matches a project key
// exactly, else ignoring case (projectKey). Each value on its own, as the
// hook's project_limits(): the project's when valid, else the default's when
// valid, else the built-in 400000 / 150000. A file whose version is not 1 (none
// at all included), a bad file or no file is the built-in for everything.
// Booleans are not integers (Number.isInteger(true) is false); 500000.0 and 5e5
// parse to the integer 500000, as the hook takes them.
//
// Main is the only writer (the Project Settings panel through
// 'write-ctx-limits'): one project's entry is changed, every other key in the
// file -- other projects, unknown keys, unknown keys inside an entry -- is
// written back as it was, and the write is a temp file in the same folder
// renamed over the old one, so the hook never reads half a file. A file that
// is there but is not a JSON object, or is not version 1, is refused rather
// than overwritten: what it held would be lost. The rename is retried a few
// times on EPERM/EBUSY/EACCES (the hook may have the file open for a moment).
//
// No Electron here: main.js and token-usage-queries.js require it, and the
// tests run it under plain Node with a temp folder.

const fs = require('fs');
const path = require('path');
const { encodeProjectPath } = require('./encode-project-path');

const DEFAULT_LIMIT = 400000;
const DEFAULT_REARM = 150000;
const LIMIT_MIN = 100000;
const LIMIT_MAX = 950000;
const REARM_MIN = 25000;
const REARM_MAX = 500000;
const LIMITS_FILE = 'limits.json';
const LIMITS_VERSION = 1;
// Claude Code's folder names are [A-Za-z0-9-] (encodeProjectPath), and the
// long-path form adds a dash and a base-36 hash (at most 208). 255 is the
// hook's own cap on a key. The slug is only ever a JSON key, never a path, but
// nothing else should be stored as one.
const SLUG_RE = /^[A-Za-z0-9-]{1,255}$/;
// The rename's retries, as driver-store.js's writeJsonAtomic (which throws and
// takes no injected fs, so it is not reused).
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = [10, 25, 60, 150, 350];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validLimit = (v) => Number.isInteger(v) && v >= LIMIT_MIN && v <= LIMIT_MAX;
const validRearm = (v) => Number.isInteger(v) && v >= REARM_MIN && v <= REARM_MAX;

function limitsPath(ctxDir) {
  return path.join(ctxDir, LIMITS_FILE);
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The key for a project path: Claude Code's folder name for it, the one its
// transcripts are in and so the hook's project_slug(). null when it is not one.
function slugForProject(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return null;
  const slug = encodeProjectPath(projectPath);
  return SLUG_RE.test(slug) ? slug : null;
}

// The key in projects that stands for slug: the same string, else the first
// key (file order) that differs from it only in case, else null.
function projectKey(projects, slug) {
  if (!isPlainObject(projects) || typeof slug !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(projects, slug)) return slug;
  const lower = slug.toLowerCase();
  for (const key of Object.keys(projects)) if (key.toLowerCase() === lower) return key;
  return null;
}

// → { doc, code }: doc is the parsed object or null; code null = read,
// 'ENOENT' = no file (normal), 'EPARSE' = not JSON, 'ESHAPE' = JSON but not an
// object, 'EVERSION' = an object whose version is not 1 (doc is still given:
// it is not to be used for numbers, only kept from being overwritten), else
// the read error's code.
function readLimitsDoc(ctxDir, fsMod = fs) {
  let text;
  try { text = fsMod.readFileSync(limitsPath(ctxDir), 'utf8'); }
  catch (err) { return { doc: null, code: err && err.code === 'ENOENT' ? 'ENOENT' : (err && err.code) || 'EREAD' }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { doc: null, code: 'EPARSE' }; }
  if (!isPlainObject(doc)) return { doc: null, code: 'ESHAPE' };
  if (doc.version !== LIMITS_VERSION) return { doc, code: 'EVERSION' };
  return { doc, code: null };
}

const usableDoc = (doc) => isPlainObject(doc) && doc.version === LIMITS_VERSION;

// The numbers the hook uses for one project, by the rules at the top.
// source says where the limit came from: 'project', 'default' or 'builtin'.
function effectiveLimits(doc, slug) {
  const usable = usableDoc(doc);
  const def = usable && isPlainObject(doc.default) ? doc.default : {};
  const projects = usable && isPlainObject(doc.projects) ? doc.projects : {};
  const key = projectKey(projects, slug);
  const entry = key !== null && isPlainObject(projects[key]) ? projects[key] : {};
  const pick = (name, valid, builtin) => {
    if (valid(entry[name])) return [entry[name], 'project'];
    if (valid(def[name])) return [def[name], 'default'];
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
  const projects = usableDoc(doc) && isPlainObject(doc.projects) ? doc.projects : {};
  const key = projectKey(projects, slug);
  const entry = key !== null && isPlainObject(projects[key]) ? projects[key] : {};
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
  if (read.code === 'EVERSION') {
    return { ok: false, error: 'limits.json is not version 1, so the hook does not use it; it was left as it is.' };
  }
  if (read.code && read.code !== 'ENOENT') {
    return { ok: false, error: 'limits.json could not be read (' + read.code + '); it was left as it is.' };
  }
  const doc = read.doc || { version: LIMITS_VERSION };
  if ('projects' in doc && !isPlainObject(doc.projects)) {
    return { ok: false, error: 'limits.json has a "projects" that is not an object; it was left as it is.' };
  }
  const projects = isPlainObject(doc.projects) ? doc.projects : {};
  // A key that differs only in case is the hook's for this project: it is
  // updated, not joined by a second.
  const key = projectKey(projects, slug) ?? slug;
  const entry = isPlainObject(projects[key]) ? { ...projects[key] } : {};
  if (limit == null) delete entry.limit; else entry.limit = limit;
  if (rearm == null) delete entry.rearm; else entry.rearm = rearm;
  if (Object.keys(entry).length) projects[key] = entry; else delete projects[key];
  doc.projects = projects;

  const target = limitsPath(ctxDir);
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  let lastErr = null;
  try {
    fsMod.mkdirSync(ctxDir, { recursive: true });
    fsMod.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try { fsMod.renameSync(tmp, target); lastErr = null; break; }
      catch (err) {
        lastErr = err;
        const code = err && err.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        if (attempt < RENAME_RETRIES - 1) sleepSync(RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (err) { lastErr = err; }
  if (lastErr) {
    try { fsMod.unlinkSync(tmp); } catch {}
    return { ok: false, error: 'limits.json could not be written (' + ((lastErr && lastErr.code) || 'EWRITE') + ').' };
  }
  return { ok: true, ...readProjectLimits(ctxDir, slug, fsMod) };
}

module.exports = {
  DEFAULT_LIMIT, DEFAULT_REARM, LIMIT_MIN, LIMIT_MAX, REARM_MIN, REARM_MAX, LIMITS_FILE, LIMITS_VERSION, SLUG_RE,
  RENAME_RETRIES, validLimit, validRearm, limitsPath, slugForProject, projectKey, readLimitsDoc, effectiveLimits,
  readProjectLimits,
  validationError, writeProjectLimits,
};
