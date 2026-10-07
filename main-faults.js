'use strict';
// main-faults.js: what the main process does with an error nobody caught. Loaded after the reloader line of main.js: a change here needs an app restart.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const TABLE_CAP = 200;             // rule S: records kept per table; the one created first is dropped
const FULL_PER_RECORD = 3;         // rule L: full entries for one record
const FULL_PER_WINDOW = 20;        // rule L: full entries over all records in FULL_WINDOW_MS
const FULL_WINDOW_MS = 60000;
const REPEAT_AFTER_MS = 30000;     // rule L: the repeat line follows the first uncounted occurrence by this
const SEND_EVERY_MS = 1000;        // rule N: one record is sent at most this often
const REOPEN_AFTER_MS = 60000;     // rule N: a dismissed record opens again this long after its dismiss
const LIST_CAP = 50;
const FIRST_LINE_MAX = 300;        // rule T
const STACK_MAX = 8192;            // rule T
const FILE_MAX = 262144;           // rule F: the fault file is renamed before a line would take it past this
const TAIL_BYTES = 65536;          // rule P: how much of the old fault file is read at start
const CALLER_LINES = 6;            // rule B: how many stack lines name the caller of app.quit, app.exit or app.relaunch

/** Rule T: the text of an error that is not null or undefined. */
function textOf(error) {
  try {
    const stack = error.stack;
    if (typeof stack === 'string' && stack !== '') return String(stack);
    if (typeof error === 'string') return error;
    return util.inspect(error, { depth: 2, breakLength: Infinity });
  } catch {
    return '(unreadable error)';
  }
}

/** Rule S: the first three lines of an error's text, with what differs from one occurrence to the next replaced. */
function signatureOf(text) {
  return text.split(/\r?\n/, 3).join('\n')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/[0-9a-f]{6,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '#');
}

function createMainFaults({ log, app, dialog, broadcast, now = Date.now, stderr = process.stderr, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  /** One string for this run: it stands on every line this run writes to the fault file. */
  const run = crypto.randomBytes(8).toString('hex');

  /** The fault file (rule F): main-faults.log beside the main log, else in app.getPath('logs'), else null: there is none. */
  let file = null;
  for (const folder of [() => path.dirname(log.transports.file.getFile().path), () => app.getPath('logs')]) {
    try {
      const dir = folder();
      if (typeof dir === 'string' && path.isAbsolute(dir)) { file = path.join(dir, 'main-faults.log'); break; }
    } catch {}
  }

  /** Every record list() can give, by id, in the order they were made. */
  const records = new Map();
  /** Rule S's two tables, key to record, the one created first in front: by signature, and by kind and session. */
  const bySignature = new Map();
  const bySession = new Map();
  /** Rule L: when the full entries of the last FULL_WINDOW_MS were written. */
  const fullAt = [];
  let made = 0;
  let windowLoaded = false;
  let mainLoaded = false;
  let listening = false;
  let crumbsInstalled = false;
  /** Rule X: true once a fault has come through one of the two listeners. */
  let listenerFaultSeen = false;
  /** app.exit as it was before installBreadcrumbs wrapped it; null while it is not wrapped. */
  let originalExit = null;
  /** Rule R: true while a call is being handled, and how many calls arrived meanwhile. */
  let busy = false;
  let nested = 0;

  /**
   * Rule R, for everything that handles something (a fault, a dismiss, a flush, a timer body): it never
   * throws, and a call that arrives while another one is being handled is only counted.
   */
  function entry(fn) {
    return (...args) => {
      if (busy) { nested += 1; return undefined; }
      busy = true;
      try { return fn(...args); } catch { return undefined; } finally { busy = false; }
    };
  }

  /** Rule R, for what only reads or registers: it never throws. */
  function safe(fn) {
    return (...args) => { try { return fn(...args); } catch { return undefined; } };
  }

  /** A timer of a record, its handle kept in record[slot]. Its body is an entry point of its own (rule R). */
  function arm(record, slot, ms, fn) {
    const body = entry(fn);
    const handle = setTimer(() => { record[slot] = null; body(); }, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    record[slot] = handle;
  }

  function disarm(record, slot) {
    if (!record[slot]) return;
    clearTimer(record[slot]);
    record[slot] = null;
  }

  /**
   * One JSON line of the fault file (rule F). When the line would take the file past FILE_MAX, the file first
   * becomes main-faults.old.log and the line starts a new one. A write that throws is swallowed.
   */
  function writeLine(ev, fields) {
    if (!file) return;
    try {
      const line = JSON.stringify({ t: now(), run, ev, ...fields }) + '\n';
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size + Buffer.byteLength(line) > FILE_MAX) fs.renameSync(file, path.join(path.dirname(file), 'main-faults.old.log'));
      fs.appendFileSync(file, line);
    } catch {}
  }

  /** Rule B: a crumb is one line of the fault file and one info line of the main log. */
  function crumb(name, fields) {
    writeLine('crumb', { name, ...fields });
    try { log.info(`[main-fault] crumb name=${name}`); } catch {}
  }

  /** Rule L: one error or warn call of the main log; when it throws, the first line goes to stderr. */
  function writeLog(level, firstLine, ...args) {
    try { log[level](...args); } catch {
      try { stderr.write(`[main-fault] ${firstLine}\n`); } catch {}
    }
  }

  /** A record as list() and the 'main-fault' event give it: a fresh plain object each time. */
  function plain(record) {
    return {
      id: record.id, kind: record.kind, sessionId: record.sessionId, firstLine: record.firstLine, count: record.count,
      firstAt: record.firstAt, lastAt: record.lastAt, previousRun: record.previousRun, dismissed: record.dismissed,
      stack: record.stack, runErrors: record.runErrors,
    };
  }

  /** Rule N: the record goes to every window now, and a send still armed for it is not needed any more. */
  function sendNow(record) {
    disarm(record, 'sendTimer');
    record.sentAt = now();
    try { broadcast('main-fault', plain(record)); } catch {}
  }

  /** Rule N: at once when the record's last send is SEND_EVERY_MS old or more, else one send armed for that moment. */
  function send(record) {
    const since = typeof record.sentAt === 'number' ? now() - record.sentAt : SEND_EVERY_MS;
    if (since >= SEND_EVERY_MS) { sendNow(record); return; }
    if (record.sendTimer) return;
    arm(record, 'sendTimer', SEND_EVERY_MS - since, () => { sendNow(record); });
  }

  /** Rules L and F: the occurrences of a record that got no full entry, as ONE line; then its count starts again. */
  function writeRepeat(record) {
    disarm(record, 'owedTimer');
    const count = record.owed;
    if (!count) return;
    record.owed = 0;
    writeLog('warn', record.firstLine, `[main-fault] kind=${record.kind} id=${record.id} line=${JSON.stringify(record.firstLine)} repeated ${count} more times`);
    writeLine('repeat', { id: record.id, kind: record.kind, firstLine: record.firstLine, count });
  }

  /** Rule S, its last sentence: a record that leaves its table leaves nothing behind. */
  function drop(record) {
    record.table.delete(record.key);
    records.delete(record.id);
    writeRepeat(record);
    disarm(record, 'sendTimer');
  }

  /** One fault: its record (rule S), its entry in the main log (rule L), its line in the fault file (rule F), its send (rule N). Returns rule T's text. */
  function handle(kind, error, origin, sessionId) {
    const at = now();
    const none = error === null || error === undefined;
    const text = none ? '' : textOf(error);
    const firstLine = text.split(/\r?\n/, 1)[0].slice(0, FIRST_LINE_MAX);
    const table = sessionId ? bySession : bySignature;
    const key = kind + '\n' + (sessionId || signatureOf(text));
    let record = table.get(key);
    if (record) {
      record.count += 1;
      record.lastAt = at;
      if (record.dismissed && at - record.dismissedAt >= REOPEN_AFTER_MS) record.dismissed = false;
    } else {
      made += 1;
      record = {
        id: 'f' + made, kind, sessionId, firstLine, count: 1, firstAt: at, lastAt: at,
        previousRun: false, dismissed: false, stack: text.slice(0, STACK_MAX), runErrors: 0,
        made, table, key, owed: 0, owedTimer: null, sentAt: null, sendTimer: null, dismissedAt: 0,
      };
      table.set(key, record);
      records.set(record.id, record);
      if (table.size > TABLE_CAP) drop(table.values().next().value);
    }
    while (fullAt.length && at - fullAt[0] >= FULL_WINDOW_MS) fullAt.shift();
    if (record.count <= FULL_PER_RECORD && fullAt.length < FULL_PER_WINDOW) {
      fullAt.push(at);
      const head = `[main-fault] kind=${kind} id=${record.id} origin=${origin}` + (sessionId ? ` session=${sessionId}` : '');
      if (none) writeLog('warn', firstLine, head); else writeLog('error', firstLine, head, text);
      const line = { id: record.id, kind, origin, n: record.count, firstLine, sessionId };
      if (record.count === 1) line.stack = record.stack;
      writeLine('fault', line);
    } else {
      record.owed += 1;
      if (!record.owedTimer) arm(record, 'owedTimer', REPEAT_AFTER_MS, () => { writeRepeat(record); });
    }
    send(record);
    return text;
  }

  /**
   * Rule X, for the one fault it applies to, after that fault is handled: the box unless there is no dialog,
   * then, when main.js has not finished loading, the crumb and the original app.exit(1). Never throws.
   */
  function startUpFault(text) {
    if (dialog) {
      try { dialog.showErrorBox('A JavaScript error occurred in the main process', file ? text + '\n\n' + file : text); } catch {}
    }
    if (mainLoaded) return;
    try { crumb('app.exit', { code: 1, caller: 'main-faults: start-up fault' }); } catch {}
    try { if (originalExit) originalExit(1); else app.exit(1); } catch {}
  }

  /**
   * A listener for one of the two process events. The fault is handled as an entry point of its own (rule R).
   * Rule X follows after that, outside it: the box can stay open for minutes and the exit ends the process, and
   * neither may hold back what arrives meanwhile.
   */
  function listener(origin) {
    const handled = entry((error) => {
      const startUp = !listenerFaultSeen && !windowLoaded;
      listenerFaultSeen = true;
      const text = handle('internal', error, origin, null);
      return startUp ? { text } : null;
    });
    return (error) => {
      const first = handled(error);
      if (first) startUpFault(first.text);
    };
  }

  function report(kind, error, info) {
    let sessionId = null;
    try { if (info && typeof info.sessionId === 'string' && info.sessionId !== '') sessionId = info.sessionId; } catch {}
    handle(kind, error, 'report', sessionId);
  }

  /** The records, newest first, at most LIST_CAP. */
  function list() {
    try {
      return [...records.values()].sort((a, b) => b.firstAt - a.firstAt || b.made - a.made).slice(0, LIST_CAP).map(plain);
    } catch {
      return [];
    }
  }

  function dismiss(id) {
    const record = records.get(id);
    if (!record) return;
    record.dismissed = true;
    record.dismissedAt = now();
    sendNow(record);
  }

  function noteWindow(win) {
    try { win.webContents.once('did-finish-load', safe(() => { windowLoaded = true; })); } catch {}
    win.on('session-end', entry(() => { crumb('windows-session-end'); }));
  }

  function noteMainLoaded() {
    mainLoaded = true;
  }

  function noteExitPath(name) {
    crumb(name);
  }

  /** What flush() does: every pending repeat line (rules L and F), then the line for the calls rule R only counted. */
  function writePending() {
    for (const record of [...records.values()]) writeRepeat(record);
    if (!nested) return;
    const count = nested;
    nested = 0;
    writeLine('nested', { count });
  }

  /** Rule B: a line for every way the app can exit. Each listener and each of the three wraps stands in its own try. */
  function installBreadcrumbs(proc, target) {
    if (crumbsInstalled) return;
    crumbsInstalled = true;
    const on = (emitter, name, fn) => { try { emitter.on(name, entry(fn)); } catch {} };
    for (const name of ['before-quit', 'will-quit', 'window-all-closed']) on(target, name, () => { crumb(name); });
    on(target, 'render-process-gone', (event, webContents, details) => {
      const { reason, exitCode } = details || {};
      crumb('render-process-gone', { reason, exitCode });
    });
    on(target, 'child-process-gone', (event, details) => {
      const { type, reason, exitCode } = details || {};
      crumb('child-process-gone', { type, reason, exitCode });
    });
    on(proc, 'exit', (code) => {
      try { writePending(); } catch {}
      writeLine('exit', { code });
    });
    for (const name of ['quit', 'exit', 'relaunch']) {
      try {
        const original = target[name];
        if (typeof original !== 'function') continue;
        const note = entry((args, caller) => { crumb('app.' + name, name === 'exit' ? { code: args[0], caller } : { caller }); });
        // The crumb is written as an entry point of its own; the original runs after it, outside it, with its own this, arguments, result and throw.
        const wrapper = function (...args) {
          let caller = '';
          try { caller = String(new Error().stack).split('\n').slice(2, 2 + CALLER_LINES).join('\n'); } catch {}   // without the 'Error' line and this function's own frame
          note(args, caller);
          return original.apply(this, args);
        };
        target[name] = wrapper;
        if (name === 'exit') originalExit = (code) => original.call(target, code);
      } catch {}
    }
  }

  function installListeners(proc) {
    if (listening) return;
    listening = true;
    proc.on('uncaughtException', listener('uncaughtException'));
    proc.on('unhandledRejection', listener('unhandledRejection'));
  }

  /** A record of the previous run (rule P): in list(), in neither table, with an id that this run makes. */
  function keepFromPreviousRun(fields) {
    made += 1;
    const record = {
      id: 'f' + made, ...fields, previousRun: true,
      made, table: null, key: null, owed: 0, owedTimer: null, sentAt: null, sendTimer: null, dismissedAt: 0,
    };
    records.set(record.id, record);
  }

  /**
   * Rule P: what the last TAIL_BYTES of the fault file say about the previous run, as records for list(). Nothing
   * here is logged, written or sent. It runs before this run's start line, so before the file can be renamed.
   */
  function readPreviousRun() {
    if (!file) return;
    let tail = '';
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - from);
      tail = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, buffer.length, from));
      if (from > 0) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
    } finally {
      fs.closeSync(fd);
    }
    let lines = [];
    for (const raw of tail.split('\n')) {
      let line = null;
      try { line = JSON.parse(raw); } catch {}
      if (line && typeof line === 'object' && typeof line.run === 'string') lines.push(line);
    }
    const isCrumb = (line, name) => line.ev === 'crumb' && line.name === name;
    // A run that holds the crumb 'second-instance' was a second app instance that quit at once: it is nobody's previous run.
    const second = new Set(lines.filter((line) => isCrumb(line, 'second-instance')).map((line) => line.run));
    lines = lines.filter((line) => !second.has(line.run));
    if (!lines.length) return;
    const previous = lines[lines.length - 1].run;
    lines = lines.filter((line) => line.run === previous);
    const closed = lines.some((line) => line.ev === 'exit' || isCrumb(line, 'windows-session-end') || isCrumb(line, 'app.exit'));
    const text = (value) => (typeof value === 'string' ? value : '');
    const amount = (line) => (Number.isFinite(line.count) && line.count > 0 ? line.count : 0);
    let errors = 0;
    const byId = new Map();
    for (const line of lines) {
      if (line.ev !== 'fault' && line.ev !== 'repeat') continue;
      errors += line.ev === 'fault' ? 1 : amount(line);
      if (typeof line.id !== 'string') continue;
      if (!byId.has(line.id)) byId.set(line.id, { faults: [], count: 0, times: [] });
      const found = byId.get(line.id);
      if (line.ev === 'fault') found.faults.push(line);
      found.count += line.ev === 'fault' ? 1 : amount(line);
      if (Number.isFinite(line.t)) found.times.push(line.t);
    }
    if (!closed) {
      const at = now();
      keepFromPreviousRun({ kind: 'last-run', sessionId: null, firstLine: '', count: 1, firstAt: at, lastAt: at, dismissed: false, stack: '', runErrors: errors });
    }
    for (const found of byId.values()) {
      if (!found.faults.length) continue;
      const first = found.faults.reduce((a, b) => (Number.isFinite(b.n) && !(b.n >= a.n) ? b : a));
      const withStack = found.faults.find((line) => typeof line.stack === 'string');
      keepFromPreviousRun({
        kind: text(first.kind), sessionId: typeof first.sessionId === 'string' ? first.sessionId : null, firstLine: text(first.firstLine),
        count: found.count, firstAt: found.times.length ? Math.min(...found.times) : 0, lastAt: found.times.length ? Math.max(...found.times) : 0,
        dismissed: true, stack: withStack ? withStack.stack : '', runErrors: 0,
      });
    }
  }

  try { readPreviousRun(); } catch {}
  let version = '';
  try { version = app.getVersion(); } catch {}
  writeLine('start', { version, pid: process.pid });

  return {
    report: entry(report),
    list,
    dismiss: entry(dismiss),
    noteWindow: safe(noteWindow),
    noteMainLoaded: safe(noteMainLoaded),
    noteExitPath: entry(noteExitPath),
    flush: entry(writePending),
    installBreadcrumbs: safe(installBreadcrumbs),
    installListeners: safe(installListeners),
    logFile: safe(() => file),
  };
}

module.exports = { createMainFaults };
