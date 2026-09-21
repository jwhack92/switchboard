const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSessionFile } = require('../harnesses/claude');
const { scanLines, readHead } = require('../jsonl-scan');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-inc-'));
}

function line(obj) { return JSON.stringify(obj) + '\n'; }

function userMsg(text, ts) {
  return line({ type: 'user', timestamp: ts, message: { content: text } });
}
function asstMsg(text, ts) {
  return line({ type: 'assistant', timestamp: ts, message: { content: text } });
}

/** Everything the cache persists and the parser resumes from. bytesRead is
 *  excluded: it measures work done, which is exactly what differs. */
function meaningful(s) {
  const { bytesRead, ...rest } = s;
  return rest;
}

function write(dir, id, body) {
  const p = path.join(dir, id + '.jsonl');
  fs.writeFileSync(p, body);
  return p;
}

// The guard window is the first 4KB. A file smaller than that has a head that
// grows as the file grows, so its hash changes on every append and it is always
// read in full - see the dedicated test below. Anything exercising resume must
// therefore start out larger than the window.
const OVER_HEAD = 'padding '.repeat(700); // ~5.6KB in one message

test('resuming from a saved offset matches a full read of the same file', () => {
  const dir = tmpdir();
  const head = userMsg('first question ' + OVER_HEAD, '2026-01-01T10:00:00.000Z')
             + asstMsg('first answer', '2026-01-01T10:00:01.000Z');
  const p = write(dir, 'sess', head);
  assert.ok(fs.statSync(p).size > 4096, 'fixture must exceed the head window');

  const first = readSessionFile(p, 'f', '/proj');
  assert.ok(first, 'initial read should succeed');
  assert.equal(first.messageCount, 2);
  assert.ok(first.indexedBytes > 0, 'should record a resume point');

  // Append, then resume from the first result.
  fs.appendFileSync(p, userMsg('second question', '2026-01-01T11:00:00.000Z')
                     + asstMsg('second answer', '2026-01-01T11:00:02.000Z'));
  const resumed = readSessionFile(p, 'f', '/proj', first);
  const full = readSessionFile(p, 'f', '/proj', null);

  assert.deepStrictEqual(meaningful(resumed), meaningful(full),
    'resumed state must equal a full re-read');
  assert.equal(resumed.messageCount, 4);
  assert.equal(resumed.lastTimestamp, '2026-01-01T11:00:02.000Z');
  assert.ok(resumed.bytesRead < full.bytesRead,
    'resuming must read fewer bytes than a full read');
});

test('a file smaller than the head window is always read in full', () => {
  const dir = tmpdir();
  const p = write(dir, 'sess', userMsg('tiny', '2026-01-01T10:00:00.000Z')
                             + asstMsg('reply', '2026-01-01T10:00:01.000Z'));
  assert.ok(fs.statSync(p).size < 4096);
  const first = readSessionFile(p, 'f', '/proj');

  fs.appendFileSync(p, userMsg('more', '2026-01-01T11:00:00.000Z'));
  const after = readSessionFile(p, 'f', '/proj', first);

  // Growing the file grew its head, so the hash moved and the offset was
  // dropped. Correct either way; cheap because the file is under 4KB.
  assert.notEqual(after.headHash, first.headHash);
  assert.equal(after.messageCount, 3, 'a full re-read still yields the right count');
});

test('a rewritten head resets the accumulator instead of resuming', () => {
  const dir = tmpdir();
  const p = write(dir, 'sess', userMsg('original', '2026-01-01T10:00:00.000Z')
                             + asstMsg('reply', '2026-01-01T10:00:01.000Z'));
  const first = readSessionFile(p, 'f', '/proj');

  // Replace the file with different history that happens to be longer.
  fs.writeFileSync(p, userMsg('replaced', '2026-02-01T10:00:00.000Z')
                    + asstMsg('new reply', '2026-02-01T10:00:01.000Z')
                    + userMsg('and more', '2026-02-01T10:00:02.000Z'));
  const after = readSessionFile(p, 'f', '/proj', first);

  assert.equal(after.summary, 'replaced', 'stale summary must not survive');
  assert.equal(after.messageCount, 3, 'counts must not accumulate across the reset');
  assert.notEqual(after.headHash, first.headHash);
});

test('truncation is not mistaken for a resumable append', () => {
  const dir = tmpdir();
  const p = write(dir, 'sess', userMsg('one', '2026-01-01T10:00:00.000Z')
                             + asstMsg('two', '2026-01-01T10:00:01.000Z')
                             + userMsg('three', '2026-01-01T10:00:02.000Z'));
  const first = readSessionFile(p, 'f', '/proj');
  assert.equal(first.messageCount, 3);

  // Shrink below the saved offset.
  fs.writeFileSync(p, userMsg('one', '2026-01-01T10:00:00.000Z')
                    + asstMsg('two', '2026-01-01T10:00:01.000Z'));
  const after = readSessionFile(p, 'f', '/proj', first);
  assert.equal(after.messageCount, 2, 'must re-read rather than trust the offset');
});

test('a trailing partial line is shown but not banked', () => {
  const dir = tmpdir();
  const complete = userMsg('q', '2026-01-01T10:00:00.000Z')
                 + asstMsg('a', '2026-01-01T10:00:01.000Z');
  // A whole JSON value with no newline - a write caught mid-flush.
  const partial = JSON.stringify({
    type: 'user',
    timestamp: '2026-01-01T10:00:02.000Z',
    message: { content: 'partial' },
  });
  const p = write(dir, 'sess', complete + partial);

  const r = readSessionFile(p, 'f', '/proj');
  assert.equal(r.messageCount, 3, 'the partial line still counts for display');
  assert.equal(r.indexedBytes, 0, 'but must not be banked as a resume point');

  // Next pass re-reads from zero, so the line is counted once, not twice.
  fs.appendFileSync(p, '\n');
  const next = readSessionFile(p, 'f', '/proj', r);
  assert.equal(next.messageCount, 3, 'no double count once the line is completed');
});

test('a same-size file with a new mtime is re-read, not resumed', () => {
  const dir = tmpdir();
  const p = write(dir, 'sess', userMsg('aaa', '2026-01-01T10:00:00.000Z')
                             + asstMsg('bbb', '2026-01-01T10:00:01.000Z'));
  const first = readSessionFile(p, 'f', '/proj');

  // Same byte length, different content past the head is outside the
  // append-only contract; the mtime check is what catches it.
  const sameSize = userMsg('ccc', '2026-01-01T10:00:00.000Z')
                 + asstMsg('ddd', '2026-01-01T10:00:01.000Z');
  assert.equal(Buffer.byteLength(sameSize), fs.statSync(p).size);
  fs.writeFileSync(p, sameSize);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(p, t, t);

  const after = readSessionFile(p, 'f', '/proj', first);
  assert.equal(after.summary, 'ccc', 'changed content must win over the offset');
});

test('one malformed line is skipped without discarding the session', () => {
  const dir = tmpdir();
  const torn = '{"type":"assistant","message":{ TORN\n';
  const p = write(dir, 'sess', userMsg('good question', '2026-01-01T10:00:00.000Z')
                             + torn
                             + asstMsg('good answer', '2026-01-01T10:00:02.000Z'));
  const r = readSessionFile(p, 'f', '/proj');
  assert.ok(r, 'a torn line must not null the whole session');
  assert.equal(r.summary, 'good question');
  assert.equal(r.messageCount, 2, 'only the parseable messages count');
});

test('scanLines splits UTF-8 correctly across a chunk boundary', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'wide.jsonl');
  // Push multi-byte characters past the 256KB chunk edge.
  const filler = 'x'.repeat(300 * 1024);
  const wide = 'héllo — 日本語 🎉';
  const body = line({ a: filler }) + line({ b: wide });
  fs.writeFileSync(p, body);

  const seen = [];
  const r = scanLines(p, 0, l => { seen.push(l); });
  assert.equal(seen.length, 2);
  assert.deepStrictEqual(JSON.parse(seen[1]).b, wide);
  assert.equal(r.consumed, Buffer.byteLength(body));
  assert.equal(r.tail, '');
});

test('scanLines stops early when asked and reports the stop', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'many.jsonl');
  fs.writeFileSync(p, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
  let count = 0;
  const r = scanLines(p, 0, () => { count++; return false; });
  assert.equal(count, 1);
  assert.equal(r.stopped, true);
});

test('readHead returns at most the requested bytes and never throws', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'h.jsonl');
  fs.writeFileSync(p, 'abcdefghij');
  assert.equal(readHead(p, 4), 'abcd');
  assert.equal(readHead(p, 100), 'abcdefghij');
  assert.equal(readHead(path.join(dir, 'missing.jsonl'), 10), '',
    'a missing file yields empty, not an exception');
});
