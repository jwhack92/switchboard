const test = require('node:test');
const assert = require('node:assert/strict');

const {
  wordsForSeconds,
  speakableFromEntry,
  extractSpeakable,
  stripForSpeech,
  extractiveSummary,
  fitOrSummarize,
  wordCount,
} = require('../public/speech-text');

// Measured over a real 623-entry transcript: every assistant entry carries
// exactly one content block — 262 tool_use, 195 thinking, 166 text. Only text is
// speakable, which is what these pin.

const textEntry = (s) => ({ type: 'assistant', message: { content: [{ type: 'text', text: s }] } });
const thinkingEntry = (s) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: s }] } });
const toolEntry = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

test('only text blocks are speakable', () => {
  assert.equal(speakableFromEntry(textEntry('hello there')), 'hello there');
  assert.equal(speakableFromEntry(thinkingEntry('internal reasoning')), '');
  assert.equal(speakableFromEntry(toolEntry()), '');
  assert.equal(speakableFromEntry({ type: 'user', message: { content: 'hi' } }), '');
  assert.equal(speakableFromEntry(null), '');
});

test('a turn concatenates its text blocks and drops the rest', () => {
  const turn = [textEntry('First part.'), thinkingEntry('hmm'), toolEntry(), textEntry('Second part.')];
  assert.equal(extractSpeakable(turn), 'First part.\n\nSecond part.');
});

test('a turn that is all tools and thinking yields nothing to say', () => {
  assert.equal(extractSpeakable([thinkingEntry('a'), toolEntry(), toolEntry()]), '');
});

test('fenced code is removed entirely', () => {
  const t = 'Here is the fix.\n\n```js\nconst x = 1;\nfoo(x);\n```\n\nThat should do it.';
  const out = stripForSpeech(t);
  assert.ok(!out.includes('const x'), 'code body must not be spoken');
  assert.ok(out.includes('Here is the fix.'));
  assert.ok(out.includes('That should do it.'));
});

test('an unterminated fence (mid-stream) does not leak code', () => {
  const out = stripForSpeech('Applying it now.\n\n```js\nconst half = tru');
  assert.ok(!out.includes('const half'));
  assert.ok(out.includes('Applying it now.'));
});

test('inline code keeps its words but loses the backticks', () => {
  const out = stripForSpeech('Call `refreshFolder` when it changes.');
  assert.ok(!out.includes('`'));
  assert.ok(out.includes('refreshFolder'));
});

test('paths and file references are not read character by character', () => {
  const out = stripForSpeech('See public/app.js:511 and C:\\Users\\jhack\\thing.txt for detail.');
  assert.ok(!out.includes('app.js'), 'file name should be replaced: ' + out);
  assert.ok(!out.includes('C:\\'), 'windows path should be replaced: ' + out);
  assert.ok(/that file|that path/.test(out));
});

test('markdown furniture is stripped without mangling the sentence', () => {
  const out = stripForSpeech('## Heading\n\n- **bold point** here\n- another');
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('**'));
  assert.ok(out.includes('bold point here'));
});

test('a spoken window converts to a word budget at ~150wpm', () => {
  assert.equal(wordsForSeconds(30), 75);
  assert.equal(wordsForSeconds(60), 150);
  assert.equal(wordsForSeconds(0), 0);
  assert.equal(wordsForSeconds(undefined), 0);
});

test('extractive summary stops on a sentence boundary, never mid-sentence', () => {
  const text = 'One two three four five. Six seven eight nine ten. Eleven twelve thirteen.';
  const out = extractiveSummary(text, 7);
  assert.equal(out, 'One two three four five.');
  assert.ok(!out.endsWith('Six'), 'must not cut mid-sentence');
});

test('a first sentence over budget is returned whole rather than chopped', () => {
  const text = 'This single opening sentence is definitely longer than the tiny budget allows.';
  const out = extractiveSummary(text, 3);
  assert.equal(out, text, 'half a sentence communicates nothing');
});

test('text already within budget is returned in full', () => {
  const text = 'Short enough.';
  assert.equal(extractiveSummary(text, 75), 'Short enough.');
});

test('nothing speakable yields nothing, not punctuation', () => {
  assert.equal(extractiveSummary('```\ncode only\n```', 75), '');
  assert.equal(stripForSpeech(''), '');
});

test('fitOrSummarize speaks short prose directly and defers long prose', () => {
  const short = fitOrSummarize('A brief answer.', 75);
  assert.equal(short.needsSummary, false);
  assert.equal(short.speak, 'A brief answer.');

  const long = fitOrSummarize(Array.from({ length: 200 }, (_, i) => 'word' + i).join(' '), 75);
  assert.equal(long.needsSummary, true);
  assert.equal(long.speak, null, 'a truncation must not masquerade as the answer');
  assert.ok(wordCount(long.clean) > 75, 'the full text is handed on for summarizing');
});

test('a code-only turn needs no summary and says nothing', () => {
  const r = fitOrSummarize('```js\nconst a = 1;\n```', 75);
  assert.equal(r.needsSummary, false);
  assert.equal(r.speak, '');
});
