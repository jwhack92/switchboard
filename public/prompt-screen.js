// --- Prompt screen -----------------------------------------------------------
//
// The marks that describe Claude Code's screen: the input box between its two
// rule rows, the pointer, a question panel, a working line. PROMPT_MARKS says
// which Claude Code version they were read on; they are edited at every redraw
// of the program. promptScreen reads one screen with them and says what it
// shows: an empty prompt, text in the input box, a question, or "unknown".
//
// Loaded directly before ctx-handoff.js, which reads the session's screen
// through window.PromptScreen. ultracodeScreen in ctx-handoff.js is the other
// reader of program text.
//
// Every mark that is missing or changed moves the answer away from 'empty', so
// a new program version can only make the buttons ask more, never type on a
// screen that is not an empty prompt.

(function () {
  'use strict';

  const PROMPT_MARKS = Object.freeze({
    readOn: '2.1.289',
    POINTER: '❯',
    RULE: /^─{10,}/,                       // a row that starts at column 0 with at least 10 line characters
    FULL_RULE: /^─{20,}\s*$/,              // a row of line characters only
    QUESTION: Object.freeze([/^\s*❯\s*\d+\.\s/, /Enter to confirm/, /Esc to cancel/]),
    WORKING: /^\s{0,2}[^\s\w]\s+\S[^(…]{0,60}…/u,   // one symbol, a space, a short text, then an ellipsis
  });

  const blank = (row) => row.trim() === '';
  const isQuestion = (row) => PROMPT_MARKS.QUESTION.some((mark) => mark.test(row));

  function panelAbove(rows, P) {
    for (let y = P - 2; y >= Math.max(0, P - 16); y--) {
      const row = rows[y];
      if (PROMPT_MARKS.FULL_RULE.test(row)) {
        for (let z = y + 1; z < P - 1; z++) {
          if (!blank(rows[z])) return y;
        }
        return -1;
      }
      if (!blank(row) && row[0] !== ' ') return -1;
    }
    return -1;
  }

  function promptScreen(read) {
    try {
      if (!read || typeof read !== 'object' || !Array.isArray(read.rows) || read.rows.length < 3) {
        return { state: 'unknown', why: 'no screen to read' };
      }
      const rows = read.rows;
      for (let y = 0; y < rows.length; y++) {
        if (typeof rows[y] !== 'string') return { state: 'unknown', why: 'row ' + y + ' is not text' };
      }

      const boxes = [];
      for (let y = 1; y < rows.length - 1; y++) {
        if (rows[y].startsWith(PROMPT_MARKS.POINTER)
          && PROMPT_MARKS.RULE.test(rows[y - 1]) && PROMPT_MARKS.RULE.test(rows[y + 1])) boxes.push(y);
      }
      if (boxes.length > 1) return { state: 'unknown', why: 'more than one input box' };

      if (boxes.length === 0) {
        for (let y = Math.max(0, rows.length - 20); y < rows.length; y++) {
          if (isQuestion(rows[y])) return { state: 'question', why: 'no input box, question words in row ' + y };
        }
        return { state: 'unknown', why: 'no input box' };
      }

      const P = boxes[0];
      const panelTop = panelAbove(rows, P);

      const cursorY = read.cursorY;
      const cursorKnown = typeof cursorY === 'number';
      if (panelTop >= 0) {
        if (cursorKnown && cursorY !== P) {
          for (let y = panelTop + 1; y < P - 1; y++) {
            if (isQuestion(rows[y])) return { state: 'question', why: 'a question panel above the box, row ' + y };
          }
        }
        return { state: 'unknown', why: 'a panel above the input box' };
      }

      if (!cursorKnown || cursorY !== P) return { state: 'unknown', why: 'the cursor is not in the input box' };

      for (let y = P - 2; y >= Math.max(0, P - 21); y--) {
        if (PROMPT_MARKS.WORKING.test(rows[y])) return { state: 'unknown', why: 'a working line in row ' + y };
      }

      if (rows[P].slice(PROMPT_MARKS.POINTER.length).trim() !== '') return { state: 'draft', why: 'text in the input box' };
      return { state: 'empty', why: 'an empty input box' };
    } catch {
      return { state: 'unknown', why: 'the screen could not be read' };
    }
  }

  function echoSeen(read, text) {
    try {
      if (!read || typeof read !== 'object' || !Array.isArray(read.rows) || typeof text !== 'string') return false;
      const rows = read.rows;
      const cursorY = read.cursorY;
      if (!Number.isInteger(cursorY) || cursorY < 0 || cursorY >= rows.length) return false;
      const typed = text.replace(/\s/g, '');
      if (typed === '') return false;

      let top = -1;
      for (let y = cursorY; y >= Math.max(1, cursorY - 3); y--) {
        if (rows[y].startsWith(PROMPT_MARKS.POINTER) && PROMPT_MARKS.RULE.test(rows[y - 1])) { top = y; break; }
      }
      if (top < 0) return false;

      const box = rows.slice(top, cursorY + 1).join('').slice(PROMPT_MARKS.POINTER.length).replace(/\s/g, '');
      if (!box.startsWith(typed)) return false;
      if (panelAbove(rows, top) >= 0) return false;
      if (box.slice(typed.length).startsWith(typed)) return false;
      return true;
    } catch {
      return false;
    }
  }

  const api = { PROMPT_MARKS, promptScreen, echoSeen };

  // Expose globally. Guarded, and mirrored onto module.exports, so this file
  // can be required under Node, where `window` does not exist.
  if (typeof window !== 'undefined') window.PromptScreen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
