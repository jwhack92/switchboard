const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claude = require('../harnesses/claude');
const { getHarness, DEFAULT_HARNESS, allHarnesses, progressBusyState } = require('../harnesses');

// This fork is Claude-only: harnesses/ is an abstraction taken from upstream
// for the seam it gives (one place that knows the CLI's on-disk layout, its
// transcript format, and its launch flags), not because a second CLI is
// coming. Anything upstream added for codex — needsIdDetection,
// readLaunchSignals, matchesLaunch, folder-prefix namespacing — is deliberately
// absent here, so the tests for it are too.

// ---------------------------------------------------------------- launch argv
//
// buildLaunchArgs was lifted out of main.js's open-terminal handler. These pin
// the exact argv it used to build, so the move stays a move.

test('a new session pre-assigns its id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: true, options: {} }),
    ['--session-id', 'abc']
  );
});

test('an existing session resumes', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: false, options: {} }),
    ['--resume', 'abc']
  );
});

test('forkFrom wins over both, and forks the source not the new id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'new', isNew: true, options: { forkFrom: 'src' } }),
    ['--resume', 'src', '--fork-session']
  );
});

test('dangerouslySkipPermissions suppresses permissionMode', () => {
  // Both set is a real state — the dialog can carry a stale mode alongside the
  // skip toggle — and passing both to claude is an error.
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true,
    options: { dangerouslySkipPermissions: true, permissionMode: 'plan' },
  });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
});

test('addDirs splits on commas and trims, skipping empties', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { addDirs: ' /one , , /two ' },
  });
  assert.deepEqual(args, ['--add-dir', '/one', '--add-dir', '/two', '--session-id', 'a']);
});

test('model and effort pass through; empty and unknown levels are left to claude', () => {
  // The effort level is checked against a list rather than passed blind: a
  // stored setting outlives the claude version that understood it, and an
  // unknown level fails the launch outright instead of degrading.
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true, options: { model: 'opus', effort: 'xhigh' } }),
    ['--session-id', 'a', '--model', 'opus', '--effort', 'xhigh']
  );
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true, options: { model: '', effort: '' } }),
    ['--session-id', 'a']
  );
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true, options: { effort: 'ultra' } }),
    ['--session-id', 'a'],
    'claude has no ultra level'
  );
});

test('appendSystemPrompt goes last', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { chrome: true, appendSystemPrompt: 'hi' },
  });
  assert.deepEqual(args.slice(-2), ['--append-system-prompt', 'hi']);
});

test('no options at all still produces a launchable argv', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true }),
    ['--session-id', 'a']
  );
});

// ------------------------------------------------- multi-value flag ordering
//
// The reason this fork took the argument reorder at all (upstream 809b754).
// `--allowedTools` and `--add-dir` are variadic: claude keeps consuming
// non-option words after them. The first prompt is a bare positional at the
// end of the argv, so if either list is still open when the argv runs out, the
// prompt is swallowed as one more tool name or directory and the session opens
// empty — the failure mode that shows up on scheduled runs with an attached
// project folder, where nobody is watching. The required session selector
// (--session-id / --resume) is what closes those lists, so it must come after
// them, never before.

test('--allowedTools and --add-dir are emitted before the session selector', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'abc', isNew: true,
    options: { allowedTools: 'Read,Bash', addDirs: '/one,/two', initialPrompt: 'do the thing' },
  });
  const selector = args.indexOf('--session-id');
  assert.ok(selector !== -1, 'a new session still names its id');
  assert.ok(args.indexOf('--allowedTools') !== -1 && args.indexOf('--allowedTools') < selector,
    `--allowedTools must precede the selector: ${JSON.stringify(args)}`);
  assert.ok(args.lastIndexOf('--add-dir') < selector,
    `every --add-dir must precede the selector: ${JSON.stringify(args)}`);
  assert.equal(args[args.length - 1], 'do the thing', 'the prompt stays the final positional');
});

test('a resume closes the variadic lists too', () => {
  // The selector is --resume rather than --session-id here, and it is just as
  // required — but only if the ordering is a property of the builder rather
  // than of the new-session branch.
  const args = claude.buildLaunchArgs({
    sessionId: 'abc', isNew: false, options: { allowedTools: 'Read', addDirs: '/one' },
  });
  assert.deepEqual(args, ['--allowedTools', 'Read', '--add-dir', '/one', '--resume', 'abc']);
});

test('a scheduled prompt is not consumed by multi-value directory or tool options', () => {
  const prompt = 'Investigate the latest alarm.\nRead the logs and summarize findings.';
  for (const addDirs of ['/attached', ' /repo one , , /repo two ']) {
    for (const allowedTools of ['', 'Read,Bash']) {
      for (const ide of [false, true]) {
        const args = claude.buildLaunchArgs({
          sessionId: 'scheduled', isNew: true,
          options: { addDirs, allowedTools, initialPrompt: prompt },
        });
        // Main appends --ide after the harness arguments when MCP emulation is on.
        if (ide) args.push('--ide');
        assert.ok(args.includes(prompt), 'the first message is present');
        // Walk each variadic flag's value run and check it ends before the prompt.
        for (let i = 0; i < args.length; i++) {
          if (!['--add-dir', '--allowedTools'].includes(args[i])) continue;
          const values = [];
          for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) values.push(args[j]);
          assert.ok(!values.includes(prompt), `${args[i]} must not consume the first message`);
          if (args[i] === '--add-dir') assert.equal(values.length, 1, 'each directory remains a separate argument');
        }
      }
    }
  }
});

test('initialPrompt is the last positional argument for a fresh session only', () => {
  const fresh = claude.buildLaunchArgs({ sessionId: 'abc', isNew: true, options: { initialPrompt: 'Work on phase 2' } });
  assert.equal(fresh[fresh.length - 1], 'Work on phase 2');
  const resumed = claude.buildLaunchArgs({ sessionId: 'abc', isNew: false, options: { initialPrompt: 'Work on phase 2' } });
  assert.ok(!resumed.includes('Work on phase 2'), 'a resume keeps its conversation');
  const forked = claude.buildLaunchArgs({ sessionId: 'new', isNew: true, options: { forkFrom: 'src', initialPrompt: 'x' } });
  assert.ok(!forked.includes('x'), 'a fork carries its parent prompt');
});

// ------------------------------------------------------------------ worktree

test('--worktree is dropped on resume, kept on a new session', () => {
  // Resuming must reuse the session's existing directory; spinning up a fresh
  // worktree makes the attach fail.
  const resumed = claude.buildLaunchArgs({
    sessionId: 'a', isNew: false, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.ok(!resumed.includes('--worktree'));

  const fresh = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.deepEqual(fresh, ['--worktree', 'wt', '--session-id', 'a']);
});

test('--worktree is gated on isNew alone, not on the session selector', () => {
  // The distinction main.js has to preserve at the call site. It computes a
  // `startFresh` that is `isNew` OR "this session never wrote a transcript, so
  // there is nothing to --resume". A session CAN create its worktree and then
  // die before writing a transcript: that recovery start is not new, and
  // passing --worktree again would cut it a second worktree.
  //
  // So the selector and the worktree flag answer different questions, and
  // buildLaunchArgs must let them disagree: startFresh drives --session-id vs
  // --resume, the raw isNew drives --worktree. Here isNew is false while the
  // caller asks for a fresh start — the recovery case — and the flag must stay
  // off.
  const recovery = claude.buildLaunchArgs({
    sessionId: 'a', isNew: false, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.ok(!recovery.includes('--worktree'), 'a recovery start must not cut a second worktree');
  assert.ok(!recovery.includes('wt'), 'and must not leave the name as a stray positional');

  // A worktree with no name is still a worktree: claude names it itself.
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true, options: { worktree: true, worktreeName: '' } }),
    ['--worktree', '--session-id', 'a']
  );
});

test('the recovery start main.js actually passes: fresh selector, no worktree', () => {
  // The shape above leaves startFresh at its isNew default, so it never sees
  // the two disagreeing. This is the call main.js makes for a session that has
  // no transcript to resume — startFresh true, isNew false — and it is the one
  // upstream's single-parameter buildLaunchArgs cannot express: handed
  // `isNew: startFresh` it would emit --worktree for a session that may already
  // have cut one.
  assert.deepEqual(
    claude.buildLaunchArgs({
      sessionId: 'a', isNew: false, startFresh: true,
      options: { worktree: true, worktreeName: 'wt' },
    }),
    ['--session-id', 'a']
  );
  // And the collapse that would have been the bug, pinned so it stays visible.
  assert.deepEqual(
    claude.buildLaunchArgs({
      sessionId: 'a', isNew: true, options: { worktree: true, worktreeName: 'wt' },
    }),
    ['--worktree', 'wt', '--session-id', 'a']
  );
  // An initial prompt follows the fresh selector on a recovery start too: the
  // conversation really is starting over, even though the session is not new.
  assert.deepEqual(
    claude.buildLaunchArgs({
      sessionId: 'a', isNew: false, startFresh: true, options: { initialPrompt: 'go' },
    }),
    ['--session-id', 'a', 'go']
  );
});

// ------------------------------------------------------------------ registry

test('an unknown or missing harness id falls back to Claude', () => {
  // Nothing in this fork's schema stores a harness id, so every lookup arrives
  // as undefined; the fallback is the normal path here, not the edge case.
  assert.equal(getHarness(undefined).id, 'claude');
  assert.equal(getHarness(null).id, 'claude');
  assert.equal(getHarness('codex-from-the-future').id, 'claude');
  assert.equal(DEFAULT_HARNESS, 'claude');
});

test('every registered harness implements the indexing contract', () => {
  // The shape harnesses/index.js documents. deriveProjectPath is deliberately
  // NOT in it: this fork derives the project path with ./derive-project-path.js
  // (see the module comment there) and never through a harness.
  const required = ['id', 'label', 'binary', 'available', 'sessionsRoot',
    'listFolders', 'folderPath', 'listTranscripts', 'transcriptPath',
    'readSessionFile', 'buildLaunchArgs'];
  for (const h of allHarnesses()) {
    for (const key of required) {
      assert.ok(h[key] !== undefined, `${h.id} is missing ${key}`);
    }
  }
});

test('Claude implements the launch contract', () => {
  assert.equal(typeof claude.buildLaunchArgs, 'function');
});

// -------------------------------------------------------------------- layout

test('the harness reads the same transcript root the rest of the app watches', () => {
  // main.js, schedule-ipc.js and schedule-runner.js each build this path
  // independently (main.js:109, schedule-ipc.js:10, schedule-runner.js:8). A
  // harness pointing anywhere else would index one set of sessions while the
  // watcher and the scheduler worked on another.
  assert.equal(claude.sessionsRoot(), path.join(os.homedir(), '.claude', 'projects'));
});

test('the harness folder key is the one main.js already computes', () => {
  // main.js snapshots a project's transcripts by building the folder name with
  // encodeProjectPath directly (main.js:1287) while the harness answers with
  // folderForProject. The two have to be the same string or the app watches
  // one directory and indexes another — including on the branches that are
  // easy to get wrong: a Windows path, and the >200-char hashed form.
  const { encodeProjectPath } = require('../encode-project-path');
  for (const p of [
    '/Users/me/proj',
    '/Users/me/proj/.claude/worktrees/wt',
    'C:\\Users\\jhack\\Bitbucket\\switchboard',
    'C:\\Users\\jhack\\' + 'x'.repeat(400),
  ]) {
    assert.equal(claude.folderForProject(p), encodeProjectPath(p), p);
    assert.match(claude.folderForProject(p), /^[a-zA-Z0-9-]+$/, p);
  }
});

test('transcriptPath prefers a stored sessionFile over reconstructing one', () => {
  // Claude names its files <sessionId>.jsonl, so the reconstruction is exact.
  // Built with path.join, not a '/' literal: on Windows the reconstruction
  // comes back with backslashes and a POSIX-shaped assertion fails here.
  assert.equal(
    claude.transcriptPath({ sessionId: 'a', folder: 'f', sessionFile: '/stored/x.jsonl' }),
    '/stored/x.jsonl'
  );
  assert.equal(
    claude.transcriptPath({ sessionId: 'a', folder: 'f' }),
    path.join(claude.sessionsRoot(), 'f', 'a.jsonl')
  );
});

// -------------------------------------------------------- activity signalling

test('Claude reports working with old and new spinner frames and idle with U+2733', () => {
  assert.equal(claude.parseTitleState('⠹ doing a thing'), 'busy');
  for (const frame of ['◐', '◑', '◒', '◓']) {
    assert.equal(claude.parseTitleState(`${frame} doing a thing`), 'busy', frame);
  }
  assert.equal(claude.parseTitleState('✳ idle'), 'idle');
});

test('an ordinary Claude title is not read as idle', () => {
  // Claude sets plain titles that mean nothing about activity, so treating
  // "not a spinner" as idle would end a busy state early.
  assert.equal(claude.parseTitleState('my-project'), null);
  assert.equal(claude.parseTitleState(''), null);
  assert.equal(claude.parseTitleState(undefined), null);
});

test('Claude notification wording maps to the two states', () => {
  for (const m of [
    'Claude Code needs your attention',
    'Claude Code needs your approval for the plan',
    'Claude needs your permission to use Bash',
    'Claude Code wants to enter plan mode',
  ]) assert.equal(claude.classifyNotification(m), 'attention', m);
  assert.equal(claude.classifyNotification('Claude is waiting for your input'), 'idle');
  assert.equal(claude.classifyNotification('some other message'), null);
});

test('every harness can report activity', () => {
  for (const h of allHarnesses()) {
    assert.equal(typeof h.parseTitleState, 'function', h.id);
    assert.equal(typeof h.classifyNotification, 'function', h.id);
  }
});

// ----------------------------------------------------------- OSC 9;4 progress
//
// Claude emits these when its `terminalProgressBarEnabled` setting is on
// (default). A slash command produces `4;3;` then `4;0;` ~200ms later without
// ever touching the title, so the busy state it raises can only be cleared by
// honouring `4;0` — otherwise the session spins until Claude's "waiting for
// your input" notice a full minute later. This fork previously ignored `4;0`
// outright; the title veto below is what makes honouring it safe, which is why
// the two were adopted together.

test('progress start marks a session busy', () => {
  for (const level of ['1', '2', '3']) {
    assert.equal(progressBusyState({ level, titleBusy: false }), 'busy', level);
  }
});

test('progress end clears busy when the title does not say otherwise', () => {
  assert.equal(progressBusyState({ level: '0', titleBusy: false }), 'idle');
});

test('progress end is ignored while the title shows a spinner', () => {
  // Any child process in the PTY can emit 9;4 — a build tool, a test runner.
  // The title comes from the CLI itself, so a subprocess finishing its progress
  // bar must not report the CLI as idle while it is visibly still working.
  assert.equal(progressBusyState({ level: '0', titleBusy: true }), null);
});

test('an unknown progress level changes nothing', () => {
  for (const level of ['9', '', undefined]) {
    assert.equal(progressBusyState({ level, titleBusy: false }), null, String(level));
  }
});

// -------------------------------------------------------------------- viewer

test('Claude transcripts reach the viewer untouched', () => {
  // The viewer was written against Claude's format, so its normalisation is
  // identity — it exists so the viewer never has to know which CLI wrote a file.
  const entries = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }];
  assert.equal(claude.toViewerEntries(entries), entries);
});

test('every harness can feed the viewer', () => {
  for (const h of allHarnesses()) {
    assert.equal(typeof h.toViewerEntries, 'function', h.id);
  }
});

// ------------------------------------------------------------ transcript parse

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-harness-claude-'));
}
function line(obj) { return JSON.stringify(obj) + '\n'; }
function userMsg(text, ts) { return line({ type: 'user', timestamp: ts, message: { content: text } }); }
function asstMsg(text, ts) { return line({ type: 'assistant', timestamp: ts, message: { content: text } }); }

/** Everything the cache persists and the parser resumes from. bytesRead is
 *  excluded: it measures work done, which is exactly what differs. */
function meaningful(s) {
  const { bytesRead, ...rest } = s;
  return rest;
}

// The head guard window is the first 4KB. A file smaller than that has a head
// that changes on every append, so it is always re-read in full; anything
// exercising resume has to start out larger than the window.
const OVER_HEAD = 'padding '.repeat(700); // ~5.6KB in one message

test("readSessionFile's resume gate survives a row with no runtime or sessionFile", () => {
  // Upstream's canResume also requires `prev.runtime === 'claude'` and
  // `prev.sessionFile === filePath`. This fork's sessions table has neither
  // column, so a row read back from the cache has neither field — and an
  // upstream-shaped gate would refuse to resume EVERY time, silently turning
  // each append to a large transcript back into a full re-parse. That is a
  // performance cliff no assertion elsewhere would catch, so pin it here.
  const dir = tmpdir();
  try {
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, userMsg('first question ' + OVER_HEAD, '2026-01-01T10:00:00.000Z')
                      + asstMsg('first answer', '2026-01-01T10:00:01.000Z'));
    assert.ok(fs.statSync(p).size > 4096, 'fixture must exceed the head window');

    const first = claude.readSessionFile(p, 'f', '/proj');
    assert.ok(first, 'initial read should succeed');
    assert.ok(first.indexedBytes > 0, 'should record a resume point');

    // A row as this fork's cache hands it back.
    const prev = { ...first };
    delete prev.runtime;
    delete prev.sessionFile;

    fs.appendFileSync(p, userMsg('second question', '2026-01-01T11:00:00.000Z')
                       + asstMsg('second answer', '2026-01-01T11:00:02.000Z'));

    const resumed = claude.readSessionFile(p, 'f', '/proj', prev);
    const full = claude.readSessionFile(p, 'f', '/proj', null);
    assert.ok(resumed, 'resumed read should succeed');
    assert.ok(resumed.bytesRead < full.bytesRead,
      `resume must read less than a full pass (${resumed.bytesRead} vs ${full.bytesRead})`);
    assert.deepEqual(meaningful(resumed), meaningful(full),
      'resumed state must equal a full re-read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale head hash still forces a full re-read', () => {
  // The other half of the gate: dropping the runtime/sessionFile checks must
  // not have loosened the check that actually matters, which is whether the
  // saved byte offset still points into the same history.
  const dir = tmpdir();
  try {
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, userMsg('first question ' + OVER_HEAD, '2026-01-01T10:00:00.000Z')
                      + asstMsg('first answer', '2026-01-01T10:00:01.000Z'));
    const first = claude.readSessionFile(p, 'f', '/proj');
    fs.appendFileSync(p, userMsg('second question', '2026-01-01T11:00:00.000Z'));

    const lied = { ...first, headHash: 'v1:' + '0'.repeat(40) };
    const resumed = claude.readSessionFile(p, 'f', '/proj', lied);
    const full = claude.readSessionFile(p, 'f', '/proj', null);
    assert.deepEqual(meaningful(resumed), meaningful(full));
    assert.equal(resumed.bytesRead, full.bytesRead, 'a mismatched head must re-read everything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the head hash keeps this fork\'s v1 tag', () => {
  // Upstream moved the tag to 'v3:' when it changed what the cached text holds.
  // Taking that tag here would invalidate every cached row on first launch and
  // re-index every transcript on this machine into FTS5 for no gain, because
  // this fork never adopted the change the tag was announcing.
  const dir = tmpdir();
  try {
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, userMsg('hello', '2026-01-01T10:00:00.000Z'));
    const s = claude.readSessionFile(p, 'f', '/proj');
    assert.ok(s, 'a one-message transcript still indexes');
    assert.match(s.headHash, /^v1:[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('textContent is capped per line and in total', () => {
  // The search index is FTS5 over this column. Upstream keeps every text block
  // in full; this fork keeps at most TEXT_LINE_CAP=500 chars of each message
  // and stops accumulating past TEXT_CONTENT_CAP=8000, so one pathological
  // session — a pasted log, a 40MB transcript — cannot dominate the index or
  // the row size. Losing the cap would not fail any other test; it would just
  // quietly grow the database.
  const TEXT_CONTENT_CAP = 8000, TEXT_LINE_CAP = 500;
  const dir = tmpdir();
  try {
    const one = path.join(dir, 'one.jsonl');
    fs.writeFileSync(one, userMsg('a'.repeat(1000), '2026-01-01T10:00:00.000Z'));
    const single = claude.readSessionFile(one, 'f', '/proj');
    assert.ok(single, 'single-message transcript indexes');
    assert.equal(single.textContent.trimEnd(), 'a'.repeat(TEXT_LINE_CAP),
      'a 1000-char message contributes 500 chars');

    const many = path.join(dir, 'many.jsonl');
    let body = '';
    for (let i = 0; i < 40; i++) {
      body += userMsg('x'.repeat(1000), `2026-01-01T10:00:${String(i).padStart(2, '0')}.000Z`);
    }
    fs.writeFileSync(many, body);
    const s = claude.readSessionFile(many, 'f', '/proj');
    assert.ok(s, 'multi-message transcript indexes');
    // The cap is checked before appending, so the last accepted line can carry
    // the total one line past it — but no further.
    assert.ok(s.textContent.length <= TEXT_CONTENT_CAP + TEXT_LINE_CAP + 1,
      `textContent should be capped, got ${s.textContent.length}`);
    // The cap is on the indexed text only: the session itself is fully parsed.
    assert.equal(s.messageCount, 40, 'every message is still counted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cap survives an incremental append', () => {
  // A resumed read starts from the cached textContent, which is already at the
  // cap. If the cap were applied only to freshly-read lines, a long-running
  // session would grow past it one append at a time.
  const dir = tmpdir();
  try {
    const p = path.join(dir, 'sess.jsonl');
    let body = '';
    for (let i = 0; i < 40; i++) {
      body += userMsg('x'.repeat(1000), `2026-01-01T10:00:${String(i).padStart(2, '0')}.000Z`);
    }
    fs.writeFileSync(p, body);
    const first = claude.readSessionFile(p, 'f', '/proj');
    fs.appendFileSync(p, userMsg('y'.repeat(1000), '2026-01-01T11:00:00.000Z'));
    const resumed = claude.readSessionFile(p, 'f', '/proj', first);
    const full = claude.readSessionFile(p, 'f', '/proj', null);
    assert.equal(resumed.textContent.length, full.textContent.length);
    assert.ok(resumed.textContent.length <= 8000 + 500 + 1,
      `still capped after an append, got ${resumed.textContent.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The project-path derivation now exists twice: ./derive-project-path.js
// (derive-project-path.js:29) and a copy inside the harness. The app keeps
// calling the standalone module — main.js:379, session-cache.js:5 — so the
// harness copy is the one nothing calls, which is exactly the kind that drifts.
// Upstream's harness version is NOT the same code: pin the two local copies to
// the same answer while both exist. This asserts agreement, not a particular
// answer; note that resolveWorktreePath is defined in both and called by
// neither, so a worktree cwd currently comes back unchanged from each.
let legacyDerive = null;
try { legacyDerive = require('../derive-project-path').deriveProjectPath; } catch {}

test('both copies of the project-path derivation give the same answer',
  { skip: (legacyDerive && claude.deriveProjectPath) ? false : 'only one copy exists' }, () => {
    const dir = tmpdir();
    try {
      for (const cwd of ['/proj', '/proj/.claude/worktrees/wt', '/proj/.worktrees/wt']) {
        const folder = fs.mkdtempSync(path.join(dir, 'folder-'));
        fs.writeFileSync(path.join(folder, 'sess.jsonl'),
          line({ type: 'user', cwd, timestamp: '2026-01-01T10:00:00.000Z', message: { content: 'hi' } }));
        assert.equal(claude.deriveProjectPath(folder), legacyDerive(folder), cwd);
      }
      // A folder with nothing to read from answers the same way in both.
      const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
      assert.equal(claude.deriveProjectPath(empty), legacyDerive(empty));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

// read-session-file.js is still what session-cache.js and the scan worker call
// (session-cache.js:6, workers/scan-projects.js). While both parsers exist they
// must agree, or a row means something different depending on which path
// indexed it. If the module is ever folded into the harness, this skips itself.
let legacyParser = null;
try { legacyParser = require('../read-session-file').readSessionFile; } catch {}

test('the harness parser and the one the cache still uses agree',
  { skip: legacyParser ? false : 'read-session-file.js has been folded into the harness' }, () => {
    const dir = tmpdir();
    try {
      const p = path.join(dir, 'sess.jsonl');
      fs.writeFileSync(p,
        line({ type: 'user', timestamp: '2026-01-01T10:00:00.000Z', slug: 'a-slug', message: { content: 'first question' } })
        + asstMsg('an answer ' + OVER_HEAD, '2026-01-01T10:00:01.000Z')
        + line({ type: 'custom-title', customTitle: 'renamed' })
        + userMsg('second question', '2026-01-01T10:05:00.000Z'));
      const viaHarness = claude.readSessionFile(p, 'f', '/proj');
      const viaCache = legacyParser(p, 'f', '/proj');
      assert.ok(viaHarness && viaCache);
      for (const key of Object.keys(viaCache)) {
        // textContent is compared without trailing whitespace: it is an FTS5
        // search column, where a final newline carries no meaning. Everything
        // else — counts, timestamps, resume offsets, the head hash — has to
        // match exactly.
        const [a, b] = key === 'textContent'
          ? [String(viaHarness[key] ?? '').trimEnd(), String(viaCache[key] ?? '').trimEnd()]
          : [viaHarness[key], viaCache[key]];
        assert.deepEqual(a, b, `${key} differs between the two parsers`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('--worktree cannot swallow a positional prompt', () => {
  // The reason --worktree is emitted before the session selector rather than
  // last. Its name argument is optional, so as the final flag it would take
  // whatever positional followed it — the same bug 809b754 fixed for --add-dir,
  // in this same function. The selector terminates it instead.
  //
  // Latent today: nothing in this fork passes initialPrompt. Live the moment
  // upstream's scheduled-task launch arrives, which does.
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true,
    options: { worktree: true, initialPrompt: 'summarise the release notes' },
  });
  const wt = args.indexOf('--worktree');
  assert.notEqual(wt, -1);
  assert.ok(
    String(args[wt + 1]).startsWith('--'),
    `--worktree is followed by ${args[wt + 1]}, which it would consume as the worktree name`
  );
  // and the prompt still survives as the final positional
  assert.equal(args[args.length - 1], 'summarise the release notes');
});

test('--add-dir cannot swallow a positional prompt either (809b754, pinned)', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true,
    options: { addDirs: '/one,/two', initialPrompt: 'do the thing' },
  });
  const last = args.lastIndexOf('--add-dir');
  assert.notEqual(last, -1);
  assert.equal(args[last + 1], '/two', 'the last --add-dir takes its own directory');
  assert.equal(args[args.length - 1], 'do the thing', 'and the prompt survives as the positional');
});
