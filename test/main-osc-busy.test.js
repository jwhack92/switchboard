'use strict';
// Pin tests: what main.js makes of the signals a session writes to its
// terminal. A spinner title means working, a title starting U+2733 means
// finished, an OSC 9;4 progress report of level 1 to 3 means working, and any
// other OSC 9 text is a notification for the window that shows the session.
// The schedule runner asks isSessionBusy for the flag these signals keep.
//
// main.js cannot be loaded in a test, so the two blocks are cut out of its
// text by their markers (test-support/source-cut.js) and run in a vm against
// fakes. The first block is part of the body of the PTY output callback, so it
// is run here as the body of a function, called once per chunk of output. What
// a title means is asked of the real harnesses module, as main.js does
// (main.js: claudeHarness).
//
// Plain node. No timers, no files but the sources, no waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const { cut, load } = require('../test-support/source-cut');
const harnesses = require('../harnesses');

// The markers are the first words of the comment that opens the block and of
// the comment after it, the two the design names. The rest of either line may
// be reworded without moving the cut.
const OSC_START = '// Parse OSC sequences';
const OSC_END = '// Standalone BEL';
const OSC_BLOCK = cut('main.js', OSC_START, OSC_END);
// The first lines of the output callback, above the block. One of them works
// out which id the session has now; the block sends every event under it.
const CALLBACK_HEAD = cut('main.js', 'ptyProcess.onData(data => {', OSC_START);
const CURRENT_ID_STATEMENTS = CALLBACK_HEAD.match(/^[ \t]*const currentId = [^;\r\n]+;[ \t]*$/gm) || [];
if (CURRENT_ID_STATEMENTS.length !== 1) {
  throw new Error(`main-osc-busy: wanted one "const currentId = ...;" statement between the start of the output callback and the OSC block, found ${CURRENT_ID_STATEMENTS.length}`);
}
const CURRENT_ID_STATEMENT = CURRENT_ID_STATEMENTS[0];
// The function and the comment block after it; the cut stops before the next function.
const BUSY_BLOCK = cut('main.js', 'function isSessionBusy(sessionId) {', 'function scheduleHostWindow() {');

// --- What a session writes ---

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\';
const osc = (code, text, end = BEL) => `${ESC}]${code};${text}${end}`;
const title = (text, end) => osc(0, text, end);
const osc9 = (text, end) => osc(9, text, end);
/** An OSC 9;4 progress report: progress(1, ';40') is "running at 40%", progress(0, ';') is "done". */
const progress = (level, rest = '', end) => osc9(`4;${level}${rest}`, end);

// Claude's spinner frames: braille through 2.1.227, the half-circles from 2.1.228.
const BRAILLE = ['\u2802', '\u2810', '\u2839', '\u2800', '\u28FF'];
const HALF_CIRCLES = ['\u25D0', '\u25D1', '\u25D2', '\u25D3'];
const FRAMES = [...BRAILLE, ...HALF_CIRCLES];
const SPIN = HALF_CIRCLES[0];
const IDLE = '\u2733';
const working = (end) => title(`${SPIN} Fix the build`, end);
const finished = (end) => title(`${IDLE} Fix the build`, end);

// --- The fakes ---

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/** A session record with the fields main.js gives a new one. `ptyGate` is the crash guard's; nothing here reads it. */
function sessionRecord(extra = {}) {
  return {
    pty: {}, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    isPlainTerminal: false, ptyGate: { hasOutput: true },
    ...extra,
  };
}

/**
 * One terminal: the id it was started under, its session record, and the
 * events the block sent for it.
 */
function boot({ startId = 'sess-1', session = {} } = {}) {
  return { startId, session: sessionRecord(session), events: [] };
}

/**
 * The id the events of a terminal are EXPECTED under: the id its record
 * carries after a re-key, else the id it was started under. Worked out here,
 * apart from the shipped statement, which is what the assertions check.
 */
const liveId = (h) => h.session.realSessionId || h.startId;

// The block, as the body of a function with the names the callback has in
// reach: its argument `data`, and `session` and `sessionId` of the code around
// it. `currentId` is set by the callback's own statement, taken from main.js
// as it ships. The names the block takes from the top of main.js are globals.
let reading = null; // the terminal whose chunk is being read
const OSC = load(`function readChunk(data, session, sessionId) {\n${CURRENT_ID_STATEMENT}\n${OSC_BLOCK}\n}`, {
  file: 'main.js',
  globals: {
    // Every name main.js can take off require('./harnesses'), and the harness
    // object it keeps.
    ...harnesses,
    claudeHarness: harnesses.getHarness(harnesses.DEFAULT_HARNESS),
    log: SILENT_LOG,
    registry: {
      // (ownerKey, channel, ...args): only the fields the page reads are kept.
      sendToOwner(ownerKey, channel, id, value) {
        reading.events.push({ to: ownerKey, channel, id, value });
        return true;
      },
    },
  },
});

/** Hands each chunk to the cut block, as one call of the output callback each. */
function feed(h, ...chunks) {
  for (const data of chunks) {
    reading = h;
    try { OSC.readChunk(data, h.session, h.startId); } finally { reading = null; }
  }
  return h;
}

/** The busy and idle events so far: true for 'working', false for 'finished'. */
const busyEvents = (h) => h.events.filter((e) => e.channel === 'cli-busy-state').map((e) => e.value);
/** The notification texts so far. */
const notices = (h) => h.events.filter((e) => e.channel === 'terminal-notification').map((e) => e.value);

/** Every event went to the owner of the session's present id, and names that id. */
function assertAddressed(h, id = liveId(h)) {
  for (const e of h.events) {
    assert.equal(e.to, id, `${e.channel}: sent to the owner of ${e.to}`);
    assert.equal(e.id, id, `${e.channel}: names session ${e.id}`);
  }
}

/** Only busy/idle events and notifications ever leave this block. */
function assertOnlyKnownChannels(h) {
  for (const e of h.events) assert.ok(e.channel === 'cli-busy-state' || e.channel === 'terminal-notification', e.channel);
}

function bootBusy(entries) {
  const ctx = load(BUSY_BLOCK, { file: 'main.js', globals: { activeSessions: new Map(entries) } });
  assert.equal(typeof ctx.isSessionBusy, 'function');
  return ctx.isSessionBusy;
}

/** A full session id, as the log must show it. */
const FULL_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** Runs fn and returns every debug and info line the block wrote meanwhile, in order. */
function logged(fn) {
  const lines = [];
  const { debug, info } = SILENT_LOG;
  SILENT_LOG.debug = (line) => { lines.push(String(line)); };
  SILENT_LOG.info = (line) => { lines.push(String(line)); };
  try { fn(); } finally { SILENT_LOG.debug = debug; SILENT_LOG.info = info; }
  return lines;
}
const titleLines = (lines) => lines.filter((line) => line.startsWith('[OSC 0] ') && line.includes(' char='));

/**
 * The same block once more, with stand-ins for the two rules of harnesses/index.js,
 * to show that main.js asks the rules and keeps no copy of them.
 */
function bootWithRules(rules) {
  const sink = { events: [], lines: [] };
  const record = (line) => { sink.lines.push(String(line)); };
  const ctx = load(`function readChunk(data, session, sessionId) {\n${CURRENT_ID_STATEMENT}\n${OSC_BLOCK}\n}`, {
    file: 'main.js',
    globals: {
      ...harnesses,
      ...rules,
      claudeHarness: harnesses.getHarness(harnesses.DEFAULT_HARNESS),
      log: { debug: record, info: record, warn() {}, error() {} },
      registry: { sendToOwner(ownerKey, channel, id, value) { sink.events.push({ to: ownerKey, channel, id, value }); return true; } },
    },
  });
  const session = sessionRecord();
  return { ...sink, session, feed(...chunks) { for (const data of chunks) ctx.readChunk(data, session, FULL_ID); } };
}

// --- Pin 11 ---

test("main osc busy (pin): a spinner title gives one busy event and an idle title one idle event; progress 0 never marks idle; other OSC 9 text is passed on; a plain terminal never 'finishes'", async (t) => {
  await t.test('a spinner title gives one busy event, and further spinner titles give no more', () => {
    const h = boot();
    assert.ok(!h.session._cliBusy, 'a new session is not busy');
    feed(h, working());
    assert.deepEqual(busyEvents(h), [true]);
    assert.equal(h.session._cliBusy, true);
    assert.equal(h.session._titleBusy, true);

    // The spinner turns: every frame, both ways of ending the sequence, one
    // chunk each and many in one chunk.
    for (const frame of FRAMES) feed(h, title(`${frame} Fix the build`), title(`${frame} Fix the build`, ST));
    feed(h, FRAMES.map((frame) => title(`${frame} Fix the build`)).join('some output between'));
    assert.deepEqual(busyEvents(h), [true], 'still the one event');
    assert.equal(h.events.length, 1);
    assert.equal(h.session._cliBusy, true);
    assertAddressed(h);

    // Each frame starts 'working' on its own, old braille and new half-circles.
    for (const frame of FRAMES) {
      for (const end of [BEL, ST]) {
        const one = boot();
        feed(one, 'text before' + title(`${frame} Reading files`, end) + 'text after');
        assert.deepEqual(one.events, [{ to: 'sess-1', channel: 'cli-busy-state', id: 'sess-1', value: true }],
          `U+${frame.codePointAt(0).toString(16)} ended by ${end === BEL ? 'BEL' : 'ST'}`);
        assert.equal(one.session._cliBusy, true);
      }
    }
  });

  await t.test('an idle title gives one idle event, and only when the session was working', () => {
    const h = boot();
    feed(h, working(), finished());
    assert.deepEqual(busyEvents(h), [true, false]);
    assert.equal(h.session._cliBusy, false);
    assert.equal(h.session._titleBusy, false);

    // The idle title again, in any form: nothing more.
    feed(h, finished(), title(`${IDLE} Another name`, ST), finished() + finished());
    assert.deepEqual(busyEvents(h), [true, false], 'still the one idle event');

    // The next turn: one of each again.
    feed(h, title(`${HALF_CIRCLES[1]} Fix the build`), title(`${HALF_CIRCLES[2]} Fix the build`), title(`${BRAILLE[2]} Fix the build`), finished(ST));
    assert.deepEqual(busyEvents(h), [true, false, true, false]);
    assert.equal(h.events.length, 4, 'nothing else was sent');
    assertAddressed(h);

    // A whole turn in one chunk: both events, in the order written.
    const one = boot();
    feed(one, working() + 'the reply' + title(`${HALF_CIRCLES[3]} Fix the build`) + finished());
    assert.deepEqual(one.events, [
      { to: 'sess-1', channel: 'cli-busy-state', id: 'sess-1', value: true },
      { to: 'sess-1', channel: 'cli-busy-state', id: 'sess-1', value: false },
    ]);
    assert.equal(one.session._cliBusy, false);

    // An idle title with no 'working' before it ends nothing: no event.
    const fresh = boot();
    feed(fresh, title(`${IDLE} Claude Code`), title(`${IDLE} Claude Code`, ST));
    assert.equal(fresh.events.length, 0);
    assert.ok(!fresh.session._cliBusy);
    assert.equal(fresh.session._titleBusy, false, 'the title is remembered as saying idle');

    // An idle title ends a 'working' that came from a progress report as well.
    const byProgress = boot();
    feed(byProgress, progress(3, ';'), finished());
    assert.deepEqual(busyEvents(byProgress), [true, false]);
    assert.equal(byProgress.session._cliBusy, false);
  });

  await t.test('a title that says neither changes nothing, and what the last telling title said stays remembered', () => {
    // The mark has to be the very first character: a blank in front of it makes a plain title.
    const plainTitles = ['my-project', 'MINGW64:/c/Users/jhack', '', ' ', `Fix ${SPIN} the build`, `x${IDLE}`,
      ` ${SPIN} Fix the build`, ` ${IDLE} Fix the build`, `\t${BRAILLE[2]} Fix the build`];

    const never = boot();
    for (const text of plainTitles) feed(never, title(text), title(text, ST));
    assert.equal(never.events.length, 0);
    assert.ok(!never.session._cliBusy);
    assert.equal(never.session._titleBusy, undefined, 'no title has said busy or idle yet');

    const busy = boot();
    feed(busy, working());
    for (const text of plainTitles) feed(busy, title(text));
    assert.deepEqual(busyEvents(busy), [true]);
    assert.equal(busy.session._cliBusy, true, 'a plain title is not an idle title');
    assert.equal(busy.session._titleBusy, true);

    const idle = boot();
    feed(idle, working(), finished());
    for (const text of plainTitles) feed(idle, title(text));
    assert.deepEqual(busyEvents(idle), [true, false]);
    assert.equal(idle.session._cliBusy, false);
    assert.equal(idle.session._titleBusy, false);

    // Output with no OSC sequence in it, a lone bell included, is not a signal.
    const quiet = boot();
    feed(quiet, 'plain output\r\n', BEL, `${ESC}[2J${ESC}[?1049h`, `${SPIN} not a title`, `${IDLE} not a title`, '');
    assert.equal(quiet.events.length, 0);
    assert.ok(!quiet.session._cliBusy);
    assert.equal(quiet.session._titleBusy, undefined);

    // Neither a progress report nor a notification is a title.
    const other = boot();
    feed(other, progress(1, ';5'), progress(0, ';'), osc9('Claude Code needs your attention'));
    assert.equal(other.session._titleBusy, undefined);

    // Only OSC 0 is read as the title: the same text under another code is not.
    const codes = boot();
    for (const code of [1, 2, 7, 10]) feed(codes, osc(code, `${SPIN} Fix the build`), osc(code, `${IDLE} Fix the build`, ST));
    assert.equal(codes.events.length, 0);
    assert.ok(!codes.session._cliBusy);
    assert.equal(codes.session._titleBusy, undefined);
  });

  await t.test('progress 0 never marks idle', () => {
    for (const zero of [progress(0), progress(0, ';'), progress(0, ';0'), progress(0, ';', ST)]) {
      const shown = JSON.stringify(zero);

      // Working by its title.
      const byTitle = boot();
      feed(byTitle, working(), zero, zero);
      assert.deepEqual(busyEvents(byTitle), [true], shown);
      assert.equal(byTitle.session._cliBusy, true, shown);
      assert.equal(byTitle.session._titleBusy, true, shown);

      // Working by a progress report, no title ever.
      const byProgress = boot();
      feed(byProgress, progress(1, ';40'), zero, zero);
      assert.deepEqual(busyEvents(byProgress), [true], shown);
      assert.equal(byProgress.session._cliBusy, true, shown);

      // Start and end of the progress in one chunk.
      const oneChunk = boot();
      feed(oneChunk, progress(3, ';') + 'downloading' + zero);
      assert.deepEqual(busyEvents(oneChunk), [true], shown);
      assert.equal(oneChunk.session._cliBusy, true, shown);

      // Nothing was working: nothing is sent.
      const nothing = boot();
      feed(nothing, zero);
      assert.equal(nothing.events.length, 0, shown);
      assert.ok(!nothing.session._cliBusy, shown);

      // After a finished turn: no second 'finished'.
      const after = boot();
      feed(after, working(), finished(), zero);
      assert.deepEqual(busyEvents(after), [true, false], shown);

      for (const h of [byTitle, byProgress, oneChunk, nothing, after]) {
        assert.deepEqual(notices(h), [], 'a progress report is not passed on as a notification');
        assertOnlyKnownChannels(h);
        assertAddressed(h);
      }
    }
  });

  await t.test('a progress report changes nothing for a session its title already shows as working, and an unknown level changes nothing at all', () => {
    const h = boot();
    feed(h, working(), progress(3, ';'), progress(1, ';10'), progress(2, ';10'), working() + progress(1, ';90'));
    assert.deepEqual(busyEvents(h), [true], 'no second busy event');
    assert.equal(h.session._cliBusy, true);
    feed(h, finished());
    assert.deepEqual(busyEvents(h), [true, false], 'and the idle title still ends it');

    // The other way round: working by a progress report, then a spinner title.
    // No second event, and the title is remembered as saying busy all the same.
    const progressFirst = boot();
    feed(progressFirst, progress(1, ';5'));
    assert.equal(progressFirst.session._titleBusy, undefined);
    feed(progressFirst, working());
    assert.deepEqual(busyEvents(progressFirst), [true], 'no second busy event');
    assert.equal(progressFirst.session._cliBusy, true);
    assert.equal(progressFirst.session._titleBusy, true, 'the spinner title is remembered although it sent nothing');
    feed(progressFirst, finished());
    assert.deepEqual(busyEvents(progressFirst), [true, false]);
    assert.equal(progressFirst.session._titleBusy, false);

    // The level is compared as text: only '1', '2' and '3' count, not a number written another way.
    for (const level of ['4', '9', '', 'x', '10', '-1', '01', '1.0', ' 1', '1 ', '2.5', ' 3', '+2']) {
      const idle = boot();
      feed(idle, progress(level, ';50'), progress(level));
      assert.equal(idle.events.length, 0, `level ${JSON.stringify(level)}`);
      assert.ok(!idle.session._cliBusy, `level ${JSON.stringify(level)}`);

      const busy = boot();
      feed(busy, working(), progress(level, ';50'));
      assert.deepEqual(busyEvents(busy), [true], `level ${JSON.stringify(level)}`);
      assert.equal(busy.session._cliBusy, true, `level ${JSON.stringify(level)}`);
      assert.deepEqual(notices(busy), []);
    }
  });

  await t.test('other OSC 9 text is passed on to the owner as a notification, whole, and changes no busy state', () => {
    const attention = 'Claude Code needs your attention';
    const h = boot();
    feed(h, osc9(attention));
    assert.deepEqual(h.events, [{ to: 'sess-1', channel: 'terminal-notification', id: 'sess-1', value: attention }]);
    assert.ok(!h.session._cliBusy);

    // Ended by ST; two in one chunk, in the order written; again on a repeat.
    feed(h, osc9('Claude needs your permission to use Bash', ST));
    feed(h, osc9('Claude is waiting for your input') + 'output' + osc9(attention, ST));
    feed(h, osc9(attention));
    assert.deepEqual(notices(h), [
      attention,
      'Claude needs your permission to use Bash',
      'Claude is waiting for your input',
      attention,
      attention,
    ]);
    assert.deepEqual(busyEvents(h), []);
    assert.ok(!h.session._cliBusy);
    assertAddressed(h);

    // While working: passed on, and the session stays working.
    const busy = boot();
    feed(busy, working(), osc9(attention), osc9('Claude is waiting for your input'));
    assert.deepEqual(busyEvents(busy), [true]);
    assert.deepEqual(notices(busy), [attention, 'Claude is waiting for your input']);
    assert.equal(busy.session._cliBusy, true);

    // The text is not cut short, and text that only looks like progress is text.
    const long = 'Build finished: ' + 'x'.repeat(300);
    const texts = boot();
    feed(texts, osc9(long), osc9('40% done'), osc9('4 files changed'), osc9(''));
    assert.deepEqual(notices(texts), [long, '40% done', '4 files changed', '']);
    assert.deepEqual(busyEvents(texts), []);

    // Blanks at either end are part of the text; a blank before '4;' makes it text, not a progress report.
    const padded = '  Claude is waiting for your input  ';
    const blanks = boot();
    feed(blanks, osc9(padded), osc9(' 4;1;50'), osc9(padded, ST));
    assert.deepEqual(notices(blanks), [padded, ' 4;1;50', padded]);
    assert.deepEqual(busyEvents(blanks), []);
    assert.ok(!blanks.session._cliBusy);
    assertAddressed(blanks);

    // In one chunk the titles are read first, then the OSC 9 texts: the busy
    // event leaves before a notification written ahead of the title.
    const order = boot();
    feed(order, osc9(attention) + working());
    assert.deepEqual(order.events.map((e) => [e.channel, e.value]), [
      ['cli-busy-state', true],
      ['terminal-notification', attention],
    ]);
    for (const each of [busy, texts, order]) { assertOnlyKnownChannels(each); assertAddressed(each); }
  });

  await t.test("a plain terminal never 'finishes': progress can mark it working, and no progress report marks it idle", () => {
    // A shell and the programs run in it, showing plain titles only: no
    // spinner title and no idle title. (That it then stays 'working' is known
    // and left alone by the relaunch work.) A plain terminal whose title DOES
    // carry Claude's marks is the next subtest.
    const h = boot({ startId: 'term-1', session: { isPlainTerminal: true } });
    feed(h, 'PS C:\\Users\\jhack> ', title('MINGW64:/c/Users/jhack'), title('npm install', ST));
    assert.equal(h.events.length, 0);

    feed(h, progress(3, ';'));
    assert.deepEqual(h.events, [{ to: 'term-1', channel: 'cli-busy-state', id: 'term-1', value: true }]);

    feed(h, progress(1, ';10'), progress(1, ';55') + 'added 12 packages' + progress(1, ';100'), progress(0, ';'));
    feed(h, BEL, 'PS C:\\Users\\jhack> ', title('MINGW64:/c/Users/jhack'));
    // Download after download, an error state too, each ended by level 0.
    for (const level of [1, 2, 3, 1]) feed(h, progress(level, ';20'), 'output', progress(0, ';'), progress(0, ';', ST));
    feed(h, progress(2, ';') + progress(0, ';') + progress(1, ';1') + progress(0));

    assert.deepEqual(busyEvents(h), [true], 'one busy event and never an idle one');
    assert.equal(h.events.length, 1);
    assert.equal(h.session._cliBusy, true);
    assert.equal(h.session._titleBusy, undefined);
    assertAddressed(h, 'term-1');

    // Each level on its own, with no title before it or only plain ones.
    for (const level of [1, 2, 3]) {
      for (const before of [[], [title('my-project')]]) {
        const one = boot({ session: { isPlainTerminal: true } });
        feed(one, ...before, progress(level, ';30'), progress(0, ';'));
        assert.deepEqual(busyEvents(one), [true], `level ${level}`);
        assert.equal(one.session._cliBusy, true, `level ${level}`);
      }
    }
    // A new Claude session that has shown no telling title yet reads the same.
    for (const level of [1, 2, 3]) {
      const claude = boot();
      feed(claude, progress(level, ';'), progress(0, ';'));
      assert.deepEqual(busyEvents(claude), [true], `level ${level}`);
      assert.equal(claude.session._cliBusy, true, `level ${level}`);
    }
  });

  await t.test("today the block does not ask whether the terminal is plain: a plain terminal whose title carries Claude's marks goes working on a spinner title and 'finishes' on an idle title", () => {
    // Claude started by hand in a shell. Recorded as it is: the pin's words
    // "a plain terminal never 'finishes'" hold for progress reports and plain
    // titles, not for a title that starts with U+2733.
    const h = boot({ startId: 'term-1', session: { isPlainTerminal: true } });
    feed(h, working());
    assert.deepEqual(h.events, [{ to: 'term-1', channel: 'cli-busy-state', id: 'term-1', value: true }]);
    assert.equal(h.session._cliBusy, true);
    assert.equal(h.session._titleBusy, true);
    feed(h, title(`${BRAILLE[0]} Fix the build`), finished(), finished(ST));
    assert.deepEqual(busyEvents(h), [true, false], 'one idle event');
    assert.equal(h.events.length, 2);
    assert.equal(h.session._cliBusy, false);
    assert.equal(h.session._titleBusy, false);
    assertAddressed(h, 'term-1');

    // An idle title ends a 'working' that a progress report started, too.
    const byProgress = boot({ startId: 'term-2', session: { isPlainTerminal: true } });
    feed(byProgress, progress(1, ';10'), progress(0, ';'), finished());
    assert.deepEqual(busyEvents(byProgress), [true, false]);
    assert.equal(byProgress.session._cliBusy, false);
    assertAddressed(byProgress, 'term-2');

    // Signal for signal a plain terminal reads the same as a Claude session.
    for (const signals of [
      [working(), progress(2, ';'), osc9('Claude Code needs your attention'), finished(), title('my-project'), working() + finished()],
      [title('npm install'), progress(1, ';5'), progress(0, ';'), osc9('done'), progress(3, ';')],
      [title(`${IDLE} Claude Code`), working(), working(ST), finished(ST)],
    ]) {
      const plain = feed(boot({ session: { isPlainTerminal: true } }), ...signals);
      const claude = feed(boot(), ...signals);
      assert.ok(plain.events.length > 0);
      assert.deepEqual(plain.events, claude.events);
      assert.equal(plain.session._cliBusy, claude.session._cliBusy);
      assert.equal(plain.session._titleBusy, claude.session._titleBusy);
    }
  });

  await t.test('every event goes to the owner of the id the session has now', () => {
    // After a re-key the record carries its new id; the events follow it. It
    // carries what a re-key leaves too (the ids it had, what it was forked from,
    // when it moved), and none of that is an id to send to.
    const rekeyed = () => ({
      realSessionId: 'now-known-as', priorIds: ['started-as', 'second-id'], forkFrom: 'forked-from', rekeyedAtMs: Date.now(),
    });
    const h = boot({ startId: 'started-as', session: rekeyed() });
    feed(h, working(), osc9('Claude Code needs your attention'), finished());
    assert.deepEqual(h.events, [
      { to: 'now-known-as', channel: 'cli-busy-state', id: 'now-known-as', value: true },
      { to: 'now-known-as', channel: 'terminal-notification', id: 'now-known-as', value: 'Claude Code needs your attention' },
      { to: 'now-known-as', channel: 'cli-busy-state', id: 'now-known-as', value: false },
    ]);
    // A plain terminal's progress report too.
    const term = boot({ startId: 'started-as', session: { ...rekeyed(), isPlainTerminal: true } });
    feed(term, progress(2, ';'));
    assert.deepEqual(term.events, [{ to: 'now-known-as', channel: 'cli-busy-state', id: 'now-known-as', value: true }]);

    // Two terminals keep their own state.
    const a = boot({ startId: 'a' });
    const b = boot({ startId: 'b' });
    feed(a, working());
    feed(b, finished());
    assert.deepEqual(a.events, [{ to: 'a', channel: 'cli-busy-state', id: 'a', value: true }]);
    assert.equal(b.events.length, 0);
    assert.ok(!b.session._cliBusy);
  });
});

// --- Pin 12 ---

// PIN 12, changed on purpose by ready state. Formerly: "main osc busy (pin, changed on purpose by ready state): progress 1 to 3 marks a session busy whatever the title says". A progress report of level 1 to 3 is now ignored while the latest title says idle; before this commit it marked the session busy whatever the title said, and that was the stuck 'working'.
test('main osc busy (pin, changed by ready state): progress 1 to 3 marks a session busy unless its latest title says idle', async (t) => {
  await t.test('the title says idle after a finished turn: the report is ignored, and the session stays idle', () => {
    for (const level of [1, 2, 3]) {
      for (const report of [progress(level), progress(level, ';'), progress(level, ';50'), progress(level, ';', ST)]) {
        const shown = JSON.stringify(report);
        const h = boot();
        feed(h, working(), finished());
        assert.equal(h.session._titleBusy, false, 'the title says idle');
        assert.equal(h.session._titleNow, 'idle');
        feed(h, report);
        assert.deepEqual(busyEvents(h), [true, false], shown);
        assert.equal(h.session._cliBusy, false, shown);
        assert.equal(h.session._titleBusy, false, shown);

        // More reports and the end of progress change nothing either.
        feed(h, report, progress(0, ';'), progress(0), report);
        assert.deepEqual(busyEvents(h), [true, false], shown);
        assert.equal(h.events.length, 2, shown);
        assert.equal(h.session._cliBusy, false, shown);
        assert.deepEqual(notices(h), []);
        assertAddressed(h);

        // The next turn is shown by its title, once, and ended by its title.
        feed(h, working(), report);
        assert.deepEqual(busyEvents(h), [true, false, true], shown);
        feed(h, finished());
        assert.deepEqual(busyEvents(h), [true, false, true, false], shown);
        assert.equal(h.session._cliBusy, false, shown);
      }
    }
  });

  await t.test('the first title of a new session says idle: the report is ignored', () => {
    for (const level of [1, 2, 3]) {
      const h = boot();
      feed(h, title(`${IDLE} Claude Code`));
      assert.equal(h.events.length, 0);
      feed(h, progress(level, ';'));
      assert.equal(h.events.length, 0, `level ${level}`);
      assert.ok(!h.session._cliBusy, `level ${level}`);
      assert.equal(h.session._titleBusy, false, `level ${level}`);
      assert.equal(h.session._titleNow, 'idle', `level ${level}`);
    }
  });

  await t.test('the idle title and the report in one chunk: the session ends idle, in either order', () => {
    for (const level of [1, 2, 3]) {
      // Titles are read first, so the report is weighed against the idle title
      // even when it was written ahead of it.
      for (const chunk of [finished() + progress(level, ';'), progress(level, ';') + finished()]) {
        const shown = JSON.stringify(chunk);
        const wasWorking = boot();
        feed(wasWorking, working(), chunk);
        assert.deepEqual(busyEvents(wasWorking), [true, false], shown);
        assert.equal(wasWorking.session._cliBusy, false, shown);

        const wasIdle = boot();
        feed(wasIdle, working(), finished(), chunk);
        assert.deepEqual(busyEvents(wasIdle), [true, false], shown);
        assert.equal(wasIdle.session._cliBusy, false, shown);
      }
    }
  });

  await t.test('whatever else the title says: no telling title yet, a plain title, a spinner title', () => {
    for (const level of [1, 2, 3]) {
      const noTitle = boot();
      feed(noTitle, progress(level, ';'));
      assert.deepEqual(busyEvents(noTitle), [true], `level ${level}`);
      assert.equal(noTitle.session._cliBusy, true);

      const plainTitle = boot();
      feed(plainTitle, title('my-project'), progress(level, ';'));
      assert.deepEqual(busyEvents(plainTitle), [true], `level ${level}`);
      assert.equal(plainTitle.session._cliBusy, true);

      const spinnerTitle = boot();
      feed(spinnerTitle, working(), progress(level, ';'));
      assert.deepEqual(busyEvents(spinnerTitle), [true], `level ${level}: already busy, no second event`);
      assert.equal(spinnerTitle.session._cliBusy, true);
    }
  });
});

// --- Pin 13 ---

test('main osc busy (pin): isSessionBusy is true only for a live session with the busy flag under its exact id', async (t) => {
  await t.test('true for a live session with the busy flag, false for every other record', () => {
    const isSessionBusy = bootBusy([
      ['busy', sessionRecord({ _cliBusy: true })],
      ['idle', sessionRecord({ _cliBusy: false })],
      ['never-said', sessionRecord()],
      ['ended-busy', sessionRecord({ exited: true, _cliBusy: true })],
      ['ended-idle', sessionRecord({ exited: true, _cliBusy: false })],
      // What the title says is not the question.
      ['title-only', sessionRecord({ _titleBusy: true, _cliBusy: false })],
      ['busy-under-idle-title', sessionRecord({ _titleBusy: false, _cliBusy: true })],
      // Nor is anything else the record carries: a stop that was asked for and
      // has not ended the session yet, or a session no window shows.
      ['busy-stop-requested', sessionRecord({ _cliBusy: true, stopRequested: true })],
      ['idle-stop-requested', sessionRecord({ _cliBusy: false, stopRequested: true })],
      ['busy-not-shown', sessionRecord({ _cliBusy: true, rendererAttached: false })],
      ['busy-plain-terminal', sessionRecord({ _cliBusy: true, isPlainTerminal: true })],
      // And the other way round: neither of those makes an idle session count as working.
      ['idle-not-shown', sessionRecord({ _cliBusy: false, rendererAttached: false })],
      ['idle-plain-terminal', sessionRecord({ isPlainTerminal: true })],
    ]);
    assert.equal(isSessionBusy('busy-stop-requested'), true, 'still working until it has ended');
    assert.equal(isSessionBusy('idle-stop-requested'), false);
    assert.equal(isSessionBusy('busy-not-shown'), true, 'a window showing it is not the question');
    assert.equal(isSessionBusy('busy-plain-terminal'), true);
    assert.equal(isSessionBusy('idle-not-shown'), false, 'a session no window shows is not working for that');
    assert.equal(isSessionBusy('idle-plain-terminal'), false, 'a plain terminal that says nothing is not working');
    assert.equal(isSessionBusy('busy'), true);
    assert.equal(isSessionBusy('idle'), false);
    assert.equal(isSessionBusy('never-said'), false);
    assert.equal(isSessionBusy('ended-busy'), false, 'a session that has ended is not working');
    assert.equal(isSessionBusy('ended-idle'), false);
    assert.equal(isSessionBusy('title-only'), false);
    assert.equal(isSessionBusy('busy-under-idle-title'), true);
    // Asking changes nothing: the same answers again.
    assert.equal(isSessionBusy('busy'), true);
    assert.equal(isSessionBusy('ended-busy'), false);
  });

  await t.test('false for an id nothing is stored under', () => {
    const none = bootBusy([]);
    for (const id of ['busy', '', undefined, null, 0]) assert.equal(none(id), false, String(id));

    const isSessionBusy = bootBusy([['aaaaaaaa-1111-2222-3333-444444444444', sessionRecord({ _cliBusy: true })]]);
    assert.equal(isSessionBusy('aaaaaaaa-1111-2222-3333-444444444444'), true);
    for (const near of ['AAAAAAAA-1111-2222-3333-444444444444', 'aaaaaaaa', 'aaaaaaaa-1111-2222-3333-444444444444 ',
      ' aaaaaaaa-1111-2222-3333-444444444444', 'aaaaaaaa-1111-2222-3333-444444444445', undefined]) {
      assert.equal(isSessionBusy(near), false, JSON.stringify(near));
    }
  });

  await t.test('the id the record is stored under decides, not an id the record carries', () => {
    // A busy session that has moved to a new id: stored under the new id only.
    // It moved this very moment (rekeyedAtMs is the time the design has a
    // re-key write on the record), so an old id followed for any length of
    // time after the move would show here.
    const moved = sessionRecord({
      _cliBusy: true, realSessionId: 'new-id', priorIds: ['first-id', 'old-id'], forkFrom: 'parent-id', rekeyedAtMs: Date.now(),
    });
    const isSessionBusy = bootBusy([['new-id', moved], ['bystander', sessionRecord()]]);
    assert.equal(isSessionBusy('new-id'), true);
    assert.equal(isSessionBusy('old-id'), false, 'not under an id it used to have');
    assert.equal(isSessionBusy('first-id'), false, 'nor under the one before that');
    assert.equal(isSessionBusy('parent-id'), false);
    assert.equal(isSessionBusy('bystander'), false, 'another session being busy does not make this one busy');

    // And a record still stored under the id it started with answers there,
    // not under the id it names.
    const named = sessionRecord({ _cliBusy: true, realSessionId: 'names-this' });
    const byKey = bootBusy([['stored-here', named]]);
    assert.equal(byKey('stored-here'), true);
    assert.equal(byKey('names-this'), false);
  });

  await t.test('the flag is the one the terminal signals keep, read at the moment of asking', () => {
    const h = boot({ startId: 'run-1' });
    const isSessionBusy = bootBusy([['run-1', h.session]]);
    assert.equal(isSessionBusy('run-1'), false, 'a new session');
    feed(h, working());
    assert.equal(isSessionBusy('run-1'), true, 'working by its title');
    feed(h, finished());
    assert.equal(isSessionBusy('run-1'), false, 'finished');
    feed(h, title(`${BRAILLE[1]} Next turn`));
    assert.equal(isSessionBusy('run-1'), true);
    h.session.exited = true;
    assert.equal(isSessionBusy('run-1'), false, 'ended while working');

    // A plain terminal after a progress report: busy until it ends.
    const term = boot({ startId: 'term-1', session: { isPlainTerminal: true } });
    const termBusy = bootBusy([['term-1', term.session]]);
    feed(term, progress(1, ';10'), progress(0, ';'));
    assert.equal(termBusy('term-1'), true);
    term.session.exited = true;
    assert.equal(termBusy('term-1'), false);
  });
});

test('main-osc-busy (main.js source cut, run in a vm)', async (t) => {
  const line94 = (level, payload, wasBusy, titleNow) =>
    `[OSC 9;4] session=${FULL_ID} level=${level} payload="${payload}" wasBusy=${wasBusy} titleNow=${titleNow}`;
  const line0 = (cp, state, wasBusy) => `[OSC 0] session=${FULL_ID} char=${cp} state=${state} wasBusy=${wasBusy}`;

  await t.test('(a) idle title, then level 3: the session is not marked busy and no event is sent', () => {
    const h = boot();
    feed(h, working(), finished(), progress(3, ';'));
    assert.deepEqual(busyEvents(h), [true, false]);
    assert.equal(h.events.length, 2);
    assert.equal(h.session._cliBusy, false);
    assert.equal(h.session._titleNow, 'idle');
  });

  await t.test('(b) spinner title: one busy event; later progress sends nothing; an idle title sends one idle event', () => {
    const h = boot();
    feed(h, working());
    assert.equal(h.session._titleNow, 'busy');
    feed(h, progress(3, ';'), progress(1, ';40'));
    assert.deepEqual(busyEvents(h), [true]);
    feed(h, finished());
    assert.deepEqual(busyEvents(h), [true, false]);
    assert.equal(h.events.length, 2);
  });

  await t.test('(c) no title, level 1 then level 0: one busy event and no idle event', () => {
    const h = boot({ session: { isPlainTerminal: true } });
    feed(h, progress(1, ';10'), progress(0, ';'));
    assert.deepEqual(busyEvents(h), [true]);
    assert.equal(h.session._cliBusy, true);
    assert.equal(h.session._titleNow, undefined, 'no title was ever read');
  });

  await t.test('(d) idle title, then a title with an unrecognised first character, then level 3: busy is sent', () => {
    const odd = '\u25CC Fix the build';
    assert.equal(harnesses.getHarness(harnesses.DEFAULT_HARNESS).parseTitleState(odd), null, 'the character is not a known mark');
    const h = boot();
    feed(h, working(), finished(), title(odd));
    assert.equal(h.session._titleBusy, false, 'the last telling title said idle');
    assert.equal(h.session._titleNow, 'none', 'the latest title does not');
    feed(h, progress(3, ';'));
    assert.deepEqual(busyEvents(h), [true, false, true]);
    assert.equal(h.session._cliBusy, true);
  });

  await t.test("(e) session start: the plain titles 'C' then 'c', then level 3: busy is sent, as before", () => {
    const h = boot();
    feed(h, title('C'), title('c'), progress(3, ';'));
    assert.deepEqual(busyEvents(h), [true]);
    assert.equal(h.session._titleNow, 'none');
  });

  await t.test('(f) idle title and level 3 in one chunk, spinner title in the next: busy arrives with the title', () => {
    const h = boot();
    feed(h, working(), finished());
    feed(h, finished() + progress(3, ';'));
    assert.deepEqual(busyEvents(h), [true, false], 'nothing with the report');
    feed(h, working());
    assert.deepEqual(busyEvents(h), [true, false, true]);
  });

  await t.test("(g) every level, 0 included, writes one report line; an ignored report also writes 'ignored: title says idle'", () => {
    // No title yet: three reports, three lines, and the one that marks busy says so.
    const fresh = boot({ startId: FULL_ID });
    assert.deepEqual(logged(() => feed(fresh, progress(0, ';'), progress(9, ';'), progress(2, ';5'))), [
      line94('0', '4;0;', false, 'none'),
      line94('9', '4;9;', false, 'none'),
      line94('2', '4;2;5', false, 'none'),
      `[OSC 9;4] session=${FULL_ID} → BUSY`,
    ]);

    // The title says idle: level 3 is ignored and says why; level 0 and an unknown level are only logged.
    const idle = boot({ startId: FULL_ID });
    feed(idle, working(), finished());
    assert.deepEqual(logged(() => feed(idle, progress(3, ';'), progress(0, ';'), progress(9, ';'))), [
      line94('3', '4;3;', false, 'idle'),
      `[OSC 9;4] session=${FULL_ID} level=3 ignored: title says idle`,
      line94('0', '4;0;', false, 'idle'),
      line94('9', '4;9;', false, 'idle'),
    ]);
    assert.deepEqual(busyEvents(idle), [true, false]);

    // The title says busy: one line, nothing ignored, no second BUSY.
    const busy = boot({ startId: FULL_ID });
    feed(busy, working());
    assert.deepEqual(logged(() => feed(busy, progress(1, ';40'))), [line94('1', '4;1;40', true, 'busy')]);

    // After a re-key every line carries the id the session has now, in full.
    const moved = boot({ startId: 'started-as', session: { realSessionId: FULL_ID } });
    feed(moved, finished());
    const lines = logged(() => feed(moved, progress(3, ';')));
    assert.deepEqual(lines, [line94('3', '4;3;', false, 'idle'), `[OSC 9;4] session=${FULL_ID} level=3 ignored: title says idle`]);
  });

  await t.test('(h) 50 spinner titles in a row write one title line; each unknown first character is logged once, 16 at most', () => {
    const h = boot({ startId: FULL_ID });
    const spin = logged(() => { for (let i = 0; i < 50; i++) feed(h, title(`${FRAMES[i % FRAMES.length]} Fix the build`)); });
    assert.deepEqual(spin, [line0('U+2802', 'busy', false), `[OSC 0] session=${FULL_ID} → BUSY`]);

    assert.deepEqual(logged(() => feed(h, finished(), finished(), finished(ST))),
      [line0('U+2733', 'idle', true), `[OSC 0] session=${FULL_ID} → IDLE`]);

    // Unknown titles: one line for each new first character; an empty title and a
    // spinner character behind a blank are unknown titles too.
    const plain = logged(() => feed(h, title('my-project'), title('my-project'), title('Make'), title('my-project'),
      title(''), title(''), title(` ${SPIN} Fix`), title(` ${SPIN} Fix`)));
    assert.deepEqual(plain, [line0('U+006D', 'none', false), line0('U+004D', 'none', false), line0('none', 'none', false), line0('U+25D0', 'none', false)]);
    assert.equal(h.session._titleSeen.size, 4);
    assert.ok(h.session._titleSeen.has('U+006D'));

    // A change of state is logged even when the character was seen before.
    assert.deepEqual(logged(() => feed(h, finished(), title('my-project'), working())),
      [line0('U+2733', 'idle', false), line0('U+006D', 'none', false), line0('U+25D0', 'busy', false), `[OSC 0] session=${FULL_ID} → BUSY`]);

    // A plain terminal with 40 different first characters, each shown twice: 16 lines.
    const term = boot({ startId: 'term-1', session: { isPlainTerminal: true } });
    const many = logged(() => { for (let i = 0; i < 40; i++) { const text = `${String.fromCodePoint(0x100 + i)} job`; feed(term, title(text), title(text)); } });
    assert.equal(titleLines(many).length, 16);
    assert.equal(term.session._titleSeen.size, 16);

    // The set stays at 16 also when every unknown title is logged for its change of state.
    const turns = boot();
    const all = logged(() => { for (let i = 0; i < 40; i++) feed(turns, finished(), title(`${String.fromCodePoint(0x100 + i)} job`)); });
    assert.equal(titleLines(all).length, 80);
    assert.equal(turns.session._titleSeen.size, 16);

    // The marks are the session's own: one terminal's titles hide none of another's.
    // b's first title is another unknown one, so that its 'my-project' is a step from
    // unknown to unknown, which only b's own set decides (a set shared with a would hide it).
    const a = boot({ startId: 'a' });
    const b = boot({ startId: 'b' });
    feed(a, title('my-project'));
    feed(b, title('x'));
    assert.equal(titleLines(logged(() => feed(b, title('my-project')))).length, 1);
    assert.equal(b.session._titleSeen.size, 2);
    assert.equal(a.session._titleSeen.size, 1);
  });
});

test('main-osc-busy: main.js asks progressBusyState and titleLogDue and keeps no copy of either rule; the skip of level 0 is its own', async (t) => {
  await t.test('progressBusyState is asked with the level and whether the latest title says idle', () => {
    const calls = [];
    const h = bootWithRules({ progressBusyState: (arg) => { calls.push({ ...arg }); return harnesses.progressBusyState(arg); } });
    h.feed(progress(2, ';'));
    assert.deepEqual(calls, [{ level: '2', titleIdle: false }]);
    calls.length = 0;
    h.feed(finished(), progress(3, ';'));
    // Ignored under an idle title: asked again without the title, to tell "ignored" from "unknown level".
    assert.deepEqual(calls, [{ level: '3', titleIdle: true }, { level: '3', titleIdle: false }]);
    calls.length = 0;
    h.feed(progress(9, ';'));
    assert.deepEqual(calls, [{ level: '9', titleIdle: true }, { level: '9', titleIdle: false }]);
    assert.equal(h.lines.filter((line) => line.endsWith('ignored: title says idle')).length, 1, 'only the level 3 report was ignored');
    calls.length = 0;
    h.feed(progress(0, ';'));
    assert.deepEqual(calls, [], 'level 0 is skipped before the rule is asked');
  });

  await t.test('what the rule answers is what happens', () => {
    const yes = bootWithRules({ progressBusyState: () => 'busy' });
    yes.feed(finished(), progress(3, ';'));
    assert.deepEqual(yes.events.map((e) => e.value), [true], 'main.js has no title check of its own');
    yes.feed(finished());
    yes.feed(progress(0, ';'));
    assert.deepEqual(yes.events.map((e) => e.value), [true, false], 'and level 0 does nothing even when the rule would say busy');

    const no = bootWithRules({ progressBusyState: () => null });
    no.feed(progress(3, ';'), progress(1, ';5'));
    assert.equal(no.events.length, 0, 'main.js has no level list of its own');
    assert.ok(!no.session._cliBusy);
  });

  await t.test('titleLogDue decides every title line and every remembered character, and is handed the state, the state before, the character and the session\'s set', () => {
    const calls = [];
    const never = bootWithRules({ titleLogDue: (arg) => { calls.push({ state: arg.state, previous: arg.previous, codePoint: arg.codePoint, seenSize: arg.seen.size }); return { due: false, remember: false }; } });
    never.feed(finished(), title('my-project'), working());
    assert.deepEqual(calls, [
      { state: 'idle', previous: undefined, codePoint: 'U+2733', seenSize: 0 },
      { state: 'none', previous: 'idle', codePoint: 'U+006D', seenSize: 0 },
      { state: 'busy', previous: 'none', codePoint: 'U+25D0', seenSize: 0 },
    ]);
    assert.equal(never.lines.filter((line) => line.includes(' char=')).length, 0, 'no title line when the rule says no');
    assert.equal(never.session._titleSeen.size, 0, 'nothing is remembered when the rule says no');
    assert.deepEqual(never.events.map((e) => e.value), [true], 'the busy event does not depend on the log rule');
    assert.equal(never.session._titleNow, 'busy');

    // The line follows `due` alone: main.js remembers nothing by itself, not even
    // the character of an unknown title whose line it has just written.
    const always = bootWithRules({ titleLogDue: () => ({ due: true, remember: false }) });
    always.feed(working(), working(), working(), working(), working());
    assert.equal(always.lines.filter((line) => line.includes(' char=')).length, 5);
    always.feed(title('my-project'), title('my-project'));
    assert.equal(always.lines.filter((line) => line.includes(' char=')).length, 7);
    assert.equal(always.session._titleSeen.size, 0, 'main.js has no "unknown title" check of its own');

    // The remembered character follows `remember` alone: with no line written, whatever
    // the title's state, and past 16 (the cap is the rule's, main.js has none).
    const quiet = bootWithRules({ titleLogDue: () => ({ due: false, remember: true }) });
    quiet.feed(working(), finished());
    assert.equal(quiet.lines.filter((line) => line.includes(' char=')).length, 0);
    assert.equal(quiet.session._titleSeen.size, 2);
    assert.ok(quiet.session._titleSeen.has('U+25D0'));
    assert.ok(quiet.session._titleSeen.has('U+2733'));
    for (let i = 0; i < 20; i++) quiet.feed(title(`${String.fromCodePoint(0x100 + i)} job`));
    assert.equal(quiet.session._titleSeen.size, 22, 'main.js has no cap of its own');
  });
});
