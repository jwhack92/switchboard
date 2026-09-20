// Decides what gets said, and for which session.
//
// Kept out of app.js on purpose: app.js is in the 24-file collision set for the
// pending upstream rebase, so the logic lives here and app.js only gains a few
// call sites.
//
// PHASE 1 SCOPE. This speaks alerts for background sessions only — "pr-review
// needs your input". Speaking the focused session's actual reply needs the text,
// which lives in the transcript on disk and therefore needs a main-process IPC;
// that is phase 2. The focused session is deliberately silent for now rather than
// being given a content-free "finished" it would only interrupt you with.

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
    return window.tts.speak(text, {});
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
  }

  window.speech = {
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
