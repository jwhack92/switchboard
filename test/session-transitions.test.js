'use strict';
// Pin 14 of the relaunch work. What session-transitions.js does TODAY when a
// new transcript appears in a project folder: which files move a running
// session to a new id (fork, --fork-session, snapshot-only fork, plan-accept),
// which do not, and what one move does, in which order.
//
// Plain node and no cut: the module is required as it ships and given a
// temporary projects folder, a plain Map of fake session records and recording
// stubs. It keeps what init() got in module variables, so every pass hands it
// its own context again.
//
// Nothing depends on the clock: each transcript's modification time is set by
// hand, relative to NOW, and Date.now answers NOW while a pass runs.
// Assertions read fields and calls, never a whole record, so a field the
// record gains later does not break them. The three database functions record
// into a list of their own, so the order of the other calls can be asserted
// before and after those three are switched on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transitions = require('../session-transitions');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-session-transitions-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FOLDER = 'C--work-demo';
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Session ids, shaped like the real ones.
const uuid = (digit) => [8, 4, 4, 4, 12].map((n) => String(digit).repeat(n)).join('-');
const LIVE = uuid(1);     // a running session, under the id it was started with
const LIVE_B = uuid(2);   // a second running session in the same folder
const TEMP = uuid(3);     // a session started as a fork, under its temporary id
const SOURCE = uuid(4);   // the conversation TEMP was started as a fork of
const NEW = uuid(5);      // a transcript that appears while they run
const NEW2 = uuid(6);     // and another
const OTHER = uuid(7);    // a conversation that has nothing to do with any of them
const OLDER = uuid(8);    // an id LIVE's record had before LIVE
const TEMP_B = uuid(9);   // a second session started as a fork of SOURCE, under its temporary id

// --- transcript lines ---

const userLine = (sessionId, extra = {}) => ({
  type: 'user', sessionId, uuid: 'u-1', cwd: 'C:\\work\\demo',
  message: { role: 'user', content: 'hello' }, ...extra,
});
const snapshotLine = (n) => ({
  type: 'file-history-snapshot', messageId: 'm-' + n,
  snapshot: { messageId: 'm-' + n, trackedFileBackups: {} }, isSnapshotUpdate: false,
});
/** The first line of a transcript forked from sourceId. */
const forkOf = (sourceId, newId, extra = {}) => [
  userLine(newId, { forkedFrom: { sessionId: sourceId, messageUuid: 'u-0' }, ...extra }),
];

// --- one projects folder, one Map of sessions, recording stubs ---

function boot({ windowFunctions = true } = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'projects-'));
  const dir = path.join(root, FOLDER);
  fs.mkdirSync(dir);

  const sessions = new Map();
  const owners = new Map();   // session id -> window id, the way window-registry.js keeps it
  const effects = [];         // rekeyMcpServer, rekeyOwner, sendToOwner: in the order they were called
  const dbCalls = [];         // the three database functions, apart from the others
  const logLines = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (...args) => { logLines.push(level + ' ' + args.join(' ')); };
  }

  /** What the Map and the record under the new id look like at the moment of a call. */
  const seen = (oldId, newId) => {
    const record = sessions.get(newId);
    return {
      oldKey: sessions.has(oldId),
      record,
      realSessionId: record && record.realSessionId,
      priorIds: record && record.priorIds && [...record.priorIds],
      sessionSlug: record && record.sessionSlug,
      knowsNewFile: !!(record && record.knownJsonlFiles && record.knownJsonlFiles.has(newId + '.jsonl')),
    };
  };

  const ctx = {
    PROJECTS_DIR: root, activeSessions: sessions, log,
    rekeyMcpServer: (...args) => { effects.push({ call: 'rekeyMcpServer', args, saw: seen(args[0], args[1]) }); },
    copySessionAssignment: (...args) => { dbCalls.push(['copySessionAssignment', ...args]); },
    rekeyPlanLinks: (...args) => { dbCalls.push(['rekeyPlanLinks', ...args]); },
    rekeyScheduleSession: (...args) => { dbCalls.push(['rekeyScheduleSession', ...args]); },
  };
  if (windowFunctions) {
    ctx.rekeyOwner = (...args) => {
      effects.push({ call: 'rekeyOwner', args, saw: seen(args[0], args[1]) });
      const [oldId, newId] = args;
      if (oldId !== newId && owners.has(oldId)) { owners.set(newId, owners.get(oldId)); owners.delete(oldId); }
    };
    ctx.sendToOwner = (...args) => {
      const windowId = owners.has(args[0]) ? owners.get(args[0]) : null;   // the window found under that id, then
      effects.push({ call: 'sendToOwner', args, windowId });
      return windowId !== null;
    };
  }

  const file = (id) => path.join(dir, id + '.jsonl');
  const listing = () => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

  /** Writes a transcript (lines, or raw text) last changed ageMs before NOW. */
  function write(id, lines, ageMs = 0, name = id + '.jsonl') {
    const text = typeof lines === 'string' ? lines : lines.map((line) => JSON.stringify(line) + '\n').join('');
    fs.writeFileSync(path.join(dir, name), text);
    const at = (NOW - ageMs) / 1000;
    fs.utimesSync(path.join(dir, name), at, at);
  }

  /** A fake session record, with the fields main.js gives one; it knows the transcripts that exist now. */
  function session(id, fields = {}) {
    const record = {
      pty: {}, exited: false, isPlainTerminal: false,
      projectFolder: FOLDER, knownJsonlFiles: new Set(listing()), sessionSlug: null, forkFrom: null,
      ...fields,
    };
    sessions.set(id, record);
    return record;
  }

  /** One pass of the detector over a folder, with the clock standing at NOW. */
  function pass(folder = FOLDER) {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      transitions.init(ctx);
      transitions.detectSessionTransitions(folder);
    } finally {
      Date.now = realNow;
    }
  }

  return { dir, sessions, owners, effects, dbCalls, logLines, file, listing, write, session, pass };
}

const knows = (record, id) => record.knownJsonlFiles.has(id + '.jsonl');

/** One move of `record` from oldId to newId: where it is now, what it carries, and the three calls in order. */
function assertMoved(h, record, oldId, newId, effectsAt = 0) {
  assert.equal(h.sessions.has(oldId), false, 'the old id is no longer a key');
  assert.equal(h.sessions.get(newId), record, 'the same record is under the new id');
  assert.equal(record.realSessionId, newId);
  assert.ok(Array.isArray(record.priorIds), 'the record keeps the ids it had');
  assert.equal(record.priorIds[record.priorIds.length - 1], oldId, 'the id it left is its newest prior id');
  assert.equal(knows(record, newId), true, 'the transcript it moved to is known');
  const calls = h.effects.slice(effectsAt, effectsAt + 3);
  assert.deepEqual(calls.map((e) => e.call), ['rekeyMcpServer', 'rekeyOwner', 'sendToOwner']);
  assert.deepEqual(calls[0].args, [oldId, newId]);
  assert.deepEqual(calls[1].args, [oldId, newId]);
  // The first four only: how many arguments the send has is counted in one place, below.
  assert.deepEqual(calls[2].args.slice(0, 4), [newId, 'session-forked', oldId, newId]);
}

/** The record never moved: it is under its id, carries no trace of a move, and no call of a move was made. */
function assertNeverMoved(h, record, id, what = '') {
  assert.equal(h.sessions.get(id), record, what + ' the record is still under its id');
  assert.equal(h.effects.length, 0, what + ' no call of a move was made');
  assert.equal(record.realSessionId, undefined, what);
  assert.equal(record.priorIds, undefined, what);
}

/** A record that has moved before, and was not moved now: still under its id, with the ids it had, and no call of a move. */
function assertNotMovedAgain(h, record, id, priorIds, what = '') {
  assert.equal(h.sessions.get(id), record, what + ' the record is still under its id');
  assert.deepEqual([...h.sessions.keys()], [id], what);
  assert.equal(h.effects.length, 0, what + ' no call of a move was made');
  assert.equal(record.realSessionId, id, what);
  assert.deepEqual(record.priorIds, priorIds, what);
}

/** What a record carries once it has moved to LIVE: started as a fork of SOURCE under TEMP, or started under OLDER. */
const MOVED_FORK = { forkFrom: SOURCE, realSessionId: LIVE, priorIds: [TEMP] };
const MOVED_BEFORE = { realSessionId: LIVE, priorIds: [OLDER] };

// --- plan-accept fixtures ---

const SLUG = 'calm-river';
/** The old transcript of LIVE: it ends with a tool call (ExitPlanMode unless told otherwise). */
const planTail = (slug, tool = 'ExitPlanMode') => [
  userLine(LIVE, { slug }),
  {
    type: 'assistant', sessionId: LIVE, slug, uuid: 'a-1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: tool, input: { plan: '# Do it' } }] },
  },
];

/**
 * LIVE with its old transcript, then the transcript an accepted plan starts, then one pass.
 * `fields` go on LIVE's record; `before(h)` writes other transcripts that are there when the session starts;
 * `newLines` replaces the one line of the new transcript.
 */
function planPass({
  oldLines = planTail(SLUG), oldAgeMs = 0, newAgeMs = 0, newExtra = { slug: SLUG, planContent: '# Do it' },
  newLines = [userLine(NEW, newExtra)], fields = {}, before = () => {},
} = {}) {
  const h = boot();
  if (oldLines) h.write(LIVE, oldLines, oldAgeMs);
  before(h);
  const record = h.session(LIVE, fields);
  h.write(NEW, newLines, newAgeMs);
  h.pass();
  return { h, record };
}
/** New transcript's modification time minus the old one's, as the file system kept them. */
const planGap = (h) => fs.statSync(h.file(NEW)).mtimeMs - fs.statSync(h.file(LIVE)).mtimeMs;

// PIN, changed on purpose by /clear: its last subtest only. After the fix copySessionAssignment, rekeyPlanLinks and rekeyScheduleSession are called with (old id, new id) on every move, after rekeyOwner and before the send.
test('session-transitions (pin, last assertion changed on purpose by /clear): fork by forkedFrom, fork-session file, snapshot-only fork, plan-accept, unrelated file, empty file retried, skipped sessions; the effects in order; one re-key per pass; the send has two arguments and comes after the owner moves; the three database functions are not called', async (t) => {
  await t.test('fork by forkedFrom: a new transcript forked from the running session moves the session to it', () => {
    const h = boot();
    h.write(LIVE, [userLine(LIVE, { slug: 'first-slug' })]);
    const record = h.session(LIVE, { sessionSlug: 'first-slug' });
    h.write(NEW, forkOf(LIVE, NEW, { slug: 'second-slug' }));
    h.pass();

    assertMoved(h, record, LIVE, NEW);
    assert.deepEqual([...h.sessions.keys()], [NEW], 'one record, one key');
    assert.deepEqual(record.priorIds, [LIVE]);
    assert.equal(record.sessionSlug, 'second-slug', 'the slug of the new transcript is taken');
    assert.deepEqual([...record.knownJsonlFiles].sort(), [LIVE + '.jsonl', NEW + '.jsonl']);
    assert.equal(h.effects.length, 3, 'one move, three calls');
  });

  await t.test('fork by forkedFrom: a session started as a fork moves to the transcript forked from its source', () => {
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const record = h.session(TEMP, { forkFrom: SOURCE });
    // Its own sessionId is the new id and it starts with no snapshot, so only forkedFrom can match it.
    h.write(NEW, forkOf(SOURCE, NEW));
    h.pass();

    assertMoved(h, record, TEMP, NEW);
    assert.deepEqual(record.priorIds, [TEMP]);
    assert.equal(record.forkFrom, SOURCE, 'the record still says what it was started as a fork of');
    assert.equal(h.effects.length, 3);
  });

  await t.test('fork by forkedFrom: a session started as a fork that has already moved is moved again by a fork of the id it has now, and today by a later fork of its source as well', () => {
    const start = () => {
      const h = boot();
      h.write(SOURCE, [userLine(SOURCE)]);
      h.write(LIVE, forkOf(SOURCE, LIVE));
      return { h, record: h.session(LIVE, { ...MOVED_FORK, priorIds: [TEMP] }) };
    };

    // Forked again under the id it has now: its own id decides, whether or not it was started as a fork.
    const own = start();
    own.h.write(NEW, forkOf(LIVE, NEW));
    own.h.pass();
    assertMoved(own.h, own.record, LIVE, NEW);
    assert.deepEqual(own.record.priorIds, [TEMP, LIVE]);
    assert.equal(own.h.effects.length, 3);

    // Recorded as it is: forkFrom stays on the record for good and is asked without "has it moved
    // yet", so a later transcript forked from the source moves this session a second time...
    const bySource = start();
    bySource.h.write(NEW, forkOf(SOURCE, NEW));
    bySource.h.pass();
    assertMoved(bySource.h, bySource.record, LIVE, NEW);
    assert.deepEqual(bySource.record.priorIds, [TEMP, LIVE]);
    assert.equal(bySource.h.effects.length, 3);

    // ...and so does a later --fork-session copy of the source.
    const byCopy = start();
    byCopy.h.write(NEW, [userLine(SOURCE)]);
    byCopy.h.pass();
    assertMoved(byCopy.h, byCopy.record, LIVE, NEW);
    assert.deepEqual(byCopy.record.priorIds, [TEMP, LIVE]);
    assert.equal(byCopy.h.effects.length, 3);
  });

  await t.test('fork by forkedFrom: a transcript forked from an id the session used to have moves nothing', () => {
    // Only the id the record is stored under now, and the source it was started as a fork of, are asked.
    for (const [what, fields, usedToHave] of [
      ['a session that has moved before:', MOVED_BEFORE, OLDER],
      ['a session started as a fork that has moved:', MOVED_FORK, TEMP],
    ]) {
      const h = boot();
      h.write(LIVE, [userLine(LIVE)]);
      const record = h.session(LIVE, { ...fields, priorIds: [...fields.priorIds] });
      h.write(NEW, forkOf(usedToHave, NEW));
      // And a --fork-session copy of it, which opens with that conversation's own messages.
      h.write(NEW2, [userLine(usedToHave)]);
      h.pass();
      assertNotMovedAgain(h, record, LIVE, fields.priorIds, what);
      assert.equal(knows(record, NEW), true, what + ' the transcript is taken as known');
      assert.equal(knows(record, NEW2), true, what + ' the copy is taken as known');
    }
  });

  // Recorded as it is. The second record takes the place of the first in the Map: the first terminal is
  // then stored under no id at all, though it runs on. Nothing refuses a move to an id that is a key already.
  // NOT on the agreed list of pins changed on purpose: the /clear plan (step 3(b)) adds a refusal of a move to
  // an id that is a key already, which would fail this subtest. Jason decides whether it is named as changed
  // on purpose by /clear, or whether forks keep today's behaviour.
  await t.test('fork by forkedFrom: today two sessions waiting for a fork of the same source both take the same transcript, and the second replaces the first under the new id', () => {
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const first = h.session(TEMP, { forkFrom: SOURCE });
    const second = h.session(TEMP_B, { forkFrom: SOURCE });
    h.write(NEW, forkOf(SOURCE, NEW));
    h.pass();

    assert.deepEqual(h.effects.map((e) => e.call),
      ['rekeyMcpServer', 'rekeyOwner', 'sendToOwner', 'rekeyMcpServer', 'rekeyOwner', 'sendToOwner'], 'two moves in the pass');
    assert.deepEqual(h.effects.map((e) => e.args.slice(0, e.call === 'sendToOwner' ? 4 : 2)), [
      [TEMP, NEW], [TEMP, NEW], [NEW, 'session-forked', TEMP, NEW],
      [TEMP_B, NEW], [TEMP_B, NEW], [NEW, 'session-forked', TEMP_B, NEW],
    ]);
    assert.deepEqual([...h.sessions.keys()], [NEW], 'one key is left');
    assert.equal(h.sessions.get(NEW), second, 'and the second record is under it');
    assert.equal([...h.sessions.values()].includes(first), false, 'the first record is under no key');
    for (const [record, was] of [[first, TEMP], [second, TEMP_B]]) {
      assert.equal(record.realSessionId, NEW);
      assert.deepEqual(record.priorIds, [was]);
      assert.equal(record.exited, false);
    }
  });

  await t.test('fork-session file: a transcript that opens with the source\'s own messages moves the session started as its fork, and nobody else', () => {
    // claude --fork-session copies the source's messages with the source's sessionId on them.
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const record = h.session(TEMP, { forkFrom: SOURCE, sessionSlug: 'kept-slug' });
    h.write(NEW, [userLine(SOURCE, { slug: 'source-slug' })]);
    h.pass();
    assertMoved(h, record, TEMP, NEW);
    assert.equal(record.sessionSlug, 'source-slug');
    assert.equal(h.effects.length, 3);

    // The same file means nothing to a session that was not started as a fork.
    const plain = boot();
    const live = plain.session(LIVE);
    plain.write(NEW, [userLine(SOURCE)]);
    plain.pass();
    assertNeverMoved(plain, live, LIVE);
    assert.equal(knows(live, NEW), true, 'it is taken as known');

    // Nor is a copy of the RUNNING session's own messages (a fork of a session that was not itself
    // started as one) a move for that session: the one that was forked is not the fork.
    const running = boot();
    running.write(LIVE, [userLine(LIVE)]);
    const source = running.session(LIVE);
    running.write(NEW, [userLine(LIVE)]);
    running.pass();
    assertNeverMoved(running, source, LIVE);
    assert.equal(knows(source, NEW), true, 'it is taken as known');

    // The source's own transcript, seen as a new file, is not the fork.
    const own = boot();
    const waiting = own.session(TEMP, { forkFrom: SOURCE });   // started before the source's file was there
    own.write(SOURCE, [userLine(SOURCE)]);
    own.pass();
    assertNeverMoved(own, waiting, TEMP);
    assert.equal(knows(waiting, SOURCE), true);
  });

  await t.test('snapshot-only fork: a session waiting for its fork takes a transcript that holds only snapshots, once', () => {
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const record = h.session(TEMP, { forkFrom: SOURCE, sessionSlug: 'kept-slug' });
    h.write(NEW, [snapshotLine(1), snapshotLine(2)]);
    h.pass();
    assertMoved(h, record, TEMP, NEW);
    assert.equal(record.sessionSlug, 'kept-slug', 'no slug in the new transcript: the one it had stays');
    assert.equal(h.effects.length, 3);

    // Once it has moved it takes no second file this way.
    h.write(NEW2, [snapshotLine(1)]);                      // snapshots only
    h.write(OTHER, [snapshotLine(1), userLine(OTHER)]);    // a snapshot, then another conversation
    h.pass();
    assert.equal(h.sessions.get(NEW), record);
    assert.equal(record.realSessionId, NEW);
    assert.deepEqual(record.priorIds, [TEMP]);
    assert.equal(h.effects.length, 3, 'no second move');
    assert.equal(knows(record, NEW2), false, 'the snapshot-only file is held back like an empty one');
    assert.equal(knows(record, OTHER), true, 'the other conversation is taken as known');

    // A session that was not started as a fork: a snapshot-only file is just an empty file.
    const plain = boot();
    const live = plain.session(LIVE);
    plain.write(NEW, [snapshotLine(1)]);
    plain.pass();
    assertNeverMoved(plain, live, LIVE);
    assert.equal(knows(live, NEW), false, 'held back for the next pass');
  });

  await t.test('snapshot-only fork: today a session still waiting for its fork also takes a transcript that starts with a snapshot and goes on as another conversation', () => {
    // Recorded as it is: nothing in this file ties it to SOURCE. Without the snapshot line it is left alone (see "unrelated file").
    const h = boot();
    const record = h.session(TEMP, { forkFrom: SOURCE });
    h.write(OTHER, [snapshotLine(1), userLine(OTHER)]);
    h.pass();
    assertMoved(h, record, TEMP, OTHER);
    assert.equal(h.effects.length, 3);
  });

  await t.test('plan-accept: a transcript with plan content and the same slug, within 30 s of an old transcript that ends in ExitPlanMode, moves the session', () => {
    for (const [what, options, gap] of [
      ['the new transcript 28 s after the old one', { oldAgeMs: 28 * SECOND }, 28 * SECOND],
      ['the new transcript 28 s before the old one', { newAgeMs: 28 * SECOND }, -28 * SECOND],
    ]) {
      const { h, record } = planPass(options);
      assert.equal(planGap(h), gap, what + ': the file system kept the times this case sets');
      assertMoved(h, record, LIVE, NEW);
      assert.deepEqual(record.priorIds, [LIVE], what);
      assert.equal(record.sessionSlug, SLUG, what + ': the slug is written on the record');
      assert.equal(h.effects.length, 3, what);
    }
  });

  await t.test('plan-accept: no move when the times are 30 s apart, or ExitPlanMode, the slug, the plan content or the old transcript is missing', () => {
    for (const [what, options, gap] of [
      ['the new transcript 30 s after the old one', { oldAgeMs: 30 * SECOND }, 30 * SECOND],
      ['the new transcript 30 s before the old one', { newAgeMs: 30 * SECOND }, -30 * SECOND],
      ['the old transcript does not end in ExitPlanMode', { oldLines: planTail(SLUG, 'Read') }],
      ['the old transcript has another slug', { oldLines: planTail('other-slug') }],
      ['the new transcript has the slug but no plan content', { newExtra: { slug: SLUG } }],
      ['the new transcript has plan content but no slug', { newExtra: { planContent: '# Do it' } }],
      ['the old transcript is not there', { oldLines: null }],
    ]) {
      const { h, record } = planPass(options);
      if (gap !== undefined) assert.equal(planGap(h), gap, what + ': the file system kept the times this case sets');
      assertNeverMoved(h, record, LIVE, what + ':');
      assert.equal(knows(record, NEW), true, what + ': the new transcript is taken as known');
    }
  });

  await t.test('plan-accept: a session started as a fork and a session that has moved before are moved the same way, and the old transcript is the one of the id the session has now', () => {
    // Started as a fork, moved to LIVE since: forkFrom is still on the record and does not switch the rule off.
    const fork = planPass({ fields: { ...MOVED_FORK, priorIds: [TEMP] } });
    assertMoved(fork.h, fork.record, LIVE, NEW);
    assert.deepEqual(fork.record.priorIds, [TEMP, LIVE]);
    assert.equal(fork.record.sessionSlug, SLUG);
    assert.equal(fork.h.effects.length, 3);

    // Moved before, from OLDER to LIVE. LIVE's transcript ends in ExitPlanMode, OLDER's does not: a move.
    const moved = planPass({
      fields: { ...MOVED_BEFORE, priorIds: [OLDER] },
      before: (h) => h.write(OLDER, [userLine(OLDER, { slug: SLUG })]),
    });
    assertMoved(moved.h, moved.record, LIVE, NEW);
    assert.deepEqual(moved.record.priorIds, [OLDER, LIVE]);
    assert.equal(moved.h.effects.length, 3);

    // The other way round, only the transcript of the id it started with ends in ExitPlanMode: no move.
    const startOnly = planPass({
      oldLines: [userLine(LIVE, { slug: SLUG })],
      fields: { ...MOVED_BEFORE, priorIds: [OLDER] },
      before: (h) => h.write(OLDER, planTail(SLUG)),
    });
    assertNotMovedAgain(startOnly.h, startOnly.record, LIVE, [OLDER]);
    assert.equal(knows(startOnly.record, NEW), true);
  });

  await t.test('plan-accept: of the slugs in the old transcript\'s tail the last one counts', () => {
    // The old transcript was renamed on the way: an early slug, then the one its last lines carry.
    const renamed = [userLine(LIVE, { slug: 'early-slug' }), ...planTail(SLUG).slice(1)];
    const last = planPass({ oldLines: renamed });
    assertMoved(last.h, last.record, LIVE, NEW);
    assert.equal(last.record.sessionSlug, SLUG);

    const early = planPass({ oldLines: renamed, newExtra: { slug: 'early-slug', planContent: '# Do it' } });
    assertNeverMoved(early.h, early.record, LIVE);
    assert.equal(knows(early.record, NEW), true);
  });

  await t.test('a new transcript is read up to its first user or assistant line and no further: what a later line carries is not seen, what an earlier line carries is', () => {
    // forkedFrom on the second message: not a fork of this session.
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    const record = h.session(LIVE);
    h.write(NEW, [userLine(NEW), userLine(NEW, { uuid: 'u-2', forkedFrom: { sessionId: LIVE, messageUuid: 'u-0' } })]);
    h.pass();
    assertNeverMoved(h, record, LIVE, 'forkedFrom on the second message:');
    assert.equal(knows(record, NEW), true);

    // The same after an assistant line.
    const afterAssistant = boot();
    afterAssistant.write(LIVE, [userLine(LIVE)]);
    const answered = afterAssistant.session(LIVE);
    afterAssistant.write(NEW, [
      { type: 'assistant', sessionId: NEW, uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      userLine(NEW, { uuid: 'u-2', forkedFrom: { sessionId: LIVE, messageUuid: 'u-0' } }),
    ]);
    afterAssistant.pass();
    assertNeverMoved(afterAssistant, answered, LIVE, 'forkedFrom after an assistant line:');

    // Plan content and the slug on the second message: not a plan-accept.
    for (const [what, newLines] of [
      ['plan content on the second message', [userLine(NEW, { slug: SLUG }), userLine(NEW, { uuid: 'u-2', slug: SLUG, planContent: '# Do it' })]],
      ['slug and plan content on the second message', [userLine(NEW), userLine(NEW, { uuid: 'u-2', slug: SLUG, planContent: '# Do it' })]],
    ]) {
      const plan = planPass({ newLines });
      assertNeverMoved(plan.h, plan.record, LIVE, what + ':');
      assert.equal(knows(plan.record, NEW), true, what);
    }

    // The source's sessionId on the second message only: not a --fork-session copy.
    const copy = boot();
    copy.write(SOURCE, [userLine(SOURCE)]);
    const waiting = copy.session(TEMP, { forkFrom: SOURCE });
    copy.write(NEW, [userLine(OTHER), userLine(SOURCE, { uuid: 'u-2' })]);
    copy.pass();
    assertNeverMoved(copy, waiting, TEMP, 'the source\'s id on the second message:');

    // A line that is neither a snapshot, a user nor an assistant line is read, and the reading goes on past it.
    const early = boot();
    early.write(LIVE, [userLine(LIVE)]);
    const forked = early.session(LIVE);
    early.write(NEW, [
      { type: 'summary', forkedFrom: { sessionId: LIVE, messageUuid: 'u-0' } },
      userLine(NEW, { slug: 'second-slug' }),
    ]);
    early.pass();
    assertMoved(early, forked, LIVE, NEW);
    assert.equal(forked.sessionSlug, 'second-slug', 'the slug of the user line after it is read too');
  });

  await t.test('unrelated file: another conversation\'s transcript, the session\'s own, a fork of someone else and a file that is not a .jsonl move nothing', () => {
    // Another conversation starts in the same folder.
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    const record = h.session(LIVE);
    h.write(OTHER, [userLine(OTHER, { slug: 'other-slug' })]);
    h.write(NEW2, forkOf(OTHER, NEW2));                          // a fork, but of that other conversation
    h.write(NEW, forkOf(LIVE, NEW), 0, NEW + '.json');           // would be this session's fork, were it a .jsonl
    h.pass();
    assertNeverMoved(h, record, LIVE);
    assert.deepEqual([...h.sessions.keys()], [LIVE]);
    assert.deepEqual([...record.knownJsonlFiles].sort(), [LIVE, NEW2, OTHER].map((id) => id + '.jsonl'), 'both are known now, the .json is not listed');
    assert.equal(record.sessionSlug, null, 'another conversation\'s slug is not taken');

    // The session's own transcript, written for the first time after it started.
    const fresh = boot();
    const started = fresh.session(LIVE);
    assert.equal(started.knownJsonlFiles.size, 0);
    fresh.write(LIVE, [snapshotLine(1), userLine(LIVE, { slug: 'own-slug' })]);
    fresh.pass();
    assertNeverMoved(fresh, started, LIVE);
    assert.equal(knows(started, LIVE), true);

    // A session waiting for its fork leaves another conversation alone, and still takes its fork later.
    const fork = boot();
    fork.write(SOURCE, [userLine(SOURCE)]);
    const waiting = fork.session(TEMP, { forkFrom: SOURCE });
    fork.write(OTHER, [userLine(OTHER)]);
    fork.write(NEW2, forkOf(OTHER, NEW2));
    fork.pass();
    assertNeverMoved(fork, waiting, TEMP);
    assert.equal(knows(waiting, OTHER), true);
    assert.equal(knows(waiting, NEW2), true);
    fork.write(NEW, [userLine(SOURCE)]);
    fork.pass();
    assertMoved(fork, waiting, TEMP, NEW);
    assert.equal(fork.effects.length, 3);
  });

  await t.test('empty file retried: an empty or half-written transcript is held back and read again on the next pass; one older than an hour is taken as known', () => {
    // Empty, 59 minutes old.
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    const record = h.session(LIVE);
    h.write(OTHER, [userLine(OTHER)]);
    h.write(NEW, '', 59 * MINUTE);
    h.pass();
    assertNeverMoved(h, record, LIVE);
    assert.equal(knows(record, NEW), false, 'the empty file is not known yet');
    assert.equal(knows(record, OTHER), true, 'a file with content next to it is');
    assert.equal(knows(record, LIVE), true);
    h.pass();
    assertNeverMoved(h, record, LIVE);
    assert.equal(knows(record, NEW), false, 'still empty, still held back');
    h.write(NEW, forkOf(LIVE, NEW));
    h.pass();
    assertMoved(h, record, LIVE, NEW);
    assert.equal(h.effects.length, 3);

    // A first line that is not whole yet counts as empty.
    const half = boot();
    const writing = half.session(LIVE);
    const whole = JSON.stringify(forkOf(LIVE, NEW)[0]);
    half.write(NEW, whole.slice(0, 40));
    half.pass();
    assertNeverMoved(half, writing, LIVE);
    assert.equal(knows(writing, NEW), false);
    half.write(NEW, whole + '\n');
    half.pass();
    assertMoved(half, writing, LIVE, NEW);

    // Empty, 61 minutes old: taken as known, so it is never read again, whatever is written to it later.
    const stale = boot();
    const old = stale.session(LIVE);
    stale.write(NEW, '', 61 * MINUTE);
    stale.pass();
    assertNeverMoved(stale, old, LIVE);
    assert.equal(knows(old, NEW), true);
    stale.write(NEW, forkOf(LIVE, NEW));
    stale.pass();
    assertNeverMoved(stale, old, LIVE);
  });

  await t.test('empty file retried: a session waiting for its fork holds an empty or half-written transcript back too, and takes it once it is whole', () => {
    // Empty, then the fork.
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const waiting = h.session(TEMP, { forkFrom: SOURCE });
    h.write(NEW, '');
    h.pass();
    assertNeverMoved(h, waiting, TEMP, 'an empty file:');
    assert.equal(knows(waiting, NEW), false, 'the empty file is not known yet');
    h.pass();
    assert.equal(knows(waiting, NEW), false, 'still empty, still held back');
    h.write(NEW, forkOf(SOURCE, NEW));
    h.pass();
    assertMoved(h, waiting, TEMP, NEW);
    assert.equal(h.effects.length, 3);

    // A whole snapshot line, then a line that is not whole yet. A line that does not parse makes the whole
    // file read as empty: it is NOT taken as a snapshot-only fork, although its first line is a snapshot.
    const half = boot();
    half.write(SOURCE, [userLine(SOURCE)]);
    const writing = half.session(TEMP, { forkFrom: SOURCE });
    const snapshot = JSON.stringify(snapshotLine(1)) + '\n';
    const message = JSON.stringify(userLine(OTHER));
    half.write(NEW, snapshot + message.slice(0, 40));
    half.pass();
    assertNeverMoved(half, writing, TEMP, 'a snapshot and half a line:');
    assert.equal(knows(writing, NEW), false, 'held back for the next pass');

    // The same for a session that was not started as a fork: half a line hides a whole line before it
    // that is not a message, forkedFrom and all.
    const plain = boot();
    const live = plain.session(LIVE);
    const early = JSON.stringify({ type: 'summary', forkedFrom: { sessionId: LIVE, messageUuid: 'u-0' } }) + '\n';
    plain.write(NEW, early + message.slice(0, 40));
    plain.pass();
    assertNeverMoved(plain, live, LIVE, 'a line that is not a message and half a line:');
    assert.equal(knows(live, NEW), false);
    plain.write(NEW, early + message + '\n');
    plain.pass();
    assertMoved(plain, live, LIVE, NEW);

    // Half a line AFTER the first whole message is never reached: the reading stops at that message,
    // so the transcript is read at once.
    const after = boot();
    const forked = after.session(LIVE);
    after.write(NEW, JSON.stringify(forkOf(LIVE, NEW)[0]) + '\n' + message.slice(0, 40));
    after.pass();
    assertMoved(after, forked, LIVE, NEW);
    assert.equal(after.effects.length, 3);
  });

  // Recorded as it is: whether an empty transcript is still held back after a move depends on where the
  // folder listing puts it.
  await t.test('empty file retried: today, in the pass that moves the session, an empty transcript listed before the one it takes stays held back, and one listed after it is taken as known', () => {
    for (const emptyFirst of [true, false]) {
      const what = emptyFirst ? 'the empty file listed first:' : 'the empty file listed last:';
      const h = boot();
      h.write(LIVE, [userLine(LIVE)]);
      const record = h.session(LIVE);
      h.write(NEW, '');
      h.write(NEW2, '');
      const listed = () => h.listing().filter((f) => f !== LIVE + '.jsonl').map((f) => path.basename(f, '.jsonl'));
      const order = listed();
      assert.deepEqual([...order].sort(), [NEW, NEW2]);
      const [empty, fork] = emptyFirst ? order : [order[1], order[0]];
      h.write(fork, forkOf(LIVE, fork));
      assert.deepEqual(listed(), order, what + ' the folder lists the two files in the order this case was built on');
      h.pass();

      assertMoved(h, record, LIVE, fork);
      assert.equal(h.effects.length, 3, what);
      assert.equal(knows(record, empty), !emptyFirst, what);
    }
  });

  await t.test('skipped sessions: an ended session, a plain terminal, one with no list of known transcripts and one of another folder are not looked at', () => {
    const start = (fields) => {
      const h = boot();
      h.write(SOURCE, [userLine(SOURCE)]);
      const record = h.session(TEMP, { forkFrom: SOURCE, ...fields });
      h.write(NEW, forkOf(SOURCE, NEW));
      return { h, record };
    };
    for (const [what, fields] of [
      ['an ended session:', { exited: true }],
      ['a plain terminal:', { isPlainTerminal: true }],
      ['a session with no list of known transcripts:', { knownJsonlFiles: null }],
      ['a session of another project folder:', { projectFolder: 'C--another-project' }],
    ]) {
      const { h, record } = start(fields);
      const known = record.knownJsonlFiles;
      const knownBefore = known && [...known];
      h.pass();
      assertNeverMoved(h, record, TEMP, what);
      assert.equal(record.knownJsonlFiles, known, what + ' its list of known transcripts is not replaced');
      if (known) assert.deepEqual([...known], knownBefore, what + ' nor added to');
    }

    // The same session with none of the four is moved by the same file.
    const { h, record } = start({});
    h.pass();
    assertMoved(h, record, TEMP, NEW);

    // The four hold for a session that was not started as a fork as well.
    const startPlain = (fields) => {
      const plain = boot();
      plain.write(LIVE, [userLine(LIVE)]);
      const live = plain.session(LIVE, fields);
      plain.write(NEW, forkOf(LIVE, NEW));
      return { plain, live };
    };
    for (const [what, fields] of [
      ['not a fork, ended:', { exited: true }],
      ['not a fork, a plain terminal:', { isPlainTerminal: true }],
      ['not a fork, no list of known transcripts:', { knownJsonlFiles: null }],
      ['not a fork, another project folder:', { projectFolder: 'C--another-project' }],
    ]) {
      const { plain, live } = startPlain(fields);
      const known = live.knownJsonlFiles;
      const knownBefore = known && [...known];
      assert.doesNotThrow(() => plain.pass(), what);
      assertNeverMoved(plain, live, LIVE, what);
      assert.equal(live.knownJsonlFiles, known, what + ' its list of known transcripts is not replaced');
      if (known) assert.deepEqual([...known], knownBefore, what + ' nor added to');
    }
    const control = startPlain({});
    control.plain.pass();
    assertMoved(control.plain, control.live, LIVE, NEW);

    // A folder that cannot be listed: nothing happens and nothing is thrown.
    const gone = boot();
    const elsewhere = gone.session(TEMP, { forkFrom: SOURCE, projectFolder: 'C--not-there' });
    assert.doesNotThrow(() => gone.pass('C--not-there'));
    assertNeverMoved(gone, elsewhere, TEMP);
  });

  await t.test('the effects in order: the record is whole under its new id before the first call; then the MCP server, then the owner, then the send', () => {
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    h.write(OTHER, [userLine(OTHER)]);
    const record = h.session(LIVE, { sessionSlug: 'first-slug', priorIds: [OLDER] });
    h.owners.set(LIVE, 7);
    h.write(NEW, forkOf(LIVE, NEW, { slug: 'second-slug' }));
    h.pass();

    assertMoved(h, record, LIVE, NEW);
    assert.equal(h.effects.length, 3);
    const [mcp, owner] = h.effects;
    for (const call of [mcp, owner]) {
      assert.equal(call.saw.oldKey, false, call.call + ': the old key is gone');
      assert.equal(call.saw.record, record, call.call + ': the record is under the new key');
      assert.equal(call.saw.realSessionId, NEW, call.call);
      assert.deepEqual(call.saw.priorIds, [OLDER, LIVE], call.call + ': the old id is added after the ids it had before');
      assert.equal(call.saw.sessionSlug, 'second-slug', call.call);
      assert.equal(call.saw.knowsNewFile, true, call.call);
    }
    assert.deepEqual(record.priorIds, [OLDER, LIVE]);
    assert.deepEqual([...record.knownJsonlFiles].sort(), [LIVE, NEW, OTHER].map((id) => id + '.jsonl'), 'afterwards it knows every transcript in the folder');
  });

  await t.test('one re-key per pass: of two transcripts that both match, a session takes the first listed and never the other', () => {
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    const record = h.session(LIVE);
    h.write(NEW, forkOf(LIVE, NEW));
    h.write(NEW2, forkOf(LIVE, NEW2));
    const [taken, left] = h.listing().filter((f) => f !== LIVE + '.jsonl').map((f) => path.basename(f, '.jsonl'));
    assert.deepEqual([taken, left].sort(), [NEW, NEW2]);
    h.pass();

    assertMoved(h, record, LIVE, taken);
    assert.equal(h.effects.length, 3, 'one move in the pass');
    assert.deepEqual([...h.sessions.keys()], [taken]);
    assert.deepEqual(record.priorIds, [LIVE]);
    assert.equal(knows(record, left), true, 'the other file is known from now on');

    h.pass();
    assert.equal(h.effects.length, 3, 'so the next pass does not take it either');
    assert.equal(h.sessions.get(taken), record);
    assert.equal(record.realSessionId, taken);
  });

  await t.test('one re-key per pass: that is one per session; two sessions each move in the same pass, and a session that moved can move again in a later one', () => {
    const h = boot();
    h.write(LIVE, [userLine(LIVE)]);
    h.write(LIVE_B, [userLine(LIVE_B)]);
    const a = h.session(LIVE);
    const b = h.session(LIVE_B);
    h.write(NEW, forkOf(LIVE, NEW));
    h.write(NEW2, forkOf(LIVE_B, NEW2));
    h.pass();
    assertMoved(h, a, LIVE, NEW, 0);
    assertMoved(h, b, LIVE_B, NEW2, 3);
    assert.equal(h.effects.length, 6);
    assert.deepEqual([...h.sessions.keys()].sort(), [NEW, NEW2]);

    // A transcript forked from the id a session has NOW moves it again; the ids it had stay in order.
    const again = boot();
    again.write(LIVE, [userLine(LIVE)]);
    const record = again.session(LIVE);
    again.write(NEW, forkOf(LIVE, NEW));
    again.pass();
    assertMoved(again, record, LIVE, NEW, 0);
    again.write(NEW2, forkOf(NEW, NEW2));
    again.pass();
    assertMoved(again, record, NEW, NEW2, 3);
    assert.equal(again.effects.length, 6);
    assert.deepEqual(record.priorIds, [LIVE, NEW]);
    assert.deepEqual([...again.sessions.keys()], [NEW2]);
  });

  await t.test('init: without the two window functions a move still happens and nothing is thrown', () => {
    const h = boot({ windowFunctions: false });
    const record = h.session(LIVE);
    h.write(NEW, forkOf(LIVE, NEW));
    assert.doesNotThrow(() => h.pass());
    assert.equal(h.sessions.get(NEW), record);
    assert.equal(h.sessions.has(LIVE), false);
    assert.equal(record.realSessionId, NEW);
    assert.deepEqual(h.effects.map((e) => e.call), ['rekeyMcpServer']);
  });

  await t.test('the send comes after the owner moves: it is addressed by the new id and finds the window that showed the old one', () => {
    const h = boot();
    const record = h.session(LIVE);
    h.owners.set(LIVE, 7);
    h.owners.set(OTHER, 9);
    h.write(NEW, forkOf(LIVE, NEW));
    h.pass();
    assertMoved(h, record, LIVE, NEW);
    const send = h.effects[2];
    assert.equal(send.call, 'sendToOwner');
    assert.equal(send.args[0], NEW, 'addressed by the new id');
    assert.equal(send.windowId, 7, 'under which the owner already was');
    assert.equal(send.args[1], 'session-forked');
    assert.equal(send.args[2], LIVE);
    assert.equal(send.args[3], NEW);
    assert.deepEqual([...h.owners].sort(), [[NEW, 7], [OTHER, 9]].sort(), 'only this session\'s owner moved');
    assert.equal(h.effects.filter((e) => e.call === 'sendToOwner').length, 1, 'one send');

    // A session no window shows: the send is still made once, by the new id, and finds nobody.
    const unowned = boot();
    const hidden = unowned.session(LIVE);
    unowned.write(NEW, forkOf(LIVE, NEW));
    unowned.pass();
    assertMoved(unowned, hidden, LIVE, NEW);
    assert.equal(unowned.effects[2].windowId, null);
    assert.equal(unowned.owners.size, 0, 'and no owner is made up');
  });

  // The only place that counts the send's arguments; every other case reads the first two. (The approved
  // design has preload.js forward four arguments of session-forked after /clear, where it forwards two today.)
  await t.test('the send has two arguments: the old id and the new id, for a fork and for a plan-accept', () => {
    const fork = boot();
    fork.session(LIVE);
    fork.write(NEW, forkOf(LIVE, NEW));
    fork.pass();
    const plan = planPass({ oldAgeMs: 28 * SECOND }).h;
    for (const [what, h] of [['fork', fork], ['plan-accept', plan]]) {
      const sends = h.effects.filter((e) => e.call === 'sendToOwner');
      assert.equal(sends.length, 1, what);
      assert.deepEqual(sends[0].args, [NEW, 'session-forked', LIVE, NEW], what + ': the owner\'s id, the channel, and two arguments');
    }
  });

  // The assertion that is changed on purpose by /clear (see the line above this pin).
  await t.test('the three database functions are not called: copySessionAssignment, rekeyPlanLinks and rekeyScheduleSession are handed to init and never used, whatever kind of move', () => {
    const byForkedFrom = boot();
    const forked = byForkedFrom.session(LIVE);
    byForkedFrom.write(NEW, forkOf(LIVE, NEW));
    byForkedFrom.pass();
    assertMoved(byForkedFrom, forked, LIVE, NEW);

    const forkSession = boot();
    const copied = forkSession.session(TEMP, { forkFrom: SOURCE });
    forkSession.write(NEW, [userLine(SOURCE)]);
    forkSession.pass();
    assertMoved(forkSession, copied, TEMP, NEW);

    const snapshotOnly = boot();
    const waiting = snapshotOnly.session(TEMP, { forkFrom: SOURCE });
    snapshotOnly.write(NEW, [snapshotLine(1)]);
    snapshotOnly.pass();
    assertMoved(snapshotOnly, waiting, TEMP, NEW);

    const plan = planPass({ oldAgeMs: 28 * SECOND });
    assertMoved(plan.h, plan.record, LIVE, NEW);

    for (const [what, h] of [
      ['fork by forkedFrom', byForkedFrom], ['fork-session file', forkSession],
      ['snapshot-only fork', snapshotOnly], ['plan-accept', plan.h],
    ]) {
      assert.deepEqual(h.dbCalls, [], what + ': none of the three is called today');
    }
  });
});
