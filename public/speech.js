// Decides what gets said, and for which session.
//
// Kept out of app.js on purpose: app.js is in the 24-file collision set for the
// pending upstream rebase, so the logic lives here and app.js only gains a few
// call sites.
//
// Two things get spoken. A background session gets a short alert — "pr-review
// needs plan approval" — built from signals already in the renderer. The FOCUSED
// session gets its actual reply, which is not in the renderer at all: the
// terminal stream is escape sequences, so the prose comes from the transcript on
// disk via the speech-new-text IPC, and is summarised when it will not fit the
// spoken window.

(function () {
  'use strict';

  const STORE_ENABLED = 'speechEnabled';
  const STORE_MUTED = 'speechMutedSessions';

  // localStorage, not sessionStorage: this survives the renderer reloads that
  // electron-reloader fires on every file save, which sessionStorage would not.
  // Phase 2 moves the enabled flag into real settings; the muted set stays here
  // because there is no per-session settings table.
  function readStore(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }
  function writeStore(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  let enabled = readStore(STORE_ENABLED, false) === true;
  const muted = new Set(Array.isArray(readStore(STORE_MUTED, [])) ? readStore(STORE_MUTED, []) : []);

  const spokenBytes = new Map();   // sessionId -> byte offset already spoken
  const turnToken = new Map();     // sessionId -> generation, to drop stale summaries

  // Voice and rate are needed on the synchronous alert path, which cannot await
  // an IPC, so the last known settings are kept here and refreshed on the async
  // reply path and at load.
  let cachedSettings = {};

  function isEnabled() { return enabled; }

  function setEnabled(value) {
    enabled = !!value;
    writeStore(STORE_ENABLED, enabled);
    if (!enabled) cancel();
    return enabled;
  }

  function isMuted(sessionId) { return muted.has(sessionId); }

  function toggleMuted(sessionId) {
    if (muted.has(sessionId)) muted.delete(sessionId);
    else { muted.add(sessionId); cancel(); }
    writeStore(STORE_MUTED, [...muted]);
    return muted.has(sessionId);
  }

  /** A session is spoken for only when speech is on, it is not muted, and the
   *  engine actually works in this build. */
  function shouldSpeakFor(sessionId) {
    if (!enabled) return false;
    if (muted.has(sessionId)) return false;
    if (!window.tts || !window.tts.isAvailable()) return false;
    return true;
  }

  /**
   * Turn a CLI notification into a few spoken words.
   *
   * The four messages the CLI actually emits are enumerated in app.js above the
   * OSC 9 handler. Read verbatim they are long and all start the same way, so
   * they collapse to the part that differs — what it wants from you.
   */
  function stateFromMessage(message) {
    const m = typeof message === 'string' ? message : '';
    if (/approval for the plan/i.test(m)) return 'needs plan approval';
    if (/wants to enter plan mode/i.test(m)) return 'wants to enter plan mode';
    if (/permission to use/i.test(m)) return 'needs permission';
    if (/waiting for your input/i.test(m)) return 'is waiting for you';
    if (/needs your attention/i.test(m)) return 'needs your attention';
    return 'needs your input';
  }

  function say(text) {
    if (!window.tts) return false;
    return window.tts.speak(text, speakOpts(cachedSettings));
  }

  /** A background session wants something. */
  function announceAttention(sessionId, name, message) {
    if (!shouldSpeakFor(sessionId)) return false;
    const who = (name || 'a session').trim();
    return say(who + ' ' + stateFromMessage(message) + '.');
  }

  /** A background session finished its turn. */
  function announceFinished(sessionId, name) {
    if (!shouldSpeakFor(sessionId)) return false;
    const who = (name || 'a session').trim();
    return say(who + ' finished.');
  }

  /** Barge-in. Called when you start talking, press Escape, or switch sessions. */
  function cancel() {
    if (window.tts) window.tts.cancel();
    // Any summary still in flight belongs to a turn you are no longer listening
    // to. Bumping the token makes its result arrive stale and be dropped.
    for (const id of turnToken.keys()) turnToken.set(id, (turnToken.get(id) || 0) + 1);
  }

  // --- Speaking the focused session's actual reply -------------------------
  //
  // The text is not in the renderer — the terminal stream is escape sequences,
  // not prose — so it comes from the transcript through speech-new-text. Each
  // session keeps a byte offset; the first call for a session returns a baseline
  // and no text, so switching the feature on never reads the backlog aloud.

  async function currentSettings() {
    try {
      const s = await window.api.getEffectiveSettings(null);
      if (s) cachedSettings = s;
    } catch {}
    return cachedSettings;
  }

  function speakOpts(settings) {
    return { rate: Number(settings.speechRate) || 1, voice: settings.speechVoice || '' };
  }

  /**
   * Called when the FOCUSED session finishes a turn.
   *
   * Measured on real transcripts: the median reply is ~88 seconds of speech and
   * 26 of 28 turns exceed 30, so the summarizer is the normal path rather than
   * an exception. A reply that already fits is spoken verbatim.
   */
  async function speakReply(sessionId) {
    if (!shouldSpeakFor(sessionId)) return;

    const settings = await currentSettings();
    if (settings.speakReplies !== 'focused') return;

    const token = (turnToken.get(sessionId) || 0) + 1;
    turnToken.set(sessionId, token);
    const stale = () => turnToken.get(sessionId) !== token || !shouldSpeakFor(sessionId);

    let res;
    try {
      res = await window.api.speechNewText(sessionId, spokenBytes.get(sessionId));
    } catch { return; }
    if (!res || res.error) return;

    spokenBytes.set(sessionId, res.bytes);
    if (res.baseline || !res.text) return;   // first sighting, or a tools-only turn
    if (stale()) return;

    const maxWords = window.speechText.wordsForSeconds(Number(settings.speechWindowSec) || 30);
    const fit = window.speechText.fitOrSummarize(res.text, maxWords);

    if (!fit.needsSummary) {
      if (fit.speak) window.tts.speak(fit.speak, speakOpts(settings));
      return;
    }

    let spokenText = '';
    try {
      const sum = await window.api.speechSummarize(fit.clean, maxWords);
      if (sum && sum.summary) spokenText = sum.summary;
    } catch { /* fall through to extractive */ }

    // Any failure — HALT engaged, timeout, no output — degrades to the local
    // summary rather than going silent.
    if (!spokenText) spokenText = window.speechText.extractiveSummary(fit.clean, maxWords);

    if (stale() || !spokenText) return;
    window.tts.speak(spokenText, speakOpts(settings));
  }

  /**
   * Start the summarizer ahead of need, when the focused session begins working.
   *
   * Gated on speech actually being on and replies actually being enabled, so a
   * user who only wants background alerts never spawns a summarizer at all.
   * Uses the cached settings rather than awaiting, because this fires on a hot
   * path and being a turn late here costs nothing.
   */
  function warmUp() {
    if (!enabled) return;
    if (cachedSettings.speakReplies !== 'focused') return;
    if (!window.tts || !window.tts.isAvailable()) return;
    if (!window.api || !window.api.speechWarmUp) return;
    window.api.speechWarmUp().catch(() => {});
  }

  /** Forget a session's offset, so a re-opened session re-baselines. */
  function forget(sessionId) {
    spokenBytes.delete(sessionId);
    turnToken.delete(sessionId);
  }

  // Prime the settings cache; the first alert can arrive before any reply does.
  if (window.api && window.api.getEffectiveSettings) {
    window.api.getEffectiveSettings(null).then((s) => { if (s) cachedSettings = s; }).catch(() => {});
  }

  window.speech = {
    speakReply,
    warmUp,
    forget,
    isEnabled,
    setEnabled,
    isMuted,
    toggleMuted,
    shouldSpeakFor,
    stateFromMessage,
    announceAttention,
    announceFinished,
    cancel,
  };
})();
