const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderMarkdownSafe,
  sanitizeMarkdownHtml,
  escapeHtmlMarkup,
  safeUrlValue,
  decodeEntitiesOnce,
} = require('../public/markdown-sanitize');

// The real parser, configured exactly as the renderer configures it
// (public/codemirror-setup.js:543).
const { marked } = require('marked');
marked.setOptions({ breaks: true, gfm: true });
const parse = (source) => marked.parse(source);
const render = (source) => renderMarkdownSafe(source, parse);

// ── Why this file exists ────────────────────────────────────────────
//
// `marked` is not a sanitiser and has not been one since v5: raw HTML is
// passed through verbatim and a link's URL is emitted as written. Pinned
// against the version in package.json so the day someone upgrades and the
// behaviour changes, this says so rather than going quietly green.
//
// WHAT "SAFE STANDALONE" IS TAKEN TO MEAN HERE, because the tests below used
// to assert it while only ever feeding the sanitiser well-formed tags. Two
// properties, both checked directly:
//
//   - every `<` in the output is one sanitizeMarkdownHtml() wrote (nothing it
//     could not tokenise is copied through), and
//   - every tag it wrote is allowlisted, with allowlisted attributes whose
//     values were re-escaped.
//
// It is NOT a claim that this is a general-purpose HTML sanitiser: there is no
// tree model, and the entity table is the short one in the module. Those
// limits are stated in markdown-sanitize.js and are not what these tests cover.

test('the parser really is unsafe — this is the threat, not a hypothetical', () => {
  assert.equal(parse('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.match(parse('[c](javascript:alert(1))'), /href="javascript:alert\(1\)"/);
});

// ── The three the brief names ───────────────────────────────────────

test('a script tag is neutralised', () => {
  const out = render('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(out), out);
  // Not merely dropped — shown, so a document that talks about script tags
  // still reads correctly.
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('an onerror attribute is neutralised', () => {
  const out = render('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/i.test(out), out);
  assert.ok(!/onerror/i.test(out.replace(/&lt;[^&]*&gt;/g, '')), out);
  assert.ok(out.includes('&lt;img'), out);
});

test('a javascript: href is neutralised', () => {
  const out = render('[click](javascript:alert(1))');
  assert.ok(!/javascript:/i.test(out), out);
  // The link text survives; only the destination is dropped.
  assert.ok(out.includes('>click</a>'), out);
});

// Same three straight into the output sanitiser, with no escaping pass in
// front of it. Layer 1 is what normally stops these, so without this the
// allowlist could rot unnoticed. Well-formed tags only — the malformed ones
// are the ── Failing closed ── section below, and the absence of that section
// is what made this test's "on its own" read as more than it had earned.
test('the three, well-formed, survive layer 2 on its own with no escaping pass', () => {
  assert.equal(sanitizeMarkdownHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
  assert.equal(sanitizeMarkdownHtml('<img src=x onerror=alert(1)>'), '<img src="x">');
  assert.equal(sanitizeMarkdownHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
});

// ── Failing closed ──────────────────────────────────────────────────
//
// THE REGRESSION THIS SECTION EXISTS FOR. The tag scanner used to be one
// regex whose attribute region was `(?:"[^"]*"|'[^']*'|[^>"'])*?` — every
// quote had to pair. An UNPAIRED quote made the alternation fail, so the
// scanner saw no tag at that `<` at all, and the bytes were copied to the
// output VERBATIM:
//
//   sanitizeMarkdownHtml('<img src=x onerror="alert(1)>')
//     -> '<img src=x onerror="alert(1)>'
//
// Nothing in this file caught it: every hostile vector in the corpus happened
// to be well-formed. In the app, layer 1 and the CSP (index.html:28) both
// stood in front of it, but the module offers sanitizeMarkdownHtml() for
// standalone reuse, so it was armed for the first caller who took it up.
//
// Input the tokeniser cannot finish is now emitted as text. The oracle is
// therefore not "is it well-formed" but "can any of it open a tag".
const OPENS_MARKUP = /<[a-zA-Z!/?]/;

const UNPARSABLE = [
  '<img src=x onerror="alert(1)>',              // the vector itself
  "<img src=x onerror='alert(1)>",              // single quotes, same shape
  '<img src="x" onerror=alert(1) title="a>',    // one paired, one not
  '<p title="><img src=x onerror=alert(1)>',    // quote straddling two tags
  '<a href="javascript:alert(1)>click</a>',
  '<img src=x onerror=alert(1)',                // no quote at all: never closes
  '<script',
  '<!--<img src=x onerror=alert(1)>',           // comment with no `-->`
  '</',
];

test('an unpaired quote can no longer hand the input back verbatim', () => {
  const vector = '<img src=x onerror="alert(1)>';
  const out = sanitizeMarkdownHtml(vector);
  assert.notEqual(out, vector, 'the input came straight back out — this is the bug');
  assert.ok(!OPENS_MARKUP.test(out), out);
  // Failing closed is not the same as deleting: the text is still readable.
  assert.ok(out.startsWith('&lt;img'), out);
});

test('everything before the bail-out is still rendered normally', () => {
  assert.equal(
    sanitizeMarkdownHtml('<p>a</p><img src=x onerror="alert(1)>'),
    '<p>a</p>&lt;img src=x onerror="alert(1)>',
  );
});

test('nothing the tokeniser refuses comes back as markup', () => {
  for (const source of UNPARSABLE) {
    const out = sanitizeMarkdownHtml(source);
    assert.ok(!OPENS_MARKUP.test(out), `${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
    assert.equal(liveMarkup(out), null, `${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
  }
});

test('and none of them survives the full markdown pipeline either', () => {
  for (const source of UNPARSABLE) {
    const out = render(source);
    assert.equal(liveMarkup(out), null, `${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
  }
});

test('bailing out inside a dropped element drops, it does not start emitting', () => {
  // The bail-out writes the rest of the input as text. Inside a <script> that
  // would turn the script body into visible page content, so it must not.
  assert.equal(sanitizeMarkdownHtml('<p>a</p><script>alert(1)</script'), '<p>a</p>');
  assert.equal(sanitizeMarkdownHtml('<script><img src=x onerror="alert(1)>'), '');
});

// ── Scheme filtering ────────────────────────────────────────────────
//
// A URL is the one place layer 1 cannot help: `[x](javascript:…)` is pure
// markdown containing no HTML at all.

test('case and entity spellings of javascript: are all rejected', () => {
  for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'JAVASCRIPT:alert(1)',
    '&#106;avascript:alert(1)',      // browsers decode this in an attribute
    '&#x6a;avascript:alert(1)',
    'java&Tab;script:alert(1)',
    'jav\tascript:alert(1)',
    'vbscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  ]) {
    const out = render(`[c](${url})`);
    assert.equal(out.includes('href='), false, `${url} -> ${out}`);
  }
});

test('an image src takes the same filter as a link href', () => {
  assert.ok(!render('![i](javascript:alert(1))').includes('src='));
  assert.ok(render('![i](https://example.com/a.png)').includes('src="https://example.com/a.png"'));
});

test('a protocol-relative URL is rejected — the page origin here is file:', () => {
  assert.equal(safeUrlValue('//evil.example.com/x.js'), null);
});

test('ordinary destinations are untouched', () => {
  assert.equal(safeUrlValue('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(safeUrlValue('http://example.com'), 'http://example.com');
  assert.equal(safeUrlValue('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeUrlValue('./docs/README.md'), './docs/README.md');
  assert.equal(safeUrlValue('../a/b.png'), '../a/b.png');
  assert.equal(safeUrlValue('#section'), '#section');
});

test('entities are decoded once, not repeatedly', () => {
  // A browser does not re-decode its own output. Looping would turn a literal
  // ampersand into a scheme and reject a perfectly good URL.
  assert.equal(decodeEntitiesOnce('&#106;avascript:'), 'javascript:');
  assert.equal(decodeEntitiesOnce('&amp;#106;avascript:'), '&#106;avascript:');
  assert.equal(safeUrlValue('&amp;#106;avascript:x'), '&amp;#106;avascript:x');
});

// ── Layer 1 ─────────────────────────────────────────────────────────

test('escapeHtmlMarkup catches every raw-HTML opener, not just tags', () => {
  assert.equal(escapeHtmlMarkup('<div>'), '&lt;div>');
  assert.equal(escapeHtmlMarkup('</div>'), '&lt;/div>');
  assert.equal(escapeHtmlMarkup('<!-- c -->'), '&lt;!-- c -->');
  assert.equal(escapeHtmlMarkup('<!DOCTYPE html>'), '&lt;!DOCTYPE html>');
  assert.equal(escapeHtmlMarkup('<?php echo 1 ?>'), '&lt;?php echo 1 ?>');
  // Prose is left alone; the parser escapes a lone `<` itself.
  assert.equal(escapeHtmlMarkup('a < b and 5 > 3'), 'a < b and 5 > 3');
});

// ── The corpus ──────────────────────────────────────────────────────
//
// Oracle, deliberately not the sanitiser's own logic: strip every tag that is
// both allowlisted and carries only inert attributes, then assert nothing with
// a `<` in it is left. Escaped text (`&lt;img …&gt;`) contains no `<` and is
// inert, which is the whole point — a string search for "onerror" would call
// that a failure.
const ALLOWED = new Set(['p', 'br', 'hr', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'em', 'strong', 'del', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'img', 'code', 'input']);
const INERT_ATTR = /^(href|src|title|alt|class|align|start|type|checked|disabled)$/;

function liveMarkup(html) {
  const residue = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (whole, close, name, attrs) => {
    if (!ALLOWED.has(name.toLowerCase())) return whole;
    if (close) return '';
    const attr = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;
    let match;
    while ((match = attr.exec(attrs)) !== null) {
      if (match[0] === '') { attr.lastIndex++; continue; }
      const name2 = match[1].toLowerCase();
      if (!INERT_ATTR.test(name2)) return whole;
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      if ((name2 === 'href' || name2 === 'src')
        && /^\s*(javascript|vbscript|data|file|about|blob)\s*:/i.test(value)) return whole;
    }
    return '';
  });
  return residue.includes('<') ? residue : null;
}

const CORPUS = [
  '<script>alert(1)</script>',
  '<sCrIpT>alert(1)</ScRiPt>',
  '<script src=//evil.example.com></script>',
  '<p>unclosed <script>alert(1)',
  '<img src=x onerror=alert(1)>',
  '<IMG SRC=X ONERROR=alert(1)>',
  '<img\nsrc=x\nonerror=alert(1)>',
  '<a href="javascript:alert(1)" onmouseover="alert(2)">x</a>',
  '<a/href=javascript:alert(1)>x</a>',
  '<a href ="javascript:alert(1)">x</a>',
  '<a href="vbscript:alert(1)>">x</a>',
  '<svg><script>alert(1)</script></svg>',
  '<svg onload=alert(1)><circle/></svg>',
  '<math><mtext></mtext></math>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)">',
  '<embed src="javascript:alert(1)">',
  '<base href="javascript:">',
  '<meta http-equiv=refresh content="0;url=javascript:alert(1)">',
  '<link rel=stylesheet href="javascript:alert(1)">',
  '<style>body{x:url(javascript:alert(1))}</style>',
  '<form action=x><input type=text name=y></form>',
  '<div onclick=alert(1)>hi</div>',
  '<p title="a>b" onload=alert(1)>t</p>',
  '<!--<img src=x onerror=alert(1)>-->',
  '<!DOCTYPE html><?php echo 1 ?>',
  '<xmp><script>alert(1)</script></xmp>',
  '<template><img src=x onerror=alert(1)></template>',
  '<textarea></textarea><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '> <img src=x onerror=alert(1)>',
  '[![i](https://a/b.png)](javascript:alert(1))',
  '<a href="https://ok" style="x:expression(alert(1))">k</a>',
  '[c]( javascript:alert(1) )',
];

test('no vector in the corpus leaves live markup behind', () => {
  for (const source of CORPUS) {
    const out = render(source);
    assert.equal(liveMarkup(out), null, `${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
  }
});

test('the corpus is also handled with no escaping pass in front', () => {
  for (const source of CORPUS) {
    const out = sanitizeMarkdownHtml(source);
    assert.equal(liveMarkup(out), null, `${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
  }
});

// ── Nothing legitimate was broken ───────────────────────────────────
//
// A sanitiser that eats real content gets turned off, so this half matters as
// much as the half above.

test('ordinary markdown comes through exactly as the parser wrote it', () => {
  const source = [
    '# Title', '',
    'Some **bold**, *em*, ~~del~~ and `inline`.', '',
    '- [x] done', '- [ ] todo', '',
    '1. one', '2. two', '',
    '> quote', '',
    '| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |', '',
    '[link](https://e.com "T") and ![i](https://e.com/i.png)', '',
    '```js', 'const x = 1;', '```', '',
    'bare https://bare.example.com and a@b.com', '',
    'a < b and 5 > 3', '',
    '[rel](../README.md)',
  ].join('\n');
  // Layer 1 does not touch this document, so the sanitised result must equal
  // the parser's own output byte for byte.
  assert.equal(render(source), parse(source));
});

// ── Attributes are escaped exactly ONCE ─────────────────────────────
//
// escapeAttr() used to escape unconditionally, which is right for href/src
// (marked leaves the `&` in `?a=1&b=2` raw) and wrong for title/alt (marked
// has already turned `A & B` into `A &amp; B`). The second escape produced
// `A &amp;amp; B`, which a reader sees as the literal text "A &amp; B" —
// ordinary markdown, visibly corrupted. The fix decodes once before escaping,
// so both producers converge; these are the two halves of that.

test('a title is escaped once, not twice — marked had already escaped it', () => {
  const out = render('[l](https://e.com "Tom & Jerry")');
  assert.ok(out.includes('title="Tom &amp; Jerry"'), out);
  assert.ok(!out.includes('&amp;amp;'), out);
});

test('the same for alt text, and an href where the single escape is ours', () => {
  const alt = render('![a & b](https://e.com/i.png)');
  assert.ok(alt.includes('alt="a &amp; b"'), alt);
  assert.ok(!alt.includes('&amp;amp;'), alt);
  // marked leaves `&` raw in a URL, so here escapeAttr is the only escape and
  // it still has to happen.
  const href = render('[q](https://e.com/?a=1&b=2)');
  assert.ok(href.includes('href="https://e.com/?a=1&amp;b=2"'), href);
  assert.ok(!href.includes('&amp;amp;'), href);
});

test('an entity outside the module table of names is preserved too', () => {
  // The first attempt at this fix decoded the value and re-escaped it, which
  // only converged for the handful of names in NAMED_ENTITIES: `&copy;`,
  // `&eacute;`, `&mdash;` were still coming out as `&amp;copy;` and rendering
  // as literal text. Escaping only an `&` that does NOT already begin a
  // character reference is what makes that whole class come out right.
  for (const source of [
    '[x](https://e.com "A &copy; B")',
    '![&copy; 2026](https://e.com/i.png)',
    '[y](https://e.com "caf&eacute;")',
    '![&hellip;](https://e.com/i.png "&mdash;")',
  ]) {
    assert.equal(render(source), parse(source), source);
  }
  // A lone `&` that is not a reference still has to be escaped.
  assert.equal(sanitizeMarkdownHtml('<a title="a & b">t</a>'), '<a title="a &amp; b">t</a>');
  assert.equal(sanitizeMarkdownHtml('<a title="a&notreal b">t</a>'), '<a title="a&amp;notreal b">t</a>');
});

test('escaping once is still escaping — no value can close its own attribute', () => {
  // A literal `"` is the only thing that can end a double-quoted attribute,
  // and it is escaped on every path, single-quoted source included.
  assert.equal(
    sanitizeMarkdownHtml(`<a title='x" onmouseover=alert(1) y="'>t</a>`),
    '<a title="x&quot; onmouseover=alert(1) y=&quot;">t</a>',
  );
  // A quote written as a reference stays a reference: the browser resolves it
  // after the attribute has been delimited, so it lands in the VALUE and
  // cannot break out. Preserved as written rather than renormalised.
  assert.equal(sanitizeMarkdownHtml('<a title="a&quot;b">t</a>'), '<a title="a&quot;b">t</a>');
  assert.equal(sanitizeMarkdownHtml('<a title="a&#34;b">t</a>'), '<a title="a&#34;b">t</a>');
  // Double-encoded: `&amp;` is the reference, `quot;` is ordinary text. It
  // must not collapse down to a live quote.
  assert.equal(sanitizeMarkdownHtml('<a title="a&amp;quot;b">t</a>'), '<a title="a&amp;quot;b">t</a>');
  // And a `<` smuggled in as an entity stays inert.
  assert.equal(sanitizeMarkdownHtml('<a title="&lt;img src=x&gt;">t</a>'),
    '<a title="&lt;img src=x&gt;">t</a>');
  // The scheme test still runs on the DECODED url, so a reference cannot
  // smuggle one past it and then be handed back intact.
  assert.equal(sanitizeMarkdownHtml('<a href="&#106;avascript:alert(1)">t</a>'), '<a>t</a>');
  assert.equal(sanitizeMarkdownHtml('<a href="java&Tab;script:alert(1)">t</a>'), '<a>t</a>');
});

test('the constructs the allowlist has attributes for all survive', () => {
  const out = render('| a |\n|:-:|\n| b |\n\n3. x\n\n```python\np\n```\n\n- [x] done');
  assert.ok(out.includes('align="center"'), out);
  assert.ok(out.includes('<ol start="3">'), out);
  assert.ok(out.includes('class="language-python"'), out);
  assert.ok(out.includes('type="checkbox"') && out.includes('checked=""'), out);
});

test('a code fence containing HTML shows the HTML as text rather than running it', () => {
  const out = render('```html\n<script>alert(1)</script>\n```');
  assert.ok(out.includes('<code class="language-html">'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
  assert.ok(!/<script/i.test(out), out);
});

test('an empty or absent document is not an error', () => {
  assert.equal(render(''), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  assert.equal(sanitizeMarkdownHtml(null), '');
});

test('a SOH already in the source cannot impersonate the internal mask', () => {
  // renderMarkdownSafe masks raw-HTML openers with U+0001 across the parse and
  // swaps them for &lt; afterwards. A U+0001 the document itself contains is
  // dropped first, so it can never come back out as a `<`.
  const out = render('before \u0001script\u0001 after');
  assert.ok(!out.includes('&lt;'), out);
  assert.ok(!out.includes('\u0001'), JSON.stringify(out));
  assert.ok(out.includes('before script after'), out);
});

test('with no parser at all the source is still inert', () => {
  // window.marked missing (the bundle failed to load): show escaped source
  // rather than nothing, and never live markup.
  const out = renderMarkdownSafe('<img src=x onerror=alert(1)>', null);
  assert.equal(liveMarkup(out), null);
  assert.ok(out.includes('&lt;img'), out);
});

// ── One sanitiser, not three ────────────────────────────────────────
//
// This logic was inlined in viewer-toolbar.js while viewer-panel.js and
// jsonl-viewer.js reached for `renderMarkdownSafe` as an ambient global that
// happened to exist because of <script> order. Phase 3 already shipped a
// second, divergent markdown parser that only review caught, so the drift is
// not hypothetical here. These two say out loud where the one copy lives.

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONSUMERS = ['viewer-toolbar.js', 'viewer-panel.js', 'jsonl-viewer.js'];

test('the sanitiser is defined in exactly one file under public/', () => {
  const definers = fs.readdirSync(PUBLIC_DIR)
    .filter(name => name.endsWith('.js'))
    .filter(name => /function\s+(sanitizeMarkdownHtml|renderMarkdownSafe)\s*\(/
      .test(fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')));
  assert.deepEqual(definers, ['markdown-sanitize.js']);
});

test('each consumer calls it instead of carrying its own allowlist', () => {
  for (const name of CONSUMERS) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
    assert.match(source, /renderMarkdownSafe\s*\(/, `${name} should call renderMarkdownSafe`);
    assert.doesNotMatch(source, /ALLOWED_TAGS|DROP_CONTENT_TAGS|SAFE_SCHEMES/,
      `${name} has grown its own copy of the allowlist`);
  }
});

// A plain <script> in a file:// page: the sanitiser has to be parsed before
// any file that calls it. It has no dependencies of its own, so it belongs
// first among the app's own scripts.
//
// This SKIPS ITSELF, loudly, while the tag is missing, because
// public/index.html is outside this change's lane — the skip reason is the
// outstanding work, not a decision to ignore it. Without the tag
// renderMarkdownSafe is undefined and both the markdown preview and the JSONL
// transcript throw at first use. It starts enforcing the ordering, and the
// skip disappears from the run, the moment the tag lands.
const SANITISER_TAG = '<script src="markdown-sanitize.js"></script>';
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

test('index.html loads markdown-sanitize.js before every consumer', () => {
  // Deliberately NOT skippable. This started life skipped because index.html was
  // outside the lane that wrote the sanitiser — and that skip is exactly why the
  // missing tag shipped green and every markdown render would have thrown
  // ReferenceError. A guard that disappears when the thing it guards is absent
  // cannot catch the regression it exists for.
  assert.ok(
    INDEX_HTML.includes(SANITISER_TAG),
    `public/index.html does not load the sanitiser — put ${SANITISER_TAG} `
    + 'immediately above <script src="viewer-toolbar.js"></script>'
  );
  const at = (file) => INDEX_HTML.indexOf(`<script src="${file}"></script>`);
  const sanitiser = at('markdown-sanitize.js');
  for (const name of CONSUMERS) {
    const consumer = at(name);
    assert.notEqual(consumer, -1, `index.html does not load ${name}`);
    assert.ok(sanitiser < consumer, `${name} is loaded before the sanitiser it needs`);
  }
});
