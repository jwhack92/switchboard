const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The in-page confirm and alert boxes (public/dialogs.js confirmDialog,
// alertDialog and the window.alert that replaces the native one).
//
// Why they exist: on Windows, closing a native confirm() or alert() box can
// leave this Electron's window taking key-downs but dropping typed characters
// (Electron PR 54380). Jason: "can't edit session names again, need a
// permanent fix for this". Nothing in the renderer opens a native box now.
//
// Three kinds of test:
//   - a scan of the shipped renderer source. The native confirm() blocked and
//     returned a boolean; confirmDialog() returns a Promise, which is truthy,
//     so one call without `await` would stop, delete or archive without
//     asking. The scan is what keeps that from coming back.
//   - the box itself: dialogs.js runs whole in a vm context against a fake
//     window and document (the way test/project-auto-open.test.js runs it),
//     so what runs here is the text that ships.
//   - the flows that stop, delete or detach something, cut out of their files
//     by their first lines and run against fakes: the scan proves a question
//     is awaited, not what is done with its answer.
//
// What this cannot prove: how the box looks, that Chromium moves the focus and
// fires key events the way the fakes do, that a click on the backdrop reports
// the overlay as its target, that it marks the later key-downs of a held key
// as repeats, how long a real double-click takes on this machine, or that
// xterm really gets its typing back after the box closes. Those need the app.

const PUBLIC = path.join(__dirname, '..', 'public');
const DIALOGS = path.join(PUBLIC, 'dialogs.js');
const STYLE = path.join(PUBLIC, 'style.css');
const DIAGNOSTICS = path.join(PUBLIC, 'terminal-diagnostics.js');
const INDEX_HTML = path.join(PUBLIC, 'index.html');

// --- The source scan ---

/**
 * A renderer file as code only: comments gone, the text of every string,
 * template and regex literal gone (the code inside a template's ${ } stays),
 * line breaks kept so that an index still gives the right line.
 *
 * It throws when it loses its place (a string or a regex that runs into a line
 * break, a template still open at the end), so a file it cannot read fails the
 * test instead of passing it unread.
 */
function codeOnly(src, file) {
  const n = src.length;
  const lost = (what, at) => new Error(`${file}:${src.slice(0, at).split('\n').length}: the scanner lost its place (${what})`);
  // A slash starts a regex after an operator or one of these words, and
  // divides after a name, a number or a closing bracket.
  const regexAllowed = (out) => {
    const m = /([\w$]+|[^\s\w$])\s*$/.exec(out.slice(-40));
    if (!m) return true;
    if (/^[\w$]+$/.test(m[1])) return /^(?:return|typeof|case|in|of|void|delete|throw|new|else|do|await|yield)$/.test(m[1]);
    return !/[)\]}]/.test(m[1]);
  };
  const modes = ['code'];   // 'code', or 'template' for the text of a template
  const braces = [0];       // open { } in each 'code' on the stack
  let out = '';
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (modes[modes.length - 1] === 'template') {
      if (c === '\\') { if (d === '\n') out += '\n'; i += 2; continue; }
      if (c === '`') { out += '`'; modes.pop(); i++; continue; }
      if (c === '$' && d === '{') { out += '${'; modes.push('code'); braces.push(0); i += 2; continue; }
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw lost('comment not closed', i);
      out += src.slice(i, end).replace(/[^\n]/g, '');
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { if (src[i + 1] === '\n') out += '\n'; i++; } else if (src[i] === '\n') throw lost('string not closed', start);
        i++;
      }
      out += c + c;
      i++;
      continue;
    }
    if (c === '`') { out += '`'; modes.push('template'); i++; continue; }
    if (c === '/' && regexAllowed(out)) {
      const start = i++;
      let inClass = false;
      while (i < n && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '\n') throw lost('regex not closed', start);
        i++;
      }
      out += '/re/';
      i++;
      continue;
    }
    if (c === '{') braces[braces.length - 1]++;
    if (c === '}') {
      if (braces[braces.length - 1] === 0 && modes.length > 1) { out += '}'; modes.pop(); braces.pop(); i++; continue; }
      braces[braces.length - 1]--;
    }
    out += c;
    i++;
  }
  if (modes.length !== 1) throw lost('a template is still open at the end', n);
  return out;
}

/** Every renderer file we wrote, as [name, code only]. The bundle is a build
 *  product of somebody else's code and is not ours to scan. */
function rendererCode() {
  return fs.readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js') && f !== 'codemirror-bundle.js')
    .map((f) => [f, codeOnly(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), f)]);
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

test('the scanner keeps code and drops comments, strings, template text and regexes', () => {
  const src = [
    "const a = 'confirm(1)'; // confirm(2)",
    '/* confirm(3)',
    '   confirm(4) */ const b = "it\'s confirm(5)";',
    'const c = `confirm(6) ${ask(`confirm(7) ${x}`, { y: 1 })} confirm(8)`;',
    "const d = s.replace(/confirm\\(9\\)['\"`/]/g, '') / 2;",
    'confirm(10);',
  ].join('\n');
  const code = codeOnly(src, 'sample.js');
  assert.equal(code.split('\n').length, 6, 'line breaks are kept');
  assert.deepEqual(code.match(/confirm\(\d+\)/g), ['confirm(10)']);
  assert.ok(code.includes('${ask(`${x}`, { y: 1 })}'), code);
  assert.ok(code.includes("s.replace(/re/g, '') / 2"), code);
  assert.throws(() => codeOnly("const a = 'never closed\n", 'broken.js'), /broken\.js:1: the scanner lost its place/);
  assert.throws(() => codeOnly('const a = `never closed', 'broken.js'), /still open/);
});

// A call of anything named confirm (not part of a longer name), bare or as a
// member of whatever: window?.confirm(), top.confirm() and a call through an
// alias of the window open the same native box, and nothing of ours has a
// method of that name. Or any mention of window.confirm at all: the focus
// watch wraps it through window[kind] and is the only thing that touches it.
// A string key on the window is the same call in a spelling this scan cannot
// read (the scanner empties the string), so there is to be none of those
// either.
const NATIVE_CONFIRM = /(?<![\w$])confirm\s*\(|\b(?:window|globalThis|self)\s*(?:\.\s*confirm\b|\[\s*['"`])/g;

test('no renderer file calls the native confirm()', () => {
  const found = [];
  for (const [file, code] of rendererCode()) {
    for (const m of code.matchAll(NATIVE_CONFIRM)) found.push(`${file}:${lineOf(code, m.index)}`);
  }
  assert.deepEqual(found, [], 'a native confirm() box can leave the window dropping typed characters; use `await confirmDialog(...)`');
});

/**
 * Every use of `name` in the given [file, code only] pairs, as file:line:
 *   defined   `function name(`
 *   awaited   `await name(`
 *   bare      any other call. A member call (window.name(...)) is one even
 *             with an await in front of it: the plain spelling is the only one
 *             this scan vouches for
 *   loose     the name without a call: stored or handed on under another
 *             name, where the scan could not follow it. `typeof name` is the
 *             one mention that is not counted
 */
function usesOf(name, files) {
  const uses = { defined: [], awaited: [], bare: [], loose: [] };
  for (const [file, code] of files) {
    for (const m of code.matchAll(new RegExp('(?<![\\w$])' + name + '(?![\\w$])(\\s*\\()?', 'g'))) {
      const before = code.slice(Math.max(0, m.index - 20), m.index);
      const where = `${file}:${lineOf(code, m.index)}`;
      if (!m[1]) { if (!/\btypeof\s+$/.test(before)) uses.loose.push(where); }
      else if (/\bfunction\s+$/.test(before)) uses.defined.push(where);
      else if (/\bawait\s+$/.test(before)) uses.awaited.push(where);
      else uses.bare.push(where);
    }
  }
  return uses;
}

test('the scans see a native confirm and an un-awaited question in the spellings somebody would write', () => {
  const sample = (...lines) => [['sample.js', codeOnly(lines.join('\n'), 'sample.js')]];
  const native = (line) => [...sample(line)[0][1].matchAll(NATIVE_CONFIRM)].length;
  for (const line of [
    "if (!confirm('Really?')) return;",
    "if (!window.confirm('Really?')) return;",
    "const ask = globalThis . confirm;",
    "if (!window['confirm']('Really?')) return;",
    'if (!self["confirm"](`Really?`)) return;',
    'if (!window[`confirm`]()) return;',
    // Found in review: a member call on anything but the three names passed.
    "if (!window?.confirm('Really?')) return;",
    "const w = window; if (!w.confirm('Really?')) return;",
    "if (!top.confirm('Really?')) return;",
    "if (!window.parent . confirm ('Really?')) return;",
  ]) assert.equal(native(line), 1, line);
  for (const line of [
    "if (!await confirmDialog('Really?', { confirm: 'Stop' })) return;",
    'async function tokConfirm(message, confirm) {}',
    // What dialogs.js and the focus watch do with the name: none is a call.
    "function confirmDialog(message, { title, confirm = 'OK' } = {}) { return queueAppDialog({ message, confirm }); }",
    'const confirmBtn = makeButton(className, request.confirm);',
    'const original = window[kind]; window[kind] = wrapped;',
    "// confirm('in a comment')",
  ]) assert.equal(native(line), 0, line);

  const uses = (...lines) => usesOf('confirmDialog', sample(...lines));
  assert.deepEqual(uses("if (!await confirmDialog('Really?')) return;"), { defined: [], awaited: ['sample.js:1'], bare: [], loose: [] });
  assert.deepEqual(uses("return typeof confirmDialog === 'function' && (await confirmDialog(m)) === true;").awaited, ['sample.js:1']);
  assert.deepEqual(uses('function confirmDialog(message) {}').defined, ['sample.js:1']);
  // Found in review: this one went ahead without asking and no test noticed.
  assert.deepEqual(uses('', "if (!window.confirmDialog('Really?')) return;").bare, ['sample.js:2']);
  assert.deepEqual(uses("if (!confirmDialog('Really?')) return;").bare, ['sample.js:1']);
  assert.deepEqual(uses("if (!await window.confirmDialog('Really?')) return;").bare, ['sample.js:1']);
  assert.deepEqual(uses("confirmDialog('Really?').then(go);").bare, ['sample.js:1']);
  assert.deepEqual(uses('const ask = confirmDialog;', "if (!ask('Really?')) return;").loose, ['sample.js:1']);
  assert.deepEqual(uses('row.onclick = window.confirmDialog;').loose, ['sample.js:1']);
  assert.deepEqual(uses('await confirmDialogs(); myconfirmDialog(); $confirmDialog();'), { defined: [], awaited: [], bare: [], loose: [] });
});

// Everything in public/ that asks a question and answers through a Promise.
// A new helper of this kind belongs in this list.
const ASKS = ['confirmDialog', 'tokConfirm', 'handoffConfirmTyping', 'confirmStopWork'];

test('every question is awaited: a Promise is truthy, so one that is not would go ahead without asking', () => {
  const files = rendererCode();
  const awaited = {};
  for (const name of ASKS) {
    const uses = usesOf(name, files);
    assert.deepEqual(uses.bare, [], `each of these must be \`await ${name}(...)\`, spelled just so`);
    assert.deepEqual(uses.loose, [], `${name} is only ever called: under another name the scan cannot see whether it is awaited`);
    assert.equal(uses.defined.length, 1, `${name} is defined once in public/ (was it renamed? then fix ASKS)`);
    awaited[name] = uses.awaited.length;
  }
  // A check that the scan saw the calls at all. The confirmDialog calls are
  // counted one by one in the next test.
  assert.equal(awaited.tokConfirm, 3, 'Rebuild, Turn off, Turn on');
  assert.ok(awaited.handoffConfirmTyping >= 2);
  assert.ok(awaited.confirmStopWork >= 2);
});

// Every confirmDialog call, in the order of the file: its own line, with the
// message left out. One entry for each of the 17 native confirms that were
// replaced; the two detach questions are now a shared first question and the
// checkout question.
//
// Two things are pinned by each entry:
//   - the options. The label is the action's own verb, and the button is red
//     where the action stops or destroys something: the box's two buttons are
//     all that says which answer does what, so a label that changes here
//     changes what a click means.
//   - what is done with the answer. Found in review: with the `!` dropped, or
//     the `return` replaced by an empty block, at a site no flow test runs
//     (the sidebar's archive and hide buttons, the settings panel, the
//     session menu), Cancel did the thing and every other test still passed.
const QUESTIONS = {
  'app.js': [
    "if (!await confirmDialog(…, { confirm: 'Stop', danger: true })) return;",                 // stop a session
    "if (!await confirmDialog(…, { confirm: 'Resume' })) return;",                             // let scheduled tasks run again
  ],
  // An explicit true, or it is a no (the line before it checks the dialog is there).
  'ctx-handoff.js': [
    "&& (await confirmDialog(…, { confirm: 'Type it anyway' })) === true;",      // Hand off, Update and Ultracode: the one box
  ],
  'projects-view.js': [
    "if (!await confirmDialog(…, { confirm: 'Remove' })) return;",                             // a session out of its project
    "if (!await confirmDialog(…, { confirm: 'Detach' })) return;",                             // a folder out of its project
    "opts = { removeWorktree: await confirmDialog(…, { confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true }) };",
    "if (result?.dirty && await confirmDialog(…, { confirm: 'Remove anyway', danger: true })) {",   // with uncommitted changes
    "if (!await confirmDialog(…, { confirm: 'Remove', cancel: 'Keep on disk', danger: true })) return;",   // a done project's worktrees
    "if (result?.dirty && await confirmDialog(…, { confirm: 'Remove anyway', danger: true })) {",   // with uncommitted changes
    "if (paused.length && !await confirmDialog(…, { confirm: 'Mark as done' })) return;",      // a track with scheduled tasks
    "if (!await confirmDialog(…, { confirm: 'Remove', danger: true })) return;",               // the project itself
  ],
  'schedules.js': ["if (!await confirmDialog(…, { confirm: 'Delete', danger: true })) return;"],
  'settings-panel.js': ["if (!await confirmDialog(…, { confirm: 'Hide' })) return;"],
  'sidebar.js': [
    // Red when running sessions are stopped first: archiveQuestion, tested below.
    "if (!await confirmDialog(…, { confirm: 'Archive', danger: question.danger })) return;",
    "if (!await confirmDialog(…, { confirm: 'Hide' })) return;",
    "if (!await confirmDialog(…, { confirm: 'Archive', danger: question.danger })) return;",
  ],
  // tokConfirm hands its label on, and answers yes for an explicit true only.
  'token-stats-view.js': ["try { return typeof confirmDialog === 'function' ? (await confirmDialog(…, { confirm })) === true : false; } catch { return false; }"],
};

test('each question names its action on the confirm button, is red where the action stops or destroys, and goes on only for a yes', () => {
  const found = {};
  for (const where of usesOf('confirmDialog', rendererCode()).awaited) {
    const [file, line] = where.split(':');
    const text = fs.readFileSync(path.join(PUBLIC, file), 'utf8').split('\n')[Number(line) - 1].trim();
    // The options are the last argument and stand on the call's own line.
    const m = /^(.*?\bawait confirmDialog\()(.*),\s*(\{[^{}]*\}\).*)$/.exec(text);
    assert.ok(m, `${where}: this confirmDialog call has no options this test can read (a label, on the call's own line)`);
    (found[file] = found[file] || []).push(`${m[1]}…, ${m[3]}`);
  }
  assert.deepEqual(found, QUESTIONS);
});

test('the archive question says how many running sessions will be stopped, and is red only when there are any', () => {
  const code = cut('sidebar.js', 'function archiveQuestion(sessions, lead) {', 'function rebindSidebarEvents(projects) {');
  const ask = (running, lead = 'Archive all 3 sessions in tools?') => {
    const ctx = { activePtyIds: new Set(running) };
    vm.createContext(ctx);
    vm.runInContext(code, ctx, { filename: path.join(PUBLIC, 'sidebar.js') });
    return plain(ctx.archiveQuestion([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }], lead));
  };
  assert.deepEqual(ask([]), { message: 'Archive all 3 sessions in tools?', danger: false });
  // A session of some other project is running: not one of these.
  assert.deepEqual(ask(['z']), { message: 'Archive all 3 sessions in tools?', danger: false });
  assert.deepEqual(ask(['b', 'z']), { message: 'Archive all 3 sessions in tools?\n\n1 running session will be stopped first.', danger: true });
  assert.deepEqual(ask(['a', 'c'], 'Archive all 3 older sessions?'), { message: 'Archive all 3 older sessions?\n\n2 running sessions will be stopped first.', danger: true });
  assert.deepEqual(ask(['a', 'b', 'c']).danger, true);
  // Both buttons ask through it, with their own first line.
  const sidebar = fs.readFileSync(path.join(PUBLIC, 'sidebar.js'), 'utf8');
  assert.equal(sidebar.split('const question = archiveQuestion(sessions, `Archive all ${sessions.length} ').length - 1, 2);
});

test('alertDialog is awaited where the next step has to wait, and called bare only by window.alert', () => {
  const uses = usesOf('alertDialog', rendererCode());
  const files = (list) => list.map((where) => where.split(':')[0]);
  assert.equal(uses.defined.length, 1);
  assert.deepEqual(uses.loose, []);
  // inPageAlert, which has to return at once, as window.alert's callers expect.
  assert.deepEqual(files(uses.bare), ['dialogs.js'], 'alertDialog(...) without await: is the next line meant to run under the open box?');
  // The plan-item edit gives its field the focus back, the worktree loop goes
  // on to the next checkout, the new project opens its session. Each of the
  // three only after the message was dismissed; a fourth belongs here.
  assert.deepEqual(files(uses.awaited), ['projects-view.js', 'projects-view.js', 'projects-view.js']);
});

test('index.html loads dialogs.js once, after terminal-diagnostics.js', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = (name) => html.indexOf(`<script src="${name}"></script>`);
  const dialogs = at('dialogs.js');
  assert.notEqual(dialogs, -1);
  assert.equal(html.indexOf('"dialogs.js"', dialogs + 20), -1, 'loaded once');
  assert.ok(at('terminal-diagnostics.js') < dialogs, 'the order the focus-watch wiring is written for (either works; see terminal-diagnostics-focus.test.js)');
  // No order is asked of the files that ask or alert: every such call is made
  // from an event handler, long after all the scripts ran. file-actions.js,
  // settings-panel.js and token-stats-view.js load before dialogs.js and
  // reach it all the same.
});

test('the box sits above every layer in the stylesheet and below the diagnostics toast; its text keeps line breaks', () => {
  const css = fs.readFileSync(STYLE, 'utf8');
  // Both classes: the overlay is an .add-project-overlay too, and that rule
  // sets a z-index of its own. Named by one class each, the later of the two
  // rules in the file would win, whatever the numbers say.
  const own = /\.add-project-overlay\.app-dialog-overlay\s*\{\s*z-index:\s*(\d+);\s*\}/.exec(css);
  assert.ok(own, 'style.css has no .add-project-overlay.app-dialog-overlay layer');
  const layer = Number(own[1]);
  const others = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])).filter((z) => z !== layer);
  assert.ok(others.length > 10);
  assert.ok(layer > Math.max(...others), `z-index ${layer} is not above ${Math.max(...others)}`);
  const toast = /\.diag-toast \{[^}]*z-index:\s*(\d+)/.exec(fs.readFileSync(DIAGNOSTICS, 'utf8'));
  assert.ok(toast, 'the diagnostics toast no longer sets a z-index in terminal-diagnostics.js');
  assert.ok(layer < Number(toast[1]), 'the diagnostics toast must stay on top');

  const message = /\.app-dialog-message\s*\{([^}]*)\}/.exec(css);
  assert.ok(message);
  assert.match(message[1], /white-space:\s*pre-wrap;/);
  // A Windows path has no space to break at; without this it runs out of the box.
  assert.match(message[1], /overflow-wrap:\s*anywhere;/);
  // :focus, not :focus-visible: see the comment in style.css.
  assert.match(css, /\.app-dialog \.add-project-actions button:focus\s*\{[^}]*outline:\s*2px solid/);
  // The class the danger button carries has a look of its own. Which look is
  // for the eye to judge.
  assert.match(css, /\.app-dialog \.app-dialog-danger\s*\{[^}]*background:/);
});

// --- The box ---

/** A fake page: elements that know their parent, and one focused element. */
function makeDom() {
  const dom = { active: null, htmlWrites: 0, focusCalls: [] };
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.id = '';
      this.type = '';
      this.disabled = false;
      this.parent = null;
      this.kids = [];
      this.attrs = {};
      this.heard = [];
      this.text = '';
    }
    get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }
    set textContent(value) { this.text = String(value); this.kids = []; }
    // The box must never build markup from a message.
    set innerHTML(value) { dom.htmlWrites++; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    appendChild(kid) { kid.parent = this; this.kids.push(kid); return kid; }
    remove() {
      const hadFocus = dom.active && this.contains(dom.active);
      if (this.parent) this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
      this.parent = null;
      // Chromium: the focus falls to the body when its element leaves the page.
      if (hadFocus) dom.active = dom.body;
    }
    contains(other) {
      for (let node = other; node; node = node.parent) if (node === this) return true;
      return false;
    }
    get isConnected() { return dom.body.contains(this); }
    focus(options) {
      dom.focusCalls.push(this);
      this.focusOptions = options;
      if (this.isConnected && !this.disabled) dom.active = this;
    }
    addEventListener(type, fn) { this.heard.push({ type, fn }); }
    /** Send an event to the listeners put on this element. */
    fire(type, event = {}) { for (const l of this.heard.slice()) if (l.type === type) l.fn({ type, target: this, ...event }); }
    find(className) {
      if (this.className.split(' ').includes(className)) return this;
      for (const kid of this.kids) { const hit = kid.find(className); if (hit) return hit; }
      return null;
    }
  }
  dom.El = El;
  dom.body = new El('body');
  dom.active = dom.body;
  return dom;
}

/**
 * dialogs.js in a context of its own, with the page around it.
 *   app.box()        the box on screen, taken apart, or null
 *   app.key(key)     press a key: a keydown through the window's capture
 *                    listeners, and on to the page behind unless stopped
 *   app.click(el)    press and release the mouse on an element
 *   app.wait()       let time pass: the guards on a box that has just opened
 *                    run out, and the last key is no longer a recent one
 *   app.behind       the key events that reached the page behind
 *   app.recorded     the key events the diagnostics recorder saw (a capture
 *                    listener on the window from before any box)
 */
function boot({ nativeAlert, globals = {} } = {}) {
  const dom = makeDom();
  const capture = [];
  const app = { dom, behind: [], recorded: [], errors: [], clock: 1000, nativeAlerts: [], docListeners: [] };
  const win = {
    alert: nativeAlert || function (message) { app.nativeAlerts.push(message); },
    addEventListener(type, fn, useCapture) { assert.equal(useCapture, true, 'the box listens in the capture phase'); capture.push({ type, fn }); },
    removeEventListener(type, fn, useCapture) {
      assert.equal(useCapture, true);
      const i = capture.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) capture.splice(i, 1);
    },
  };
  const ctx = {
    console: { error: (...a) => app.errors.push(a.map(String).join(' ')), log() {}, warn() {} },
    performance: { now: () => app.clock },
    window: win,
    document: {
      body: dom.body,
      createElement: (tag) => new dom.El(tag),
      get activeElement() { return dom.active; },
      addEventListener(type, fn, useCapture) { app.docListeners.push({ type, fn, useCapture }); },
      removeEventListener(type, fn) {
        const i = app.docListeners.findIndex((l) => l.type === type && l.fn === fn);
        if (i >= 0) app.docListeners.splice(i, 1);
      },
    },
    ...globals,
  };
  /** Code behind the box moves the focus: the element takes it, and the
   *  document hears a focusin, as in a browser (a bare el.focus() in this fake
   *  reports no event). */
  app.focusFrom = (el) => {
    el.focus();
    for (const l of app.docListeners.slice()) if (l.type === 'focusin') l.fn({ type: 'focusin', target: el });
  };
  vm.createContext(ctx);
  // The recorder terminal-diagnostics.js puts on the window at start-up.
  for (const type of ['keydown', 'keypress', 'keyup']) capture.push({ type, fn: (e) => app.recorded.push(e) });
  vm.runInContext(fs.readFileSync(DIALOGS, 'utf8'), ctx, { filename: DIALOGS });
  // What is on the window with no box up: the recorder, and the one listener
  // dialogs.js keeps there to know when a key last went down.
  const before = capture.length;

  Object.assign(app, {
    ctx, win,
    guardMs: vm.runInContext('APP_DIALOG_GUARD_MS', ctx),
    confirm: (message, options) => (options === undefined ? ctx.confirmDialog(message) : ctx.confirmDialog(message, options)),
    alertBox: (message, options) => (options === undefined ? ctx.alertDialog(message) : ctx.alertDialog(message, options)),
    /** Key listeners the box has on the window right now. */
    boxListeners: () => capture.length - before,
    overlays: () => dom.body.kids.filter((el) => el.className.split(' ').includes('app-dialog-overlay')),
    box() {
      const overlays = app.overlays();
      assert.ok(overlays.length <= 1, 'more than one box on screen');
      if (!overlays.length) return null;
      const overlay = overlays[0];
      const dialog = overlay.find('app-dialog');
      const actions = dialog.find('add-project-actions');
      return {
        overlay, dialog,
        heading: dialog.kids.find((k) => k.tagName === 'H3') || null,
        message: dialog.find('app-dialog-message'),
        buttons: actions.kids,
        labels: actions.kids.map((b) => b.textContent),
        cancel: dialog.find('add-project-cancel-btn'),
        confirm: dialog.find('add-project-add-btn'),
      };
    },
    event(type, key, over = {}) {
      const e = {
        type, key, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, stopped: false,
        preventDefault() { e.defaultPrevented = true; },
        stopPropagation() { e.stopped = true; },
        stopImmediatePropagation() { e.stopped = true; e.immediate = true; },
        ...over,
      };
      for (const l of capture.slice()) {
        if (l.type !== type) continue;
        l.fn(e);
        if (e.immediate) break;
      }
      // Past the window's capture phase: the focused element (xterm's
      // textarea), the document listeners of other dialogs, the shortcuts.
      if (!e.stopped) app.behind.push(e);
      return e;
    },
    key: (key, over) => app.event('keydown', key, over),
    click(el) { el.fire('mousedown'); el.fire('click'); },
    wait(ms = 1000) { app.clock += ms; },
    /** Let promise chains run. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return app;
}

/** A promise's state right now: its value once settled, PENDING before. */
const PENDING = Symbol('pending');
async function peek(promise) {
  return Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(PENDING)))]);
}

test('a confirm is an add-project dialog with the message as text, Cancel then the action, and the focus on the action', async () => {
  const app = boot();
  const message = 'Remove <img src=x onerror=alert(1)> from Build?\n\nThe session stays in the Sessions tab under its folder.';
  const answer = app.confirm(message, { confirm: 'Remove' });
  const box = app.box();
  assert.equal(box.overlay.className, 'add-project-overlay app-dialog-overlay');
  assert.equal(box.dialog.className, 'add-project-dialog app-dialog');
  assert.equal(box.dialog.attrs.role, 'alertdialog');
  assert.equal(box.dialog.attrs['aria-modal'], 'true');
  assert.equal(box.dialog.attrs['aria-describedby'], box.message.id);
  assert.equal(box.message.text, message, 'the message, line breaks and markup included, as text');
  assert.equal(app.dom.htmlWrites, 0, 'nothing in the box is built from markup');
  assert.equal(box.heading, null, 'no heading unless a title is given');
  assert.deepEqual(box.labels, ['Cancel', 'Remove']);
  assert.ok(box.buttons.every((b) => b.tagName === 'BUTTON' && b.type === 'button'));
  assert.equal(box.confirm.className, 'add-project-add-btn', 'not a danger button unless asked');
  assert.equal(app.dom.active, box.confirm, 'as in the native box: click, then Enter');
  assert.equal(await peek(answer), PENDING, 'nothing is answered by opening it');
});

test('the options: a title, both labels, and the danger button', () => {
  const app = boot();
  app.confirm('Also remove the checkout?', { title: 'Detach <b>api</b>', confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true });
  const box = app.box();
  assert.equal(box.heading.text, 'Detach <b>api</b>');
  assert.equal(box.dialog.kids.indexOf(box.heading), 0, 'the title comes first');
  assert.deepEqual(box.labels, ['Keep on disk', 'Remove checkout']);
  assert.equal(box.confirm.className, 'add-project-add-btn app-dialog-danger');
  assert.equal(app.dom.htmlWrites, 0);

  const plain = boot();
  plain.confirm('Go on?');
  assert.deepEqual(plain.box().labels, ['Cancel', 'OK']);
  // What a caller passes is shown as text whatever it is.
  const odd = boot();
  odd.confirm(new Error('disk full'), { confirm: 7 });
  assert.equal(odd.box().message.text, 'Error: disk full');
  assert.deepEqual(odd.box().labels, ['Cancel', '7']);
});

test('a confirm resolves true for its button and for Enter, false for Cancel, Escape and the backdrop', async () => {
  const ways = {
    'the confirm button': [(app, box) => box.confirm.fire('click'), true],
    'Cancel': [(app, box) => box.cancel.fire('click'), false],
    'Enter': [(app) => app.key('Enter'), true],
    'Space': [(app) => app.key(' '), true],
    'Shift+Enter': [(app) => app.key('Enter', { shiftKey: true }), true],
    'Escape': [(app) => app.key('Escape'), false],
    'the backdrop': [(app, box) => app.click(box.overlay), false],
    'Tab, Enter': [(app) => { app.key('Tab'); app.key('Enter'); }, false],
    'Shift+Tab, Space': [(app) => { app.key('Tab', { shiftKey: true }); app.key(' '); }, false],
    'Tab, Tab, Enter': [(app) => { app.key('Tab'); app.key('Tab'); app.key('Enter'); }, true],
  };
  for (const [name, [act, want]] of Object.entries(ways)) {
    const app = boot();
    const answer = app.confirm('Stop this session?', { confirm: 'Stop', danger: true });
    app.wait();
    const sent = act(app, app.box());
    if (sent && sent.type === 'keydown') assert.equal(sent.defaultPrevented, true, name + ': the answering key is used up');
    assert.equal(await peek(answer), want, name);
    assert.equal(app.box(), null, `${name}: the box is gone`);
    assert.equal(app.boxListeners(), 0, `${name}: its key listeners are gone`);
  }
});

test('a click inside the box that is not on a button answers nothing', async () => {
  const app = boot();
  const answer = app.confirm('Stop this session?');
  app.wait();
  const box = app.box();
  // A click on the text bubbles to the overlay with the text as its target.
  box.overlay.fire('mousedown', { target: box.message });
  box.overlay.fire('click', { target: box.message });
  // Whatever the press before it was.
  box.overlay.fire('mousedown');
  box.overlay.fire('click', { target: box.dialog });
  assert.equal(await peek(answer), PENDING);
  assert.ok(app.box());
});

test('a press that began inside the box and ends on the backdrop closes nothing', async () => {
  // Dragging across the message to select it, and letting go past the edge of
  // the box: the browser reports a click on what the press and the release
  // have in common, which is the overlay.
  for (const open of [
    (app) => app.confirm('Also remove the checkout at C:\\wt\\api?', { confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true }),
    (app) => app.alertBox('fatal: C:\\wt\\api contains modified or untracked files, use --force to delete it'),
  ]) {
    const app = boot();
    const answer = open(app);
    app.wait();
    const box = app.box();
    for (const from of [box.message, box.dialog, box.confirm]) {
      box.overlay.fire('mousedown', { target: from });
      box.overlay.fire('click');
      assert.equal(await peek(answer), PENDING, `a press on the ${from.className || from.tagName} released on the backdrop`);
      assert.ok(app.box(), 'the message is still there to be copied');
    }
    // A click that is all on the backdrop still closes it.
    app.click(box.overlay);
    assert.notEqual(await peek(answer), PENDING);
    assert.equal(app.box(), null);
  }
});

test('Tab and Shift+Tab stay inside the box', () => {
  const app = boot();
  app.confirm('Stop this session?');
  const box = app.box();
  const seen = [];
  for (const shiftKey of [false, false, false, true, true, true]) {
    const e = app.key('Tab', { shiftKey });
    assert.equal(e.defaultPrevented, true, 'the browser must not move the focus itself');
    seen.push(app.dom.active === box.confirm ? 'confirm' : app.dom.active === box.cancel ? 'cancel' : 'outside');
  }
  assert.deepEqual(seen, ['cancel', 'confirm', 'cancel', 'confirm', 'cancel', 'confirm']);

  const one = boot();
  one.alertBox('Could not save the file.');
  one.key('Tab');
  one.key('Tab', { shiftKey: true });
  assert.equal(one.dom.active, one.box().confirm, 'an alert has the one button to be on');
});

test('an alert has one button and resolves, with nothing, however it is closed', async () => {
  const ways = {
    'OK': (app, box) => box.confirm.fire('click'),
    'Enter': (app) => app.key('Enter'),
    'Space': (app) => app.key(' '),
    'Escape': (app) => app.key('Escape'),
    'the backdrop': (app, box) => app.click(box.overlay),
  };
  for (const [name, act] of Object.entries(ways)) {
    const app = boot();
    const closed = app.alertBox('Could not add the files.\n\nC:\\a\\b: EPERM');
    const box = app.box();
    assert.deepEqual(box.labels, ['OK'], name);
    assert.equal(box.cancel, null);
    assert.equal(box.message.text, 'Could not add the files.\n\nC:\\a\\b: EPERM');
    assert.equal(app.dom.active, box.confirm);
    assert.equal(await peek(closed), PENDING, name);
    app.wait();
    act(app, box);
    assert.equal(await peek(closed), undefined, name);
    assert.equal(app.box(), null, name);
  }
  const labelled = boot();
  labelled.alertBox('Saved.', { title: 'Done', ok: 'Close' });
  assert.deepEqual(labelled.box().labels, ['Close']);
  assert.equal(labelled.box().heading.text, 'Done');
});

test('window.alert is replaced by the in-page box, marked, and does not block', async () => {
  const app = boot();
  assert.equal(app.win.alert.inPage, true, 'the mark terminal-diagnostics.js looks for');
  assert.equal(app.win.alert, app.ctx.inPageAlert);

  // Called bare, the way every call site does it.
  const { alert } = app.win;
  assert.equal(alert('Pick a time in the future.'), undefined, 'returns at once, and no Promise a caller could mistake for an answer');
  assert.equal(app.box().message.text, 'Pick a time in the future.');
  assert.deepEqual(app.nativeAlerts, [], 'the native box is never opened');
  app.key('Enter');
  assert.equal(app.box(), null);

  // The native alert turned whatever it was given into text.
  for (const [given, shown] of [[[], ''], [[undefined], 'undefined'], [[null], 'null'], [[42], '42'], [[new Error('EBUSY')], 'Error: EBUSY']]) {
    app.wait();
    alert(...given);
    assert.equal(app.box().message.text, shown);
    app.key('Escape');
  }
  await app.settle();
  assert.deepEqual(app.errors, []);
});

test('one box at a time: later requests wait their turn, first in first out', async () => {
  const app = boot();
  const order = [];
  const first = app.confirm('first?').then((v) => { order.push(['first', v]); });
  app.win.alert('second');
  const third = app.confirm('third?', { confirm: 'Delete' }).then((v) => { order.push(['third', v]); });
  const fourth = app.alertBox('fourth').then((v) => { order.push(['fourth', v]); });

  assert.equal(app.box().message.text, 'first?');
  app.key('Escape');
  assert.equal(app.box().message.text, 'second', 'the next one opens as the first closes');
  await app.settle();
  assert.deepEqual(order, [['first', false]]);
  // An Enter still held from answering one box must not answer the next,
  // however long it is held.
  app.wait();
  app.key('Enter', { repeat: true });
  assert.equal(app.box().message.text, 'second');
  app.key('Enter');
  assert.equal(app.box().message.text, 'third?');
  assert.deepEqual(app.box().labels, ['Cancel', 'Delete']);
  app.wait();
  app.key('Enter');
  assert.equal(app.box().message.text, 'fourth');
  app.wait();
  app.key('Escape');
  assert.equal(app.box(), null);
  await Promise.all([first, third, fourth]);
  assert.deepEqual(order, [['first', false], ['third', true], ['fourth', undefined]]);
  assert.equal(app.boxListeners(), 0);
});

test('a box answers once: a late click on one that has closed opens nothing and answers nothing', async () => {
  const app = boot();
  const first = app.confirm('first?');
  const second = app.confirm('second?');
  const third = app.confirm('third?');
  app.wait();
  const stale = app.box();
  stale.confirm.fire('click');
  assert.equal(await peek(first), true);
  assert.equal(app.box().message.text, 'second?');

  // A second answer from the first box would tell the queue that the box on
  // screen had closed, and the third would open on top of the second.
  app.wait();
  stale.confirm.fire('click');
  stale.cancel.fire('click');
  app.click(stale.overlay);
  assert.equal(app.overlays().length, 1, 'one box on screen');
  assert.equal(app.box().message.text, 'second?');
  assert.equal(await peek(second), PENDING);
  assert.equal(await peek(third), PENDING);

  app.box().cancel.fire('click');
  assert.equal(await peek(second), false);
  assert.equal(app.box().message.text, 'third?', 'the queue goes on in order');
  app.wait();
  app.box().confirm.fire('click');
  assert.equal(await peek(third), true);
  assert.equal(app.box(), null);
  assert.equal(app.boxListeners(), 0);
});

test('a key pressed as a box appears is not its answer: the next box in the queue, and one that opens while the user types', async () => {
  // Found in review. The Enter that closes one box is followed by the next
  // box in the same tick, with the focus on its confirm button.
  const app = boot();
  app.alertBox('C:\\wt\\api: the folder is in use');
  const answer = app.confirm('C:\\wt\\web has uncommitted changes.\n\nRemove it anyway and lose them?', { confirm: 'Remove anyway', danger: true });
  app.key('Enter');
  assert.deepEqual(app.box().labels, ['Cancel', 'Remove anyway'], 'the alert is closed and the question is up');
  const again = app.key('Enter');
  assert.equal(again.defaultPrevented, true, 'the key does nothing at all');
  assert.equal(again.stopped, true);
  app.key(' ');
  // Escape too: on an alert it would close a message nobody has read.
  app.key('Escape');
  assert.equal(await peek(answer), PENDING, 'a second Enter does not remove the checkout');
  assert.equal(app.dom.active, app.box().confirm, 'the box is as it opened');
  app.wait(app.guardMs - 1);
  app.key('Enter');
  assert.equal(await peek(answer), PENDING, 'just inside the guard');
  app.wait(1);
  app.key('Enter');
  assert.equal(await peek(answer), true, 'once the box has been on screen for a moment, a key answers it');

  // A box that opens by itself (a reply came back) while the user types in a
  // terminal: the keys meant for the terminal reach neither it nor the box.
  const typing = boot();
  typing.key('y');
  typing.wait(typing.guardMs - 1);
  const closed = typing.alertBox('Could not save the file.');
  typing.behind.length = 0;
  for (const key of ['Escape', ' ', 'Enter']) assert.equal(typing.key(key).defaultPrevented, true, key);
  assert.equal(await peek(closed), PENDING, 'the message stays up to be read');
  assert.deepEqual(typing.behind, []);
  typing.wait(typing.guardMs);
  typing.key('Escape');
  assert.equal(await peek(closed), undefined);

  // Found in review: Escape kept down. Its repeats ran past the guard and
  // closed every box in the queue, each 350 ms after it opened, unread.
  const held = boot();
  held.alertBox('C:\\wt\\api: the folder is in use');
  held.alertBox('C:\\wt\\web: the folder is in use');
  const last = held.confirm('Remove the project?', { confirm: 'Remove', danger: true });
  held.key('Escape');
  assert.equal(held.box().message.text, 'C:\\wt\\web: the folder is in use', 'the press itself closes the box it was meant for');
  for (let i = 0; i < 40; i++) {
    held.wait(30);
    const repeat = held.key('Escape', { repeat: true });
    assert.equal(repeat.defaultPrevented, true);
    assert.equal(repeat.stopped, true);
  }
  assert.equal(held.box().message.text, 'C:\\wt\\web: the folder is in use', 'a key that is still down answers nothing, however long it is held');
  held.event('keyup', 'Escape');
  held.key('Escape');
  assert.deepEqual(held.box().labels, ['Cancel', 'Remove'], 'let go and pressed again, it does');
  held.wait();
  held.key(' ', { repeat: true });
  assert.equal(await peek(last), PENDING, 'the same for Space');
  assert.deepEqual(held.behind, []);

  // Tab is not an answer and is not held back.
  const tabbing = boot();
  tabbing.key('y');
  tabbing.confirm('Stop this session?', { confirm: 'Stop', danger: true });
  tabbing.key('Tab');
  assert.equal(tabbing.dom.active, tabbing.box().cancel);

  // The user had stopped typing: the first key is an answer, as after a click.
  const paused = boot();
  paused.key('y');
  paused.wait(paused.guardMs);
  const stop = paused.confirm('Stop this session?', { confirm: 'Stop', danger: true });
  paused.key('Enter');
  assert.equal(await peek(stop), true);
});

test('the focus goes back to where it was, if that is still on the page', async () => {
  const app = boot();
  const terminal = app.dom.body.appendChild(new app.dom.El('textarea'));
  terminal.className = 'xterm-helper-textarea';
  terminal.focus();

  const answer = app.confirm('Stop this session?', { confirm: 'Stop' });
  assert.equal(app.dom.active, app.box().confirm);
  app.key('Enter');
  assert.equal(await answer, true);
  assert.equal(app.dom.active, terminal, 'typing carries on in the terminal');
  // Read as a property: the options object was made inside the vm, so it is not deepEqual to one made here.
  assert.equal(terminal.focusOptions && terminal.focusOptions.preventScroll, true, 'given back without scrolling the terminal to its off-screen textarea');

  // Two in a row: each goes back to the same place.
  app.wait();
  app.confirm('one?');
  app.win.alert('two');
  app.key('Escape');
  assert.equal(app.dom.active, app.box().confirm);
  app.wait();
  app.key('Escape');
  assert.equal(app.dom.active, terminal);

  // The row that asked was removed while the box was up (a list re-rendered).
  const row = app.dom.body.appendChild(new app.dom.El('button'));
  row.focus();
  app.wait();
  app.confirm('Archive?');
  row.remove();
  app.dom.focusCalls.length = 0;
  app.key('Enter');
  assert.equal(app.dom.focusCalls.includes(row), false, 'an element that left the page is not focused');
  assert.equal(app.dom.active, app.dom.body);

  // Nothing had the focus: nothing is given it.
  app.dom.focusCalls.length = 0;
  app.wait();
  app.confirm('Again?');
  app.dom.focusCalls.length = 0;
  app.key('Escape');
  assert.deepEqual(app.dom.focusCalls, []);
});

test('no key reaches the page behind while a box is up, and the diagnostics recorder still sees them all', () => {
  const app = boot();
  app.key('a');
  assert.equal(app.behind.length, 1, 'with no box, keys pass');

  app.wait();
  app.confirm('Stop this session?');
  app.behind.length = 0;
  app.recorded.length = 0;
  const sent = [];
  for (const type of ['keydown', 'keypress', 'keyup']) {
    for (const key of ['a', 'A', 'ArrowDown', 'F5', 'Backspace']) sent.push(app.event(type, key));
  }
  sent.push(app.key('c', { ctrlKey: true }), app.key('d', { ctrlKey: true, shiftKey: true }), app.key(' ', { altKey: true }));
  sent.push(app.key('Enter', { ctrlKey: true }), app.key('Enter', { metaKey: true }), app.key('Enter', { altKey: true }));
  assert.deepEqual(app.behind, [], 'a key reached the page behind the box');
  assert.equal(app.recorded.length, sent.length, 'stopPropagation, not stopImmediatePropagation: Ctrl+Shift+D must still work');
  assert.ok(sent.every((e) => !e.immediate));
  // Left to the browser: copying the message with Ctrl+C, the window menu on
  // Alt+Space, the application menu's shortcuts.
  assert.ok(sent.every((e) => e.defaultPrevented === false), 'a key the box does not use keeps its default');
  assert.ok(app.box(), 'and none of them answered the box');

  // The keys the box does use do not also do what the browser would do.
  assert.equal(app.key('Tab').defaultPrevented, true);
  const enterUp = app.event('keyup', 'Enter');
  assert.equal(enterUp.stopped, true);
  assert.ok(app.box(), 'the box answers on key-down only');
  assert.equal(app.key('Enter', { repeat: true }).defaultPrevented, true);
  assert.ok(app.box(), 'a key held down since before the box does not answer it');
  assert.equal(app.key('Escape').defaultPrevented, true);
  assert.equal(app.box(), null);

  app.behind.length = 0;
  app.key('a');
  assert.equal(app.behind.length, 1, 'once the box is closed, keys pass again');
});

test('when something behind the box takes the focus, a key neither types there nor answers the box', async () => {
  const app = boot();
  const terminal = app.dom.body.appendChild(new app.dom.El('textarea'));
  const answer = app.confirm('Remove the project?', { confirm: 'Remove', danger: true });
  const box = app.box();
  terminal.focus();   // showSession() on an event from main, say

  const typed = app.key('x');
  assert.equal(typed.defaultPrevented, true, 'the default would have typed into the terminal');
  assert.equal(typed.stopped, true);
  assert.equal(app.dom.active, box.confirm, 'the focus is taken back');

  terminal.focus();
  const paste = app.key('v', { ctrlKey: true });
  assert.equal(paste.defaultPrevented, true, 'so would a paste');

  terminal.focus();
  const enter = app.key('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(await peek(answer), PENDING, 'an Enter meant for the terminal does not remove the project');
  assert.equal(app.dom.active, box.confirm);
  app.key('Enter');
  assert.equal(await peek(answer), true, 'the next one, with the ring on the button, does');

  // Escape is always a way out.
  app.wait();
  const second = app.confirm('Again?');
  terminal.focus();
  app.key('Escape');
  assert.equal(await peek(second), false);
});

test('code behind the box that takes the focus loses it again at once, so one Enter still answers', async () => {
  const app = boot();
  const terminal = app.dom.body.appendChild(new app.dom.El('textarea'));
  terminal.focus();
  const answer = app.confirm('Stop this session?', { confirm: 'Stop', danger: true });
  const box = app.box();
  assert.equal(app.docListeners.filter((l) => l.type === 'focusin' && l.useCapture === true).length, 1, 'the box listens for the focus leaving it');

  app.focusFrom(terminal);          // a sidebar repaint, or showSession() on an event from main
  assert.equal(app.dom.active, box.confirm, 'taken straight back');
  app.key('Tab');                   // on Cancel now
  app.focusFrom(box.cancel);        // the browser reports the move inside the box too
  app.focusFrom(terminal);
  assert.equal(app.dom.active, box.cancel, 'back to the button it was on, not always the confirm button');
  app.key('Tab');
  app.focusFrom(box.confirm);
  app.focusFrom(terminal);
  app.key('Enter');
  assert.equal(await peek(answer), true, 'click Stop, press Enter: one Enter');
  assert.equal(app.docListeners.length, 0, 'and the box stops listening when it closes');
  assert.equal(app.dom.active, terminal);
});

test('a box opened from a button hands the keyboard to the terminal on screen, not back to the button', async () => {
  const session = (visible) => {
    const entry = { focused: 0, element: { offsetParent: visible ? {} : null } };
    entry.terminal = { focus() { entry.focused++; } };
    return entry;
  };
  // The header's Stop button was clicked: it has the focus when the box opens.
  const shown = session(true);
  let app = boot({ globals: { activeSessionId: 's1', openSessions: new Map([['s1', shown]]) } });
  let button = app.dom.body.appendChild(new app.dom.El('button'));
  button.focus();
  let answer = app.confirm('Stop this session?', { confirm: 'Stop' });
  app.key('Escape');
  assert.equal(await answer, false);
  assert.equal(shown.focused, 1, 'the terminal on screen gets the keyboard');
  assert.equal(app.box(), null);

  // A terminal that is not on screen (another tab is showing) is left alone.
  const hidden = session(false);
  app = boot({ globals: { activeSessionId: 's1', openSessions: new Map([['s1', hidden]]) } });
  button = app.dom.body.appendChild(new app.dom.El('button'));
  button.focus();
  answer = app.confirm('Remove the project?', { confirm: 'Remove' });
  app.key('Escape');
  await answer;
  assert.equal(hidden.focused, 0);
  assert.equal(app.dom.active, button, 'back to the button, as before');

  // A field the user was typing in keeps the keyboard, terminal or no terminal.
  const other = session(true);
  app = boot({ globals: { activeSessionId: 's1', openSessions: new Map([['s1', other]]) } });
  const field = app.dom.body.appendChild(new app.dom.El('input'));
  field.focus();
  answer = app.confirm('Delete the scheduled task?', { confirm: 'Delete' });
  app.key('Escape');
  await answer;
  assert.equal(other.focused, 0);
  assert.equal(app.dom.active, field);
});

test('with the focus on no button, Enter puts it back on the confirm button and answers on the next press', async () => {
  const app = boot();
  const answer = app.confirm('Delete the scheduled task?', { confirm: 'Delete', danger: true });
  const box = app.box();
  app.dom.active = app.dom.body;   // a click on the message text
  const copy = app.key('c', { ctrlKey: true });
  assert.equal(copy.defaultPrevented, false, 'the selected text can be copied');
  assert.equal(app.dom.active, app.dom.body, 'and the selection is not disturbed by moving the focus');
  app.key('Enter');
  assert.equal(await peek(answer), PENDING);
  assert.equal(app.dom.active, box.confirm);
  app.key('Enter');
  assert.equal(await peek(answer), true);
});

test('a click in the first moments after the box opens is not an answer; a key is', async () => {
  for (const target of ['confirm', 'cancel', 'overlay']) {
    const app = boot();
    const answer = app.confirm('Stop this session?', { confirm: 'Stop' });
    const box = app.box();
    // The second click of a double-click on whatever opened the box.
    app.wait(120);
    app.click(box[target]);
    assert.equal(await peek(answer), PENDING, `${target} at 120 ms`);
    app.wait(app.guardMs - 121);
    app.click(box[target]);
    assert.equal(await peek(answer), PENDING, `${target} just inside the guard`);
    app.wait(1);
    app.click(box[target]);
    assert.equal(await peek(answer), target === 'confirm', `${target} once the guard is over`);
  }
  // "Click Stop, press Enter" is not slowed down.
  const quick = boot();
  const answer = quick.confirm('Stop this session?', { confirm: 'Stop' });
  quick.key('Enter');
  assert.equal(await peek(answer), true);
});

test('the second click of a double-click that answered one box is not an answer to the next', async () => {
  // Found in review. Detaching a worktree asks twice, and "Remove checkout"
  // comes up where "Detach" was: 360 ms after the first click, just past the
  // guard on a new box, a second click removed the checkout.
  const afterMs = (app) => vm.runInContext('APP_DIALOG_AFTER_ANSWER_MS', app.ctx);
  for (const target of ['confirm', 'cancel', 'overlay']) {
    const app = boot();
    app.confirm('Detach api from Build?', { confirm: 'Detach' });
    const second = app.confirm('Also remove the checkout at C:\\wt\\api?', { confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true });
    assert.ok(afterMs(app) >= 700, 'longer than a double-click: 500 ms is the Windows default, and people set it slower');
    app.wait();
    app.box().confirm.fire('click');
    const box = app.box();
    assert.deepEqual(box.labels, ['Keep on disk', 'Remove checkout'], 'the next box is up in the same task');
    let waited = 0;
    for (const at of [app.guardMs + 10, 499, afterMs(app) - 1]) {
      app.wait(at - waited);
      waited = at;
      app.click(box[target]);
      assert.equal(await peek(second), PENDING, `${target}, ${at} ms after the answer`);
    }
    app.wait(1);
    app.click(box[target]);
    assert.equal(await peek(second), target === 'confirm', `${target} once a double-click is over`);
  }

  // Counted from the answer, not from the opening: the next question may come
  // only after a reply from main (the checkout turned out to be dirty).
  const late = boot();
  late.confirm('Also remove the checkout?', { confirm: 'Remove checkout', danger: true });
  late.wait();
  late.box().confirm.fire('click');
  late.wait(300);
  const anyway = late.confirm('Remove it anyway and lose those changes?', { confirm: 'Remove anyway', danger: true });
  late.wait(late.guardMs + 10);
  late.click(late.box().confirm);
  assert.equal(await peek(anyway), PENDING, '660 ms after the answer');
  late.wait(40);
  late.click(late.box().confirm);
  assert.equal(await peek(anyway), true);

  // A box that comes long after the last answer has the short guard only.
  const apart = boot();
  apart.confirm('one?');
  apart.wait();
  apart.box().confirm.fire('click');
  apart.wait();
  const two = apart.confirm('two?');
  apart.wait(apart.guardMs);
  apart.click(apart.box().confirm);
  assert.equal(await peek(two), true);

  // A key after the click is a second decision, and is not held back.
  const keyed = boot();
  keyed.confirm('Detach api from Build?', { confirm: 'Detach' });
  const kept = keyed.confirm('Also remove the checkout?', { confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true });
  keyed.wait();
  keyed.box().confirm.fire('click');
  keyed.key('Escape');
  assert.equal(await peek(kept), false);
});

test('a box that cannot be built is a no, is reported, and does not hold up the next one', async () => {
  const app = boot();
  const append = app.dom.body.appendChild;
  app.dom.body.appendChild = () => { throw new Error('no body'); };
  const answer = app.confirm('Remove the project?', { confirm: 'Remove', danger: true });
  assert.equal(await peek(answer), false, 'nothing was confirmed');
  assert.equal(app.errors.length, 1);
  assert.match(app.errors[0], /^\[dialog\] could not show an in-page dialog: Error: no body/);
  assert.equal(app.boxListeners(), 0, 'no key listener is left swallowing every key');
  app.key('a');
  assert.equal(app.behind.length, 1);

  app.dom.body.appendChild = append;
  app.wait();
  const next = app.confirm('And this?');
  assert.ok(app.box(), 'the queue is not stuck');
  app.key('Enter');
  assert.equal(await peek(next), true);
});

// --- The call sites ---
//
// What each flow that stops, deletes or detaches something does with its
// answers. The function is the shipped text, cut out of its file from its
// first line to the first line of what follows it; everything it reaches is a
// fake. Found in review: with the `!` gone from one of these, or the two
// labels of another swapped, every other test here still passed.

/** The source from `start` up to `end`. Both markers must be there, `start` once. */
function cut(file, start, end) {
  const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const a = src.indexOf(start);
  assert.ok(a >= 0, `marker not found in ${file}: ${start}`);
  assert.equal(src.indexOf(start, a + 1), -1, `marker is not unique in ${file}: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `end marker not found after it in ${file}: ${end}`);
  return src.slice(a, b);
}

/** A promise and the function that settles it, for a box that is still up. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** A value made inside the vm context, as one of this file's own objects. */
const plain = (value) => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);

/**
 * One flow in a context of its own.
 *   answers     what confirmDialog resolves to, one per question, in order. A
 *               question with no answer left fails the test
 *   api         window.api: name -> what the call answers (a function of its
 *               arguments)
 *   alertGate   a deferred the awaited alertDialog stays open on
 *   globals     whatever else the flow reaches
 * calls.asked is every question as { message, options }; calls.api every
 * window.api call as [name, ...arguments]; calls.alerts every message shown,
 * by alert() or alertDialog(); calls.reloads how often the list was reloaded.
 */
function bootFlow(code, file, { answers = [], api = {}, alertGate = null, globals = {} } = {}) {
  const calls = { asked: [], api: [], alerts: [], reloads: 0 };
  const ctx = {
    confirmDialog: async (message, options) => {
      calls.asked.push({ message, options: plain(options) });
      assert.ok(answers.length, `a question the test did not expect: ${message}`);
      return answers.shift();
    },
    alertDialog: async (message) => {
      calls.alerts.push(message);
      if (alertGate) await alertGate.promise;
    },
    alert: (message) => { calls.alerts.push(message); },
    loadProjects: () => { calls.reloads++; },
    pathBasename: (p) => String(p).split(/[\\/]/).pop(),
    window: {
      api: Object.fromEntries(Object.entries(api).map(([name, reply]) => [name, async (...args) => {
        calls.api.push([name, ...args.map(plain)]);
        return reply(...args);
      }])),
    },
    ...globals,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: path.join(PUBLIC, file) });
  return { ctx, calls };
}

const DETACH_FLOW = cut('projects-view.js', 'async function detachFolderFlow(project, folder) {', 'async function deleteTrackFlow(');
const OFFER_FLOW = cut('projects-view.js', 'async function offerWorktreeRemoval(project, worktrees) {', 'function runningWorkInProject(project) {');
const REMOVE_PROJECT_FLOW = cut('projects-view.js', 'async function removeProjectFlow(project) {', '// --- "Sessions start in" select');
const DELETE_SCHEDULE_FLOW = cut('schedules.js', 'async function deleteScheduleFlow(schedule) {', '/** Reload the list');
const STOP_FLOW = cut('app.js', 'async function confirmAndStopSession(sessionId) {', '// --- Terminal header controls ---');

const BUILD = { id: 'p1', name: 'Build', root: 'C:\\projects\\build' };
const WORKTREE = { path: 'C:\\wt\\api', mode: 'worktree', branch: 'build' };
// Any mode but 'worktree': nothing of it is on disk for the project to remove.
const LINKED = { path: 'C:\\src\\docs', mode: 'shared' };

test('detaching a folder: Cancel, Escape and the backdrop detach nothing, a worktree included', async () => {
  // Found in review: the worktree's one box asked only about the checkout, and
  // both of its answers detached, so there was no way out of it.
  for (const folder of [LINKED, WORKTREE]) {
    const flow = bootFlow(DETACH_FLOW, 'projects-view.js', { answers: [false], api: { detachProjectFolder: () => ({ ok: true }) } });
    await flow.ctx.detachFolderFlow(BUILD, folder);
    assert.deepEqual(flow.calls.api, [], folder.mode);
    assert.equal(flow.calls.reloads, 0);
    assert.equal(flow.calls.asked.length, 1, 'the checkout is not asked about once the detach is refused');
    assert.match(flow.calls.asked[0].message, /^Detach \w+ from Build\?/);
    assert.deepEqual(flow.calls.asked[0].options, { confirm: 'Detach' }, 'detaching alone loses nothing: not a red button');
  }
});

test('detaching a folder that is not a worktree: one question, and nothing is said about a checkout', async () => {
  const flow = bootFlow(DETACH_FLOW, 'projects-view.js', { answers: [true], api: { detachProjectFolder: () => ({ ok: true }) } });
  await flow.ctx.detachFolderFlow(BUILD, LINKED);
  assert.equal(flow.calls.asked.length, 1);
  assert.match(flow.calls.asked[0].message, /Nothing on disk changes\./);
  assert.deepEqual(flow.calls.api, [['detachProjectFolder', 'p1', 'C:\\src\\docs', {}]]);
  assert.equal(flow.calls.reloads, 1);
});

test('detaching a worktree: the checkout is removed for "Remove checkout" and for nothing else', async () => {
  for (const [second, removeWorktree] of [[true, true], [false, false]]) {
    const flow = bootFlow(DETACH_FLOW, 'projects-view.js', { answers: [true, second], api: { detachProjectFolder: () => ({ ok: true }) } });
    await flow.ctx.detachFolderFlow(BUILD, WORKTREE);
    assert.equal(flow.calls.asked.length, 2);
    assert.equal(/Nothing on disk changes/.test(flow.calls.asked[0].message), false, 'not said of a worktree, where the next answer may change it');
    assert.match(flow.calls.asked[1].message, /^Also remove the checkout at C:\\wt\\api\?/);
    assert.match(flow.calls.asked[1].message, /The branch "build" stays either way\./);
    // true, the confirm button, is "Remove checkout". Escape and the backdrop
    // are false, with Cancel: "Keep on disk".
    assert.deepEqual(flow.calls.asked[1].options, { confirm: 'Remove checkout', cancel: 'Keep on disk', danger: true });
    assert.deepEqual(flow.calls.api, [['detachProjectFolder', 'p1', 'C:\\wt\\api', { removeWorktree }]]);
    assert.equal(flow.calls.reloads, 1);
  }
});

test('detaching a worktree with uncommitted changes: forced only for "Remove anyway"', async () => {
  const dirty = (id, folderPath, opts) => (opts.force ? { ok: true } : { dirty: true, error: ' M src/api.js' });
  const forced = bootFlow(DETACH_FLOW, 'projects-view.js', { answers: [true, true, true], api: { detachProjectFolder: dirty } });
  await forced.ctx.detachFolderFlow(BUILD, WORKTREE);
  assert.match(forced.calls.asked[2].message, /uncommitted changes\.\n\n M src\/api\.js\n\nRemove it anyway/);
  assert.deepEqual(forced.calls.asked[2].options, { confirm: 'Remove anyway', danger: true });
  assert.deepEqual(forced.calls.api, [
    ['detachProjectFolder', 'p1', 'C:\\wt\\api', { removeWorktree: true }],
    ['detachProjectFolder', 'p1', 'C:\\wt\\api', { removeWorktree: true, force: true }],
  ]);
  assert.deepEqual(forced.calls.alerts, []);
  assert.equal(forced.calls.reloads, 1);

  const kept = bootFlow(DETACH_FLOW, 'projects-view.js', { answers: [true, true, false], api: { detachProjectFolder: dirty } });
  await kept.ctx.detachFolderFlow(BUILD, WORKTREE);
  assert.equal(kept.calls.api.length, 1, 'no forced removal');
  assert.deepEqual(kept.calls.alerts, [' M src/api.js']);
  assert.equal(kept.calls.reloads, 0);
});

test('removing a done project\'s worktrees: nothing without a yes, and one failure is read before the next checkout is touched', async () => {
  const refused = bootFlow(OFFER_FLOW, 'projects-view.js', { answers: [false], api: { detachProjectFolder: () => ({ ok: true }) } });
  await refused.ctx.offerWorktreeRemoval(BUILD, ['C:\\wt\\api', 'C:\\wt\\web']);
  assert.deepEqual(refused.calls.api, []);
  assert.match(refused.calls.asked[0].message, /^Remove 2 worktrees for Build\?\n\nC:\\wt\\api\nC:\\wt\\web\n\n/);
  assert.deepEqual(refused.calls.asked[0].options, { confirm: 'Remove', cancel: 'Keep on disk', danger: true });

  // The native alert held the loop until OK. The in-page one does not, so the
  // loop awaits it: the second checkout waits for the first message to go.
  const alertGate = deferred();
  const flow = bootFlow(OFFER_FLOW, 'projects-view.js', {
    answers: [true],
    alertGate,
    api: { detachProjectFolder: (id, p) => (p === 'C:\\wt\\api' ? { error: 'C:\\wt\\api: the folder is in use' } : { ok: true }) },
  });
  const done = flow.ctx.offerWorktreeRemoval(BUILD, ['C:\\wt\\api', 'C:\\wt\\web']);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flow.calls.alerts, ['C:\\wt\\api: the folder is in use']);
  assert.deepEqual(flow.calls.api, [['detachProjectFolder', 'p1', 'C:\\wt\\api', { removeWorktree: true }]], 'the message is up and the second worktree has not been touched');
  alertGate.resolve();
  await done;
  assert.deepEqual(flow.calls.api.map((call) => call[2]), ['C:\\wt\\api', 'C:\\wt\\web']);
});

test('removing a done project\'s worktrees: a dirty one is forced only for "Remove anyway"', async () => {
  const dirty = (id, p, opts) => (opts.force ? { ok: true } : { dirty: true, error: ' M notes.md' });
  const forced = bootFlow(OFFER_FLOW, 'projects-view.js', { answers: [true, true], api: { detachProjectFolder: dirty } });
  await forced.ctx.offerWorktreeRemoval(BUILD, ['C:\\wt\\api']);
  assert.match(forced.calls.asked[1].message, /^C:\\wt\\api has uncommitted changes\./);
  assert.deepEqual(forced.calls.asked[1].options, { confirm: 'Remove anyway', danger: true });
  assert.deepEqual(forced.calls.api[1], ['detachProjectFolder', 'p1', 'C:\\wt\\api', { removeWorktree: true, force: true }]);
  assert.deepEqual(forced.calls.alerts, []);

  const kept = bootFlow(OFFER_FLOW, 'projects-view.js', { answers: [true, false], api: { detachProjectFolder: dirty } });
  await kept.ctx.offerWorktreeRemoval(BUILD, ['C:\\wt\\api']);
  assert.equal(kept.calls.api.length, 1, 'no forced removal');
  assert.deepEqual(kept.calls.alerts, [' M notes.md']);
});

test('deleting a scheduled task, removing a project and stopping a session each do nothing without a yes', async () => {
  const flows = {
    'delete a scheduled task': {
      code: DELETE_SCHEDULE_FLOW, file: 'schedules.js',
      api: 'deleteSchedule', globals: (calls) => ({ refreshSchedules: async () => { calls.reloads++; } }),
      run: (ctx) => ctx.deleteScheduleFlow({ id: 's1', name: 'Nightly' }),
      asks: /^Delete the scheduled task “Nightly”\?/, options: { confirm: 'Delete', danger: true }, call: ['deleteSchedule', 's1'],
    },
    'remove a project': {
      code: REMOVE_PROJECT_FLOW, file: 'projects-view.js',
      api: 'deleteProject', globals: () => ({
        projectsUi: { navigationByProject: new Map([['p1', {}]]), selectedProjectId: 'p2' },
        saveProjectsUi() {}, leaveProjectViews() {}, placeholder: { style: {} },
      }),
      run: (ctx) => ctx.removeProjectFlow(BUILD),
      asks: /^Remove Build from Switchboard\?/, options: { confirm: 'Remove', danger: true }, call: ['deleteProject', 'p1'],
    },
    'stop a session': {
      code: STOP_FLOW, file: 'app.js',
      api: 'stopSession', globals: (calls) => ({
        activePtyIds: new Set(['sess1']), gridViewActive: true, activeSessionId: 'sess1',
        setActiveSession() {}, terminalHeader: { style: {} }, placeholder: { style: {} },
        refreshSidebar: () => { calls.reloads++; },
      }),
      run: (ctx) => ctx.confirmAndStopSession('sess1'),
      asks: /^Stop this session\?$/, options: { confirm: 'Stop', danger: true }, call: ['stopSession', 'sess1'],
    },
  };
  for (const [name, flow] of Object.entries(flows)) {
    for (const answer of [false, true]) {
      const calls = { reloads: 0 };
      const booted = bootFlow(flow.code, flow.file, { answers: [answer], api: { [flow.api]: () => ({ ok: true }) }, globals: flow.globals(calls) });
      await flow.run(booted.ctx);
      assert.equal(booted.calls.asked.length, 1, name);
      assert.match(booted.calls.asked[0].message, flow.asks);
      assert.deepEqual(booted.calls.asked[0].options, flow.options, name);
      assert.deepEqual(booted.calls.api, answer ? [flow.call] : [], `${name}, answered ${answer}`);
      assert.equal(calls.reloads + booted.calls.reloads, answer ? 1 : 0, `${name}, answered ${answer}: the list is repainted only after the action`);
      assert.deepEqual(booted.calls.alerts, []);
    }
  }
});

const CLEAR_STOP_FLOW = cut('app.js', 'async function clearStop() {', 'async function refreshStopState() {');
const TRACK_DONE_FLOW = cut('projects-view.js', 'async function toggleTrackDone(project, track, patch) {', 'async function toggleProjectDone(project) {');
const EDIT_ITEM_FLOW = cut('projects-view.js', 'function editItemInline(project, kind, item, textEl, afterSave) {', 'async function toggleFileLine(');

test('lifting the scheduler stop: scheduled tasks run again for "Resume" and for nothing else', async () => {
  // The flow's own comment: lifting a stop "should not be a single stray
  // click". The question is the whole of that safety.
  for (const answer of [false, true]) {
    const outcomes = [];
    let refreshed = 0;
    const flow = bootFlow(CLEAR_STOP_FLOW, 'app.js', {
      answers: [answer],
      api: { clearDriverHalt: () => ({ ok: true }) },
      globals: {
        stopState: { halted: { halted: true, reason: 'a runaway nightly' }, survivors: [4242, 4243] },
        setStopOutcome: (text, kind) => { outcomes.push([text, kind]); },
        refreshStopState: async () => { refreshed++; },
      },
    });
    await flow.ctx.clearStop();
    assert.deepEqual(flow.calls.asked, [{
      message: 'Let scheduled tasks run again?\n\nCurrent stop reason:\na runaway nightly\n\n2 process(es) from the last stop were never confirmed dead.',
      options: { confirm: 'Resume' },
    }]);
    assert.deepEqual(flow.calls.api, answer ? [['clearDriverHalt']] : [], `answered ${answer}`);
    assert.deepEqual(outcomes, answer ? [['scheduled tasks may run again', 'ok']] : [], `answered ${answer}`);
    assert.equal(refreshed, answer ? 1 : 0);
  }
});

test('marking a track done: its scheduled tasks pause only for "Mark as done", and no question is asked where nothing pauses', async () => {
  const schedules = [
    { trackId: 't1', enabled: true }, { trackId: 't1', enabled: true },
    { trackId: 't1', enabled: false }, { trackId: 't2', enabled: true },
  ];
  const run = async (track, answers) => {
    const patches = [];
    const flow = bootFlow(TRACK_DONE_FLOW, 'projects-view.js', { answers, globals: { schedulesForProject: () => schedules } });
    await flow.ctx.toggleTrackDone(BUILD, track, async (patch) => { patches.push(plain(patch)); });
    return { asked: flow.calls.asked, patches };
  };
  const refused = await run({ id: 't1', name: 'Release', status: 'active' }, [false]);
  assert.deepEqual(refused.asked, [{
    message: 'Mark “Release” as done?\n\n2 scheduled tasks in it will pause until the track is reopened.',
    options: { confirm: 'Mark as done' },
  }]);
  assert.deepEqual(refused.patches, [], 'Cancel leaves the track as it was');
  assert.deepEqual((await run({ id: 't1', name: 'Release', status: 'active' }, [true])).patches, [{ status: 'done' }]);

  // One task, in the singular; none, and reopening: nothing to ask.
  assert.match((await run({ id: 't2', name: 'Docs', status: 'active' }, [true])).asked[0].message, /\n\n1 scheduled task in it will pause/);
  assert.deepEqual(await run({ id: 't3', name: 'Idle', status: 'active' }, []), { asked: [], patches: [{ status: 'done' }] });
  assert.deepEqual(await run({ id: 't1', name: 'Release', status: 'done' }, []), { asked: [], patches: [{ status: 'active' }] });
});

test('a plan-item edit that fails: the field is given back, with the focus, only once the message is dismissed', async () => {
  // The native alert held the handler until OK. The in-page box takes the
  // focus while it is up, so the field is focused again after it, not before.
  const made = [];
  const el = () => ({ value: '', disabled: false, parentElement: null, focused: 0, replacedWith: [], focus() { this.focused++; }, select() {}, replaceWith(other) { this.replacedWith.push(other); } });
  const alertGate = deferred();
  const flow = bootFlow(EDIT_ITEM_FLOW, 'projects-view.js', {
    alertGate,
    api: { editPlanItem: (id, kind, line, text) => (text === 'taken' ? { error: 'todos.md changed on disk.' } : { ok: true }) },
    globals: { document: { createElement: () => { made.push(el()); return made[made.length - 1]; } } },
  });
  const textEl = el();
  const item = { text: 'old', line: 3 };
  let saved = 0;
  flow.ctx.editItemInline(BUILD, 'todos', item, textEl, () => { saved++; });
  const input = made[0];
  assert.equal(input.focused, 1, 'the field opens with the focus');

  input.value = ' taken ';
  const failing = input.onkeydown({ key: 'Enter', preventDefault() {} });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flow.calls.alerts, ['todos.md changed on disk.']);
  assert.equal(input.disabled, true, 'while the message is up the field is still out of use');
  assert.equal(input.focused, 1, 'and is not focused under the box');
  input.onblur();
  assert.deepEqual(input.replacedWith, [], 'losing the focus to the box does not throw the edit away');
  alertGate.resolve();
  await failing;
  assert.equal(input.disabled, false);
  assert.equal(input.focused, 2, 'typing carries on in the field');
  assert.equal(item.text, 'old');
  assert.equal(saved, 0);

  // And the edit that goes through.
  input.value = 'new';
  await input.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(flow.calls.api.map((call) => call.slice(1)), [['p1', 'todos', 3, 'taken'], ['p1', 'todos', 3, 'new']]);
  assert.equal(item.text, 'new');
  assert.equal(textEl.textContent, 'new');
  assert.deepEqual(input.replacedWith, [textEl]);
  assert.equal(saved, 1);
});
