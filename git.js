// git.js — the few git commands Switchboard runs itself, for project worktrees.
//
// Every call goes through execFile with an argv array and no shell, so a path
// or branch name can never be read as shell syntax. Errors carry git's stderr
// as their message. Nothing here is used unless a project attaches a folder
// "on a branch".
//
// The one consumer is projects.js (`require('./git')`, projects.js:50):
// repoRoot / worktreeAdd / worktreeRemove / isDirtyWorktreeError at
// projects.js:893-944, and isGitRepo / status / snapshot / fileDiff at
// projects.js:1902-1938. run / version / branchExists / gitCommonDir /
// parsePorcelain have no caller in this tree; they are upstream's and are kept
// with upstream's signatures so upstream's test/git.test.js ports unchanged
// (it drives run, branchExists and gitCommonDir directly).
//
// WHEN THE PATH IS NOT A GIT REPOSITORY — and the same for a path that does
// not exist, or a machine with no git on PATH, since all three arrive as an
// execFile error:
//
//   isGitRepo    → false          (`rev-parse --is-inside-work-tree` throws)
//   branchExists → false
//   version      → null           (only git-not-installed gets that far)
//   snapshot     → { git: false } (it asks isGitRepo before anything else)
//   repoRoot, status, gitCommonDir, worktreeAdd, worktreeRemove, fileDiff
//                → reject, message = git's own stderr, e.g. "fatal: not a git
//                  repository (or any of the parent directories): .git", or
//                  "spawn git ENOENT" when git itself is missing.
//
// Every one of those rejections already has a catcher in projects.js:
// attachWorktree catches repoRoot (projects.js:893) and worktreeAdd (:910),
// detachFolder catches worktreeRemove (:944), folderGitInfo catches status
// (:1904). projectGitInfo/projectGitDiff do not catch snapshot/fileDiff, but
// they only ever pass a folder row the project has already attached, and
// snapshot's isGitRepo guard turns a non-repo into an ordinary
// `{ git: false }` result rather than a throw.
//
// FORK NOTE — what differs from upstream d4a51aa:git.js.
//
// Upstream runs every git child unbounded and counts untracked lines with
// synchronous fs calls. In an Electron main process both are ways to hang the
// app on a huge repo or a repo on a network share, so three things changed:
//
//  1. TIMEOUTS. Every child carries `timeout` + `killSignal: 'SIGKILL'`:
//     DEFAULT_TIMEOUT_MS for the read-only commands, WORKTREE_TIMEOUT_MS for
//     `worktree add`/`worktree remove`, whose checkout of a large repo is
//     legitimately slow. A killed child rejects with "git <verb> timed out
//     after <n>ms" and `err.timedOut === true` instead of upstream's empty
//     fallback message, and a maxBuffer overflow says that instead. Nothing
//     here fetches, so a network repo only makes a local command slow — but a
//     credential helper or askpass that decides to ask would park a child
//     forever, which is what GIT_TERMINAL_PROMPT=0 and the timeout together
//     rule out.
//
//  2. STDIN CLOSED, NO CONSOLE WINDOW. execFile leaves the child an open stdin
//     pipe nobody ever writes to, so a git that reads stdin waits for input
//     that never comes — measured: `git hash-object --stdin` sat there until
//     the timeout killed it. execFile forwards no `stdio` option to spawn (it
//     hands spawn only cwd/env/uid/gid/shell/signal/windowsHide/…), so the
//     pipe is closed on the child object instead, and git gets EOF at once.
//     `windowsHide: true` — which execFile does forward — keeps a console
//     window from flashing on Windows on every status poll. Both match this
//     fork's other child processes (speech-ipc.js:163, claude-auth.js:33).
//
//  3. BOUNDED UNTRACKED COUNTING. countUntrackedInsertions is the only part of
//     this file that touched the disk on the caller's thread: upstream stats
//     and reads *every* untracked file with fs.statSync/readFileSync, and
//     `--untracked-files=all` in a repo with an unignored node_modules is tens
//     of thousands of them. Measured here at ~4ms a file, upstream's loop is
//     nine seconds of frozen window for 2,000 of them. It is async now
//     (fs/promises, so the reads leave the main thread) and stops at
//     MAX_UNTRACKED_STAT_FILES or UNTRACKED_STAT_BUDGET_MS, so on a repo that
//     big `stats.insertions` — one number in the Git tab's +/- line —
//     under-counts instead. snapshot awaits it.
//
// Nothing else is changed: same exports, same signatures, same return shapes.

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_DIFF_LENGTH = 256 * 1024;
const MAX_UNTRACKED_STAT_BYTES = 2 * 1024 * 1024;
// Fork: caps on the untracked-file scan. Measured on this fork's Windows dev
// machine, stat + read of a one-line file costs ~4ms (100 files 537ms, 2000
// files 8.7s), so the budget is what bounds a big repo in practice and the
// file cap is the backstop on a fast disk. See FORK NOTE 3.
const MAX_UNTRACKED_STAT_FILES = 2_000;
const UNTRACKED_STAT_BUDGET_MS = 1_500;
// Fork: no git child runs unbounded. See FORK NOTE 1.
const DEFAULT_TIMEOUT_MS = 20_000;
const WORKTREE_TIMEOUT_MS = 10 * 60_000;

/** The execFile options every git child shares. */
function childOptions(cwd, timeout) {
  return {
    cwd,
    maxBuffer: MAX_BUFFER,
    timeout,
    killSignal: 'SIGKILL',
    // Never hang on a credential prompt; a worktree add has no reason to ask.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    // No console window flashing on Windows for every status poll.
    windowsHide: true,
  };
}

/**
 * execFile, with the child's stdin closed. execFile passes no stdio option
 * through to spawn, so the child always gets a stdin pipe this side never
 * writes to; a git that reads stdin would wait on it until the timeout kills
 * it. Ending it hands git EOF instead. See FORK NOTE 2.
 */
function spawnGit(args, cwd, timeout, done) {
  const child = execFile('git', args, childOptions(cwd, timeout), done);
  if (child.stdin) {
    child.stdin.on('error', () => {}); // a child that exits first is not an error here
    child.stdin.end();
  }
  return child;
}

/** One Error for a failed child: git's stderr where there is any, else why it died. */
function childError(args, err, stdout, stderr, timeout) {
  const overflowed = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  // A timeout kill can still leave progress lines on stderr, so say the child
  // was killed rather than quoting them as if git had reported a failure.
  const killed = !overflowed && (err.killed === true || err.signal != null);

  let message;
  if (overflowed) message = `git ${args[0]} produced more than ${MAX_BUFFER} bytes of output`;
  else if (killed) message = `git ${args[0]} timed out after ${timeout}ms`;
  else message = String(stderr || err.message).trim() || `git ${args[0]} failed`;

  const error = new Error(message);
  error.code = err.code;
  error.stderr = String(stderr || '');
  error.stdout = String(stdout || '');
  if (killed) error.timedOut = true;
  return error;
}

function run(args, cwd, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    spawnGit(args, cwd, timeout, (err, stdout, stderr) => {
      if (err) {
        reject(childError(args, err, stdout, stderr, timeout));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/** Run git without trimming its output. Some machine-readable formats use NULs. */
function runRaw(args, cwd, { allowExitCodes = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    spawnGit(args, cwd, timeout, (err, stdout, stderr) => {
      // A killed child is never an allowed exit code: its output is a fragment.
      if (!err || (!err.killed && err.signal == null && allowExitCodes.includes(err.code))) {
        resolve(String(stdout));
        return;
      }
      reject(childError(args, err, stdout, stderr, timeout));
    });
  });
}

async function runOr(args, cwd, fallback = '') {
  try { return await runRaw(args, cwd); } catch { return fallback; }
}

async function version() {
  try { return await run(['--version']); } catch { return null; }
}

async function isGitRepo(dir) {
  try { return (await run(['rev-parse', '--is-inside-work-tree'], dir)) === 'true'; } catch { return false; }
}

/** Top-level directory of the checkout that contains dir. Rejects outside a repo. */
async function repoRoot(dir) {
  return run(['rev-parse', '--show-toplevel'], dir);
}

async function branchExists(repo, name) {
  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Check the branch out at targetPath, creating the branch from HEAD if needed. */
async function worktreeAdd(repo, targetPath, branch) {
  // A first checkout of a large repo is slow on purpose: it gets the long budget.
  const slow = { timeout: WORKTREE_TIMEOUT_MS };
  if (await branchExists(repo, branch)) {
    await run(['worktree', 'add', targetPath, branch], repo, slow);
  } else {
    await run(['worktree', 'add', '-b', branch, targetPath], repo, slow);
  }
}

/** Remove a worktree. Refuses a dirty one unless force; the branch always stays. */
async function worktreeRemove(repo, targetPath, { force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetPath);
  await run(args, repo, { timeout: WORKTREE_TIMEOUT_MS });
  try { await run(['worktree', 'prune'], repo); } catch {}
}

/** True when git refused to remove a worktree because it has local changes. */
function isDirtyWorktreeError(err) {
  return /modified or untracked|use --force|uncommitted|contains modified/i.test(String(err?.message || ''));
}

/** The repository's shared .git directory, absolute, from any of its worktrees. */
async function gitCommonDir(dir) {
  const out = await run(['rev-parse', '--git-common-dir'], dir);
  return path.resolve(dir, out);
}

/** Branch, whether anything is modified or untracked, and ahead/behind upstream. */
async function status(dir) {
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const porcelain = await run(['status', '--porcelain'], dir);
  let ahead = null;
  let behind = null;
  try {
    const counts = await run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir);
    const [b, a] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) { ahead = a; behind = b; }
  } catch {}
  return { branch, dirty: porcelain.length > 0, ahead, behind };
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parse `git status --porcelain=v1 -z` without losing unusual filenames. */
function parsePorcelain(output) {
  const records = String(output || '').split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    const code = record.slice(0, 2);
    const indexStatus = code[0];
    const worktreeStatus = code[1];
    const filePath = record.slice(3);
    let oldPath = null;
    // With -z, a rename/copy is the destination followed by a second,
    // NUL-terminated source pathname.
    if (/[RC]/.test(code) && i + 1 < records.length) oldPath = records[++i] || null;

    let statusName = 'modified';
    if (CONFLICT_CODES.has(code)) statusName = 'conflicted';
    else if (code === '??') statusName = 'untracked';
    else if (/[RC]/.test(code)) statusName = 'renamed';
    else if (code.includes('D')) statusName = 'deleted';
    else if (code.includes('A')) statusName = 'added';

    changes.push({
      path: filePath,
      oldPath,
      code,
      status: statusName,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
    });
  }
  return changes;
}

function parseShortStat(output) {
  const text = String(output || '');
  const insertions = Number(text.match(/(\d+) insertion/)?.[1] || 0);
  const deletions = Number(text.match(/(\d+) deletion/)?.[1] || 0);
  return { insertions, deletions };
}

/**
 * Lines in the untracked files, which no `git diff` counts. Async and capped:
 * a repo with thousands of untracked files gives up a complete count rather
 * than the caller's thread. See FORK NOTE 3.
 */
async function countUntrackedInsertions(dir, changes) {
  let insertions = 0;
  let scanned = 0;
  const deadline = Date.now() + UNTRACKED_STAT_BUDGET_MS;
  for (const change of changes) {
    if (change.status !== 'untracked') continue;
    if (scanned >= MAX_UNTRACKED_STAT_FILES || Date.now() > deadline) break;
    scanned += 1;
    const absolute = path.resolve(dir, change.path);
    const relative = path.relative(dir, absolute);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_STAT_BYTES) continue;
      const content = await fsp.readFile(absolute);
      if (content.includes(0)) continue;
      if (content.length) insertions += content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
    } catch {}
  }
  return insertions;
}

function parseCommits(output) {
  return String(output || '')
    .split('\x1e')
    .map(record => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, date, subject] = record.split('\0');
      return { hash, shortHash, author, date, subject };
    });
}

function gitOperation(gitDir) {
  const exists = (name) => fs.existsSync(path.join(gitDir, name));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  if (exists('BISECT_LOG')) return 'bisect';
  return null;
}

/** Read-only state used by the project Git tab. `{ git: false }` outside a repo. */
async function snapshot(dir, { commitLimit = 20 } = {}) {
  if (!await isGitRepo(dir)) return { git: false };

  const [branchName, head, porcelain, counts, logOutput, statOutput, gitDirOutput] = await Promise.all([
    runOr(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    runOr(['rev-parse', '--short', 'HEAD'], dir),
    runRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir),
    runOr(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir, ''),
    runOr(['log', `-${Math.max(1, Math.min(100, Number(commitLimit) || 20))}`, '--date=iso-strict', '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x1e'], dir, ''),
    runOr(['diff', '--shortstat', 'HEAD', '--'], dir, ''),
    runOr(['rev-parse', '--git-dir'], dir, ''),
  ]);

  const changes = parsePorcelain(porcelain);
  const [behindRaw, aheadRaw] = counts.trim().split(/\s+/);
  const ahead = counts ? Number(aheadRaw) : null;
  const behind = counts ? Number(behindRaw) : null;
  const stats = parseShortStat(statOutput);
  stats.insertions += await countUntrackedInsertions(dir, changes);
  const gitDir = gitDirOutput ? path.resolve(dir, gitDirOutput.trim()) : null;
  const detached = branchName.trim() === 'HEAD';

  return {
    git: true,
    branch: detached ? '' : branchName.trim(),
    detached,
    head: head.trim(),
    dirty: changes.length > 0,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    operation: gitDir ? gitOperation(gitDir) : null,
    changes,
    stats,
    commits: parseCommits(logOutput),
  };
}

function safeRelativePath(dir, filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('File path is required');
  const absolute = path.resolve(dir, filePath);
  const relative = path.relative(dir, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('File is outside the repository');
  }
  return { absolute, relative };
}

/** Return a read-only unified diff for one currently changed file. */
async function fileDiff(dir, filePath) {
  const { absolute, relative } = safeRelativePath(dir, filePath);
  const changes = parsePorcelain(await runRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir));
  const change = changes.find(item => item.path === relative || item.path === filePath);
  if (!change) throw new Error('File is not currently changed');

  let diff = '';
  if (change.status === 'untracked') {
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    diff = await runRaw(['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', nullPath, absolute], dir, { allowExitCodes: [1] });
  } else {
    try {
      diff = await runRaw(['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', relative], dir);
    } catch {
      const [staged, unstaged] = await Promise.all([
        runOr(['diff', '--cached', '--no-ext-diff', '--unified=3', '--', relative], dir, ''),
        runOr(['diff', '--no-ext-diff', '--unified=3', '--', relative], dir, ''),
      ]);
      diff = [staged, unstaged].filter(Boolean).join('\n');
    }
  }

  const truncated = diff.length > MAX_DIFF_LENGTH;
  if (truncated) diff = diff.slice(0, MAX_DIFF_LENGTH) + '\n\n… diff truncated by Switchboard …\n';
  return { path: relative, diff, truncated };
}

module.exports = {
  run, version, isGitRepo, repoRoot, branchExists,
  worktreeAdd, worktreeRemove, isDirtyWorktreeError, gitCommonDir, status,
  parsePorcelain, snapshot, fileDiff,
};
