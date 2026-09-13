const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { scanLines } = require('./jsonl-scan');

const HEAD_BYTES = 4096;          // guard window for append-only transcripts
const TEXT_CONTENT_CAP = 8000;    // how much body text the search index keeps
const TEXT_LINE_CAP = 500;

// Identity of the file's first 4KB, used to decide whether a saved byte offset
// still refers to the same history. dev/ino are included so an atomic replace
// that happens to share a prefix still resets the accumulator.
function hashHead(fd, stat) {
  const n = Math.min(HEAD_BYTES, stat.size);
  if (n === 0) return '';
  const buf = Buffer.allocUnsafe(n);
  if (fs.readSync(fd, buf, 0, n, 0) !== n) throw new Error('JSONL head changed during read');
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
  // A single malformed line skips itself. Parsing the whole file under one try
  // used to discard the entire session when one line was torn mid-write.
  let entry;
  try { entry = JSON.parse(line); } catch { return; }

  if (entry.timestamp) {
    // ISO-8601 UTC strings — lexicographic comparison is chronological
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
 * Parse a single .jsonl file into a session object (or null if invalid).
 *
 * `prev` is the session's cached row. When it carries usable resume state the
 * file is read from that byte offset instead of from zero, which is what keeps
 * an active 25MB transcript from being re-parsed on every append. A changed
 * head, a replacement, a truncation, or a changed file that did not grow all
 * reset the accumulator. In-place edits past the head that also grow the file
 * fall outside the append-only contract and need a full re-index.
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
    // Hash and scan the same descriptor, and only through the size captured
    // above. Concurrent appends are left for the next pass; a read error
    // returns null rather than saving partial metadata under a fresh mtime.
    const { consumed, read, tail } = scanLines(fd, start, line => applyLine(line, st), stat.size);
    if (tail) applyLine(tail, st);
    const after = fs.fstatSync(fd);
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) return null;
    if (!st.summary || st.messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary: st.summary, firstPrompt: st.summary,
      // created/modified are display+sort values from message timestamps;
      // fileMtime is the cache-invalidation key (compared against stat.mtime
      // in refreshFolder). Old transcripts without timestamps fall back to stat.
      created: st.firstTimestamp || stat.birthtime.toISOString(),
      modified: st.lastTimestamp || fileMtime,
      fileMtime,
      messageCount: st.messageCount, textContent: st.textContent,
      slug: st.slug, customTitle: st.customTitle, aiTitle: st.aiTitle,
      // Raw bounds are stored separately from created/modified, whose fallback
      // to file times must not become an accumulator value on a later append.
      firstTimestamp: st.firstTimestamp, lastTimestamp: st.lastTimestamp,
      headHash,
      // A complete JSON value with no trailing newline is displayed but cannot
      // be accumulated safely: re-read it next pass instead of double-counting.
      indexedBytes: tail ? 0 : consumed,
      bytesRead: read + Math.min(HEAD_BYTES, stat.size),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = { readSessionFile };
