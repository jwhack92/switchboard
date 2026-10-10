const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', 'public', 'prompt-screen.js');
const { PROMPT_MARKS, promptScreen } = require('../public/prompt-screen');

const P = '\u276f';                 // the prompt pointer
const NB = '\u00a0';                // the no-break space the program puts after it
const COLS = 146;
const RULE = '\u2500'.repeat(COLS);
const TOP_ULTRA = '\u2500'.repeat(134) + ' ultracode \u2500';   // the box's top line while ultracode is on
const echo = (text) => (P + ' ' + text).padEnd(COLS);          // a prompt repeated in the conversation

// A 55-row screen from { row: text }; every other row is blank.
function screen(map, cursorY) {
  const rows = new Array(55).fill('');
  for (const [y, text] of Object.entries(map)) rows[Number(y)] = text;
  return { rows, cursorY };
}
const BANNER = {
  1: ' \u2590\u259b\u2588\u2588\u2588\u259b\u2588   Claude Code v2.1.289',
  2: '\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u2588\u2580  Opus 5.5 with xhigh effort \u00b7 Claude Max',
  3: ' \u259d\u259d   \u259d\u259d   C:\\proj',
};
const STATUS = {
  53: '  Opus 5.5\u00b7xhigh \u00b7 ctx 50K/1M 5% ' + '\u2591'.repeat(10),
  54: '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 2 agents',
};
const BOX = { 50: RULE, 51: P + NB, 52: RULE };
const TURN_1 = { 6: echo('Reply with the single word ok'), 8: '\u25cf ok', 10: '\u273b Worked for 6s \u00b7 done 6:38 AM' };
const TURN_2 = { 12: echo('/effort ultracode'), 13: '  \u23bf  Ultracode on (this session only): dynamic workflows on every task. Effort stays xhigh.' };
const TURN_3 = { 15: echo('Reply with the single word ok'), 17: '\u25cf ok', 19: '\u273b Brewed for 8s \u00b7 done 6:42 AM' };
const PANEL = {
  40: RULE,
  41: '  Teach auto mode about your environment?',
  43: '  Auto mode works better when it knows your environment. Takes about a minute.',
  45: '  ' + P + ' 1. Yes',
  46: '    2. Not now',
  47: "    3. Don't show again",
  49: '  Enter to confirm \u00b7 Esc to cancel',
};

const S02C = screen({ ...BANNER, ...TURN_1, ...BOX, ...STATUS }, 51);                  // empty prompt after a turn
const S02SAY = screen({ ...BANNER, ...TURN_1, ...PANEL, ...BOX, ...STATUS }, 53);      // a question is open
const S01STATUS = screen({ ...BANNER, 49: ' '.repeat(127) + '\u25c9 xhigh \u00b7 /effort  ',
  50: RULE, 51: P + NB + 'Try "how does <filepath> work?"', 52: RULE, ...STATUS }, 51); // fresh session, grey hint
const S04B = screen({ ...BANNER, ...TURN_1, ...TURN_2, 50: TOP_ULTRA, 51: P + NB, 52: RULE, ...STATUS }, 51);
const S04D = screen({ ...BANNER, ...TURN_1, ...TURN_2, ...TURN_3, 50: TOP_ULTRA, 51: P + NB, 52: RULE, ...STATUS }, 51);
const S06A = screen({ ...BANNER, ...TURN_1, ...TURN_2, ...TURN_3,
  21: echo('/effort ultracode off'), 22: '  \u23bf  Ultracode off. Effort stays xhigh.',
  24: echo('C:/Program Files/Git/clear'),
  47: '\u273b Transmogrifying\u2026 (running UserPromptSubmit hook \u00b7 4s)',
  48: '  \u23bf ' + NB + 'Tip: Use git worktrees to run multiple Claude sessions in parallel.',
  ...BOX, ...STATUS }, 51);                                                            // a turn is running
const S06D = screen({ ...BANNER, 6: echo('/clear'), ...BOX, ...STATUS }, 51);          // empty prompt after /clear

// A copy of a screen with some rows replaced and, when given, another cursor row.
const change = (s, map, cursorY = s.cursorY) => {
  const rows = s.rows.slice();
  for (const [y, text] of Object.entries(map)) rows[Number(y)] = text;
  return { rows, cursorY };
};
const stateOf = (read) => {
  const result = promptScreen(read);
  assert.equal(typeof result.why, 'string');
  assert.ok(result.why.length > 0, 'every answer says why');
  return result.state;
};

test('prompt-screen: the file loads under plain Node and puts the same object on window.PromptScreen', () => {
  assert.equal(typeof promptScreen, 'function');
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), context);
  // Only the two names of this commit are asked for: task 08 adds a third to the same object.
  assert.equal(typeof context.window.PromptScreen.promptScreen, 'function');
  assert.equal(context.window.PromptScreen.PROMPT_MARKS.readOn, '2.1.289');
  assert.equal(context.window.PromptScreen.promptScreen(null).state, 'unknown');
});

test('prompt-screen: the marks say which Claude Code version they were read on', () => {
  assert.equal(PROMPT_MARKS.readOn, '2.1.289');
  assert.equal(PROMPT_MARKS.POINTER, '\u276f');
  assert.equal(Object.isFrozen(PROMPT_MARKS), true);
});

test('prompt-screen: promptScreen reads the recorded screens (rebuilt to 55 rows)', () => {
  for (const [name, s] of [['02c', S02C], ['04b', S04B], ['04d', S04D], ['06d', S06D]]) assert.equal(stateOf(s), 'empty', name);
  assert.equal(stateOf(S02SAY), 'question');
  assert.equal(stateOf(S01STATUS), 'draft');
  assert.equal(stateOf(S06A), 'unknown');
  const COMPACTING = '\u273b Compacting conversation\u2026 (esc to interrupt)';
  assert.equal(stateOf(change(S06A, { 47: COMPACTING })), 'unknown');
  assert.equal(stateOf(change(S06A, { 47: '', 48: '', 33: COMPACTING })), 'unknown', '18 rows above the box');
  // It is the working row that decides: without it the same screen is an empty prompt.
  assert.equal(stateOf(change(S06A, { 47: '', 48: '' })), 'empty');
  // 22 rows above the box is outside the 20 rows that are searched.
  assert.equal(stateOf(change(S06A, { 47: '', 48: '', 29: COMPACTING })), 'empty');
});

test("prompt-screen: promptScreen never says 'empty' on a doubt", () => {
  const doubts = {
    'null': null,
    'undefined': undefined,
    'no rows': { rows: [], cursorY: 0 },
    'two rows': { rows: [RULE, P + NB], cursorY: 1 },
    'rows that are not a list': { rows: 'x', cursorY: 51 },
    'the cursor on another row': change(S02C, {}, 53),
    'no cursor row': change(S02C, {}, null),
    'a cursor row that is not a number': change(S02C, {}, '51'),
    'no rule row above the pointer row': change(S02C, { 50: '' }),
    'no rule row below the pointer row': change(S02C, { 52: '' }),
    'two input boxes': change(S02C, { 44: RULE, 45: P + NB, 46: RULE }),
  };
  for (const [name, read] of Object.entries(doubts)) assert.equal(stateOf(read), 'unknown', name);
});

test('prompt-screen: an empty box is the pointer with only blanks after it, the no-break space included', () => {
  for (const box of [P, P + NB, P + ' ', P + NB + NB + ' ']) assert.equal(stateOf(change(S02C, { 51: box })), 'empty', JSON.stringify(box));
  for (const box of [P + NB + 'x', P + ' fix the tests', P + NB + 'Try "how does <filepath> work?"']) {
    assert.equal(stateOf(change(S02C, { 51: box })), 'draft', JSON.stringify(box));
  }
});

test('prompt-screen: with no input box drawn, question words in the bottom 20 rows are a question, and higher up they are not', () => {
  const noBox = { 50: '', 51: '', 52: '' };
  assert.equal(stateOf(change(S02SAY, noBox)), 'question');
  const higher = change(S02C, { ...noBox, 20: '  ' + P + ' 1. Yes', 22: '  Enter to confirm \u00b7 Esc to cancel' });
  assert.equal(stateOf(higher), 'unknown');
});

test('prompt-screen: words in the conversation do not trip the check', () => {
  const quoted = { 40: RULE, 41: '  The menu looked like this:', 43: '  ' + P + ' 1. Yes', 45: '  Enter to confirm \u00b7 Esc to cancel' };
  // (a) a column-0 row between the quoted menu and the box: no panel.
  assert.equal(stateOf(change(S06D, { ...quoted, 47: '\u273b Worked for 6s \u00b7 done 6:38 AM' })), 'empty');
  // (b) the rule and the indented rows run up to the box, cursor in the box: not a question, and not empty.
  assert.equal(stateOf(change(S06D, quoted)), 'unknown');
  // (c) the recorded question with the cursor moved into the box.
  assert.equal(stateOf(change(S02SAY, {}, 51)), 'unknown');
});

test('prompt-screen: index.html loads prompt-screen.js directly above ctx-handoff.js, once', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').split(/\r?\n/).map(line => line.trim());
  const at = lines.indexOf('<script src="ctx-handoff.js"></script>');
  assert.notEqual(at, -1);
  assert.equal(lines[at - 1], '<script src="prompt-screen.js"></script>');
  assert.equal(lines.filter(line => line === '<script src="prompt-screen.js"></script>').length, 1);
});

test('prompt-screen: a draft that takes more than one row is never an empty prompt and never a question', () => {
  // Rows 49 to 52: the rule, the pointer with the first row of a long draft, the draft's second row, the rule.
  // How Claude Code 2.1.289 draws a draft of two rows was not recorded. This test needs one thing of it only:
  // the row directly below the pointer row is not a rule row.
  const wrapped = change(S02C, {
    49: RULE,
    50: P + NB + 'a long first line of a prompt that runs to the right edge of the input box and',
    51: '  goes on in a second row',
    52: RULE,
  });
  assert.equal(stateOf(wrapped), 'unknown', 'the cursor on the last row of the draft');
  assert.equal(stateOf(change(wrapped, {}, 50)), 'unknown', 'the cursor on its first row');
});

test('prompt-screen: a short screen is read like a tall one: the two walks above the box end at row 0', () => {
  // 14 rows: the banner, one finished turn, the input box on rows 10 to 12, one status row.
  const short = (map, cursorY) => {
    const rows = new Array(14).fill('');
    for (const [y, text] of Object.entries(map)) rows[Number(y)] = text;
    return { rows, cursorY };
  };
  const SMALL = { 1: BANNER[1], 2: BANNER[2], 3: BANNER[3], 5: echo('Reply with the single word ok'), 7: TURN_1[8],
    10: RULE, 11: P + NB, 12: RULE, 13: STATUS[53] };
  assert.equal(stateOf(short(SMALL, 11)), 'empty');
  assert.equal(stateOf(short({ ...SMALL, 9: S06A.rows[47] }, 11)), 'unknown', 'the working row of the recording, two rows above the box');
  assert.equal(stateOf(short({ ...SMALL, 11: P + NB + 'fix the tests' }, 11)), 'draft');
  // Nothing but blank rows above the box: both walks run to the top of the screen and stop there.
  assert.equal(stateOf({ rows: ['', '', RULE, P + NB, RULE, STATUS[53]], cursorY: 3 }), 'empty');
});

test('prompt-screen: a row that is not text is a doubt, wherever it stands', () => {
  assert.equal(stateOf({ rows: [1, null, {}, 'x'], cursorY: 1 }), 'unknown');
  for (const bad of [null, undefined, 7, {}, ['x']]) {
    assert.equal(stateOf(change(S02C, { 20: bad })), 'unknown', 'row 20 of an empty prompt is ' + JSON.stringify(bad));
  }
});

// ── echoSeen (ready state, commit 3) ───────────────────────────────────────
// P (the pointer) and RULE (a rule row, edge to edge) are declared at the top of this file, by task 07.
const { echoSeen } = require('../public/prompt-screen');
const HANDOFF = 'Write the context handoff now. [ctx-handoff:request]';
// A screen that ends in the input box: `box` are its rows (one, or more when the line wraps).
const screenWith = (box, above = ['\u25cf ok', '', '\u273b Worked for 6s']) => {
  const rows = [...above, RULE, ...box, RULE, '  status'];
  return { rows, cursorY: above.length + box.length };   // the cursor on the last row of the box
};

test('prompt-screen: echoSeen is true when the typed text shows in the input box at the cursor row', () => {
  assert.equal(echoSeen(screenWith([P + '\u00a0/effort ultracode']), '/effort ultracode'), true);
  assert.equal(echoSeen(screenWith([P + '\u00a0' + HANDOFF]), HANDOFF), true);
  assert.equal(echoSeen(screenWith([P + ' ' + HANDOFF.replace(/ /g, '  ')]), HANDOFF), true, 'spacing does not matter');
  assert.equal(echoSeen(screenWith([P + '\u00a0/effort ultracode   a grey suggestion']), '/effort ultracode'), true, 'text after it is allowed');
  assert.equal(echoSeen(screenWith([P + '\u00a0/effort ultracode off']), '/effort ultracode'), true, 'more text after it is not the line a second time');
  // A long line wraps: the rows from the pointer row to the cursor row are read as one.
  assert.equal(echoSeen(screenWith([P + '\u00a0' + HANDOFF.slice(0, 30), HANDOFF.slice(30)]), HANDOFF), true);
  assert.equal(echoSeen(screenWith([P + '\u00a0' + HANDOFF.slice(0, 10), HANDOFF.slice(10, 20), HANDOFF.slice(20, 30), HANDOFF.slice(30)]), HANDOFF), true, 'the pointer row three rows above the cursor');
});

test('prompt-screen: echoSeen is false on every doubt', () => {
  const text = '/effort ultracode';
  assert.equal(echoSeen(screenWith([P + '\u00a0']), text), false, 'an empty box');
  assert.equal(echoSeen(screenWith([P + '\u00a0my own text' + text]), text), false, 'the line typed after a draft');
  assert.equal(echoSeen(screenWith([P + '\u00a0/effort ultra']), text), false, 'only part of it yet');
  // CK-I: the typed line twice in a row. The app's own unsent line was in the box when it was typed again.
  assert.equal(echoSeen(screenWith([P + '\u00a0' + text + text]), text), false, 'the line twice in a row');
  assert.equal(echoSeen(screenWith([P + '\u00a0' + HANDOFF + ' ' + HANDOFF.slice(0, 20), HANDOFF.slice(20)]), HANDOFF), false, 'twice, the second copy wrapped onto the next row');
  assert.equal(echoSeen(screenWith([P + '\u00a0' + text]), ''), false, 'no text to look for');
  assert.equal(echoSeen(null, text), false);
  assert.equal(echoSeen({ rows: null, cursorY: 3 }, text), false);
  assert.equal(echoSeen({ ...screenWith([P + '\u00a0' + text]), cursorY: null }, text), false, 'no cursor row');
  assert.equal(echoSeen({ ...screenWith([P + '\u00a0' + text]), cursorY: 99 }, text), false, 'a cursor row off the screen');
  // A prompt echoed in the conversation starts with the pointer too, but has no rule row above it.
  assert.equal(echoSeen({ rows: ['\u25cf ok', P + ' ' + text, '', RULE, P + '\u00a0', RULE], cursorY: 1 }, text), false);
  // The pointer row more than three rows above the cursor is not looked for.
  const five = [P + '\u00a0' + HANDOFF.slice(0, 10), HANDOFF.slice(10, 20), HANDOFF.slice(20, 30), HANDOFF.slice(30, 40), HANDOFF.slice(40)];
  assert.equal(echoSeen(screenWith(five), HANDOFF), false);
});

test('prompt-screen: echoSeen reads the cursor row, not a menu row under the box', () => {
  const text = '/effort ultracode';
  const menu = (boxText) => {
    const rows = ['\u25cf ok', '', RULE, P + '\u00a0' + boxText, RULE, P + ' /effort ultracode   Turn ultracode on', '  /effort high'];
    return { rows, cursorY: 3 };
  };
  assert.equal(echoSeen(menu(text), text), true, 'the box holds the text; the menu under it does not matter');
  assert.equal(echoSeen(menu(''), text), false, 'the text is only in the menu row');
});

test('prompt-screen: echoSeen is false while a question panel is open above the box', () => {
  const text = '/effort ultracode';
  const rows = ['\u273b Worked for 6s', RULE, '  Do you want to proceed?', '  ' + P + ' 1. Yes', '    2. No', '',
    '  Enter to confirm \u00b7 Esc to cancel', RULE, P + '\u00a0' + text, RULE, '  status'];
  assert.equal(echoSeen({ rows, cursorY: 8 }, text), false, 'the cursor on the box');
  assert.equal(echoSeen({ rows, cursorY: 10 }, text), false, 'the cursor under the box, as the recorded question had it');
  // The same rows without the panel: seen.
  const plain = ['\u273b Worked for 6s', '', '', '', '', '', '', RULE, P + '\u00a0' + text, RULE, '  status'];
  assert.equal(echoSeen({ rows: plain, cursorY: 8 }, text), true);
});
