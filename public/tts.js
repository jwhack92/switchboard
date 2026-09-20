// Speech output, wrapping the Web Speech API.
//
// Measured in this Electron build before this was written: speechSynthesis
// exists, speak() starts with no prior user gesture, and getVoices() returns
// THREE local Windows voices (David, Mark, Zira) — but only about a second after
// page load. The first getVoices() call returns an empty array and two
// voiceschanged events follow. Anything that reads the voice list once at startup
// sees nothing, which is why loadVoices() below waits for the event.
//
// Windows has five SAPI voices installed; Chromium exposes three of them. The
// two "Desktop" variants are not offered, so a stored voice name can legitimately
// fail to resolve — speak() falls back to the default rather than going silent.

(function () {
  'use strict';

  const VOICE_WAIT_MS = 5000;

  let voices = [];
  let voicesPromise = null;
  let current = null;        // the utterance in flight, for cancel()
  let lastError = null;

  function isAvailable() {
    return typeof window !== 'undefined'
      && typeof window.speechSynthesis !== 'undefined'
      && typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  /**
   * Resolve once the voice list is populated. Cached: the browser only fills it
   * once per page, and a voice installed after launch does not appear until the
   * app restarts, so there is nothing to gain from re-asking.
   */
  function loadVoices() {
    if (!isAvailable()) return Promise.resolve([]);
    if (voicesPromise) return voicesPromise;

    voicesPromise = new Promise((resolve) => {
      const read = () => window.speechSynthesis.getVoices() || [];
      const immediate = read();
      if (immediate.length) return resolve(immediate);

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(read());
      };
      window.speechSynthesis.addEventListener('voiceschanged', done);
      // Never hang the caller: an empty list is a valid answer.
      setTimeout(done, VOICE_WAIT_MS);
    }).then((v) => { voices = v; return v; });

    return voicesPromise;
  }

  function listVoices() { return voices.slice(); }

  function resolveVoice(name) {
    if (!name) return null;
    return voices.find(v => v.name === name) || null;
  }

  /**
   * Speak `text`, replacing anything already speaking.
   *
   * Interrupt-and-replace is deliberate: while an agent works, the newest reply
   * is the one that matches what is on screen, and queueing would leave speech
   * narrating history minutes behind the terminal.
   */
  function speak(text, opts) {
    const options = opts || {};
    if (!isAvailable()) return false;
    const say = typeof text === 'string' ? text.trim() : '';
    if (!say) return false;

    cancel();

    try {
      const u = new window.SpeechSynthesisUtterance(say);
      const rate = Number(options.rate);
      if (Number.isFinite(rate) && rate > 0) u.rate = Math.min(Math.max(rate, 0.5), 3);
      const voice = resolveVoice(options.voice);
      if (voice) u.voice = voice;   // unresolved name falls through to the default

      u.onend = () => { if (current === u) current = null; if (options.onend) options.onend(); };
      u.onerror = (e) => {
        // 'interrupted' and 'canceled' are what cancel() itself produces; they
        // are the mechanism working, not a failure worth recording.
        const err = (e && e.error) || 'unknown';
        if (err !== 'interrupted' && err !== 'canceled') lastError = err;
        if (current === u) current = null;
        if (options.onerror) options.onerror(err);
      };

      current = u;
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      current = null;
      return false;
    }
  }

  /** Stop immediately. Safe to call when nothing is speaking. */
  function cancel() {
    if (!isAvailable()) return;
    current = null;
    try { window.speechSynthesis.cancel(); } catch {}
  }

  function isSpeaking() {
    if (!isAvailable()) return false;
    try { return !!window.speechSynthesis.speaking; } catch { return false; }
  }

  function getLastError() { return lastError; }

  window.tts = {
    isAvailable,
    loadVoices,
    listVoices,
    speak,
    cancel,
    isSpeaking,
    getLastError,
  };
})();
