// Main-process half of spoken output: reading what Claude said, and condensing
// it to fit a spoken window.
//
// Deliberately required AFTER main.js:57 so it stays outside electron-reloader's
// main-process snapshot. The cost of that is real and worth stating: editing
// THIS file reloads the renderer but leaves the old main-process copy running,
// so changes here need a manual restart to take effect.

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { scanLines } = require('./jsonl-scan');
const speechText = require('./public/speech-text');

// A summary is a few hundred tokens of Haiku. If it has not answered by now
// something is wrong, and a spoken summary that arrives a minute late is worse
// than none — the terminal has moved on.
const SUMMARY_TIMEOUT_MS = 45_000;
const MAX_INPUT_CHARS = 60_000;   // ~15k tokens; longer replies are truncated for the prompt only

let log, cleanEnv, PROJECTS_DIR, getCachedFolder, driverStore, custody;

function resolveClaudeBin() {
  // Windows installs it as claude.exe; libuv's PATH search handles PATHEXT, but
  // resolving explicitly avoids depending on that and on the shell.
  const candidates = [];
  const home = os.homedir();
  candidates.push(path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return 'claude';   // let the OS try
}

function transcriptPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const folder = getCachedFolder(sessionId);
  if (!folder) return null;
  return path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
}

/**
 * The assistant text appended since `sinceBytes`.
 *
 * The baseline case matters more than it looks: called with no offset, this
 * returns the CURRENT size and no text, rather than everything from byte zero.
 * Without that, the first thing spoken after enabling the feature would be the
 * session's entire history.
 */
function newTextSince(sessionId, sinceBytes) {
  const file = transcriptPath(sessionId);
  if (!file) return { error: 'unknown-session', text: '', bytes: 0 };

  let size;
  try { size = fs.statSync(file).size; } catch { return { error: 'no-transcript', text: '', bytes: 0 }; }

  const resumable = Number.isSafeInteger(sinceBytes) && sinceBytes >= 0 && sinceBytes <= size;
  if (!resumable) return { text: '', bytes: size, baseline: true };
  if (sinceBytes === size) return { text: '', bytes: size };

  const entries = [];
  let consumed = sinceBytes;
  try {
    const r = scanLines(file, sinceBytes, (line) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      entries.push(entry);
    }, size);
    // A trailing partial line is a write caught mid-flush. Do not bank it, or
    // the completed line is skipped on the next pass.
    consumed = r.tail ? sinceBytes : r.consumed;
  } catch (err) {
    return { error: String(err && err.message || err), text: '', bytes: sinceBytes };
  }

  return { text: speechText.extractSpeakable(entries), bytes: consumed };
}

function buildPrompt(text, maxWords) {
  const body = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  return [
    `Condense the assistant reply below into at most ${maxWords} words, to be read aloud.`,
    '',
    'Rules: plain spoken prose. No markdown, no lists, no code, no file paths, no',
    'preamble, no sign-off. Say what was done or decided and why it matters. Output',
    'only the summary text.',
    '',
    '--- REPLY ---',
    body,
  ].join('\n');
}

// --- The warm summarizer -------------------------------------------------
//
// `claude -p` boots a whole session per call, which measured 7-12s and left
// speech trailing the screen badly. One process fed over stream-json answers in
// about 1.5s after the first turn.
//
// The flag set below is not tuning, it is load-bearing. Given "Remember the
// number 7" an unrestricted process replied "I'll save that to memory for
// future reference" and wrote two real files under the user's memory directory.
// The text being summarised is a Claude reply this feature does not control, so
// the summarizer gets no tools at all. The locked-down set also happens to be
// faster (4.8s vs 8.3s cold) and cheaper, because no tool schemas ship.
//
// --verbose is mandatory: --output-format stream-json errors without it.
// --allowed-tools goes last because it is variadic and would otherwise swallow
// whichever flag followed it.
const WARM_ARGS = [
  '-p', '--model', 'claude-haiku-4-5',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--allowed-tools', '',
];

// Context accumulates across turns, and /clear does not reset it — verified.
// Restarting is the only way to bound the growth.
const RECYCLE_AFTER = 20;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

class WarmSummarizer {
  constructor() {
    this.child = null;
    this.turns = 0;
    this.buf = '';
    this.pending = null;              // { resolve, timer, text }
    this.tail = Promise.resolve();    // serializes turns: one conversation, one at a time
    this.idleTimer = null;
    this.failures = 0;
  }

  isRunning() { return !!this.child; }

  start() {
    if (this.child) return { ok: true };

    const gate = driverStore.isHalted();
    if (gate.halted) {
      driverStore.appendEvent('SPAWN_VETOED', { name: 'speech-summary', reason: gate.reason });
      log.warn(`[speech] warm start vetoed — global stop in force: ${gate.reason}`);
      return { ok: false, error: 'halted', reason: gate.reason };
    }

    const startedAtMs = Date.now();
    let child;
    try {
      child = spawn(resolveClaudeBin(), WARM_ARGS, {
        cwd: os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...cleanEnv, FORCE_COLOR: '0' },
        windowsHide: true,
      });
    } catch (err) {
      return { ok: false, error: 'spawn-failed', detail: String(err && err.message || err) };
    }

    // Custody before anything else, as runScheduleCommand does. A long-lived
    // child that is not in the registry cannot be reaped or halted, which would
    // make the kill switch cosmetic for this feature.
    try {
      custody.register({
        pid: child.pid, startedAtMs, cwd: os.homedir(),
        tag: 'speech-summary-warm', cmdlineNeedle: 'claude',
      });
    } catch (err) {
      log.error(`[speech] could not take custody of pid ${child.pid}; killing it:`, err.message);
      try { custody.killTree(child.pid); } catch {}
      return { ok: false, error: 'custody-failed' };
    }

    this.child = child;
    this.turns = 0;
    this.buf = '';
    log.info(`[speech] warm summarizer started, pid ${child.pid}`);

    child.stdout.on('data', (d) => this._consume(d.toString()));
    child.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) log.warn(`[speech] warm stderr: ${t.slice(0, 200)}`);
    });
    child.on('error', (err) => this._died('process-error: ' + (err && err.message)));
    child.on('exit', (code) => this._died('exited with code ' + code));

    this._touchIdle();
    return { ok: true };
  }

  /** Tear down, for any reason. Safe when nothing is running. */
  stop(reason) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    this.buf = '';
    if (!child) return;
    log.info(`[speech] warm summarizer stopping (${reason}), pid ${child.pid}`);
    try { custody.unregister(child.pid); } catch {}
    try { custody.killTree(child.pid); } catch {}
  }

  /** The child went away on its own: fail the turn in flight. The next request
   *  starts a fresh process. */
  _died(why) {
    const child = this.child;
    this.child = null;
    if (child) { try { custody.unregister(child.pid); } catch {} }
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      this.failures++;
      log.warn(`[speech] warm summarizer died mid-request: ${why}`);
      p.resolve({ error: 'process-died', detail: why });
    }
  }

  _touchIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('idle'), IDLE_SHUTDOWN_MS);
    // A pending shutdown must never be a reason to stay alive. Without unref a
    // ten-minute timer holds the event loop open, which hangs anything that
    // would otherwise exit.
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /** Newline-delimited JSON. Assistant text accumulates; `result` ends the turn. */
  _consume(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const p = this.pending;
      if (!p) continue;

      if (event.type === 'assistant') {
        const blocks = (event.message && event.message.content) || [];
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') p.text += b.text;
        }
      } else if (event.type === 'result') {
        // One message produces one result, which is what pairs request to reply.
        this.pending = null;
        clearTimeout(p.timer);
        const summary = p.text.trim();
        if (summary) { this.failures = 0; p.resolve({ summary }); }
        else { this.failures++; p.resolve({ error: 'no-output' }); }
      }
    }
  }

  _turn(prompt) {
    return new Promise((resolve) => {
      // Recycle before the turn, so the restart cost lands on a request that was
      // going to pay startup anyway rather than delaying the following one.
      if (this.child && this.turns >= RECYCLE_AFTER) this.stop('recycle');

      if (!this.child) {
        const started = this.start();
        if (!started.ok) {
          return resolve(started.error === 'halted'
            ? { error: 'halted', reason: started.reason }
            : { error: started.error, detail: started.detail });
        }
      }

      // A halt between spawn and request must still refuse.
      const gate = driverStore.isHalted();
      if (gate.halted) {
        this.stop('halted');
        driverStore.appendEvent('SPAWN_VETOED', { name: 'speech-summary', reason: gate.reason });
        return resolve({ error: 'halted', reason: gate.reason });
      }

      this.turns++;
      this._touchIdle();

      const timer = setTimeout(() => {
        this.pending = null;
        this.failures++;
        log.warn(`[speech] warm turn timed out after ${SUMMARY_TIMEOUT_MS}ms; restarting`);
        this.stop('timeout');
        resolve({ error: 'timeout' });
      }, SUMMARY_TIMEOUT_MS);

      this.pending = { resolve, timer, text: '' };

      try {
        this.child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: prompt },
        }) + '\n');
      } catch (err) {
        this.pending = null;
        clearTimeout(timer);
        this.stop('write-failed');
        resolve({ error: 'stdin-failed', detail: String(err && err.message || err) });
      }
    });
  }

  /** Public entry. Serialized: one conversation cannot run two turns at once. */
  request(prompt) {
    const run = () => this._turn(prompt);
    const result = this.tail.then(run, run);
    this.tail = result.then(() => {}, () => {});   // keep the chain alive either way
    return result;
  }
}

const warm = new WarmSummarizer();

/**
 * Condense a reply with Haiku, through the warm process so startup is paid once
 * rather than per summary.
 *
 * Every failure path returns an error rather than throwing; the renderer falls
 * back to its local extractive summary, so speech degrades instead of stopping.
 */
async function summarize(text, maxWords) {
  const clean = typeof text === 'string' ? text.trim() : '';
  const words = Number(maxWords);
  if (!clean) return { error: 'empty' };
  if (!Number.isFinite(words) || words <= 0) return { error: 'bad-budget' };

  if (warm.failures >= MAX_CONSECUTIVE_FAILURES) {
    return { error: 'giving-up', detail: `${warm.failures} consecutive failures` };
  }

  const startedAtMs = Date.now();
  const res = await warm.request(buildPrompt(clean, Math.round(words)));
  if (res.summary) res.ms = Date.now() - startedAtMs;
  return res;
}

function init(ctx) {
  log = ctx.log;
  cleanEnv = ctx.cleanEnv;
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  getCachedFolder = ctx.getCachedFolder;
  driverStore = ctx.driverStore;
  custody = ctx.custody;

  ipcMain.handle('speech-new-text', (_event, sessionId, sinceBytes) =>
    newTextSince(sessionId, sinceBytes));

  ipcMain.handle('speech-summarize', (_event, text, maxWords) =>
    summarize(text, maxWords));

  // Called when the focused session starts working, so the process is ready by
  // the time its reply lands.
  ipcMain.handle('speech-warmup', () => {
    if (warm.isRunning()) return { ok: true, already: true };
    return warm.start();
  });

  // Called on HALT. A process you deliberately stopped should not still be
  // running, so this kills it rather than merely refusing future work.
  ipcMain.handle('speech-shutdown', () => {
    warm.stop('requested');
    return { ok: true };
  });
}

module.exports = {
  init, newTextSince, summarize, buildPrompt, resolveClaudeBin,
  warm, WarmSummarizer, WARM_ARGS,
  SUMMARY_TIMEOUT_MS, RECYCLE_AFTER, IDLE_SHUTDOWN_MS, MAX_CONSECUTIVE_FAILURES,
};
