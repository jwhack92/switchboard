// Turning a Claude turn into something worth listening to.
//
// Pure functions, no DOM and no Electron, so they can be unit-tested under plain
// node. Loaded as a classic script in the renderer and required directly by the
// tests; the export shim at the bottom serves both.
//
// What a transcript actually looks like, measured over a real 623-entry session:
// every assistant entry carries exactly ONE content block — 262 tool_use, 195
// thinking, 166 text. So "the reply" is the run of text blocks in a turn, and
// thinking and tool calls are not part of it.

(function (root) {
  'use strict';

  const WORDS_PER_SECOND = 2.5;   // ~150 wpm, a normal speaking pace

  /** How many words fit in a spoken window of `seconds`. */
  function wordsForSeconds(seconds) {
    const n = Math.floor((Number(seconds) || 0) * WORDS_PER_SECOND);
    return n > 0 ? n : 0;
  }

  /**
   * The speakable text of one assistant entry, or '' if it has none.
   * Only `text` blocks count: `thinking` is internal reasoning and `tool_use` is
   * machinery, and reading either aloud is noise.
   */
  function speakableFromEntry(entry) {
    if (!entry || entry.type !== 'assistant') return '';
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }

  /** Speakable text across a run of entries (one turn). */
  function extractSpeakable(entries) {
    if (!Array.isArray(entries)) return '';
    const parts = [];
    for (const e of entries) {
      const t = speakableFromEntry(e);
      if (t) parts.push(t);
    }
    return parts.join('\n\n');
  }

  /**
   * Strip what should not be read aloud.
   *
   * Fenced code goes entirely — a spoken code block is unintelligible and long.
   * Inline code and bare paths are replaced rather than dropped, because they
   * usually sit mid-sentence and removing them outright mangles the grammar.
   */
  function stripForSpeech(text) {
    if (typeof text !== 'string' || !text) return '';
    let out = text;

    out = out.replace(/```[\s\S]*?```/g, ' ');       // fenced blocks
    out = out.replace(/```[\s\S]*$/g, ' ');          // unterminated fence (streaming)
    out = out.replace(/`([^`\n]*)`/g, ' $1 ');       // inline code keeps its words
    // Indented code blocks. [ \t] and not \s: \s matches newlines, so `\s{4,}`
    // spans the blank lines around a paragraph and eats the paragraph with it.
    out = out.replace(/^[ \t]{4,}\S.*$/gm, ' ');

    // Markdown furniture that reads badly.
    out = out.replace(/^#{1,6}\s+/gm, '');           // heading markers
    out = out.replace(/^\s*[-*+]\s+/gm, '');         // bullet markers
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');     // bold
    out = out.replace(/(^|\W)\*([^*\n]+)\*/g, '$1$2'); // italic
    out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links keep their label

    // A path or a file:line reference read character by character is unbearable.
    out = out.replace(/\b[A-Za-z]:\\[^\s]+/g, ' that path ');     // C:\...
    out = out.replace(/(^|\s)[.~]?\/[^\s]{2,}/g, '$1 that path '); // /a/b, ./a
    out = out.replace(/\b[\w.-]+\.(js|ts|json|md|css|html|ps1|py|java|rpgle)\b(:\d+)?/gi, ' that file ');

    out = out.replace(/\s+/g, ' ').trim();
    return out;
  }

  /** Split into sentences, keeping terminators. */
  function sentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
    return parts ? parts.map(s => s.trim()).filter(Boolean) : [];
  }

  function wordCount(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  /**
   * Fallback summary: whole sentences from the front, up to `maxWords`.
   *
   * Never cuts mid-sentence — a spoken fragment that stops dead is worse than a
   * shorter complete one. If even the first sentence is over budget it is
   * returned whole, because half a sentence communicates nothing.
   */
  function extractiveSummary(text, maxWords) {
    const clean = stripForSpeech(text);
    if (!clean) return '';
    const budget = Number(maxWords) || 0;
    if (budget <= 0) return '';
    if (wordCount(clean) <= budget) return clean;

    const out = [];
    let used = 0;
    for (const s of sentences(clean)) {
      const n = wordCount(s);
      if (out.length && used + n > budget) break;
      out.push(s);
      used += n;
      if (used >= budget) break;
    }
    return out.join(' ').trim();
  }

  /**
   * What to actually speak for a turn: the prose if it already fits the window,
   * otherwise null to signal that a real summary is needed. Returning null
   * rather than a truncation keeps the "summarize vs speak in full" decision in
   * one place.
   */
  function fitOrSummarize(text, maxWords) {
    const clean = stripForSpeech(text);
    if (!clean) return { speak: '', needsSummary: false };
    if (wordCount(clean) <= (Number(maxWords) || 0)) {
      return { speak: clean, needsSummary: false };
    }
    return { speak: null, needsSummary: true, clean };
  }

  const api = {
    WORDS_PER_SECOND,
    wordsForSeconds,
    speakableFromEntry,
    extractSpeakable,
    stripForSpeech,
    extractiveSummary,
    fitOrSummarize,
    sentences,
    wordCount,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.speechText = api;
})(typeof window !== 'undefined' ? window : null);
