/**
 * markdown-sanitize.js — the ONE markdown sanitiser.
 *
 * Every surface that turns markdown into innerHTML calls this module:
 * viewer-toolbar.js (toggleMarkdownPreview), viewer-panel.js (the file-watcher
 * re-render) and jsonl-viewer.js (transcript text). It has no DOM and no
 * dependencies, so it can load first and be tested under Node.
 *
 * SECURITY. `marked` is a renderer, not a sanitiser: it passes raw HTML
 * through verbatim and emits whatever URL a link was written with. Measured
 * against the version this fork ships (marked ^17.0.4, package.json:34):
 *
 *   marked.parse('<img src=x onerror=alert(1)>')  -> '<img src=x onerror=alert(1)>'
 *   marked.parse('[c](javascript:alert(1))')      -> '<a href="javascript:alert(1)">c</a>'
 *
 * Those strings were being assigned straight to `.innerHTML`, and preload.js
 * hands the renderer openTerminal (preload.js:21) and saveFileForPanel
 * (preload.js:165) over contextBridge, so a hostile README.md in any cloned
 * repository was one click from running as the app. With the project file
 * browser landing, that README no longer has to be opened on purpose.
 *
 * Three layers, none of which is sufficient alone:
 *
 *   1. escapeHtmlMarkup() / maskRawHtml() neutralise every raw-HTML construct
 *      in the markdown SOURCE, so the parser never gets the chance to pass one
 *      through. This generalises the local regex jsonl-viewer.js used to
 *      carry (the note it left behind is at jsonl-viewer.js:8): that one only
 *      caught `<tag ...>` shapes and left comments, `<!doctype>` and
 *      processing instructions alone.
 *   2. sanitizeMarkdownHtml() re-derives the OUTPUT from an allowlist. Layer 1
 *      cannot touch `[x](javascript:...)`, which is pure markdown containing
 *      no raw HTML at all, so a URL-scheme check is mandatory and has to
 *      happen after the parse.
 *   3. The page's Content-Security-Policy (index.html:28) — `script-src 'self'
 *      file:`, no 'unsafe-inline' — which is what stops an `onerror=` that
 *      did reach the DOM from firing at all.
 *
 * WHAT LAYER 2 ON ITS OWN GUARANTEES, stated exactly, because an earlier
 * version of this comment over-claimed and a reviewer was right to call it:
 *
 *   - Every `<` in the output is one this function wrote. Input the tokeniser
 *     cannot finish parsing is emitted as text, never copied through.
 *   - Every emitted tag is in ALLOWED_TAGS, rebuilt from its parsed name, and
 *     carries only allowlisted attributes whose values passed attributeValue()
 *     and were re-escaped by escapeAttr().
 *
 * What it is NOT: a full HTML5 parser. It has no tree model, so nesting is not
 * corrected and a `</p>` can be emitted without its `<p>`; it resolves the
 * named entities in NAMED_ENTITIES rather than the whole HTML5 table; and it
 * is a hand-written allowlist, not a hardened library. It is safe to call on
 * attacker-authored HTML in the sense above — it will not emit markup the
 * allowlist forbids — but it is not a substitute for DOMPurify and must not be
 * described as one.
 *
 * Why not DOMPurify: `marked` reaches the renderer as an esbuild bundle
 * (codemirror-setup.js:16 imports it, :544 publishes window.marked), so adding
 * DOMPurify means a package.json dependency, an npm install, a bundle entry
 * and an index.html <script> — four files outside this change, and the hole
 * stays open until every one of them lands. This is dependency-free and works
 * now. The trade is stated rather than hidden: raw HTML inside a markdown
 * document is shown as text instead of being rendered.
 */
(function (root) {
  // Exactly what marked emits, measured rather than remembered, by parsing one
  // document containing every markdown construct. Anything outside this list
  // is not a tag the parser can produce, so dropping it cannot lose
  // legitimate rendering.
  const ALLOWED_TAGS = new Map(Object.entries({
    p: [], br: [], hr: [], blockquote: [], pre: [],
    h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    ul: [], li: [], em: [], strong: [], del: [],
    table: [], thead: [], tbody: [], tfoot: [], tr: [],
    ol: ['start'],
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    th: ['align'], td: ['align'],
    input: ['type', 'checked', 'disabled'],
  }));

  // Void elements among the above: written without a closing tag.
  const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

  // Dropped WITH their content. A disallowed tag normally has only its markup
  // removed and its text kept, but for these that would turn script source
  // into rendered markup or visible junk. Layer 1 means none of them can reach
  // here from a markdown document; carrying the set anyway is what keeps this
  // function usable on HTML that did not come through layer 1.
  const DROP_CONTENT_TAGS = new Set([
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'applet', 'noscript', 'noembed', 'template', 'title', 'textarea',
    'xmp', 'svg', 'math', 'link', 'meta', 'base', 'form',
  ]);

  const URL_ATTRS = new Set(['href', 'src']);
  // mailto is here because GFM autolinks a bare e-mail address into one.
  const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    colon: ':', sol: '/', tab: '\t', newline: '\n', semi: ';',
    lpar: '(', rpar: ')', period: '.', num: '#',
  };

  /**
   * Decode HTML entities once, the way a browser does when it reads an
   * attribute value. This has to happen before any scheme test:
   * `&#106;avascript:alert(1)` IS `javascript:alert(1)` by the time a
   * navigation happens, and marked's encodeURI() leaves `&` and `#` untouched,
   * so it arrives here intact.
   *
   * Once, not repeatedly. A browser does not re-decode its own output, and
   * looping would reject `&amp;#106;avascript:`, which is a literal ampersand
   * and perfectly safe.
   */
  function decodeEntitiesOnce(value) {
    return String(value).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  /**
   * The value to put in an href/src, or null to drop the attribute entirely.
   *
   * Relative paths, query strings and fragments carry no scheme and are kept.
   * Anything that does carry a scheme must carry one of SAFE_SCHEMES, which
   * rules out javascript:, vbscript:, data: (`data:text/html` is a whole
   * document with the page's own privileges) and the editor URIs that the
   * terminal link provider handles by a different, validated route.
   */
  function safeUrlValue(rawValue) {
    // A browser ignores C0 controls and surrounding whitespace when it decides
    // what scheme a URL has, so `java\tscript:` navigates. Strip them first.
    const value = decodeEntitiesOnce(rawValue).replace(/[\u0000- \u007f]+/g, '');
    if (!value) return null;
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
    if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
    // A protocol-relative URL inherits the page's scheme, which here is file:.
    if (value.startsWith('//')) return null;
    return rawValue;
  }

  function attributeValue(tag, name, rawValue) {
    if (URL_ATTRS.has(name)) return safeUrlValue(rawValue);
    // Only the fence language marked writes onto a <code> block.
    if (name === 'class') return /^language-[\w#+.-]*$/.test(rawValue) ? rawValue : null;
    if (name === 'align') return /^(left|center|right)$/.test(rawValue) ? rawValue : null;
    if (name === 'start') return /^\d{1,9}$/.test(rawValue) ? rawValue : null;
    if (name === 'type') return tag === 'input' && rawValue.toLowerCase() === 'checkbox' ? 'checkbox' : null;
    // checked / disabled are boolean; marked writes them as `checked=""`.
    if (name === 'checked' || name === 'disabled') return '';
    return rawValue;
  }

  /**
   * Escape a value for a double-quoted attribute, WITHOUT escaping it twice.
   *
   * The input is an attribute value lifted back out of HTML, so it already
   * carries whatever escaping its producer chose — and the two producers here
   * disagree. marked escapes `title` and `alt` (a title of `A & B` arrives as
   * `A &amp; B`, a `©` as `&copy;`) but leaves `href`/`src` alone (`?a=1&b=2`
   * arrives with a raw `&`). Escaping every `&` unconditionally therefore
   * corrupted half of them: `A &amp; B` became `A &amp;amp; B`, which the
   * reader sees as the literal text "A &amp; B". Skipping the escape for the
   * "already escaped" half would have been a hole, so that is not the fix
   * either.
   *
   * The rule instead is the standard one: escape an `&` unless it already
   * begins a character reference. Raw input and escaped input then both come
   * out escaped exactly once, whatever entity was used and whether or not this
   * module's own NAMED_ENTITIES knows it.
   *
   * This does not weaken the escape. The only character that can end a
   * double-quoted attribute is a literal `"`, and that is still escaped on
   * every path; character references are resolved by the browser AFTER the
   * attribute value has been delimited, so a preserved `&quot;` or `&lt;`
   * becomes part of the VALUE and can neither close the attribute nor open a
   * tag. (`href`/`src` have already been vetted by safeUrlValue(), which runs
   * its scheme test on the decoded form.)
   */
  const escapeAttr = value => String(value)
    .replace(/&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // A name, then optionally `=` and a double-quoted, single-quoted or bare value.
  const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;

  function rebuildTag(tag, attrText, selfClosing) {
    const allowed = ALLOWED_TAGS.get(tag);
    let out = '<' + tag;
    ATTR_RE.lastIndex = 0;
    let match;
    while ((match = ATTR_RE.exec(attrText)) !== null) {
      if (match[0] === '') { ATTR_RE.lastIndex++; continue; }
      const name = match[1].toLowerCase();
      if (!allowed.includes(name)) continue;
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      const value = attributeValue(tag, name, raw);
      if (value === null) continue;
      out += ' ' + name + '="' + escapeAttr(value) + '"';
    }
    return out + (selfClosing && !VOID_TAGS.has(tag) ? ' /' : '') + '>';
  }

  // ── The tokeniser ───────────────────────────────────────────────────
  //
  // Hand-written rather than one regex, because a regex cannot fail closed.
  // The regex this replaced stated the quoting rule correctly —
  // `<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>` — but
  // had no way to add "and if that fails, distrust the input". An UNPAIRED
  // quote made the alternation fail, the scanner found no tag at that `<`, and
  // the bytes were copied to the output VERBATIM:
  //
  //   sanitizeMarkdownHtml('<img src=x onerror="alert(1)>')
  //     -> '<img src=x onerror="alert(1)>'        // straight back out
  //
  // Layer 1 and the CSP both covered that inside this app, but the hole was in
  // the one function the module invites other callers to reuse on their own.
  // Everything below fails CLOSED instead: what cannot be tokenised leaves as
  // text.

  // A tag name, sticky so it can be tested at a position without slicing.
  const TAG_NAME_RE = /[a-zA-Z][a-zA-Z0-9:-]*/y;

  /**
   * Index of the `>` that ends the tag whose attribute region starts at
   * `from`, or -1 when the tag never closes.
   *
   * Quoting is tracked the way an HTML tokeniser tracks it: `"` or `'` opens
   * an attribute-value region that only the SAME character closes, and inside
   * it `>` is ordinary data. An unpaired quote therefore runs to the end of
   * the input and the tag is reported unterminated — which is the point.
   */
  function findTagEnd(src, from) {
    let quote = '';
    for (let i = from; i < src.length; i++) {
      const ch = src[i];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') return i;
    }
    return -1;
  }

  /**
   * Rewrite an HTML fragment so it contains only allowlisted tags and
   * attributes. Every kept tag is REBUILT from its parsed name and attribute
   * list rather than copied through, so no byte of the input survives as tag
   * syntax — only as a re-escaped attribute value, or as text.
   */
  function sanitizeMarkdownHtml(html) {
    const src = String(html ?? '');
    let out = '';
    let text = 0;       // start of the pending run of literal text
    let i = 0;          // scan position
    let skipping = '';  // the drop-with-content element being skipped, if any

    // The text between the last token and `upto`. Inside a drop-with-content
    // element there is no text to emit. It can hold no `<`: the scan stops at
    // every one.
    const pushText = (upto) => { if (!skipping) out += src.slice(text, upto); };

    // Give up at `at`. Everything from there could not be tokenised, so it
    // leaves as TEXT with every `<` neutralised — nothing unparsed is guessed
    // at, and nothing unparsed can come back as markup. `&` is deliberately
    // left alone: it cannot open a tag, and re-escaping it would corrupt the
    // entities the parser already wrote.
    const bailOut = (at) => {
      pushText(at);
      if (!skipping) out += src.slice(at).split('<').join('&lt;');
      return out;
    };

    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt === -1) break;
      const after = src[lt + 1];

      // Comment, declaration (<!DOCTYPE …>) or processing instruction: the
      // whole construct is dropped, content included.
      if (after === '!' || after === '?') {
        const isComment = src.startsWith('<!--', lt);
        const end = isComment ? src.indexOf('-->', lt + 4) : src.indexOf('>', lt + 2);
        if (end === -1) return bailOut(lt);
        pushText(lt);
        i = text = end + (isComment ? 3 : 1);
        continue;
      }

      const closing = after === '/';
      TAG_NAME_RE.lastIndex = lt + (closing ? 2 : 1);
      const name = TAG_NAME_RE.exec(src);

      if (!name) {
        if (closing) {
          // `</>`, `</ x>`: a bogus comment. Browsers drop it; so do we.
          const end = src.indexOf('>', lt + 2);
          if (end === -1) return bailOut(lt);
          pushText(lt);
          i = text = end + 1;
          continue;
        }
        // `a < b`, `<3`, a trailing `<`: data, not a tag — a browser reads it
        // the same way. Emitted as `&lt;` rather than copied through, so that
        // every `<` in the output is one this function wrote.
        pushText(lt);
        if (!skipping) out += '&lt;';
        i = text = lt + 1;
        continue;
      }

      const end = findTagEnd(src, TAG_NAME_RE.lastIndex);
      if (end === -1) return bailOut(lt);

      pushText(lt);
      let attrText = src.slice(TAG_NAME_RE.lastIndex, end);
      i = text = end + 1;

      // `<br/>`: a trailing solidus is the self-closing marker, not an
      // attribute. It is outside every quoted region by construction, because
      // findTagEnd only returns a `>` it reached with no quote open.
      let selfClosing = false;
      if (attrText.endsWith('/')) { selfClosing = true; attrText = attrText.slice(0, -1); }

      const tag = name[0].toLowerCase();

      if (skipping) {
        if (closing && tag === skipping) skipping = '';
        continue;
      }
      if (DROP_CONTENT_TAGS.has(tag)) {
        if (!closing && !selfClosing) skipping = tag;
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) continue;      // drop the markup, keep the text
      if (closing) { if (!VOID_TAGS.has(tag)) out += '</' + tag + '>'; continue; }
      out += rebuildTag(tag, attrText, selfClosing);
    }

    pushText(src.length);
    return out;
  }

  // A placeholder standing in for a `<` that must not reach the parser as
  // markup. It cannot be `&lt;` directly: inside a fenced code block the
  // parser escapes the whole text again, `&` included, so `&lt;script&gt;`
  // is displayed as the literal characters "&lt;script&gt;" instead of
  // "<script>". A code fence full of HTML is exactly what a transcript and a
  // README are made of, so that is not a cosmetic loss.
  //
  // SOH survives the parse untouched in text, in code blocks and in fence
  // info strings, and is swapped for `&lt;` once the output has been
  // sanitised. Substituting afterwards is safe by construction: the inserted
  // text is a character entity, which can never be read as markup no matter
  // where in the document it lands.
  const RAW_HTML_MARK = '\u0001';

  /**
   * Replace every raw-HTML opener in a markdown source with RAW_HTML_MARK, so
   * the parser emits none of it. `<` is masked when what follows could begin a
   * tag, an end tag, a comment or a declaration; a bare `<` in prose
   * ("a < b") is left alone and the parser escapes it itself.
   *
   * Any RAW_HTML_MARK already in the source is dropped first, so a control
   * character in the input cannot be mistaken for one of ours. It is a
   * non-printing character either way, so nothing visible is lost.
   */
  function maskRawHtml(source) {
    return String(source ?? '')
      .split(RAW_HTML_MARK).join('')
      .replace(/<(?=[a-zA-Z!/?])/g, RAW_HTML_MARK);
  }

  /**
   * The same masking expressed directly as entities, for when there is no
   * parser to run and the source is shown as it stands.
   *
   * Cost of the masking, stated rather than hidden: `<https://x>` and
   * `<a@b.c>` autolinks lose their angle-bracket form. With gfm on —
   * codemirror-setup.js:543 — the bare URL and the bare address inside are
   * still autolinked, so the link survives and only the brackets show. Raw
   * HTML embedded in a markdown document (a README's `<details>`) is shown as
   * text rather than rendered. That is the deliberate price of not executing
   * it.
   */
  function escapeHtmlMarkup(source) {
    return maskRawHtml(source).split(RAW_HTML_MARK).join('&lt;');
  }

  /**
   * markdown source -> HTML that is safe to assign to innerHTML.
   *
   * `parse` is injectable so the whole pipeline can be tested against the real
   * marked under Node, where `window` does not exist.
   */
  function renderMarkdownSafe(source, parse) {
    const parser = parse
      || (root && root.marked && root.marked.parse && root.marked.parse.bind(root.marked));
    // No parser (the bundle failed to load): the escaped source is already
    // inert, and showing it as plain text beats showing nothing at all.
    if (!parser) return sanitizeMarkdownHtml(escapeHtmlMarkup(source));
    return sanitizeMarkdownHtml(parser(maskRawHtml(source)))
      .split(RAW_HTML_MARK).join('&lt;');
  }

  const api = { renderMarkdownSafe, sanitizeMarkdownHtml, escapeHtmlMarkup, safeUrlValue, decodeEntitiesOnce };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
