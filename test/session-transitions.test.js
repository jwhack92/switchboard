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

// PIN 14, changed on purpose by /clear re-key. Formerly: "session-transitions (pin, last assertion changed on purpose by /clear): fork by forkedFrom, fork-session file, snapshot-only fork, plan-accept, unrelated file, empty file retried, skipped sessions; the effects in order; one re-key per pass; the send has two arguments and comes after the owner moves; the three database functions are not called". Two subtests changed and no other: the last one (copySessionAssignment, rekeyPlanLinks and rekeyScheduleSession are now called once with (old id, new id) on every move, after rekeyOwner and before the send) and "fork by forkedFrom: of two sessions waiting ..." (a move to an id another live terminal has is refused).
test('session-transitions (pin, changed by /clear): fork by forkedFrom, fork-session file, snapshot-only fork, plan-accept, unrelated file, empty file retried, skipped sessions; the effects in order; one re-key per pass; the send has two arguments and comes after the owner moves; the three database functions are called once on every move; a move to an id another live terminal has is refused', async (t) => {
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

  // Changed on purpose by /clear re-key commit 1 (Jason, 2026-10-06, "Every kind (Recommended)"): the one
  // rekey() refuses, with one warning, a move to an id another live terminal already has as its key or as
  // an earlier id. Before this commit both sessions took the transcript and the second replaced the first
  // in the Map, so the first terminal was stored under no id at all though it ran on.
  await t.test('fork by forkedFrom: of two sessions waiting for a fork of the same source the first takes the transcript; the second is refused with one warning and stays under its own id', () => {
    const h = boot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const first = h.session(TEMP, { forkFrom: SOURCE });
    const second = h.session(TEMP_B, { forkFrom: SOURCE });
    h.write(NEW, forkOf(SOURCE, NEW));
    h.pass();

    assertMoved(h, first, TEMP, NEW);
    assert.equal(h.effects.length, 3, 'one move in the pass');
    assert.deepEqual([...h.sessions.keys()].sort(), [NEW, TEMP_B].sort());
    assert.equal(h.sessions.get(TEMP_B), second, 'the second record is still under its own id');
    assert.equal(second.realSessionId, undefined);
    assert.equal(second.priorIds, undefined);
    assert.equal(second.exited, false);
    const refused = () => h.logLines.filter((l) => l.startsWith('warn ') && l.includes('[session-transition] refused'));
    assert.deepEqual(refused(), [`warn [session-transition] refused old=${TEMP_B} new=${NEW} kind=fork holder=${NEW}`]);
    assert.equal(knows(second, NEW), true, 'the transcript is taken as known');
    h.pass();
    assert.equal(refused().length, 1, 'so it is refused once, not on every pass');
    assert.equal(h.effects.length, 3);
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

  // Changed on purpose by /clear re-key commit 1: the three are called with (old id, new id) on every move.
  // Their place between the other calls (after rekeyOwner, before the send) is asserted by
  // "detector: after any re-key ..." below, which records every call in one list.
  await t.test('the three database functions are called once on every move with the old id and the new id: copySessionAssignment, rekeyPlanLinks, rekeyScheduleSession, whatever kind of move', () => {
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

    for (const [what, h, oldId] of [
      ['fork by forkedFrom', byForkedFrom, LIVE], ['fork-session file', forkSession, TEMP],
      ['snapshot-only fork', snapshotOnly, TEMP], ['plan-accept', plan.h, LIVE],
    ]) {
      assert.deepEqual(h.dbCalls, [
        ['copySessionAssignment', oldId, NEW], ['rekeyPlanLinks', oldId, NEW], ['rekeyScheduleSession', oldId, NEW],
      ], what);
    }
  });
});

test('session-transitions: keyOf gives the key a record is stored under, by identity: the start id first, then realSessionId, then the whole list', () => {
  const st = require('../session-transitions');
  const list = new Map();
  st.init({ activeSessions: list });
  const a = {};
  const b = { realSessionId: 'id-b2' };
  const c = {};
  const twin = { realSessionId: 'id-b2' }; // same ids as b, another object, in no list
  const moved = { realSessionId: 'id-stale' };
  list.set('id-a', a);
  list.set('id-b2', b);
  list.set('id-b1', c);       // id-b1 was b's first id; another terminal lives there now
  list.set('id-now', moved);  // its realSessionId points at nothing
  assert.equal(st.keyOf(a, 'id-a'), 'id-a');
  assert.equal(st.keyOf(a), 'id-a', 'no start id, no realSessionId: found by looking through the list');
  assert.equal(st.keyOf(b, 'id-b1'), 'id-b2', 'the start id points at another record');
  assert.equal(st.keyOf(b), 'id-b2');
  assert.equal(st.keyOf(c, 'id-b1'), 'id-b1');
  assert.equal(st.keyOf(c, 'id-nobody'), 'id-b1');
  assert.equal(st.keyOf(moved, 'id-first'), 'id-now');
  assert.equal(st.keyOf(twin, 'id-b1'), null, 'same ids, another object');
  assert.equal(st.keyOf(twin), null);
  assert.equal(st.keyOf(null, 'id-a'), null);
  assert.equal(st.keyOf(undefined), null);
  list.delete('id-a');
  assert.equal(st.keyOf(a, 'id-a'), null, 'a record that left the list has no key');
  // Before init there is no list: no key, and nothing is thrown.
  const file = require.resolve('../session-transitions');
  const kept = require.cache[file];
  delete require.cache[file];
  try { assert.equal(require(file).keyOf({}, 'x'), null); } finally { require.cache[file] = kept; }
});

// --- /clear: the clear pass, rekey() for every kind, the 5 s follow ---

const LIVE_C = uuid(0);      // a third running session in the folder
const TAG_A = uuid('a');     // the tags of three terminals
const TAG_B = uuid('b');
const TAG_C = uuid('c');
const TAG_E = uuid('e');     // a tag no terminal has

/**
 * The head of the transcript /clear starts. Record shapes read from two real transcripts (Claude Code
 * 2.1.289): a mode record with the file's own id, a snapshot, the hook's attachment (not in every
 * version), the caveat record, the /clear record, a system record. The value of `mode` is filler.
 */
const clearHead = (id, { attachment = true, command = true, commandId = id } = {}) => [
  { type: 'mode', mode: 'default', sessionId: id },
  snapshotLine(1),
  ...(attachment ? [{ type: 'attachment', sessionId: id, uuid: 'at-1', attachment: { type: 'hook_success', hookName: 'SessionStart:clear', hookEvent: 'SessionStart' } }] : []),
  userLine(id, { uuid: 'u-caveat', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } }),
  ...(command ? [userLine(commandId, { uuid: 'u-clear', message: { role: 'user', content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>' } })] : []),
  { type: 'system', subtype: 'local_command', content: '', sessionId: id, uuid: 's-1' },
];

/** The note the hook writes for transcript `id`: started by /clear in the terminal tagged `tag`, 3 s before NOW. */
const note = (id, tag, clearedFrom = null, extra = {}) => ({
  v: 1, session_id: id, source: 'clear', host_token: tag, cleared_from: clearedFrom, prior: [], ts: NOW / 1000 - 3, ...extra,
});

/**
 * boot() plus what the clear pass needs: notes, a clock, hand-made timers, and ONE list of every call a
 * move makes, in the order made. init() is called once, here. A pass does not call it again, because
 * init() forgets the files that wait for their note. So: one clearBoot at a time.
 */
function clearBoot() {
  const h = boot();
  const notes = new Map();     // transcript id -> what readClearOrigin answers for it
  const noteReads = [];        // the ids it was asked for, in order
  const calls = [];            // [name, ...args] of every call of a move
  const throwing = new Set();  // names of database follow-ups that throw when called
  const clock = { now: NOW };
  let timers = [];
  let seq = 0;
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args) => { h.logLines.push(level + ' ' + args.join(' ')); };
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const followUp = (name) => (...args) => { calls.push([name, ...args]); if (throwing.has(name)) throw new Error(name + ' failed'); };
  transitions.init({
    PROJECTS_DIR: path.dirname(h.dir), activeSessions: h.sessions, log,
    rekeyMcpServer: record('rekeyMcpServer'),
    rekeyOwner: (oldId, newId) => {
      calls.push(['rekeyOwner', oldId, newId]);
      if (h.owners.has(oldId)) { h.owners.set(newId, h.owners.get(oldId)); h.owners.delete(oldId); }
    },
    sendToOwner: record('sendToOwner'),
    copySessionAssignment: followUp('copySessionAssignment'), rekeyPlanLinks: followUp('rekeyPlanLinks'),
    rekeyScheduleSession: followUp('rekeyScheduleSession'), copyStar: followUp('copyStar'),
    broadcast: record('broadcast'),
    ownerId: (id) => (h.owners.has(id) ? h.owners.get(id) : null),
    readClearOrigin: (id) => { noteReads.push(id); return notes.has(id) ? notes.get(id) : null; },
    now: () => clock.now,
    setTimer: (fn, ms) => { const timer = { id: ++seq, fn, at: clock.now + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timers = timers.filter((t) => t !== timer); },
  });
  return {
    ...h, notes, noteReads, calls, throwing, clock,
    /** One pass over the folder at the clock's time. init() is NOT called again. */
    pass(folder = FOLDER) {
      const realNow = Date.now;
      Date.now = () => clock.now;
      try { transitions.detectSessionTransitions(folder); } finally { Date.now = realNow; }
    },
    /** Moves the clock on by ms and runs every timer that falls due, in order. */
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        clock.now = due.at;
        timers = timers.filter((t) => t !== due);
        due.fn();
      }
      clock.now = end;
    },
    /** How long from now each waiting timer falls due. */
    waiting: () => timers.map((t) => t.at - clock.now),
    /** The log lines of one level that hold `part`. */
    lines: (level, part) => h.logLines.filter((l) => l.startsWith(level + ' ') && l.includes(part)),
  };
}

/** The calls of one move, in the order rekey() makes them. `clearedAtMs` set = a clear. */
const moveCalls = (oldId, newId, { clearedAtMs, windowId = null } = {}) => [
  ['rekeyMcpServer', oldId, newId],
  ['rekeyOwner', oldId, newId],
  ['copySessionAssignment', oldId, newId],
  ['rekeyPlanLinks', oldId, newId],
  ['rekeyScheduleSession', oldId, newId],
  ...(clearedAtMs === undefined ? [] : [['copyStar', oldId, newId]]),
  clearedAtMs === undefined
    ? ['sendToOwner', newId, 'session-forked', oldId, newId]
    : ['sendToOwner', newId, 'session-forked', oldId, newId, 'clear', { clearedAtMs }],
  ['broadcast', 'session-owner-changed', { sessionId: newId, windowId }],
  ['broadcast', 'session-owner-changed', { sessionId: oldId, windowId: null }],
];

test('detector: after any re-key the owner broadcast, the three database follow-ups, and for a clear the star carry', async (t) => {
  await t.test('a fork: MCP, owner, the three follow-ups, the send with two arguments, then the two broadcasts; no star carry', () => {
    const h = clearBoot();
    h.write(LIVE, [userLine(LIVE)]);
    const a = h.session(LIVE);
    h.owners.set(LIVE, 7);
    h.write(NEW, forkOf(LIVE, NEW));
    h.pass();
    assert.equal(h.sessions.get(NEW), a);
    assert.deepEqual(h.calls, moveCalls(LIVE, NEW, { windowId: 7 }));
    assert.equal(a.rekeyedAtMs, NOW, 'the move is stamped with the injected clock');
  });

  await t.test('a plan-accept: the same calls in the same order', () => {
    const h = clearBoot();
    h.write(LIVE, planTail(SLUG), 28 * SECOND);
    const a = h.session(LIVE);
    h.write(NEW, [userLine(NEW, { slug: SLUG, planContent: '# Do it' })]);
    h.pass();
    assert.equal(h.sessions.get(NEW), a);
    assert.deepEqual(h.calls, moveCalls(LIVE, NEW));
    assert.deepEqual(h.lines('info', '[session-transition]'), [`info [session-transition] ${LIVE} → ${NEW} (plan-accept)`]);
  });

  for (const name of ['copySessionAssignment', 'rekeyPlanLinks', 'rekeyScheduleSession']) {
    await t.test(`a follow-up that throws (${name}) stops neither the others, the send nor the broadcasts, and is logged once`, () => {
      const h = clearBoot();
      h.write(LIVE, [userLine(LIVE)]);
      const a = h.session(LIVE);
      h.throwing.add(name);
      h.write(NEW, forkOf(LIVE, NEW));
      assert.doesNotThrow(() => h.pass());
      assert.equal(h.sessions.get(NEW), a);
      assert.deepEqual(h.calls, moveCalls(LIVE, NEW));
      assert.deepEqual(h.lines('warn', 'follow-up failed'),
        [`warn [session-transition] follow-up failed name=${name} old=${LIVE} new=${NEW} error=${name} failed`]);
    });
  }
  await t.test('a clear: the same order, the star carry after the three, and four arguments on the send', () => {
    const { h, b } = oneTerminal();
    h.owners.set(LIVE_B, 7);
    h.write(NEW, clearHead(NEW));
    h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
    h.pass();
    assert.equal(h.sessions.get(NEW), b);
    assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW, { clearedAtMs: TS * 1000, windowId: 7 }));
  });

  await t.test('a clear whose star carry throws still sends and broadcasts, and is logged once', () => {
    const { h, b } = oneTerminal();
    h.throwing.add('copyStar');
    h.write(NEW, clearHead(NEW));
    h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
    assert.doesNotThrow(() => h.pass());
    assert.equal(h.sessions.get(NEW), b);
    assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW, { clearedAtMs: TS * 1000 }));
    assert.deepEqual(h.lines('warn', 'follow-up failed'),
      [`warn [session-transition] follow-up failed name=copyStar old=${LIVE_B} new=${NEW} error=copyStar failed`]);
  });
});

test("detector: the new id is already another live terminal's key or prior id (clear and fork); and new id equal to the old id", async (t) => {
  const holders = [
    ['its key', (h) => h.session(NEW), NEW],
    ['an earlier id', (h) => h.session(LIVE_C, { realSessionId: LIVE_C, priorIds: [NEW] }), LIVE_C],
    ['the key of a terminal that has ended', (h) => h.session(NEW, { exited: true }), NEW],
  ];
  for (const [what, makeHolder, holderKey] of holders) {
    await t.test(`a fork to an id another terminal has as ${what} is refused with one warning and nothing moves`, () => {
      const h = clearBoot();
      h.write(LIVE, [userLine(LIVE)]);
      const a = h.session(LIVE);
      const holder = makeHolder(h);
      h.write(NEW, forkOf(LIVE, NEW));
      h.pass();
      h.pass();
      assert.equal(h.sessions.get(LIVE), a);
      assert.equal(h.sessions.get(holderKey), holder);
      assert.equal(a.realSessionId, undefined);
      assert.equal(a.priorIds, undefined);
      assert.equal(a.rekeyedAtMs, undefined);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.lines('warn', '[session-transition]'),
        [`warn [session-transition] refused old=${LIVE} new=${NEW} kind=fork holder=${holderKey}`]);
    });
  }

  await t.test('an earlier id of a terminal that has ended does not count: the fork moves', () => {
    const h = clearBoot();
    h.write(LIVE, [userLine(LIVE)]);
    const a = h.session(LIVE);
    h.session(LIVE_C, { exited: true, realSessionId: LIVE_C, priorIds: [NEW] });
    h.write(NEW, forkOf(LIVE, NEW));
    h.pass();
    assert.equal(h.sessions.get(NEW), a);
    assert.deepEqual(h.lines('warn', ''), []);
  });

  await t.test('a plan-accept to an id another terminal has is refused the same way', () => {
    const plan = planPass({ oldAgeMs: 28 * SECOND, before: (h) => { h.session(NEW); } });
    assertNeverMoved(plan.h, plan.record, LIVE);
    assert.deepEqual(plan.h.logLines.filter((l) => l.startsWith('warn ')),
      [`warn [session-transition] refused old=${LIVE} new=${NEW} kind=plan-accept holder=${NEW}`]);
  });

  await t.test("a transcript with the terminal's own id that matches a fork rule changes nothing and logs nothing", () => {
    const h = clearBoot();
    h.write(SOURCE, [userLine(SOURCE)]);
    const waiting = h.session(TEMP, { forkFrom: SOURCE });
    h.write(TEMP, [userLine(SOURCE)]);   // opens with the source's messages, under the terminal's own id
    h.pass();
    assert.equal(h.sessions.get(TEMP), waiting);
    assert.equal(waiting.realSessionId, undefined);
    assert.equal(waiting.priorIds, undefined);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.lines('warn', ''), []);
    assert.deepEqual(h.lines('info', '[session-transition]'), []);
    assert.equal(knows(waiting, TEMP), true);
  });
  for (const [what, makeHolder] of [
    ['its key', (h) => h.session(NEW)],
    ['an earlier id', (h) => h.session(LIVE_C, { realSessionId: LIVE_C, priorIds: [NEW] })],
  ]) {
    await t.test(`a clear note for a transcript another terminal has as ${what}: the file is left out before any note is read`, () => {
      const { h, b } = oneTerminal();
      makeHolder(h);
      h.write(NEW, clearHead(NEW));
      h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
      h.pass();
      assert.equal(h.sessions.get(LIVE_B), b);
      assert.equal(b.realSessionId, undefined);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.noteReads, []);
      assert.deepEqual(h.waiting(), []);
      assert.deepEqual(h.lines('info', '[clear-detect]').concat(h.lines('warn', '')), []);
    });
  }
});

const MODE = (id) => ({ type: 'mode', mode: 'default', sessionId: id });
/** A session waiting for its fork, alone in the folder, and one new transcript; then one pass. */
function waitingFork(lines) {
  const h = clearBoot();
  h.write(SOURCE, [userLine(SOURCE)]);
  const a = h.session(TEMP, { forkFrom: SOURCE, hostToken: TAG_A });
  h.write(NEW, lines);
  h.pass();
  return { h, a };
}

test("detector: a real snapshot-only fork file, and a file with a snapshot whose first record names its own id but has no /clear record", async (t) => {
  for (const [what, lines] of [
    ['snapshots only', [snapshotLine(1), snapshotLine(2)]],
    ['a mode record with its own id, then a snapshot', [MODE(NEW), snapshotLine(1)]],
    ['the same, then a first prompt', [MODE(NEW), snapshotLine(1), userLine(NEW)]],
  ]) {
    await t.test(`${what}: still taken by the snapshot rule, as today`, () => {
      const { h, a } = waitingFork(lines);
      assert.equal(h.sessions.get(NEW), a, what);
      assert.deepEqual(a.priorIds, [TEMP], what);
      assert.deepEqual(h.calls, moveCalls(TEMP, NEW), what + ': a fork, so the send has two arguments');
      assert.deepEqual(h.waiting(), [], what + ': a folder whose only tagged terminal waits for its fork arms no timer');
      assert.deepEqual(h.noteReads, [NEW], what + ': the snapshot rule asks once whether the file has a clear note');
    });
  }
});

test('detector: a transcript marked as started by /clear is never taken by the snapshot rule', async (t) => {
  const fillers = (n) => Array.from({ length: n }, (_, i) => ({ type: 'ai-title', aiTitle: 't' + i, sessionId: NEW }));
  const caveat = userLine(NEW, { uuid: 'u-caveat', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' } });
  const command = (sessionId) => userLine(sessionId, { uuid: 'u-clear', message: { role: 'user', content: '<command-name>/clear</command-name>' } });
  const noId = (line) => { const copy = { ...line }; delete copy.sessionId; return copy; };
  const half = JSON.stringify(userLine(NEW)).slice(0, 40);
  const text = (lines) => lines.map((line) => JSON.stringify(line) + '\n').join('');

  for (const [what, lines] of [
    ['the whole real head', clearHead(NEW)],
    ['the /clear record and no attachment', clearHead(NEW, { attachment: false })],
    ['the attachment and no /clear record', clearHead(NEW, { command: false })],
    ['a /clear record with no session id', [MODE(NEW), snapshotLine(1), caveat, noId(command(NEW))]],
    ['the /clear record as the 40th record that is not a snapshot', [MODE(NEW), snapshotLine(1), ...fillers(37), caveat, command(NEW)]],
    ['half a line after the /clear record', text([MODE(NEW), snapshotLine(1), caveat, command(NEW)]) + half],
  ]) {
    await t.test(`${what}: the waiting fork does not take it`, () => {
      const { h, a } = waitingFork(lines);
      assert.equal(h.sessions.get(TEMP), a, what);
      assert.equal(a.realSessionId, undefined, what);
      assert.deepEqual(h.calls, [], what);
      assert.equal(knows(a, NEW), true, what + ': it is read at once and taken as known');
    });
  }

  for (const [what, lines] of [
    ["a /clear record that carries another conversation's id", clearHead(NEW, { attachment: false, commandId: OTHER })],
    ['the /clear record as the 41st record that is not a snapshot', [MODE(NEW), snapshotLine(1), ...fillers(38), caveat, command(NEW)]],
    ['half a line between the caveat and the /clear record', text([MODE(NEW), snapshotLine(1), caveat]) + half + '\n' + text([command(NEW)])],
    ['the words in an assistant message', [MODE(NEW), snapshotLine(1), { type: 'assistant', sessionId: NEW, uuid: 'a-1', message: { role: 'assistant', content: '<command-name>/clear</command-name>' } }]],
  ]) {
    await t.test(`${what}: not a clear head, the snapshot rule takes it as today`, () => {
      const { h, a } = waitingFork(lines);
      assert.equal(h.sessions.get(NEW), a, what);
      assert.deepEqual(h.calls, moveCalls(TEMP, NEW), what);
    });
  }
});

/** Terminal B (tag TAG_B) alone in the folder, with its transcript; returns { h, b }. */
function oneTerminal(fields = {}) {
  const h = clearBoot();
  h.write(LIVE_B, [userLine(LIVE_B)]);
  const b = h.session(LIVE_B, { hostToken: TAG_B, ...fields });
  return { h, b };
}
const TS = NOW / 1000 - 3;   // the note's time in seconds; note() uses it

test("detector: real /clear head (mode record with its own id, snapshot, attachment, caveat record, /clear record), three terminals in one folder, a note with B's tag and B's id as old id", () => {
  const h = clearBoot();
  for (const id of [LIVE, LIVE_B, LIVE_C]) h.write(id, [userLine(id)]);
  const a = h.session(LIVE, { hostToken: TAG_A });
  const b = h.session(LIVE_B, { hostToken: TAG_B });
  const c = h.session(LIVE_C, { hostToken: TAG_C });
  h.owners.set(LIVE_B, 7);
  h.write(NEW, clearHead(NEW));
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
  h.pass();

  assert.deepEqual([...h.sessions.keys()], [LIVE, LIVE_C, NEW]);
  assert.equal(h.sessions.get(NEW), b, 'only B moved');
  assert.equal(h.sessions.get(LIVE), a);
  assert.equal(h.sessions.get(LIVE_C), c);
  assert.equal(b.realSessionId, NEW);
  assert.deepEqual(b.priorIds, [LIVE_B]);
  assert.equal(b.rekeyedAtMs, NOW);
  assert.equal(a.realSessionId, undefined);
  assert.equal(c.realSessionId, undefined);
  assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW, { clearedAtMs: TS * 1000, windowId: 7 }));
  assert.deepEqual(h.lines('info', '[session-transition]'), [`info [session-transition] ${LIVE_B} → ${NEW} (clear)`]);
  assert.deepEqual(h.lines('info', '[clear-detect]'),
    [`info [clear-detect] new=${NEW} tag=bbbbbbbb followed: old=${LIVE_B} look=first afterMs=3000`]);
  assert.deepEqual(h.lines('warn', ''), []);
  assert.deepEqual(h.noteReads, [NEW], 'the note is read once in the pass');
  assert.deepEqual(h.waiting(), [], 'nothing waits, no timer');
  for (const record of [a, b, c]) assert.equal(knows(record, NEW), true);
});

test('detector: the same real head, note arrives AFTER the first look', () => {
  const { h, b } = oneTerminal();
  h.write(NEW, clearHead(NEW));
  h.pass();
  assert.equal(h.sessions.get(LIVE_B), b, 'not moved yet');
  assert.equal(knows(b, NEW), true, 'the fork and plan rules took the file as known, as today');
  assert.deepEqual(h.waiting(), [2000], 'one re-check, in 2 s');
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B, { ts: NOW / 1000 + 1 }));
  h.advance(2000);   // the transcript is not touched again
  assert.equal(h.sessions.get(NEW), b);
  assert.deepEqual(b.priorIds, [LIVE_B]);
  assert.equal(b.rekeyedAtMs, NOW + 2000);
  assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW, { clearedAtMs: NOW + 1000 }));
  assert.deepEqual(h.lines('info', '[clear-detect]'),
    [`info [clear-detect] new=${NEW} tag=bbbbbbbb followed: old=${LIVE_B} look=recheck afterMs=1000`]);
  assert.deepEqual(h.waiting(), [], 'the timer stops when nothing waits');
});

test('detector: note that is 11 minutes old when the pass runs', () => {
  const { h, b } = oneTerminal();
  h.write(NEW, clearHead(NEW));
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B, { ts: NOW / 1000 - 660 }));
  h.pass();
  assert.equal(h.sessions.get(NEW), b);
  assert.deepEqual(h.lines('info', '[clear-detect]'),
    [`info [clear-detect] new=${NEW} tag=bbbbbbbb followed: old=${LIVE_B} look=first afterMs=660000`]);
});

test('detector: no note ever; injected clock past 60 s', () => {
  const { h, b } = oneTerminal();   // one terminal alone in the folder: being the only candidate attaches nothing
  h.write(NEW, clearHead(NEW));
  h.pass();
  h.advance(58000);
  assert.equal(h.sessions.get(LIVE_B), b);
  assert.deepEqual(h.waiting(), [2000]);
  assert.deepEqual(h.lines('info', '[clear-detect]'), []);
  h.advance(2000);   // the look at 60 s
  assert.deepEqual(h.lines('info', '[clear-detect]'), [`info [clear-detect] new=${NEW} tag=none not followed: no note after 60 s`]);
  assert.deepEqual(h.waiting(), [], 'the timer stops');
  assert.equal(h.noteReads.length, 31, 'the first look and thirty re-checks');
  assert.equal(h.sessions.get(LIVE_B), b);
  assert.deepEqual(h.calls, []);
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
  h.pass();
  h.advance(10000);
  assert.equal(h.sessions.get(LIVE_B), b, 'a note that comes after the file was dropped moves nothing');
  assert.equal(h.lines('info', '[clear-detect]').length, 1, 'and the line is not written again');
});

test("detector: terminal A waits for a fork and comes first in the Map; B's clear file is seen with a late note", () => {
  const h = clearBoot();
  h.write(SOURCE, [userLine(SOURCE)]);
  h.write(LIVE_B, [userLine(LIVE_B)]);
  const a = h.session(TEMP, { forkFrom: SOURCE, hostToken: TAG_A });
  const b = h.session(LIVE_B, { hostToken: TAG_B });
  h.write(NEW, clearHead(NEW));
  h.pass();
  assert.equal(h.sessions.get(TEMP), a, 'A did not take the cleared transcript');
  assert.equal(a.realSessionId, undefined);
  assert.deepEqual(h.calls, []);
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
  h.advance(2000);
  assert.equal(h.sessions.get(NEW), b);
  assert.equal(h.sessions.get(TEMP), a);
  assert.deepEqual(h.lines('warn', ''), []);
});

test("detector: A waits for a fork, B's clear file has a valid note in the same pass", () => {
  const h = clearBoot();
  h.write(SOURCE, [userLine(SOURCE)]);
  h.write(LIVE_B, [userLine(LIVE_B)]);
  const a = h.session(TEMP, { forkFrom: SOURCE, hostToken: TAG_A });   // first in the Map
  const b = h.session(LIVE_B, { hostToken: TAG_B });
  // No /clear record and no attachment in the head: only the pass order and the note keep A away.
  h.write(NEW, [MODE(NEW), snapshotLine(1)]);
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
  h.pass();
  assert.equal(h.sessions.get(NEW), b, 'B is moved before any fork rule runs');
  assert.equal(h.sessions.get(TEMP), a);
  assert.equal(a.realSessionId, undefined);
  assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW, { clearedAtMs: TS * 1000 }));
  assert.deepEqual(h.lines('warn', ''), [], 'A did not even try: a file with a valid clear note is not a snapshot fork');
});

test('detector: note whose tag belongs to no live terminal, or to one that is exited, plain, in another folder, or a fork waiting for its file', async (t) => {
  for (const [what, tag, fields] of [
    ['no terminal', TAG_E, {}],
    ['an exited terminal', TAG_B, { exited: true }],
    ['a plain terminal', TAG_B, { isPlainTerminal: true }],
    ['a terminal of another folder', TAG_B, { projectFolder: 'C--another-project' }],
    ['a fork still waiting for its file', TAG_B, { forkFrom: SOURCE }],
  ]) {
    await t.test(`${what} has the tag: nobody moves, one line`, () => {
      const h = clearBoot();
      h.write(LIVE, [userLine(LIVE)]);
      h.write(LIVE_B, [userLine(LIVE_B)]);
      const watcher = h.session(LIVE, { hostToken: TAG_A });   // an eligible terminal, so the folder is looked at
      const target = h.session(LIVE_B, { hostToken: TAG_B, ...fields });
      h.write(NEW, clearHead(NEW));
      h.notes.set(NEW, note(NEW, tag, LIVE_B));
      h.pass();
      h.pass();
      assert.equal(h.sessions.get(LIVE_B), target, what);
      assert.equal(target.realSessionId, undefined, what);
      assert.equal(h.sessions.get(LIVE), watcher, what);
      assert.deepEqual(h.calls, [], what);
      assert.deepEqual(h.lines('info', '[clear-detect]'),
        [`info [clear-detect] new=${NEW} tag=${tag.slice(0, 8)} not followed: no live terminal has this tag`], what);
      assert.deepEqual(h.waiting(), [], what);
    });
  }
});

test("detector: note with B's tag and no old id", async (t) => {
  for (const [what, change] of [
    ['cleared_from null', (n) => n],
    ['no cleared_from field', (n) => { delete n.cleared_from; return n; }],
    ['no cleared_from and no prior field', (n) => { delete n.cleared_from; delete n.prior; return n; }],
  ]) {
    await t.test(`${what}: the tag is enough`, () => {
      const { h, b } = oneTerminal();
      h.write(NEW, clearHead(NEW));
      h.notes.set(NEW, change(note(NEW, TAG_B, null)));
      h.pass();
      assert.equal(h.sessions.get(NEW), b, what);
      assert.deepEqual(b.priorIds, [LIVE_B], what);
    });
  }
});

test("detector: note with B's tag whose old id is another terminal's id or an unknown id, and no prior list", async (t) => {
  for (const [what, clearedFrom] of [["another terminal's id", LIVE], ['an unknown id', OTHER]]) {
    await t.test(`${what}: nobody moves, one warning`, () => {
      const h = clearBoot();
      h.write(LIVE, [userLine(LIVE)]);
      h.write(LIVE_B, [userLine(LIVE_B)]);
      const a = h.session(LIVE, { hostToken: TAG_A });
      const b = h.session(LIVE_B, { hostToken: TAG_B });
      h.write(NEW, clearHead(NEW));
      h.notes.set(NEW, note(NEW, TAG_B, clearedFrom));
      h.pass();
      h.pass();
      assert.equal(h.sessions.get(LIVE), a, what);
      assert.equal(h.sessions.get(LIVE_B), b, what);
      assert.deepEqual(h.calls, [], what);
      assert.deepEqual(h.lines('warn', '[clear-detect]'),
        [`warn [clear-detect] new=${NEW} tag=bbbbbbbb not followed: old id does not lead back to this terminal`], what);
      assert.deepEqual(h.lines('info', '[clear-detect]'), [], what);
      assert.deepEqual(h.waiting(), [], what);
    });
  }
});

test("detector: a missed clear, then a second one whose note lists the terminal's key under prior; and the same through an older note of the same tag", async (t) => {
  await t.test('through the prior list', () => {
    const { h, b } = oneTerminal({ realSessionId: LIVE_B, priorIds: [OLDER] });
    h.write(NEW, clearHead(NEW));
    h.pass();              // the first clear: its start step was cut off, no note ever
    h.advance(60000);      // dropped
    h.write(NEW2, clearHead(NEW2));
    h.notes.set(NEW2, note(NEW2, TAG_B, NEW, { prior: [LIVE_B] }));
    h.pass();
    assert.equal(h.sessions.get(NEW2), b);
    assert.deepEqual(b.priorIds, [OLDER, NEW, LIVE_B], 'the missed id goes in before the old key, which stays the newest earlier id');
    assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW2, { clearedAtMs: TS * 1000 }));
  });

  await t.test('through an older note of the same tag', () => {
    const h = clearBoot();
    h.write(LIVE_B, [userLine(LIVE_B)]);
    h.write(NEW, clearHead(NEW));   // there before the terminal's list was taken: never looked at as new
    const b = h.session(LIVE_B, { hostToken: TAG_B });
    h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
    h.write(NEW2, clearHead(NEW2));
    h.notes.set(NEW2, note(NEW2, TAG_B, NEW));
    h.pass();
    assert.equal(h.sessions.get(NEW2), b);
    assert.deepEqual(b.priorIds, [NEW, LIVE_B]);
    assert.deepEqual(h.noteReads, [NEW2, NEW], 'the older note is read once, for the hop');
  });

  await t.test('an older note with another tag does not count', () => {
    const { h, b } = oneTerminal();
    h.notes.set(NEW, note(NEW, TAG_C, LIVE_B));
    h.write(NEW2, clearHead(NEW2));
    h.notes.set(NEW2, note(NEW2, TAG_B, NEW));
    h.pass();
    assert.equal(h.sessions.get(LIVE_B), b);
    assert.equal(h.lines('warn', '[clear-detect]').length, 1);
  });
});

test('detector: two clears from one terminal in one pass, both file orders', async (t) => {
  for (const [first, second] of [[NEW, NEW2], [NEW2, NEW]]) {
    await t.test(`the older clear is ${first === NEW ? 'listed first' : 'listed last'}: one re-key, to the newest`, () => {
      const { h, b } = oneTerminal();
      h.write(first, clearHead(first));
      h.write(second, clearHead(second));
      h.notes.set(first, note(first, TAG_B, LIVE_B, { ts: TS }));
      h.notes.set(second, note(second, TAG_B, first, { ts: TS + 2 }));
      h.pass();
      assert.deepEqual([...h.sessions.keys()], [second]);
      assert.equal(h.sessions.get(second), b);
      assert.deepEqual(b.priorIds, [first, LIVE_B]);
      assert.deepEqual(h.calls, moveCalls(LIVE_B, second, { clearedAtMs: (TS + 2) * 1000 }));
      h.pass();
      h.advance(4000);
      assert.equal(h.calls.filter((call) => call[0] === 'sendToOwner').length, 1, 'and it never goes back to the older one');
    });
  }
});

test('detector: two terminals clear in the same pass', () => {
  const h = clearBoot();
  h.write(LIVE, [userLine(LIVE)]);
  h.write(LIVE_B, [userLine(LIVE_B)]);
  const a = h.session(LIVE, { hostToken: TAG_A });
  const b = h.session(LIVE_B, { hostToken: TAG_B });
  h.write(NEW, clearHead(NEW));
  h.write(NEW2, clearHead(NEW2));
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));   // the first file listed belongs to the second terminal
  h.notes.set(NEW2, note(NEW2, TAG_A, LIVE));
  h.pass();
  assert.equal(h.sessions.get(NEW), b);
  assert.equal(h.sessions.get(NEW2), a);
  assert.deepEqual([...h.sessions.keys()].sort(), [NEW, NEW2]);
  assert.equal(h.calls.filter((call) => call[0] === 'sendToOwner').length, 2);
});

test("detector: malformed note, wrong session_id, source 'startup', tag not a UUID, ts not a number", async (t) => {
  for (const [what, bad] of [
    ['a string', 'not a note'],
    ['an array', [1]],
    ['v 2', note(NEW, TAG_B, LIVE_B, { v: 2 })],
    ['the session_id of another file', note(NEW, TAG_B, LIVE_B, { session_id: NEW2 })],
    ["source 'startup'", note(NEW, TAG_B, LIVE_B, { source: 'startup' })],
    ['a tag that is not a UUID', note(NEW, TAG_B, LIVE_B, { host_token: 'bbbbbbbb' })],
    ['no tag', note(NEW, TAG_B, LIVE_B, { host_token: undefined })],
    ['ts as text', note(NEW, TAG_B, LIVE_B, { ts: String(TS) })],
    ['ts NaN', note(NEW, TAG_B, LIVE_B, { ts: NaN })],
  ]) {
    await t.test(`${what}: treated as no note, the file waits`, () => {
      const { h, b } = oneTerminal();
      h.write(NEW, clearHead(NEW));
      h.notes.set(NEW, bad);
      h.pass();
      assert.equal(h.sessions.get(LIVE_B), b, what);
      assert.deepEqual(h.calls, [], what);
      assert.deepEqual(h.waiting(), [2000], what);
      assert.deepEqual(h.lines('info', '[clear-detect]').concat(h.lines('warn', '[clear-detect]')), [], what);
    });
  }
});

test("detector: a new terminal's own first transcript is not held for a note and not logged", () => {
  const { h } = oneTerminal();
  const c = h.session(NEW, { hostToken: TAG_C });   // started under NEW; its transcript is not there yet
  h.write(NEW, [userLine(NEW)]);
  h.pass();
  assert.equal(h.sessions.get(NEW), c);
  assert.deepEqual(h.noteReads, []);
  assert.deepEqual(h.waiting(), [], 'no timer for a file that is a live terminal\'s own');
  assert.deepEqual(h.lines('info', '[clear-detect]'), []);
});

test('detector: a note that lands 59 s after the first look is still followed at the look at 60 s', () => {
  const { h, b } = oneTerminal();
  h.write(NEW, clearHead(NEW));
  h.pass();
  h.advance(58000);
  h.notes.set(NEW, note(NEW, TAG_B, LIVE_B, { ts: NOW / 1000 + 59 }));
  h.advance(2000);
  assert.equal(h.sessions.get(NEW), b);
  assert.deepEqual(h.lines('info', '[clear-detect]'),
    [`info [clear-detect] new=${NEW} tag=bbbbbbbb followed: old=${LIVE_B} look=recheck afterMs=1000`]);
  assert.deepEqual(h.waiting(), []);
});

test('detector: a transcript that stays new for several passes is looked at once and logged once; an empty transcript with a valid note is followed at once', () => {
  const settled = oneTerminal();
  settled.h.write(NEW, '');   // empty: the fork rules hold it back, so it is new again on every pass
  settled.h.notes.set(NEW, note(NEW, TAG_E, null));
  settled.h.pass();
  settled.h.pass();
  settled.h.pass();
  assert.equal(knows(settled.b, NEW), false, 'held back as an empty file, as today');
  assert.deepEqual(settled.h.noteReads, [NEW]);
  assert.equal(settled.h.lines('info', '[clear-detect]').length, 1);
  assert.deepEqual(settled.h.waiting(), []);

  const followed = oneTerminal();
  followed.h.write(NEW, '');
  followed.h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
  followed.h.pass();
  assert.equal(followed.h.sessions.get(NEW), followed.b, 'the tag decides; the transcript need not have a line yet');
});

test('detector: two notes that name each other as the old id end the walk and move nobody', () => {
  const { h, b } = oneTerminal();
  h.write(NEW, clearHead(NEW));
  h.write(NEW2, clearHead(NEW2));
  h.notes.set(NEW, note(NEW, TAG_B, NEW2));
  h.notes.set(NEW2, note(NEW2, TAG_B, NEW));
  h.pass();
  assert.equal(h.sessions.get(LIVE_B), b);
  assert.deepEqual(h.calls, []);
  assert.equal(h.lines('warn', '[clear-detect]').length, 2, 'one warning for each file');
  assert.deepEqual(h.waiting(), []);
});

test('detector: a tagged terminal that accepts a plan or forks moves in that pass as before; its new transcript gets no clear line and the one re-check stops by itself', async (t) => {
  for (const [what, oldLines, oldAgeMs, newLines] of [
    ['a plan-accept', planTail(SLUG), 28 * SECOND, [userLine(NEW, { slug: SLUG, planContent: '# Do it' })]],
    ['a fork', [userLine(LIVE)], 0, forkOf(LIVE, NEW)],
  ]) {
    await t.test(what, () => {
      const h = clearBoot();
      h.write(LIVE, oldLines, oldAgeMs);
      const a = h.session(LIVE, { hostToken: TAG_A });
      h.write(NEW, newLines);
      h.pass();
      assert.equal(h.sessions.get(NEW), a, what);
      assert.deepEqual(h.calls, moveCalls(LIVE, NEW), what + ': two arguments on the send, no star carry');
      assert.deepEqual(h.noteReads, [NEW], what + ': the clear pass looked at the file first and found no note');
      assert.deepEqual(h.waiting(), [2000], what + ': so one re-check was armed before the old rule took the file');
      h.advance(2000);
      assert.deepEqual(h.waiting(), [], what + ": by then the file is the terminal's own key: forgotten, and the timer stops");
      assert.deepEqual(h.noteReads, [NEW], what + ': the note is not asked for again');
      assert.deepEqual(h.calls, moveCalls(LIVE, NEW), what + ': no further call');
      assert.deepEqual(h.lines('info', '[clear-detect]').concat(h.lines('warn', '')), [], what);
    });
  }
});

test('detector: the tagged terminal ends, or leaves the list, while its cleared transcript waits for its note: nobody moves, and a note that lands afterwards moves nothing', async (t) => {
  for (const [what, gone] of [
    ['the terminal has ended', (h, b) => { b.exited = true; }],
    ['the terminal has left the list', (h) => { h.sessions.delete(LIVE_B); }],
  ]) {
    await t.test(`${what}, alone in its folder: the re-check stops and no line is written`, () => {
      const { h, b } = oneTerminal();
      h.write(NEW, clearHead(NEW));
      h.pass();
      assert.deepEqual(h.waiting(), [2000], what + ': the file waits for its note');
      gone(h, b);
      assert.doesNotThrow(() => h.advance(2000), what);
      assert.deepEqual(h.waiting(), [], what + ': no eligible terminal is left in the folder, so the timer stops');
      h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
      assert.doesNotThrow(() => { h.pass(); h.advance(10000); }, what);
      assert.equal(b.realSessionId, undefined, what);
      assert.equal(h.sessions.has(NEW), false, what + ': nobody is stored under the new id');
      assert.deepEqual(h.calls, [], what);
      assert.deepEqual(h.waiting(), [], what);
      assert.deepEqual(h.lines('info', '[clear-detect]').concat(h.lines('warn', '')), [], what);
    });
  }

  await t.test('the terminal has ended and another tagged terminal runs in the folder: the late note ends the file with one line', () => {
    const h = clearBoot();
    h.write(LIVE, [userLine(LIVE)]);
    h.write(LIVE_B, [userLine(LIVE_B)]);
    const watcher = h.session(LIVE, { hostToken: TAG_A });
    const b = h.session(LIVE_B, { hostToken: TAG_B });
    h.write(NEW, clearHead(NEW));
    h.pass();
    assert.deepEqual(h.waiting(), [2000]);
    b.exited = true;
    h.advance(2000);
    assert.deepEqual(h.waiting(), [2000], 'the file still waits: the other terminal keeps the folder looked at');
    h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
    h.advance(2000);
    assert.equal(h.sessions.get(LIVE_B), b);
    assert.equal(b.realSessionId, undefined);
    assert.equal(h.sessions.get(LIVE), watcher);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.lines('info', '[clear-detect]'),
      [`info [clear-detect] new=${NEW} tag=bbbbbbbb not followed: no live terminal has this tag`]);
    assert.deepEqual(h.lines('warn', ''), []);
    assert.deepEqual(h.waiting(), [], 'the file has its outcome: the timer stops');
  });
});

test('detector: a second /clear from the same terminal while the first cleared transcript still waits for its note', () => {
  const { h, b } = oneTerminal();
  h.write(NEW, clearHead(NEW));
  h.pass();            // the first clear: no note yet, the file waits
  h.advance(10000);
  assert.deepEqual(h.waiting(), [2000], 'still waiting, 10 s in');
  h.write(NEW2, clearHead(NEW2));
  h.notes.set(NEW2, note(NEW2, TAG_B, NEW, { prior: [LIVE_B], ts: NOW / 1000 + 9 }));
  h.pass();
  assert.deepEqual([...h.sessions.keys()], [NEW2], 'one re-key, to the newest id');
  assert.equal(h.sessions.get(NEW2), b);
  assert.deepEqual(b.priorIds, [NEW, LIVE_B], 'the id that still waited goes in before the old key');
  assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW2, { clearedAtMs: NOW + 9000 }));
  h.advance(60000);
  assert.deepEqual(h.lines('info', '[clear-detect]'),
    [`info [clear-detect] new=${NEW2} tag=bbbbbbbb followed: old=${LIVE_B} look=first afterMs=1000`],
    'the first file is an earlier id of a live terminal now: forgotten, with no "not followed" line');
  assert.deepEqual(h.lines('warn', ''), []);
  assert.deepEqual(h.waiting(), [], 'and the timer stops');
  assert.equal(h.calls.filter((call) => call[0] === 'sendToOwner').length, 1);
});

test("detector: a clear's missed id that another terminal holds does not become an earlier id of the terminal that moved on; forgetPriorId still takes an id out of the list rekey() wrote", async (t) => {
  for (const [what, makeHolder, holderKey] of [
    ['its key', (h) => h.session(NEW), NEW],
    ['an earlier id', (h) => h.session(LIVE_C, { realSessionId: LIVE_C, priorIds: [NEW] }), LIVE_C],
  ]) {
    await t.test(`the missed id is another terminal's, as ${what}: the clear is followed and the id is left out`, () => {
      // B's first /clear (to NEW) was missed: no note ever. NEW was then opened again in a second terminal.
      const { h, b } = oneTerminal({ realSessionId: LIVE_B, priorIds: [OLDER] });
      const holder = makeHolder(h);
      h.write(NEW2, clearHead(NEW2));
      h.notes.set(NEW2, note(NEW2, TAG_B, NEW, { prior: [LIVE_B] }));
      h.pass();
      assert.equal(h.sessions.get(NEW2), b, what + ': the clear is followed');
      assert.equal(h.sessions.get(holderKey), holder, what + ': the other terminal is not touched');
      assert.deepEqual(b.priorIds, [OLDER, LIVE_B], what + ': NEW belongs to the other terminal, so it is no earlier id of this one');
      assert.deepEqual(h.calls, moveCalls(LIVE_B, NEW2, { clearedAtMs: TS * 1000 }), what);
      assert.deepEqual(h.lines('warn', ''), [], what);
      // Task 04's rule itself still works on the list rekey() wrote.
      transitions.forgetPriorId(LIVE_B);
      assert.deepEqual(b.priorIds, [OLDER], what);
    });
  }
});

test('resolveInputSession table', () => {
  const sessions = new Map();
  transitions.init({ activeSessions: sessions });   // as the pty harness does: nothing else is needed, nothing throws
  const T = NOW;
  const moved = { exited: false, realSessionId: 'now', priorIds: ['first', 'before'], rekeyedAtMs: T - 4000 };
  sessions.set('now', moved);
  const at = (id, nowMs = T) => transitions.resolveInputSession(id, nowMs);

  assert.deepEqual(Object.keys(at('now')), ['id', 'session']);
  assert.equal(at('now').id, 'now');
  assert.equal(at('now').session, moved, 'the exact key');
  assert.equal(at('before').id, 'now', 'the newest earlier id, 4 s after the move: the live id is answered');
  assert.equal(at('before').session, moved);
  assert.equal(at('before', moved.rekeyedAtMs + 5000).session, moved, 'exactly 5 s: still followed');
  assert.equal(at('before', moved.rekeyedAtMs + 5001), null, 'one ms more: not followed');
  assert.equal(at('first'), null, 'an older earlier id is never followed');
  assert.equal(at('nobody'), null);
  for (const bad of [undefined, null, '', 7]) assert.equal(at(bad), null, 'not an id: ' + String(bad));

  // A record that was moved by something that did not stamp it is not followed.
  sessions.set('unstamped', { exited: false, realSessionId: 'unstamped', priorIds: ['was'] });
  assert.equal(at('was'), null);
  // A record with an empty list of earlier ids is not found by a missing id.
  sessions.set('fresh', { exited: false, priorIds: [], rekeyedAtMs: T });
  assert.equal(at(undefined), null);

  // The exact key always wins: another record stored under the earlier id.
  const resumed = { exited: false };
  sessions.set('before', resumed);
  assert.equal(at('before').session, resumed);
  assert.equal(at('before').id, 'before');
  sessions.delete('before');

  // A moved record that has ended is not followed; under its own key it is answered as it is.
  moved.exited = true;
  assert.equal(at('before'), null);
  assert.equal(at('now').session, moved);
});

test('session-transitions: the file says that a change to it needs an app restart, and names the other lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'session-transitions.js'), 'utf8');
  assert.ok(source.slice(0, 600).includes('a change here needs an app restart'));
  assert.match(source, /resolveLiveSession/);
});

// --- the handoff switch: the hook's opt-out marker follows a re-key (copyHandoffOff) ---

/**
 * The context clearBoot() hands init(), plus a recorder for copyHandoffOff: `calls` holds it with every
 * other call of a move, in the order made. init() is called once, here: one handoffOffBoot at a time.
 */
function handoffOffBoot() {
  const h = boot();
  const notes = new Map();     // transcript id -> what readClearOrigin answers for it
  const calls = [];            // [name, ...args] of every call of a move
  const throwing = new Set();  // names of follow-ups that throw when called
  const clock = { now: NOW };
  let timers = [];
  let seq = 0;
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args) => { h.logLines.push(level + ' ' + args.join(' ')); };
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const followUp = (name) => (...args) => { calls.push([name, ...args]); if (throwing.has(name)) throw new Error(name + ' failed'); };
  transitions.init({
    PROJECTS_DIR: path.dirname(h.dir), activeSessions: h.sessions, log,
    rekeyMcpServer: record('rekeyMcpServer'),
    rekeyOwner: (oldId, newId) => {
      calls.push(['rekeyOwner', oldId, newId]);
      if (h.owners.has(oldId)) { h.owners.set(newId, h.owners.get(oldId)); h.owners.delete(oldId); }
    },
    sendToOwner: record('sendToOwner'),
    copySessionAssignment: followUp('copySessionAssignment'), rekeyPlanLinks: followUp('rekeyPlanLinks'),
    rekeyScheduleSession: followUp('rekeyScheduleSession'), copyStar: followUp('copyStar'),
    copyHandoffOff: followUp('copyHandoffOff'),
    broadcast: record('broadcast'),
    ownerId: (id) => (h.owners.has(id) ? h.owners.get(id) : null),
    readClearOrigin: (id) => (notes.has(id) ? notes.get(id) : null),
    now: () => clock.now,
    setTimer: (fn, ms) => { const timer = { id: ++seq, fn, at: clock.now + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timers = timers.filter((t) => t !== timer); },
  });
  return {
    ...h, notes, calls, throwing,
    /** One pass over the folder at the clock's time. init() is NOT called again. */
    pass(folder = FOLDER) {
      const realNow = Date.now;
      Date.now = () => clock.now;
      try { transitions.detectSessionTransitions(folder); } finally { Date.now = realNow; }
    },
    /** The log lines of one level that hold `part`. */
    lines: (level, part) => h.logLines.filter((l) => l.startsWith(level + ' ') && l.includes(part)),
  };
}

/** moveCalls() with the copyHandoffOff call where rekey() makes it: after the other follow-ups, directly before the send. */
const moveCallsWithHandoffOff = (oldId, newId, options) => {
  const calls = moveCalls(oldId, newId, options);
  calls.splice(calls.findIndex(([name]) => name === 'sendToOwner'), 0, ['copyHandoffOff', oldId, newId]);
  return calls;
};

test('detector: copyHandoffOff is called once with the old and the new id on a fork, a plan-accept and a clear, after the other follow-ups and before the send', async (t) => {
  await t.test('copyHandoffOff on a fork: once, after the three follow-ups and directly before the send', () => {
    const h = handoffOffBoot();
    h.write(LIVE, [userLine(LIVE)]);
    const a = h.session(LIVE);
    h.write(NEW, forkOf(LIVE, NEW));
    h.pass();
    assert.equal(h.sessions.get(NEW), a);
    assert.deepEqual(h.calls.filter(([name]) => name === 'copyHandoffOff'), [['copyHandoffOff', LIVE, NEW]]);
    assert.deepEqual(h.calls, moveCallsWithHandoffOff(LIVE, NEW));
    assert.deepEqual(h.lines('info', '[session-transition]'), [`info [session-transition] ${LIVE} → ${NEW} (fork)`]);
  });

  await t.test('copyHandoffOff on a plan-accept: once, after the three follow-ups and directly before the send', () => {
    const h = handoffOffBoot();
    h.write(LIVE, planTail(SLUG), 28 * SECOND);
    const a = h.session(LIVE);
    h.write(NEW, [userLine(NEW, { slug: SLUG, planContent: '# Do it' })]);
    h.pass();
    assert.equal(h.sessions.get(NEW), a);
    assert.deepEqual(h.calls.filter(([name]) => name === 'copyHandoffOff'), [['copyHandoffOff', LIVE, NEW]]);
    assert.deepEqual(h.calls, moveCallsWithHandoffOff(LIVE, NEW));
    assert.deepEqual(h.lines('info', '[session-transition]'), [`info [session-transition] ${LIVE} → ${NEW} (plan-accept)`]);
  });

  await t.test('copyHandoffOff on a clear: once, after the star carry and directly before the send', () => {
    const h = handoffOffBoot();
    h.write(LIVE_B, [userLine(LIVE_B)]);
    const b = h.session(LIVE_B, { hostToken: TAG_B });
    h.write(NEW, clearHead(NEW));
    h.notes.set(NEW, note(NEW, TAG_B, LIVE_B));
    h.pass();
    assert.equal(h.sessions.get(NEW), b);
    assert.deepEqual(h.calls.filter(([name]) => name === 'copyHandoffOff'), [['copyHandoffOff', LIVE_B, NEW]]);
    assert.deepEqual(h.calls, moveCallsWithHandoffOff(LIVE_B, NEW, { clearedAtMs: TS * 1000 }));
    assert.deepEqual(h.lines('info', '[session-transition]'), [`info [session-transition] ${LIVE_B} → ${NEW} (clear)`]);
  });
});

test('detector: a copyHandoffOff that throws stops nothing and is logged once', () => {
  const h = handoffOffBoot();
  h.write(LIVE, [userLine(LIVE)]);
  const a = h.session(LIVE);
  h.owners.set(LIVE, 7);
  h.throwing.add('copyHandoffOff');
  h.write(NEW, forkOf(LIVE, NEW));
  assert.doesNotThrow(() => h.pass());
  assert.deepEqual(h.calls.filter(([name]) => name === 'copyHandoffOff'), [['copyHandoffOff', LIVE, NEW]]);
  assert.equal(h.sessions.get(NEW), a);
  assert.deepEqual(h.calls, moveCallsWithHandoffOff(LIVE, NEW, { windowId: 7 }), 'the send and both broadcasts still follow');
  assert.deepEqual(h.lines('warn', 'follow-up failed'),
    [`warn [session-transition] follow-up failed name=copyHandoffOff old=${LIVE} new=${NEW} error=copyHandoffOff failed`]);
});
