// JSON reader: a collapsible tree for .json and .jsonc files, shown by the
// viewer's Preview button next to the editor.
//
// Parsing is jsonc-parser, VS Code's parser. Its tree keeps what JSON.parse
// loses and a reader should show: key order, duplicate keys, and exact
// numbers, taken from the file's own text because the parsed value is
// rounded. Its errors carry offsets; V8's JSON.parse messages often have
// none. .jsonc allows comments and trailing commas; .json stays strict.
//
// This fork does not depend on jsonc-parser yet, and nothing here may add the
// dependency. So the parser is resolved lazily and its absence is a degraded
// mode, not a load-time crash: JSON.parse stands in for strict .json, the
// result is tagged `degraded`, and .jsonc (which JSON.parse cannot read) is
// reported as needing the module. Once jsonc-parser is installed and the
// renderer bundle exposes window.JsoncParser, the full path resumes with no
// change here. Resolution is lazy rather than load-time so the bundle's
// <script> tag does not have to precede this file's.
//
// Children are built when a node is first opened, so a large file costs only
// what is on screen.
(function (root) {
  // jsonc-parser recurses once per level and overflows the stack on very deep
  // input, so deeper than this is reported as an error before it parses.
  const MAX_DEPTH = 512;
  // The top level opens its containers only while there are few of them.
  const AUTO_OPEN_CHILDREN = 20;
  // jsonc-parser's error codes, in words.
  const MESSAGES = {
    InvalidSymbol: 'Unexpected character',
    InvalidNumberFormat: 'Invalid number',
    PropertyNameExpected: 'Expected a property name in double quotes',
    ValueExpected: 'Expected a value',
    ColonExpected: "Expected ':' after the property name",
    CommaExpected: "Expected ','",
    CloseBraceExpected: "Expected '}'",
    CloseBracketExpected: "Expected ']'",
    EndOfFileExpected: 'Unexpected content after the end of the JSON value',
    InvalidCommentToken: 'Comments are not allowed in .json (they are in .jsonc)',
    UnexpectedEndOfComment: 'Unterminated comment',
    UnexpectedEndOfString: 'Unterminated string',
    UnexpectedEndOfNumber: 'Invalid number',
    InvalidUnicode: 'Invalid \\u escape',
    InvalidEscapeCharacter: 'Invalid escape',
    InvalidCharacter: 'Unescaped control character in a string',
  };
  const DEGRADED_NOTE = 'jsonc-parser is not installed, so this is JSON.parse: '
    + 'duplicate keys and exact number text are not shown.';

  // ── Parser resolution ─────────────────────────────────────────────

  /** The module, or null. Only a successful lookup is remembered. */
  let jsoncCache = null;

  function usable(candidate) {
    return !!candidate
      && typeof candidate.createScanner === 'function'
      && typeof candidate.parseTree === 'function'
      && typeof candidate.printParseErrorCode === 'function'
      && !!candidate.SyntaxKind;
  }

  function getJsonc() {
    if (jsoncCache) return jsoncCache;
    let found = null;
    // Renderer first: contextIsolation leaves no require(), and the bundle
    // publishes the module as a global.
    if (usable(root && root.JsoncParser)) {
      found = root.JsoncParser;
    } else if (typeof require === 'function') {
      try {
        const loaded = require('jsonc-parser');
        if (usable(loaded)) found = loaded;
      } catch {
        found = null;
      }
    }
    if (found) jsoncCache = found;
    return found;
  }

  function isJsoncAvailable() {
    return !!getJsonc();
  }

  // ── Parsing ───────────────────────────────────────────────────────

  /** Offset where nesting first passes MAX_DEPTH, or -1. The scanner does not recurse. */
  function tooDeepAt(jsonc, text) {
    const scanner = jsonc.createScanner(text, true);
    const K = jsonc.SyntaxKind;
    let depth = 0;
    for (let token = scanner.scan(); token !== K.EOF; token = scanner.scan()) {
      if (token === K.OpenBraceToken || token === K.OpenBracketToken) {
        if (++depth > MAX_DEPTH) return scanner.getTokenOffset();
      } else if (token === K.CloseBraceToken || token === K.CloseBracketToken) {
        depth--;
      }
    }
    return -1;
  }

  /** jsonc-parser's nodes into the reader's own shape. Only called on a tree without errors. */
  function convert(node, text) {
    switch (node.type) {
      case 'object':
        return { type: 'object', entries: (node.children || []).map(property => ({
          key: property.children[0].value, value: convert(property.children[1], text),
        })) };
      case 'array':
        return { type: 'array', items: (node.children || []).map(child => convert(child, text)) };
      case 'number':
        return { type: 'number', text: text.slice(node.offset, node.offset + node.length) };
      case 'string':
      case 'boolean':
        return { type: node.type, value: node.value };
      default:
        return { type: 'null' };
    }
  }

  // Degraded mode only. JSON.parse hands back a plain value, so the tree is
  // built from the value and the same depth ceiling has to be enforced here —
  // this conversion recurses where tooDeepAt() did not.
  const TOO_DEEP = Symbol('too deep');

  function numberText(value) {
    // JSON.parse('-0') is -0, and String(-0) is '0'.
    return Object.is(value, -0) ? '-0' : String(value);
  }

  function fromValue(value, depth) {
    if (depth > MAX_DEPTH) throw TOO_DEEP;
    if (value === null || value === undefined) return { type: 'null' };
    if (Array.isArray(value)) {
      return { type: 'array', items: value.map(item => fromValue(item, depth + 1)) };
    }
    switch (typeof value) {
      case 'object':
        return { type: 'object', entries: Object.keys(value).map(key => ({
          key, value: fromValue(value[key], depth + 1),
        })) };
      case 'number':
        return { type: 'number', text: numberText(value) };
      case 'string':
        return { type: 'string', value };
      case 'boolean':
        return { type: 'boolean', value };
      default:
        return { type: 'null' };
    }
  }

  /**
   * V8 says "Expected ':' after property name in JSON at position 5 (line 1
   * column 6)", or "Unexpected non-whitespace character after JSON at
   * position 8 (...)", or "Unexpected token '/', \"// c\" is not valid JSON"
   * with no position at all. Take the offset when it is there, and drop the
   * tail — this reader reports line and column itself. endOffset is where an
   * unexpected end of input happened: the end.
   */
  function fromJsonParseError(err, endOffset) {
    const raw = String((err && err.message) || 'Invalid JSON');
    const at = /at position (\d+)/.exec(raw);
    const message = raw
      .replace(/\s+(in|after) JSON at position[\s\S]*$/, '')
      .replace(/,\s*(\.\.\.)?"[\s\S]*$/, '')
      .trim();
    const offset = at ? Number(at[1])
      : /end of (JSON input|data)/i.test(raw) ? endOffset
      : 0;
    return { message: message || raw, offset };
  }

  /** 1-based line and column of an offset, counted the way the editor counts. */
  function lineColumn(text, offset) {
    let line = 1;
    let lineStart = 0;
    for (let k = 0; k < offset && k < text.length; k++) {
      if (text.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
    }
    return { line, column: offset - lineStart + 1 };
  }

  /**
   * { ok: true, root } or { ok: false, message, offset, line, column }.
   * comments: true reads JSONC (comments and trailing commas allowed).
   *
   * Without jsonc-parser a successful result also carries
   * { degraded: <reason> }; callers that ignore it still work.
   */
  function parseJsonForReader(text, { comments = false } = {}) {
    const source = String(text ?? '');
    // A byte order mark is not JSON, but editors write one; read past it and
    // keep reported positions in terms of the file as the editor shows it.
    const skip = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    const body = skip ? source.slice(1) : source;
    const fail = (message, offset) => ({ ok: false, message, offset: offset + skip, ...lineColumn(source, offset + skip) });

    const jsonc = getJsonc();
    if (!jsonc) return parseWithoutJsonc(body, comments, fail);

    const deep = tooDeepAt(jsonc, body);
    if (deep >= 0) return fail(`Nested more than ${MAX_DEPTH} levels, too deep to show`, deep);
    const errors = [];
    const tree = jsonc.parseTree(body, errors, { disallowComments: !comments, allowTrailingComma: comments, allowEmptyContent: false });
    if (errors.length) {
      const code = jsonc.printParseErrorCode(errors[0].error);
      return fail(MESSAGES[code] || code, errors[0].offset);
    }
    if (!tree) return fail('Expected a value', 0);
    return { ok: true, root: convert(tree, body) };
  }

  function parseWithoutJsonc(body, comments, fail) {
    // allowEmptyContent: false, said the same way.
    if (!body.trim()) return fail('Expected a value', 0);
    try {
      return { ok: true, root: fromValue(JSON.parse(body), 0), degraded: DEGRADED_NOTE };
    } catch (err) {
      // fromValue recurses where jsonc's scanner did not, so the ceiling is
      // enforced by the conversion rather than ahead of the parse. V8's own
      // stack overflow on very deep input is a RangeError, reported as-is.
      if (err === TOO_DEEP) return fail(`Nested more than ${MAX_DEPTH} levels, too deep to show`, 0);
      const { message, offset } = fromJsonParseError(err, body.length);
      // JSON.parse rejects comments and trailing commas, which is the whole
      // point of .jsonc. Do not let its message blame the file alone.
      return fail(comments
        ? `${message} — comments and trailing commas need jsonc-parser, which is not installed`
        : message, offset);
    }
  }

  // ── Tree ──────────────────────────────────────────────────────────

  function childCount(node) {
    if (node.type === 'object') return node.entries.length;
    if (node.type === 'array') return node.items.length;
    return 0;
  }

  function scalarText(node) {
    if (node.type === 'string') return JSON.stringify(node.value);
    if (node.type === 'number') return node.text;
    if (node.type === 'boolean') return String(node.value);
    return 'null';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendKey(row, key) {
    if (!key) return;
    const label = el('span', key.index ? 'json-reader-key json-reader-index' : 'json-reader-key',
      key.index ? String(key.name) : JSON.stringify(key.name));
    if (key.duplicate) {
      label.className += ' json-reader-dup';
      label.setAttribute('title', 'Duplicate key. Most JSON readers keep only the last one.');
    }
    row.appendChild(label);
    row.appendChild(el('span', 'json-reader-colon', ': '));
  }

  function buildNode(node, key, path, depth, state, firstRender, siblings) {
    if (node.type !== 'object' && node.type !== 'array') {
      const row = el('div', 'json-reader-row json-reader-leaf');
      appendKey(row, key);
      row.appendChild(el('span', `json-reader-value json-reader-${node.type}`, scalarText(node)));
      return row;
    }
    const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
    const count = childCount(node);
    if (!count) {
      const row = el('div', 'json-reader-row json-reader-leaf');
      appendKey(row, key);
      row.appendChild(el('span', 'json-reader-brace', open + close));
      return row;
    }

    const details = el('details', 'json-reader-node');
    const summary = el('summary', 'json-reader-row');
    appendKey(summary, key);
    summary.appendChild(el('span', 'json-reader-brace', `${open}…${close}`));
    const noun = node.type === 'object' ? (count === 1 ? 'key' : 'keys') : (count === 1 ? 'item' : 'items');
    summary.appendChild(el('span', 'json-reader-count', `${count} ${noun}`));
    details.appendChild(summary);
    const body = el('div', 'json-reader-children');
    details.appendChild(body);

    let built = false;
    const buildChildren = () => {
      if (built) return;
      built = true;
      if (node.type === 'array') {
        node.items.forEach((item, index) => {
          body.appendChild(buildNode(item, { name: index, index: true }, `${path}/${index}`, depth + 1, state, firstRender, count));
        });
        return;
      }
      const totals = new Map();
      for (const entry of node.entries) totals.set(entry.key, (totals.get(entry.key) || 0) + 1);
      const seen = new Map();
      for (const entry of node.entries) {
        const nth = seen.get(entry.key) || 0;
        seen.set(entry.key, nth + 1);
        // encodeURIComponent never emits '#', so a duplicate's marker cannot
        // collide with another key's name.
        const childPath = `${path}/${encodeURIComponent(entry.key)}${nth ? `#${nth}` : ''}`;
        body.appendChild(buildNode(entry.value, { name: entry.key, duplicate: totals.get(entry.key) > 1 },
          childPath, depth + 1, state, firstRender, count));
      }
    };

    // First render: the top is open, and its containers too while there are
    // few. After that (a reload, a buffer edit) whatever the user left open.
    const startOpen = firstRender
      ? depth === 0 || (depth === 1 && siblings <= AUTO_OPEN_CHILDREN)
      : state.open.has(path);
    details.open = startOpen;
    if (startOpen) {
      state.open.add(path);
      buildChildren();
    }
    details.addEventListener('toggle', () => {
      if (details.open) {
        state.open.add(path);
        buildChildren();
      } else {
        state.open.delete(path);
      }
    });
    return details;
  }

  /**
   * Render a parsed tree into container. state.open is the set of expanded
   * node paths; pass the same state object back on a re-render to keep them.
   */
  function renderTree(container, tree, state) {
    const firstRender = !state.open;
    if (firstRender) state.open = new Set();
    container.appendChild(buildNode(tree, null, '', 0, state, firstRender, 1));
  }

  const api = { parseJsonForReader, renderTree, lineColumn, isJsoncAvailable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JsonReader = api;
})(typeof window !== 'undefined' ? window : globalThis);
