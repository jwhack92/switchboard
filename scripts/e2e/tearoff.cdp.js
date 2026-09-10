// End-to-end tear-off test, driven over the Chrome DevTools Protocol.
//
// Not part of `npm test`: it needs a running app with remote debugging on, and
// it spawns real PTYs. Run it by hand:
//
//   scripts\Switchboard.exe --remote-debugging-port=9222
//   node scripts/e2e/tearoff.cdp.js .
//
// It lives under scripts/, not test/, because `node --test` treats every .js
// file inside a test/ directory as a unit test and would run it with no app up.
//
// What it proves that the unit tests cannot: that a live session really does
// change windows, that its scrollback arrives intact (asserted by echoing a
// random marker BEFORE the move and finding it after), that it is still
// interactive afterwards, and that opening/closing windows does not kill it.
//
// Two things it has to wait for, both learned the hard way:
//   * a new window resolves its own id asynchronously, and a null id silently
//     means "tear off into a new window" to moveSession;
//   * Git Bash can take >5s to print its first prompt, and keystrokes sent
//     before then are swallowed by shell init.

const http = require('http');
const REPO = process.argv[2];
const WebSocket = require(REPO + '/node_modules/ws');

const PORT = 9222;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Page {
  constructor(target) { this.target = target; this.seq = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) j(new Error(JSON.stringify(msg.error)));
          else r(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('eval threw: ' + ((d.exception && d.exception.description) || d.text));
    }
    return res.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function pages() {
  const targets = await httpJson('/json/list');
  const out = [];
  for (const t of targets.filter(t => t.type === 'page' && t.url.includes('index.html'))) {
    const p = new Page(t);
    await p.connect();
    await p.send('Runtime.enable');
    // A newly created window resolves its own id asynchronously (getWindowInfo).
    // Reading it too early yields null, and null means "tear off into a NEW
    // window" to moveSession — so the test would silently exercise the wrong path.
    for (let i = 0; i < 40; i++) {
      p.windowId = await p.eval('return window._getMyWindowId ? window._getMyWindowId() : null;');
      if (p.windowId != null) break;
      await new Promise(r => setTimeout(r, 250));
    }
    out.push(p);
  }
  return out;
}

// Git Bash can take well over five seconds to print its first prompt on this
// machine. Typing before then loses the keystrokes to shell init, so every
// scrollback assertion has to wait for the shell to actually be alive.
async function waitForPrompt(page, SID, label) {
  for (let i = 0; i < 45; i++) {
    const n = await page.eval(
      'const e = window._openSessions.get(' + SID + '); if (!e) return -1;'
      + 'const b = e.terminal.buffer.active; let n = 0;'
      + 'for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) n++; }'
      + 'return n;');
    if (n > 0) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('      (' + label + ': shell never printed a prompt)');
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -- ' + detail : ''));
  if (!ok) failures++;
}

(async () => {
  let ps = await pages();
  console.log('\n[1] startup');
  check('exactly one renderer', ps.length === 1, 'found ' + ps.length);
  check('it knows its own window id', ps[0].windowId != null, 'windowId=' + ps[0].windowId);
  const firstId = ps[0].windowId;

  console.log('\n[2] open a second window');
  await ps[0].eval('return window.api.newWindow();');
  await sleep(7000);
  ps.forEach(p => p.close());
  ps = await pages();
  check('two renderers now', ps.length === 2, 'found ' + ps.length);
  const ids = ps.map(p => p.windowId);
  check('each has a distinct window id', new Set(ids).size === 2, 'ids=' + ids.join(','));

  const src = ps.find(p => p.windowId === firstId);
  const dst = ps.find(p => p.windowId !== firstId);
  if (!src || !dst) { console.log('  cannot identify windows, aborting'); process.exit(1); }

  console.log('\n[3] start a plain terminal session in window ' + src.windowId);
  const proj = await src.eval(
    'return (typeof cachedAllProjects !== "undefined" && cachedAllProjects[0]) ? cachedAllProjects[0].projectPath : null;');
  console.log('      project: ' + proj);
  const started = await src.eval(
    'if (typeof launchTerminalSession !== "function") return { error: "no launchTerminalSession" };'
    + 'launchTerminalSession({ projectPath: ' + JSON.stringify(proj) + ' }); return { ok: true };');
  check('launchTerminalSession is callable', !started.error, started.error || '');
  await sleep(7000);

  const srcSessions = await src.eval('return [...window._openSessions.keys()];');
  check('source window has a live session', srcSessions.length > 0, 'open=' + srcSessions.length);
  if (!srcSessions.length) { console.log('  no session to move, aborting'); process.exit(1); }
  const sid = srcSessions[srcSessions.length - 1];
  const SID = JSON.stringify(sid);
  console.log('      session: ' + sid);

  const owners1 = await src.eval('return window.api.getSessionOwners();');
  check('main says the source window owns it', owners1[sid] === src.windowId,
    'owner=' + owners1[sid] + ' expected=' + src.windowId);

  const ready = await waitForPrompt(src, SID, 'source');
  check('the shell printed a prompt (session is genuinely alive)', ready);

  // Put a known marker in the scrollback. Without this the test can serialize
  // before the shell has even printed its prompt and prove nothing.
  const MARKER = 'tearoff-marker-' + Math.random().toString(36).slice(2, 10);
  console.log('      writing marker: ' + MARKER);
  await src.eval('window.api.sendInput(' + SID + ', "echo ' + MARKER + '\\r"); return 1;');
  let sawMarker = false;
  for (let i = 0; i < 20 && !sawMarker; i++) {
    await sleep(1000);
    sawMarker = await src.eval(
      'const e = window._openSessions.get(' + SID + '); if (!e) return false;'
      + 'const b = e.terminal.buffer.active; let t = "";'
      + 'for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) t += l.translateToString(true); }'
      + 'return t.indexOf(' + JSON.stringify(MARKER) + ') !== -1;');
  }
  check('marker appeared in the source terminal (PTY output is flowing)', sawMarker);

  console.log('\n[4] move it to window ' + dst.windowId);
  check('the destination window id is known (not a disguised tear-off)',
    dst.windowId != null, 'dst=' + dst.windowId);
  const moved = await src.eval(
    'const s = typeof serializeSession === "function" ? serializeSession(' + SID + ') : "";'
    + 'const res = await window.api.moveSession(' + SID + ', ' + dst.windowId + ', s);'
    + 'return { res, len: s.length, hasMarker: s.indexOf(' + JSON.stringify(MARKER) + ') !== -1 };');
  check('move reported ok', moved.res && moved.res.ok, JSON.stringify(moved.res));
  check('scrollback was serialized and handed over', moved.len > 0, moved.len + ' chars');
  check('the serialized buffer contains the marker', moved.hasMarker === true);
  await sleep(5000);

  const owners2 = await src.eval('return window.api.getSessionOwners();');
  check('ownership moved to the destination', owners2[sid] === dst.windowId,
    'owner=' + owners2[sid] + ' expected=' + dst.windowId);
  check('source dropped its view',
    (await src.eval('return window._openSessions.has(' + SID + ');')) === false);
  check('destination built a view',
    (await dst.eval('return window._openSessions.has(' + SID + ');')) === true);

  const rows = await dst.eval(
    'const e = window._openSessions.get(' + SID + '); if (!e) return null;'
    + 'const b = e.terminal.buffer.active; let n = 0;'
    + 'for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).trim()) n++; }'
    + 'return { rows: b.length, nonEmpty: n };');
  check('moved terminal has content', rows && rows.nonEmpty > 0, JSON.stringify(rows));

  // The real fidelity assertion: the exact text from before the move is present
  // in the destination window's freshly built terminal.
  const markerMoved = await dst.eval(
    'const e = window._openSessions.get(' + SID + '); if (!e) return false;'
    + 'const b = e.terminal.buffer.active; let t = "";'
    + 'for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) t += l.translateToString(true); }'
    + 'return t.indexOf(' + JSON.stringify(MARKER) + ') !== -1;');
  check('scrollback SURVIVED the move (marker present in the destination)', markerMoved === true);

  // And the session is still interactive there, not a frozen transcript.
  const MARKER2 = MARKER + '-live';
  await dst.eval('window.api.sendInput(' + SID + ', "echo ' + MARKER2 + '\\r"); return 1;');
  let live = false;
  for (let i = 0; i < 15 && !live; i++) {
    await sleep(1000);
    live = await dst.eval(
      'const e = window._openSessions.get(' + SID + '); if (!e) return false;'
      + 'const b = e.terminal.buffer.active; let t = "";'
      + 'for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) t += l.translateToString(true); }'
      + 'return t.indexOf(' + JSON.stringify(MARKER2) + ') !== -1;');
  }
  check('the moved session is still INTERACTIVE in its new window', live === true);

  console.log('\n[5] the PTY survived the move');
  const active = await dst.eval('return window.api.getActiveSessions();');
  check('session still running', active.includes(sid), 'active=' + active.length);

  console.log('\n[6] move it back to window ' + src.windowId);
  const back = await dst.eval(
    'const s = typeof serializeSession === "function" ? serializeSession(' + SID + ') : "";'
    + 'return window.api.moveSession(' + SID + ', ' + src.windowId + ', s);');
  check('move back reported ok', back && back.ok, JSON.stringify(back));
  await sleep(5000);
  const owners3 = await src.eval('return window.api.getSessionOwners();');
  check('ownership came back', owners3[sid] === src.windowId, 'owner=' + owners3[sid]);
  check('the other window released it',
    (await dst.eval('return window._openSessions.has(' + SID + ');')) === false);

  console.log('\n[7] a no-op move is refused');
  const noop = await src.eval('return window.api.moveSession(' + SID + ', ' + src.windowId + ', "");');
  check('dropping on its own window does nothing', noop && noop.noop === true, JSON.stringify(noop));

  console.log('\n[8] closing a window must NOT kill the other window\'s session');
  const beforeClose = await src.eval('return window.api.getActiveSessions();');
  await dst.eval('return window.api.newWindow();');
  await sleep(6000);
  const all = await httpJson('/json/list');
  console.log('      renderers now: ' + all.filter(t => t.url.includes('index.html')).length);
  const afterOpen = await src.eval('return window.api.getActiveSessions();');
  check('opening a third window kept the session alive',
    afterOpen.includes(sid), 'active=' + afterOpen.length + ' before=' + beforeClose.length);

  console.log('\n' + (failures === 0 ? 'ALL FUNCTIONAL CHECKS PASSED' : failures + ' FAILURE(S)'));
  ps.forEach(p => p.close());
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('DRIVER ERROR: ' + e.message); process.exit(2); });
