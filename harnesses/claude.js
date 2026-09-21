// Claude Code harness.
//
// Owns everything that is specific to how the `claude` CLI stores sessions on
// disk and how it is launched:
//
//   - transcript layout: ~/.claude/projects/<encoded-project>/<sessionId>.jsonl
//   - transcript format: one JSON object per line
//   - launch flags: --session-id / --resume / --fork-session / …
//
// Nothing outside this file should assume any of that. See harnesses/index.js
// for the shape every harness implements.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { scanLines } = require('../jsonl-scan');
const { encodeProjectPath } = require('../encode-project-path');

const id = 'claude';
const label = 'Claude';
const binary = 'claude';

// --- Layout ---

function sessionsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Is there anything to index here?
 *
 * Deliberately NOT a check for the binary on PATH: the packaged app inherits a
 * minimal environment from the Dock, while sessions are launched through a
 * login shell that sources the user's profile — so the main process's PATH is
 * not the PATH a session actually runs under, and probing it reported every CLI
 * as missing. Whether a CLI can be started is left to the launch itself, which
 * surfaces the shell's own error.
 */
function available() {
  return fs.existsSync(sessionsRoot());
}

/** Folder keys under sessionsRoot(). For Claude these are encoded project paths. */
function listFolders() {
  try {
    return fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
  } catch {
    return [];
  }
}

function folderPath(folder) {
  return path.join(sessionsRoot(), folder);
}

/** Which folder a project's sessions live in. */
function folderForProject(projectPath) {
  return encodeProjectPath(projectPath);
}

/** Transcript files inside a folder, as absolute paths. */
function listTranscripts(folder) {
  try {
    const dir = folderPath(folder);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Absolute transcript path for a cached row. `sessionFile` is authoritative
 * when present; rows written before that column existed reconstruct the path
 * from folder + sessionId, which is exactly how Claude names its files.
 */
function transcriptPath({ sessionId, folder, sessionFile }) {
  if (sessionFile) return sessionFile;
  return path.join(folderPath(folder), sessionId + '.jsonl');
}

// --- Project path derivation ---

function extractCwdFromJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  const worktreeMatch = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

/** The project a folder belongs to, read out of any transcript it contains. */
function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return cwd;
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return cwd;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Transcript parsing ---

const HEAD_BYTES = 4096;          // guard window for append-only transcripts
const TEXT_CONTENT_CAP = 8000;    // how much body text the search index keeps
const TEXT_LINE_CAP = 500;

function hashHead(fd, stat) {
  const n = Math.min(HEAD_BYTES, stat.size);
  if (n === 0) return '';
  const buf = Buffer.allocUnsafe(n);
  if (fs.readSync(fd, buf, 0, n, 0) !== n) throw new Error('JSONL head changed during read');
  // Tag the state so a change to WHAT is accumulated invalidates saved offsets.
  // This fork stays on v1: it keeps the capped textContent that v1 rows hold,
  // so every cached row's offset stays valid and no re-index is forced.
  // Include file identity so an atomic replacement with the same prefix resets.
  return 'v1:' + crypto.createHash('sha1')
    .update(`${stat.dev}:${stat.ino}:`).update(buf).digest('hex');
}

/** Accumulator. Every field is either a first-occurrence or a running total,
 *  which is what makes resuming mid-file valid. */
function emptyState() {
  return { summary: '', messageCount: 0, textContent: '', slug: null, customTitle: null, aiTitle: null, firstTimestamp: null, lastTimestamp: null };
}

function stateFrom(prev) {
  return {
    summary: prev.summary || '',
    messageCount: prev.messageCount || 0,
    textContent: prev.textContent || '',
    slug: prev.slug || null,
    customTitle: prev.customTitle || null,
    aiTitle: prev.aiTitle || null,
    firstTimestamp: prev.firstTimestamp || null,
    lastTimestamp: prev.lastTimestamp || null,
  };
}

function applyLine(line, st) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }

  if (entry.timestamp) {
    if (!st.firstTimestamp || entry.timestamp < st.firstTimestamp) st.firstTimestamp = entry.timestamp;
    if (!st.lastTimestamp || entry.timestamp > st.lastTimestamp) st.lastTimestamp = entry.timestamp;
  }

  if (entry.slug && !st.slug) st.slug = entry.slug;
  if (entry.type === 'custom-title' && entry.customTitle) st.customTitle = entry.customTitle;
  if (entry.type === 'ai-title' && entry.aiTitle) st.aiTitle = entry.aiTitle;

  if (entry.type === 'user' || entry.type === 'assistant' ||
      (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
    st.messageCount++;
  }

  // First text block only, and for any record that carries one. Upstream joins
  // every text block and pushes only for conversation records — a different
  // corpus, which would need a new head-hash tag to force the re-index that
  // makes old and new rows consistent. This fork stays on v1 (see hashHead),
  // so what is indexed must stay exactly what v1 rows already hold.
  const msg = entry.message;
  const text = typeof msg === 'string' ? msg :
    (typeof msg?.content === 'string' ? msg.content :
    (msg?.content?.[0]?.text || ''));

  if (!st.summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
    // Skip local command messages (! prefix) — use the next real user message
    if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
      // Use scheduled task name if present
      const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
      st.summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
    }
  }

  if (text && st.textContent.length < TEXT_CONTENT_CAP) {
    st.textContent += text.slice(0, TEXT_LINE_CAP) + '\n';
  }
}

/**
 * Parse metadata in bounded chunks. A cached row lets append-only transcripts
 * resume at the previous newline instead of re-reading their entire history.
 * Head changes, replacement, truncation, or a changed file with no growth reset
 * the accumulator. In-place edits beyond the head while also growing the file
 * are outside this append-only contract; a full re-index is needed for those.
 */
function readSessionFile(filePath, folder, projectPath, prev = null) {
  const sessionId = path.basename(filePath, '.jsonl');
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileMtime = stat.mtime.toISOString();
    const headHash = hashHead(fd, stat);
    const canResume = !!prev && !!headHash
      && prev.sessionId === sessionId && prev.headHash === headHash
      && Number.isSafeInteger(prev.indexedBytes) && prev.indexedBytes > 0
      && prev.indexedBytes <= stat.size
      && (prev.indexedBytes < stat.size || prev.fileMtime === fileMtime);
    const st = canResume ? stateFrom(prev) : emptyState();
    const start = canResume ? prev.indexedBytes : 0;
    // Hash and scan the same descriptor and only the size captured above.
    // Concurrent appends are left for the next pass; read errors return null
    // rather than saving partial metadata under a supposedly up-to-date mtime.
    const { consumed, read, tail } = scanLines(fd, start, line => applyLine(line, st), stat.size);
    if (tail) applyLine(tail, st);
    const after = fs.fstatSync(fd);
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) return null;
    if (!st.summary || st.messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary: st.summary, firstPrompt: st.summary,
      created: st.firstTimestamp || stat.birthtime.toISOString(),
      modified: st.lastTimestamp || fileMtime,
      fileMtime,
      messageCount: st.messageCount, textContent: st.textContent,
      slug: st.slug, customTitle: st.customTitle, aiTitle: st.aiTitle,
      firstTimestamp: st.firstTimestamp, lastTimestamp: st.lastTimestamp,
      headHash,
      // A complete JSON value without a newline is displayed but cannot be
      // accumulated safely: re-read it next time instead of double-counting it.
      indexedBytes: tail ? 0 : consumed,
      bytesRead: read + Math.min(HEAD_BYTES, stat.size),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Transcript records as the JSONL viewer wants them.
 *
 * Claude's own format IS the viewer's format — the viewer was written against
 * it — so this is identity. It exists so the viewer never has to know which
 * CLI wrote the file it is showing.
 */
function toViewerEntries(entries) {
  return entries;
}

// --- Activity signalling ---

// Claude marks a working session by prefixing its terminal title with a spinner
// frame, and an idle one with U+2733. Versions through 2.1.227 used braille;
// 2.1.228+ use the four rotating half-circle glyphs U+25D0-U+25D3.
//
// Both ranges are accepted because testing only braille stopped matching at
// that release, silently: measured across this machine's logs when the
// half-circles were added to main.js, busy=true appeared 0 times in 10,730
// title events, every one of them U+25D0 or U+25D1. (Upstream doctly/switchboard
// a8fe1e3 reached the same two ranges.)
const SPINNER_MIN = 0x2800, SPINNER_MAX = 0x28FF;
const HALF_CIRCLE_MIN = 0x25D0, HALF_CIRCLE_MAX = 0x25D3;
const IDLE_MARK = '\u2733'; // ✳

/** What an OSC 0 title says about the session: 'busy', 'idle', or nothing. */
function parseTitleState(title) {
  const first = String(title || '').charAt(0);
  if (!first) return null;
  const code = first.charCodeAt(0);
  if ((code >= SPINNER_MIN && code <= SPINNER_MAX) ||
      (code >= HALF_CIRCLE_MIN && code <= HALF_CIRCLE_MAX)) return 'busy';
  if (first === IDLE_MARK) return 'idle';
  return null;
}

/**
 * What an OSC 9 notification means.
 *
 * 'attention' — the session is blocked on the user
 * 'idle'      — the turn finished and a response is waiting to be read
 */
function classifyNotification(message) {
  const text = String(message || '');
  // "Claude Code needs your attention", "…needs your approval for the plan",
  // "Claude needs your permission to use {tool}", "…wants to enter plan mode"
  if (/attention|approval|permission|needs your|wants to enter/i.test(text)) return 'attention';
  // "Claude is waiting for your input" — a delayed idle notification
  if (/waiting for your input/i.test(text)) return 'idle';
  return null;
}

// --- Launch ---

// The levels `claude --effort` accepts. Checked rather than passed blind: a
// stored setting can outlive the claude version that understood it, and an
// unknown level fails the launch.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Argv for the claude binary. Returned as an array so the caller can quote it
 * for the target shell rather than building a command string here.
 *
 * Two flags, because they answer two different questions:
 *
 *   startFresh — does this launch begin a NEW CONVERSATION? It picks
 *                --session-id over --resume and gates the positional first
 *                prompt. A session that died before writing a transcript has
 *                nothing to resume, so recovering it is a fresh start.
 *   isNew      — was this session created by THIS launch? It alone gates
 *                --worktree, because that flag CREATES a git worktree. The
 *                recovery case above may already have made one, and asking
 *                for a second breaks the launch.
 *
 * startFresh defaults to isNew, so a caller holding only one flag gets the
 * straightforward behaviour.
 */
function buildLaunchArgs({ sessionId, isNew, startFresh = isNew, options }) {
  const args = [];
  // These options accept multiple values. Keep them before the required
  // session selector so it ends their lists before the positional prompt.
  // Otherwise project attachments can consume a schedule's entire prompt
  // as one more --add-dir value, leaving an empty interactive session.
  if (options?.allowedTools) args.push('--allowedTools', String(options.allowedTools));
  if (options?.addDirs) {
    const dirs = String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean);
    for (const dir of dirs) args.push('--add-dir', dir);
  }
  // --worktree belongs up here with the other flags whose value is optional or
  // repeatable, and for the same reason: its name argument is optional, so if
  // it were emitted last a trailing positional prompt would be swallowed as the
  // worktree name. This is the bug 809b754 fixed for --add-dir, in the same
  // function. Putting it before the session selector means that selector always
  // terminates it. Latent today — nothing sets a positional prompt — and live
  // the moment upstream's scheduled-task launch arrives, which does.
  //
  // --worktree only applies when STARTING a session: it creates a fresh
  // isolated git worktree, and resuming must reuse the session's existing
  // directory. Gated on the raw isNew, NOT startFresh: a session can create its
  // worktree and still die before writing a transcript, so a recovery start
  // passing --worktree again risks a second one or a failed attach.
  if (isNew && options?.worktree) {
    args.push('--worktree');
    if (options.worktreeName) {
      args.push(String(options.worktreeName));
    }
  }
  if (options?.forkFrom) {
    args.push('--resume', String(options.forkFrom), '--fork-session');
  } else if (startFresh) {
    args.push('--session-id', String(sessionId));
  } else {
    args.push('--resume', String(sessionId));
  }

  if (options) {
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (options.permissionMode) {
      args.push('--permission-mode', String(options.permissionMode));
    }
    // Empty leaves the choice to claude's own default.
    if (options.model) {
      args.push('--model', String(options.model));
    }
    if (EFFORT_LEVELS.has(options.effort)) {
      args.push('--effort', options.effort);
    }
    if (options.chrome) {
      args.push('--chrome');
    }
  }

  if (options?.appendSystemPrompt) {
    args.push('--append-system-prompt', String(options.appendSystemPrompt));
  }

  // A first prompt, as the positional argument. Only for a brand-new session:
  // a resume continues where it was, and a fork carries its parent's prompt.
  if (startFresh && !options?.forkFrom && options?.initialPrompt) {
    args.push(String(options.initialPrompt));
  }

  return args;
}

module.exports = {
  id, label, binary,
  available, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, transcriptPath,
  deriveProjectPath, resolveWorktreePath,
  readSessionFile, toViewerEntries,
  parseTitleState, classifyNotification,
  buildLaunchArgs,
};
