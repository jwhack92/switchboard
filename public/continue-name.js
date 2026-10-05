// --- Continue name -----------------------------------------------------------
//
// WHY THIS EXISTS
//
// "Continue in new session" (ctx-handoff.js handoffContinue) starts a sibling
// that picks up where a handed-off session stopped. Jason: "the session name
// should be the previous session name with an incrementing number". So
// "Relaunch work" continues as "Relaunch work 2", and that one as "Relaunch
// work 3". A session with no typed name uses the title it was showing.
//
// The one hard case is a title that ends in a number of its own. Jason's
// answer: count up only our own numbers. "Upgrade Electron 41" continues as
// "Upgrade Electron 41 2", not "Upgrade Electron 42". The text cannot say
// which kind of number it is looking at, so this file also keeps the list of
// names Continue has given, by session id. A name is "ours" only while the
// session still carries exactly the name it was given: one Jason has since
// changed by hand is his, and gets " 2" like any other.
//
// The list lives in localStorage, so the rule is the same after a restart and
// in every window. Losing it costs nothing worse than one " 2" where a higher
// number was due.
//
// Pure functions and a store with its Storage injected, so node --test can run
// both. ctx-handoff.js owns the browser side: which session, which title, and
// what counts as taken.

(function () {
  'use strict';

  // What a session with nothing to show is called (app.js launchNewSession
  // gives it as the summary; projects-view.js sessionTitle falls back to it).
  // It says nothing about the work, so there is nothing to carry over.
  const PLACEHOLDER = 'New session';
  // Continue's own numbers start here: the session continued FROM is number 1
  // without saying so.
  const FIRST_NUMBER = 2;
  // A row shows one line and ends in an ellipsis (style.css .session-summary),
  // in a sidebar 340px wide unless it is dragged wider. About this many
  // characters of 13px text fit there with room left for the number, the only
  // part that tells two siblings apart. Worked out from the CSS, not measured.
  const MAX_STEM = 40;
  // How far to count past names that are already in use before giving up.
  const MAX_STEPS = 200;

  const STORE_KEY = 'continue-names';
  const MAX_REMEMBERED = 500;

  // "stem 7": a stem that does not end in a space, one space, a whole number
  // written the way this file writes one (no sign, no leading zero).
  const NUMBERED = /^(.*\S) ([1-9]\d*)$/;

  /** Cut to MAX_STEM code points (a slice by code unit could leave half of an
   *  emoji at the end), and back to the end of a word when the cut falls
   *  inside one, unless that would throw away more than half of the stem. */
  function cutStem(text) {
    const chars = Array.from(text);
    if (chars.length <= MAX_STEM) return text;
    let end = MAX_STEM;
    if (chars[end] !== ' ') {
      const space = chars.lastIndexOf(' ', end - 1);
      if (space >= MAX_STEM / 2) end = space;
    }
    return chars.slice(0, end).join('').trim();
  }

  /**
   * The name for a session continued from one showing `title`, or null when
   * there is nothing worth carrying over (no title, or the placeholder).
   *
   *   ours    the title is a name this file gave (store.isOurs). Only then is
   *           a trailing number counted up; otherwise it is part of the title.
   *   taken   optional, name -> boolean: a session already has this name.
   *           While it does, count up. One that throws counts as "not taken".
   */
  function continuedName(title, opts) {
    const o = opts || {};
    const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (!text || text === PLACEHOLDER) return null;

    let stem = text;
    let n = FIRST_NUMBER;
    const m = o.ours === true ? NUMBERED.exec(text) : null;
    if (m) {
      const last = Number(m[2]);
      // Below FIRST_NUMBER it is not a number Continue wrote, whatever the
      // store says; past the safe integers adding one would not change it.
      if (last >= FIRST_NUMBER && Number.isSafeInteger(last + MAX_STEPS + 1)) {
        stem = m[1];
        n = last + 1;
      }
    }
    stem = cutStem(stem);

    const isTaken = (name) => {
      try { return typeof o.taken === 'function' && o.taken(name) === true; } catch { return false; }
    };
    let name = stem + ' ' + n;
    for (let step = 0; step < MAX_STEPS && isTaken(name); step++) {
      n++;
      name = stem + ' ' + n;
    }
    return name;
  }

  /**
   * The names Continue has given, by session id.
   *
   * `storage` is a Storage (window.localStorage in the app) or nothing. The
   * list is one JSON array of [id, name] pairs under one key, oldest first; an
   * array because "oldest dropped first" needs an order a JSON object does not
   * promise for every key. It is read again on every call, since another
   * window may have written to it.
   *
   * Everything this page has remembered is also kept in a Map, so the rule
   * still holds for the life of the page when storage is missing, full or
   * throws. Anything unreadable in storage reads as an empty list.
   */
  function createStore(storage) {
    const own = new Map();             // id -> name, remembered by this page

    function read() {
      const held = new Map();
      try {
        const parsed = JSON.parse(storage.getItem(STORE_KEY));
        if (Array.isArray(parsed)) {
          for (const pair of parsed) {
            if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0] && typeof pair[1] === 'string') {
              held.set(pair[0], pair[1]);
            }
          }
        }
      } catch {}
      // What this page gave and storage does not hold: a write that failed, or
      // an entry another window has since dropped as the oldest. They go at
      // the OLDEST end, so the next write cannot bring a dropped entry back in
      // place of a newer one.
      const list = new Map();
      for (const [id, name] of own) if (!held.has(id)) list.set(id, name);
      for (const [id, name] of held) list.set(id, name);
      return list;
    }

    /** Continue named session `id` `name`. */
    function remember(id, name) {
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return;
      own.delete(id);
      own.set(id, name);
      while (own.size > MAX_REMEMBERED) own.delete(own.keys().next().value);
      const list = read();
      list.delete(id);                 // to the newest end
      list.set(id, name);
      const pairs = [...list].slice(-MAX_REMEMBERED);
      try { storage.setItem(STORE_KEY, JSON.stringify(pairs)); } catch {}
    }

    /** Session `id` was named by Continue and still carries that name. */
    function isOurs(id, name) {
      if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return false;
      return read().get(id) === name;
    }

    return { remember, isOurs };
  }

  const api = {
    continuedName, createStore,
    PLACEHOLDER, MAX_STEM, MAX_STEPS, STORE_KEY, MAX_REMEMBERED,
  };

  // Expose globally. Guarded, and mirrored onto module.exports, so this file
  // can be required under Node, where `window` does not exist.
  if (typeof window !== 'undefined') window.ContinueName = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
