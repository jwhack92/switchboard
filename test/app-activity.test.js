'use strict';
// Pin tests (relaunch work, Phase 1b): working, finished and "needs you" in the
// window, with the speech that goes with them. They record the behaviour of
// public/app.js as it is today, so that a later fix cannot change it unnoticed.
//
// Four pieces of public/app.js are cut out by marker strings and run together
// in one vm context against fakes (test-support/source-cut.js): the activity
// state with setActivity, the spoken-name rule, the notification listener and
// the busy listener. The tests drive them the way main does, through the two
// listeners. cleanDisplayName is the real one, cut from public/utils.js.
//
// Speech is a recorder in most cases, so a case shows exactly which call the
// page made. One case per pin runs the real public/speech.js against a fake
// voice, so "speaks" also means words reached the voice.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cut, load, peek } = require('../test-support/source-cut');

const APP = 'public/app.js';
const SPEECH = 'public/speech.js';

const ACTIVITY = cut(APP, '// --- Activity tracking ---', 'function clearUnread(sessionId) {');
const SPOKEN_NAME = cut(APP, 'const SPOKEN_NAME_MAX = 48;', "const speechEl = document.getElementById('status-bar-speech');");
const NOTIFICATION = cut(APP, 'window.api.onTerminalNotification((sessionId, message) => {', '// --- CLI busy state');
const BUSY_LISTENER = cut(APP, 'window.api.onCliBusyState((sessionId, busy) => {', '// --- Single entry point for all sidebar renders ---');
const CLEAN_NAME = cut('public/utils.js', 'function cleanDisplayName(name) {', 'function formatDate(date) {');
const PAGE = [ACTIVITY, CLEAN_NAME, SPOKEN_NAME, NOTIFICATION, BUSY_LISTENER].join('\n');
// The whole speech module, from its first line.
const SPEECH_FILE = cut(SPEECH, '// Decides what gets said, and for which session.');

const T0 = 1800000000000;   // the fake clock; no test reads the real one

// The four messages the CLI sends when it wants something, and what the real
// speech module makes of each.
const ATTENTION = [
  { message: 'Claude Code needs your attention', spoken: 'needs your attention' },
  { message: 'Claude Code needs your approval for the plan', spoken: 'needs plan approval' },
  { message: 'Claude needs your permission to use Bash', spoken: 'needs permission' },
  { message: 'Claude Code wants to enter plan mode', spoken: 'wants to enter plan mode' },
];
const WAITING = 'Claude is waiting for your input';

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** A sidebar row: only its classes matter here. */
function fakeRow() {
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    classes: () => [...classes].sort(),
  };
}

/**
 * The page pieces in a context of its own. Two sessions: 'back' ("Review
 * Pass") and 'front' ("Phase 7"); `onScreen` is the one the user looks at.
 *   speech    'recorder' (default), 'real' (public/speech.js with a fake voice)
 *             or 'none' (speech.js not loaded)
 *   voiceOn   real speech only: the status-bar speech switch
 *   rows      the ids that have a row in the sidebar
 *   more      further sessions the window knows (they have no sidebar row)
 * counts.dots is the number of times the Projects tab's dots were redrawn.
 */
function bootPage({ onScreen = 'front', speech = 'recorder', voiceOn = true, rows = ['back', 'front'], more = [] } = {}) {
  const clock = { now: T0 };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  const listeners = {};
  const said = [];       // recorder: [method, ...arguments]
  const spoken = [];     // real speech: the texts handed to the voice
  const asked = [];      // real speech: the reads of the transcript's new text
  const refreshes = [];
  const counts = { dots: 0 };
  const items = new Map(rows.map((id) => [id, fakeRow()]));
  const sessionMap = new Map([
    ['back', { sessionId: 'back', name: 'Review Pass', modified: '2026-01-01T00:00:00.000Z' }],
    ['front', { sessionId: 'front', name: 'Phase 7', modified: '2026-01-01T00:00:00.000Z' }],
    ...more.map((session) => [session.sessionId, session]),
  ]);
  const api = {
    onTerminalNotification: (cb) => { listeners.notify = cb; },
    onCliBusyState: (cb) => { listeners.busy = cb; },
  };
  const window = { api };
  if (speech === 'recorder') {
    const record = (method) => (...args) => { said.push([method, ...args]); };
    window.speech = {
      announceFinished: record('announceFinished'),
      announceAttention: record('announceAttention'),
      speakReply: record('speakReply'),
      warmUp: record('warmUp'),
    };
  }
  if (speech === 'real') {
    api.getEffectiveSettings = async () => ({ speakReplies: 'focused' });
    api.speechNewText = async (id, from) => { asked.push([id, from]); return { bytes: 120, text: 'The build passed.' }; };
    window.localStorage = { getItem: (key) => (key === 'speechEnabled' ? JSON.stringify(voiceOn) : null), setItem() {} };
    window.tts = { isAvailable: () => true, speak: (text) => { spoken.push(text); return true; }, cancel() {} };
    // The fitting rule has its own tests; here every reply fits as it is.
    window.speechText = { wordsForSeconds: () => 75, fitOrSummarize: (text) => ({ needsSummary: false, speak: text }) };
    load(SPEECH_FILE, { file: SPEECH, globals: { window } });
    assert.equal(typeof window.speech.announceFinished, 'function', 'speech.js gives the page window.speech');
  }
  const header = { textContent: '', style: { display: 'none' } };
  const ctx = load(PAGE, {
    file: APP,
    globals: {
      window,
      document: {
        querySelector: (selector) => {
          const m = /^\.session-item\[data-session-id="([^"]*)"\]$/.exec(selector);
          return (m && items.get(m[1])) || null;
        },
      },
      Date: FakeDate,
      sessionMap,
      activeSessionId: onScreen,
      terminalHeaderPtyTitle: header,
      refreshProjectViews: (how) => { refreshes.push({ ...how }); },
      updateProjectStatusDots: () => { counts.dots++; },
    },
  });
  assert.equal(typeof listeners.busy, 'function', 'the block registers the busy listener');
  assert.equal(typeof listeners.notify, 'function', 'the block registers the notification listener');
  return {
    ctx, clock, said, spoken, asked, refreshes, counts, header,
    busy: (id, on) => listeners.busy(id, on),
    notify: (id, message) => listeners.notify(id, message),
    classes: (id) => items.get(id).classes(),
    needsYou: peek(ctx, 'attentionSessions'),
    ready: peek(ctx, 'responseReadySessions'),
    working: peek(ctx, 'sessionBusyState'),
    eventTimes: peek(ctx, 'sessionEventTimes'),
  };
}

test('app activity (pin): working then finished on a background session speaks once and marks the row; on the session on screen the reply is read; finished without working says nothing', async (t) => {
  await t.test('background: working shows the spinner and is silent; finished speaks once and marks the row', () => {
    const page = bootPage({ onScreen: 'front' });

    page.busy('back', true);
    assert.deepEqual(page.classes('back'), ['cli-busy']);
    assert.equal(page.working.get('back'), true);
    assert.deepEqual(page.said, [], 'working says nothing, and a background session warms nothing up');
    assert.equal(page.counts.dots, 1, 'working redraws the Projects tab dots');
    assert.equal(page.eventTimes.get('back'), new Date('2026-01-01T00:00:00.000Z').getTime(), 'a turn that starts pins the row at the time it had, the transcript\'s last message, so it does not move while it works');
    assert.deepEqual(page.refreshes, [], 'starting to work is not an event the Projects tab re-sorts on');

    page.busy('back', true);   // main may say it again
    assert.deepEqual(page.said, []);
    assert.equal(page.counts.dots, 2, 'every working signal redraws the dots');

    page.clock.now = T0 + 60000;
    page.busy('back', false);
    assert.deepEqual(page.said, [['announceFinished', 'back', 'Review Pass']], 'one alert, by the row\'s name');
    assert.deepEqual(page.classes('back'), ['response-ready'], 'the spinner goes, "response ready" comes');
    assert.equal(page.ready.has('back'), true);
    assert.equal(page.working.get('back'), false);
    assert.equal(page.eventTimes.get('back'), T0 + 60000, 'the end of a turn is the time the Projects tab sorts by');
    assert.deepEqual(page.classes('front'), [], 'the other row is untouched');
    assert.equal(page.counts.dots, 3, 'finished redraws the Projects tab dots');

    // Finished again, with nothing in between: nothing more is said.
    page.busy('back', false);
    page.busy('back', false);
    assert.deepEqual(page.said.length, 1, 'spoken once');
    assert.deepEqual(page.classes('back'), ['response-ready']);
    assert.equal(page.counts.dots, 3, 'a row that is already "response ready" redraws nothing more');
  });

  await t.test('background: working again clears "response ready", and the next finish speaks again', () => {
    const page = bootPage({ onScreen: 'front' });
    page.busy('back', true);
    page.busy('back', false);
    assert.deepEqual(page.classes('back'), ['response-ready']);

    page.busy('back', true);
    assert.deepEqual(page.classes('back'), ['cli-busy'], 'straight back to working');
    assert.equal(page.ready.has('back'), false);
    assert.equal(page.working.get('back'), true);
    assert.equal(page.said.length, 1, 'starting to work says nothing');

    page.busy('back', false);
    assert.deepEqual(page.said, [
      ['announceFinished', 'back', 'Review Pass'],
      ['announceFinished', 'back', 'Review Pass'],
    ], 'one alert per finished turn');
    assert.deepEqual(page.classes('back'), ['response-ready']);
  });

  await t.test('background: a session without a sidebar row, or without a known name, is still marked and spoken for', () => {
    const page = bootPage({ onScreen: 'front', rows: ['front'] });
    page.busy('back', true);
    page.busy('back', false);
    assert.deepEqual(page.said, [['announceFinished', 'back', 'Review Pass']]);
    assert.equal(page.ready.has('back'), true);

    page.busy('nobody-knows', true);
    page.busy('nobody-knows', false);
    assert.deepEqual(page.said[1], ['announceFinished', 'nobody-knows', 'a session']);
    assert.equal(page.ready.has('nobody-knows'), true);
  });

  await t.test('background: the alert names the session by its name, else its AI title, else its summary, else its slug, and cuts a long name at 48 characters', () => {
    const LONG = 'Refactor the invoice export so that totals reconcile with the ledger';
    const cases = [
      [{ name: 'Given Name', aiTitle: 'AI Title', summary: 'The Summary', slug: 'the-slug' }, 'Given Name', 'the name comes first'],
      [{ aiTitle: 'AI Title', summary: 'The Summary', slug: 'the-slug' }, 'AI Title', 'then the AI title'],
      [{ summary: 'The Summary', slug: 'the-slug' }, 'The Summary', 'then the summary'],
      [{ slug: 'the-slug' }, 'the-slug', 'then the slug'],
      [{}, 'a session', 'a row with none of them'],
      [{ name: '<command>', slug: 'the-slug' }, 'the-slug', 'a name that is only a tag cleans to nothing: the slug'],
      [{ name: '  Padded   Name  ' }, 'Padded Name', 'spaces are collapsed and trimmed'],
      [{ name: 'Refactor the invoice export so that totals match' }, 'Refactor the invoice export so that totals match', 'exactly 48 characters are spoken whole'],
      [{ name: LONG }, 'Refactor the invoice export so that totals', 'longer: cut back to the last whole word within 48 characters'],
      [{ name: 'A'.repeat(60) }, 'A'.repeat(48), 'longer and without a space: the first 48 characters'],
      [{ name: 'Short head ' + 'B'.repeat(50) }, 'Short head ' + 'B'.repeat(37), 'longer, its only space within the first 16 characters: the first 48 characters'],
      [{ name: '<command>', aiTitle: 'AI Title', slug: 'the-slug' }, 'the-slug', 'a name that cleans to nothing goes to the slug, not on to the AI title'],
      [{ name: 'Refactor the invoice export so that totals match.' }, 'Refactor the invoice export so that totals', 'one character over 48 is already cut'],
      [{ name: 'C'.repeat(16) + ' ' + 'D'.repeat(40) }, 'C'.repeat(16) + ' ' + 'D'.repeat(31), 'longer, its last space at index 16: the first 48 characters'],
      [{ name: 'E'.repeat(17) + ' ' + 'F'.repeat(40) }, 'E'.repeat(17), 'longer, its last space at index 17: cut back to it'],
    ];
    assert.equal(LONG.length > 48, true);
    const more = cases.map(([fields], i) => ({ sessionId: `n${i}`, modified: '2026-01-01T00:00:00.000Z', ...fields }));
    const page = bootPage({ onScreen: 'front', more });
    cases.forEach(([, spokenAs, why], i) => {
      page.busy(`n${i}`, true);
      page.busy(`n${i}`, false);
      assert.deepEqual(page.said.at(-1), ['announceFinished', `n${i}`, spokenAs], why);
    });
    assert.equal(page.said.length, cases.length, 'one alert per session');
  });

  await t.test('on screen: working warms the summarizer up once; finished reads the reply and marks nothing', () => {
    const page = bootPage({ onScreen: 'front' });

    page.busy('front', true);
    assert.deepEqual(page.said, [['warmUp']]);
    assert.deepEqual(page.classes('front'), ['cli-busy']);
    page.busy('front', true);
    assert.deepEqual(page.said, [['warmUp']], 'not warmed up again while it is working');

    page.clock.now = T0 + 5000;
    page.busy('front', false);
    assert.deepEqual(page.said, [['warmUp'], ['speakReply', 'front']], 'the reply is read; there is no "finished" alert');
    assert.deepEqual(page.classes('front'), [], 'no spinner and no "response ready" on the row you are looking at');
    assert.equal(page.ready.has('front'), false);
    assert.equal(page.working.get('front'), false);
    assert.equal(page.eventTimes.get('front'), T0 + 5000);

    page.busy('front', false);
    assert.equal(page.said.length, 2, 'read once');
  });

  await t.test('finished without working says nothing and marks nothing', () => {
    const page = bootPage({ onScreen: 'front' });
    page.busy('back', false);
    page.busy('front', false);
    page.busy('back', false);
    assert.deepEqual(page.said, []);
    assert.deepEqual(page.classes('back'), []);
    assert.deepEqual(page.classes('front'), []);
    assert.equal(page.ready.size, 0);
    assert.equal(page.eventTimes.size, 0, 'no turn ended, so nothing moves in the Projects tab');
    assert.deepEqual(page.refreshes, []);
  });

  await t.test('without the speech module the rows are marked the same and nothing throws', () => {
    const page = bootPage({ onScreen: 'front', speech: 'none' });
    page.busy('back', true);
    page.busy('back', false);
    page.busy('front', true);
    page.busy('front', false);
    assert.deepEqual(page.classes('back'), ['response-ready']);
    assert.deepEqual(page.classes('front'), []);
  });

  await t.test('with the real speech module: the background alert is "<name> finished." once, the reply on screen reaches the voice, and with speech off nothing is said', async () => {
    const page = bootPage({ onScreen: 'front', speech: 'real' });
    await settle();
    page.busy('back', true);
    page.busy('back', false);
    page.busy('back', false);
    await settle();
    assert.deepEqual(page.spoken, ['Review Pass finished.']);
    assert.deepEqual(page.asked, [], 'no transcript is read for a background session');

    page.busy('front', true);
    page.busy('front', false);
    await settle();
    assert.deepEqual(page.asked.map(([id]) => id), ['front'], 'the new text of the session on screen is asked for once');
    assert.deepEqual(page.spoken, ['Review Pass finished.', 'The build passed.']);

    const off = bootPage({ onScreen: 'front', speech: 'real', voiceOn: false });
    await settle();
    off.busy('back', true);
    off.busy('back', false);
    off.busy('front', true);
    off.busy('front', false);
    await settle();
    assert.deepEqual(off.spoken, []);
    assert.deepEqual(off.asked, []);
    assert.deepEqual(off.classes('back'), ['response-ready'], 'the row is marked whether or not speech is on');
  });
});

test('app activity (pin): the four attention wordings mark and speak for a background session only; \'waiting for your input\' counts as finished', async (t) => {
  await t.test('each of the four wordings marks the background row and speaks, and does not end its turn', () => {
    assert.equal(ATTENTION.length, 4);
    for (const { message } of ATTENTION) {
      const page = bootPage({ onScreen: 'front' });
      page.busy('back', true);
      page.clock.now = T0 + 30000;
      assert.equal(page.counts.dots, 1, message + ': one redraw of the dots so far, for the working signal');
      page.notify('back', message);

      assert.equal(page.counts.dots, 2, message + ': the mark redraws the Projects tab dots once');
      assert.equal(page.needsYou.has('back'), true, message);
      assert.deepEqual(page.classes('back'), ['cli-busy', 'needs-attention'], message + ': marked, and still working');
      assert.deepEqual(page.said, [['announceAttention', 'back', 'Review Pass', message]], message + ': one alert, with the message');
      assert.equal(page.ready.has('back'), false, message + ': it is not "response ready"');
      assert.equal(page.working.get('back'), true, message + ': the turn has not ended');
      assert.equal(page.eventTimes.get('back'), T0 + 30000, message + ': asking is an event the Projects tab sorts by');
      assert.deepEqual(page.refreshes.at(-1), { reason: 'sessions' }, message);
      assert.equal(page.header.textContent, '', message + ': the header belongs to the session on screen');
      assert.equal(page.header.style.display, 'none', message);
      assert.deepEqual(page.classes('front'), [], message);
    }

    // The match does not depend on letter case, and an idle session is marked too.
    const idle = bootPage({ onScreen: 'front' });
    idle.notify('back', 'CLAUDE NEEDS YOUR PERMISSION TO USE BASH');
    assert.deepEqual(idle.classes('back'), ['needs-attention']);
    assert.equal(idle.said.length, 1);
    assert.equal(idle.said[0][0], 'announceAttention');
    assert.equal(idle.counts.dots, 1);
  });

  await t.test('the pattern is wider than the four wordings: each of its other four words marks a background session on its own', () => {
    // The fifth, "wants to enter", is the fourth wording itself.
    const ALONE = ['Your attention, please', 'Plan approval is pending', 'Permission required', 'Claude needs your answer'];
    for (const message of ALONE) {
      const page = bootPage({ onScreen: 'front' });
      page.notify('back', message);
      assert.equal(page.needsYou.has('back'), true, message);
      assert.deepEqual(page.classes('back'), ['needs-attention'], message);
      assert.deepEqual(page.said, [['announceAttention', 'back', 'Review Pass', message]], message);

      page.notify('front', message);
      assert.equal(page.needsYou.has('front'), false, message + ': never the session on screen');
      assert.equal(page.said.length, 1, message);
    }
  });

  await t.test('on the session on screen the four wordings mark nothing and say nothing; the header shows the message', () => {
    for (const { message } of ATTENTION) {
      const page = bootPage({ onScreen: 'front' });
      page.busy('front', true);
      page.said.length = 0;   // the warm-up of a working session on screen is the other pin's
      page.notify('front', message);

      assert.equal(page.needsYou.size, 0, message);
      assert.deepEqual(page.classes('front'), ['cli-busy'], message + ': no mark');
      assert.deepEqual(page.said, [], message + ': nothing is said');
      assert.equal(page.eventTimes.get('front'), new Date('2026-01-01T00:00:00.000Z').getTime(), message + ': no event; the time is the one the turn began with');
      assert.equal(page.header.textContent, message, message);
      assert.equal(page.header.style.display, '', message + ': the header line is shown');
      assert.equal(page.counts.dots, 1, message + ': the dots were redrawn for the working signal only');
    }
  });

  await t.test('"waiting for your input" counts as finished: a working background session is marked "response ready" and announced once, not marked as needing you', () => {
    const page = bootPage({ onScreen: 'front' });
    page.busy('back', true);
    page.notify('back', WAITING);

    assert.deepEqual(page.said, [['announceFinished', 'back', 'Review Pass']]);
    assert.deepEqual(page.classes('back'), ['response-ready']);
    assert.equal(page.ready.has('back'), true);
    assert.equal(page.working.get('back'), false);
    assert.equal(page.needsYou.size, 0, 'it is not an attention mark');
    assert.equal(page.header.textContent, '', 'not the session on screen');
    assert.equal(page.counts.dots, 2, 'the dots are redrawn as for any finished turn');

    // The finished event that follows from main adds nothing.
    page.busy('back', false);
    page.notify('back', WAITING);
    assert.equal(page.said.length, 1, 'announced once');

    // A session that was not working: nothing to finish.
    const idle = bootPage({ onScreen: 'front' });
    idle.notify('back', WAITING);
    assert.deepEqual(idle.said, []);
    assert.deepEqual(idle.classes('back'), []);
    assert.equal(idle.ready.size, 0);

    // On screen and working: the reply is read, as for any finished turn.
    const front = bootPage({ onScreen: 'front' });
    front.busy('front', true);
    front.notify('front', 'claude is WAITING FOR YOUR INPUT');
    assert.deepEqual(front.said, [['warmUp'], ['speakReply', 'front']]);
    assert.deepEqual(front.classes('front'), []);
    assert.equal(front.header.textContent, 'claude is WAITING FOR YOUR INPUT');
  });

  await t.test('any other message marks nothing and says nothing', () => {
    const page = bootPage({ onScreen: 'front' });
    page.busy('back', true);
    page.notify('back', 'Build finished');
    assert.deepEqual(page.said, []);
    assert.deepEqual(page.classes('back'), ['cli-busy']);
    assert.equal(page.needsYou.size, 0);
    assert.equal(page.ready.size, 0);
    assert.equal(page.header.textContent, '');
    assert.equal(page.counts.dots, 1, 'no redraw of the dots for a message that marks nothing');

    page.notify('front', 'Build finished');
    assert.deepEqual(page.said, []);
    assert.equal(page.header.textContent, 'Build finished', 'the header of the session on screen shows any message');
  });

  await t.test('with the real speech module each wording is spoken by the row\'s name, and nothing for the session on screen', async () => {
    const page = bootPage({ onScreen: 'front', speech: 'real' });
    await settle();
    for (const { message } of ATTENTION) page.notify('back', message);
    for (const { message } of ATTENTION) page.notify('front', message);
    await settle();
    assert.deepEqual(page.spoken, ATTENTION.map(({ spoken }) => `Review Pass ${spoken}.`));

    // "waiting for your input" on a working background session is the finished alert.
    page.busy('back', true);
    page.notify('back', WAITING);
    await settle();
    assert.equal(page.spoken.at(-1), 'Review Pass finished.');
    assert.equal(page.spoken.length, ATTENTION.length + 1);
  });
});
