const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const TTS_PATH = path.join(__dirname, '..', 'public', 'tts.js');

// tts.js is a classic script that assigns window.tts at load, so each test gets a
// fresh fake window and a fresh module instance.
function load({ voices = [], available = true } = {}) {
  const spoken = [];
  const cancels = [];
  const listeners = new Map();
  let voiceList = voices;

  class FakeUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.voice = null; }
  }

  const synth = {
    speaking: false,
    getVoices: () => voiceList,
    speak(u) { spoken.push(u); this.speaking = true; },
    cancel() { cancels.push(Date.now()); this.speaking = false; },
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = listeners.get(ev) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };

  global.window = available
    ? { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }
    : {};

  delete require.cache[require.resolve(TTS_PATH)];
  require(TTS_PATH);

  return {
    tts: global.window.tts,
    spoken,
    cancels,
    setVoices(v) { voiceList = v; },
    fire(ev) { for (const fn of (listeners.get(ev) || []).slice()) fn(); },
  };
}

test.afterEach(() => { delete global.window; });

const voice = (name) => ({ name, lang: 'en-US' });

test('reports unavailable when the API is missing rather than throwing', () => {
  const { tts } = load({ available: false });
  assert.equal(tts.isAvailable(), false);
  assert.equal(tts.speak('hello'), false);
  assert.doesNotThrow(() => tts.cancel());
  assert.equal(tts.isSpeaking(), false);
});

test('voices already present resolve without waiting for the event', async () => {
  const { tts } = load({ voices: [voice('David'), voice('Zira')] });
  const v = await tts.loadVoices();
  assert.equal(v.length, 2);
  assert.deepEqual(tts.listVoices().map(x => x.name), ['David', 'Zira']);
});

// The measured behaviour in this Electron build: getVoices() is empty on the
// first call and two voiceschanged events follow about a second later.
test('an initially empty voice list is filled by voiceschanged', async () => {
  const h = load({ voices: [] });
  const pending = h.tts.loadVoices();
  h.setVoices([voice('David'), voice('Mark'), voice('Zira')]);
  h.fire('voiceschanged');
  const v = await pending;
  assert.equal(v.length, 3);
  assert.deepEqual(h.tts.listVoices().map(x => x.name), ['David', 'Mark', 'Zira']);
});

test('speaking replaces whatever is already speaking', () => {
  const h = load({ voices: [voice('David')] });
  h.tts.speak('first');
  h.tts.speak('second');
  assert.equal(h.spoken.length, 2);
  assert.equal(h.spoken[1].text, 'second');
  assert.ok(h.cancels.length >= 2, 'each speak cancels first, so the newest always wins');
});

test('empty or whitespace text says nothing', () => {
  const h = load();
  assert.equal(h.tts.speak(''), false);
  assert.equal(h.tts.speak('   '), false);
  assert.equal(h.tts.speak(null), false);
  assert.equal(h.spoken.length, 0);
});

test('a named voice is selected when it exists', async () => {
  const h = load({ voices: [voice('David'), voice('Zira')] });
  await h.tts.loadVoices();
  h.tts.speak('hi', { voice: 'Zira' });
  assert.equal(h.spoken[0].voice.name, 'Zira');
});

// Windows has five SAPI voices but Chromium exposes only three, so a stored name
// can legitimately stop resolving.
test('an unknown voice name falls back to the default instead of going silent', async () => {
  const h = load({ voices: [voice('David')] });
  await h.tts.loadVoices();
  const ok = h.tts.speak('hi', { voice: 'Microsoft Zira Desktop' });
  assert.equal(ok, true, 'it must still speak');
  assert.equal(h.spoken[0].voice, null, 'with no voice set, i.e. the default');
});

test('rate is clamped to a sane range', () => {
  const h = load();
  h.tts.speak('a', { rate: 99 });
  h.tts.speak('b', { rate: 0.01 });
  h.tts.speak('c', { rate: 1.4 });
  assert.equal(h.spoken[0].rate, 3);
  assert.equal(h.spoken[1].rate, 0.5);
  assert.equal(h.spoken[2].rate, 1.4);
});

test('a cancel-induced error is not recorded as a failure', () => {
  const h = load();
  h.tts.speak('a');
  h.spoken[0].onerror({ error: 'interrupted' });
  assert.equal(h.tts.getLastError(), null, 'interruption is the mechanism working');

  h.tts.speak('b');
  h.spoken[1].onerror({ error: 'synthesis-failed' });
  assert.equal(h.tts.getLastError(), 'synthesis-failed', 'a real failure is kept');
});

test('onend is delivered to the caller', () => {
  const h = load();
  let ended = false;
  h.tts.speak('a', { onend: () => { ended = true; } });
  h.spoken[0].onend();
  assert.equal(ended, true);
});
