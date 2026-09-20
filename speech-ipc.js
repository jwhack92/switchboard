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

/**
 * Condense a reply with Haiku, via the CLI so it runs on the existing
 * subscription rather than needing an API key.
 *
 * The gate sequence is copied from runScheduleCommand rather than reinvented:
 * synchronous HALT check immediately before spawn (no TOCTOU window), custody
 * registered before anything else with kill-on-failure, unregister on both exit
 * and error.
 */
function summarize(text, maxWords) {
  return new Promise((resolve) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    const words = Number(maxWords);
    if (!clean) return resolve({ error: 'empty' });
    if (!Number.isFinite(words) || words <= 0) return resolve({ error: 'bad-budget' });

    const gate = driverStore.isHalted();
    if (gate.halted) {
      driverStore.appendEvent('SPAWN_VETOED', { name: 'speech-summary', reason: gate.reason });
      log.warn(`[speech] summary vetoed — global stop in force: ${gate.reason}`);
      return resolve({ error: 'halted', reason: gate.reason });
    }

    let child;
    const startedAtMs = Date.now();
    try {
      // --no-session-persistence is not optional: without it every summary
      // writes a transcript into ~/.claude/projects, which Switchboard then
      // indexes and shows as a session. Verified by doing exactly that.
      // --bare would cut startup roughly threefold but skips keychain reads and
      // the call comes back "Not logged in", so it cannot be used.
      child = spawn(resolveClaudeBin(), ['-p', '--model', 'claude-haiku-4-5', '--no-session-persistence'], {
        cwd: os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...cleanEnv, FORCE_COLOR: '0' },
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ error: 'spawn-failed', detail: String(err && err.message || err) });
    }

    try {
      custody.register({
        pid: child.pid, startedAtMs, cwd: os.homedir(),
        tag: 'speech-summary', cmdlineNeedle: 'claude',
      });
    } catch (err) {
      log.error(`[speech] could not take custody of pid ${child.pid}; killing it:`, err.message);
      try { custody.killTree(child.pid); } catch {}
      return resolve({ error: 'custody-failed' });
    }

    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      log.warn(`[speech] summary timed out after ${SUMMARY_TIMEOUT_MS}ms; killing pid ${child.pid}`);
      try { custody.killTree(child.pid); } catch {}
      finish({ error: 'timeout' });
    }, SUMMARY_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });

    child.on('error', (err) => {
      custody.unregister(child.pid);
      finish({ error: 'process-error', detail: String(err && err.message || err) });
    });

    child.on('exit', (code) => {
      custody.unregister(child.pid);
      const summary = out.trim();
      if (code !== 0 || !summary) {
        log.warn(`[speech] summary failed (code ${code}): ${errOut.slice(0, 300)}`);
        return finish({ error: 'no-output', code });
      }
      finish({ summary, ms: Date.now() - startedAtMs });
    });

    try {
      child.stdin.end(buildPrompt(clean, Math.round(words)));
    } catch (err) {
      try { custody.killTree(child.pid); } catch {}
      finish({ error: 'stdin-failed', detail: String(err && err.message || err) });
    }
  });
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
}

module.exports = { init, newTextSince, summarize, buildPrompt, resolveClaudeBin, SUMMARY_TIMEOUT_MS };
