// VS Code tasks.json (schema 2.0.0) parser: reads a project's .vscode/tasks.json
// and resolves each entry into exactly what would be spawned.
//
// Ported from upstream d4a51aa with three security changes an audit required.
// All three are pure functions here so they can be tested without Electron:
//
//   (a) Every normalized task carries `commandLine`, `cwd`, `envFile` and
//       `envKeys` -- the RESOLVED facts. `label` and `detail` are written by
//       whoever wrote the tasks.json, i.e. by whoever wrote the repo you just
//       cloned, so a menu built from those two alone tells the user nothing
//       about what is about to run. See describeResolvedTask.
//
//   (b) `options.envFile` is rejected unless it resolves inside the project
//       root (or the parent repo a worktree inherits its tasks from). Upstream
//       resolved an absolute envFile anywhere on disk and fed its contents to
//       the child as environment, which turns any tasks.json into a reader for
//       ~/.aws/credentials or ~/.npmrc. See resolveEnvFile / isInsideRoot.
//
//   (c) A (project, label) pair carries a trust fingerprint over the resolved
//       graph, so the caller can demand an explicit confirmation before the
//       first run -- and again whenever what actually runs changes.
//       See describeTaskRun / taskRunFingerprint / isTaskTrusted.
//
// TWO FORK NOTES, both about dependencies upstream has and this fork does not:
//
//   * `jsonc-parser` is not installed here and is not in package.json, so the
//     JSONC scanner below is vendored rather than imported.
//   * `dotenv` IS in node_modules but only as a DEV-ONLY transitive dependency
//     of app-builder-lib (package-lock marks it "dev": true), so it would be
//     absent from a packaged build. The .env parser below is vendored too.
//
// Neither vendored piece needs a package.json change, which is deliberate:
// this module must not require one.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASKS_RELATIVE_PATH = path.join('.vscode', 'tasks.json');

// -- JSONC ----------------------------------------------------------------

// Blank out // and /* */ comments IN PLACE (same length, newlines preserved)
// so a JSON.parse error offset still points at the original text.
function stripJsonComments(text, filePath) {
  const out = Array.from(text);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      let closed = false;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          closed = true;
          break;
        }
        if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
        i += 1;
      }
      if (!closed) throw new Error(`${filePath}: unterminated block comment at offset ${start}`);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// Blank out a comma that is followed only by whitespace and a closer.
function stripTrailingCommas(text) {
  const out = Array.from(text);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') out[i] = ' ';
    }
    i += 1;
  }
  return out.join('');
}

function parseJsonc(text, filePath = 'tasks.json') {
  const stripped = stripTrailingCommas(stripJsonComments(String(text), filePath));
  let document;
  try {
    document = JSON.parse(stripped);
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  return document;
}

// -- .env -----------------------------------------------------------------

// A deliberate subset of the dotenv grammar: KEY=value, an optional `export`
// prefix, single/double/backtick quoting (multi-line allowed), \n \r \t and
// \\ escapes inside double quotes only, `#` comments, and an inline comment on
// an unquoted value only when preceded by whitespace. Variable interpolation
// is NOT supported, on purpose: an env file is data, not a second expression
// language, and every extra evaluation step is another thing to audit.
function parseEnvText(text) {
  const result = {};
  const source = String(text).replace(/^\uFEFF/, '');
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && /\s/.test(source[i])) i += 1;
    if (i >= n) break;
    if (source[i] === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    const lineStart = i;
    while (i < n && source[i] !== '=' && source[i] !== '\n') i += 1;
    if (i >= n || source[i] === '\n') { i += 1; continue; } // no '=' on this line

    let key = source.slice(lineStart, i).trim();
    i += 1; // consume '='
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;

    while (i < n && (source[i] === ' ' || source[i] === '\t')) i += 1;

    let value = '';
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i += 1;
      const chunk = [];
      while (i < n) {
        if (quote === '"' && source[i] === '\\' && i + 1 < n) {
          const next = source[i + 1];
          chunk.push(next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next);
          i += 2;
          continue;
        }
        if (source[i] === quote) { i += 1; break; }
        chunk.push(source[i]);
        i += 1;
      }
      value = chunk.join('');
      while (i < n && source[i] !== '\n') i += 1; // discard the rest of the line
    } else {
      const valueStart = i;
      while (i < n && source[i] !== '\n') i += 1;
      value = source.slice(valueStart, i);
      const comment = /\s#/.exec(value);
      if (comment) value = value.slice(0, comment.index);
      if (value.trimStart().startsWith('#')) value = '';
      value = value.trim();
    }
    result[key] = value;
  }
  return result;
}

// -- platform / merging ---------------------------------------------------

function platformKey(platform = process.platform) {
  if (platform === 'darwin') return 'osx';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function mergeOptions(...values) {
  const result = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const previousEnv = result.env;
    Object.assign(result, value);
    if (value.env || previousEnv) result.env = { ...(previousEnv || {}), ...(value.env || {}) };
  }
  return result;
}

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...base };
  return {
    ...base,
    ...override,
    options: mergeOptions(base.options, override.options),
    presentation: { ...(base.presentation || {}), ...(override.presentation || {}) },
  };
}

function valueOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

function expandString(value, context) {
  if (typeof value !== 'string') return value;
  const variables = {
    workspaceFolder: context.workspaceFolder,
    workspaceFolderBasename: path.basename(context.workspaceFolder),
    userHome: context.userHome || os.homedir(),
    pathSeparator: path.sep,
    '/': path.sep,
    cwd: context.workspaceFolder,
  };

  return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    if (name.startsWith('env:')) return context.env?.[name.slice(4)] ?? '';
    const error = new Error(`Unsupported task variable ${match}`);
    error.unsupportedVariable = true;
    throw error;
  });
}

function expandValue(value, context) {
  if (typeof value === 'string') return expandString(value, context);
  if (Array.isArray(value)) return value.map(item => expandValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item, context)]));
  }
  return value;
}

// -- (b) env file containment ---------------------------------------------

// True when `target` is `root` itself or lives beneath it.
//
// path.relative is the right primitive and its edge cases are the reason:
// on win32 it compares the root case-insensitively (C:\Foo vs c:\foo -> inside),
// it returns a LEADING ".." for a sibling whose name merely starts with the
// root's ("C:\Foo\Bar" vs "C:\Foo\Barn\x" -> "..\Barn\x", correctly outside,
// which a startsWith() string test gets wrong), and for a different drive it
// returns an ABSOLUTE path ("D:\Foo\x"), which is why isAbsolute is checked.
function isInsideRoot(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function insideAnyRoot(roots, target) {
  return roots.some(root => isInsideRoot(root, target));
}

function resolveAgainst(root, envFile, context) {
  const expanded = expandString(String(envFile), { ...context, workspaceFolder: root });
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

// Resolve options.envFile and read it, or explain why it was refused.
// Returns { declared, resolved, status, keys, error, env } and NEVER returns
// values for a rejected file -- `env` is {} and the caller must treat the task
// as unrunnable.
function resolveEnvFile(envFile, context) {
  if (envFile == null || envFile === '') {
    return { declared: null, resolved: null, status: 'none', keys: [], error: null, env: {} };
  }

  const declared = String(envFile);
  const readFile = context.readFile || fs.readFileSync;
  // realpath is what closes the symlink hole: a link INSIDE the root pointing
  // at ~/.ssh/id_rsa passes a purely lexical containment test.
  const realpath = context.realpath || (candidate => {
    try { return fs.realpathSync(candidate); } catch { return candidate; }
  });

  const roots = [context.workspaceFolder, context.fallbackWorkspaceFolder]
    .filter(Boolean)
    .map(root => path.resolve(root));

  const candidates = [resolveAgainst(roots[0], declared, context)];
  if (roots[1]) {
    const fallback = resolveAgainst(roots[1], declared, context);
    if (fallback !== candidates[0]) candidates.push(fallback);
  }

  const allowed = candidates.filter(candidate =>
    insideAnyRoot(roots, candidate) && insideAnyRoot(roots, realpath(candidate)));

  if (!allowed.length) {
    return {
      declared,
      resolved: candidates[0],
      status: 'rejected',
      keys: [],
      env: {},
      error: `Task env file "${declared}" resolves to ${candidates[0]}, which is outside the project root (${roots.join(', ')}). Refusing to read it.`,
    };
  }

  let lastError = null;
  for (const candidate of allowed) {
    try {
      const parsed = parseEnvText(readFile(candidate, 'utf8'));
      return {
        declared,
        resolved: candidate,
        status: 'loaded',
        keys: Object.keys(parsed).sort(),
        env: parsed,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`Could not read task env file ${allowed[0]}: ${lastError?.message}`);
  error.envFileUnreadable = true;
  throw error;
}

// -- (a) resolved command line --------------------------------------------

// Tokens made only of these need no quoting to be read back unambiguously.
// Backslash and colon are in the set so a Windows path shows as C:\x\y.exe
// rather than as a quoted blob.
const DISPLAY_SAFE = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

function quoteForDisplay(token) {
  const text = token == null ? '' : String(token);
  if (text === '') return "''";
  if (DISPLAY_SAFE.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// For a `shell` task the command string IS a shell fragment, so it is shown
// verbatim: quoting it would hide the pipes and semicolons that are the whole
// reason a reviewer is being shown this line.
function buildCommandLine(type, executable, args) {
  if (executable == null) return '';
  const head = type === 'shell' ? String(executable) : quoteForDisplay(executable);
  const tail = (args || []).map(quoteForDisplay);
  return [head, ...tail].join(' ').trim();
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// -- normalization --------------------------------------------------------

function normalizeArgs(args, context) {
  if (args == null) return [];
  if (!Array.isArray(args)) throw new Error('Task args must be an array');
  return args.map(arg => String(expandValue(valueOf(arg), context)));
}

function normalizeTask(rawTask, root, context, key) {
  const platform = key || platformKey();
  const existsSync = context.existsSync || fs.existsSync;
  const rootWithPlatform = mergeConfig(root, root[platform]);
  let task = mergeConfig(rawTask, rawTask?.[platform]);
  task = {
    ...task,
    options: mergeOptions(rootWithPlatform.options, task.options),
    presentation: { ...(rootWithPlatform.presentation || {}), ...(task.presentation || {}) },
  };

  const label = task.label || task.taskName;
  if (!label || typeof label !== 'string') throw new Error('Every task must have a string label');

  const variableContext = {
    ...context,
    env: { ...(context.env || process.env) },
  };
  const envFileResult = resolveEnvFile(task.options?.envFile ?? task.envFile, variableContext);
  const fileEnv = envFileResult.env;
  const inlineEnv = task.options?.env || {};
  const rawEnv = { ...fileEnv, ...inlineEnv };
  const expandedEnv = {};
  const expandedInline = {};
  for (const [name, value] of Object.entries(rawEnv)) {
    if (value === null) {
      expandedEnv[name] = null;
    } else {
      expandedEnv[name] = String(expandValue(value, { ...variableContext, env: { ...variableContext.env, ...fileEnv } }));
    }
    if (Object.prototype.hasOwnProperty.call(inlineEnv, name)) expandedInline[name] = expandedEnv[name];
  }
  variableContext.env = { ...variableContext.env, ...fileEnv, ...expandedEnv };

  const dependsOn = task.dependsOn == null
    ? []
    : (Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn]).map(String);
  const type = task.type || (task.command != null ? 'shell' : 'compound');
  const compound = type === 'compound' || (task.command == null && dependsOn.length > 0 && type !== 'npm');
  const cwdValue = task.options?.cwd || context.workspaceFolder;
  const cwd = path.resolve(context.workspaceFolder, expandString(String(cwdValue), variableContext));

  const rejected = envFileResult.status === 'rejected';
  const envKeys = Object.keys(expandedEnv).sort();
  const normalized = {
    label,
    type: compound ? 'compound' : type,
    detail: typeof task.detail === 'string' ? expandString(task.detail, variableContext) : '',
    dependsOn,
    dependsOrder: task.dependsOrder === 'sequence' ? 'sequence' : 'parallel',
    isBackground: task.isBackground === true,
    cwd,
    env: rejected ? {} : expandedEnv,
    envKeys: rejected ? [] : envKeys,
    // A name-only summary of the env file, for the popover. Values are never
    // exposed to the renderer: the names alone are what a reviewer needs.
    envFile: envFileResult.status === 'none' ? null : {
      declared: envFileResult.declared,
      resolved: envFileResult.resolved,
      status: envFileResult.status,
      keys: envFileResult.keys,
      error: envFileResult.error,
    },
    // Changes when the env NAMES change or an INLINE (tasks.json-authored)
    // value changes; deliberately stable across a value-only edit to an
    // in-root .env, so rotating a token does not re-prompt the user.
    envFingerprint: hashHex(JSON.stringify([
      rejected ? [] : envKeys,
      Object.keys(expandedInline).sort().map(name => [name, expandedInline[name]]),
      envFileResult.resolved || '',
      envFileResult.status,
    ])),
    presentation: task.presentation || {},
    problemMatcher: task.problemMatcher,
    commandLine: '',
    supported: true,
  };

  if (rejected) {
    // A hard refusal, not a warning: resolveTaskGraph declines to run an
    // unsupported task, so the env file is neither read nor injected. The row
    // still carries its resolved command line, so the popover can show both
    // what it wanted to run and why it will not.
    normalized.supported = false;
    normalized.error = envFileResult.error;
  }

  if (compound) return normalized;

  if (type === 'npm') {
    const script = valueOf(task.script || task.command);
    if (!script) throw new Error(`Task "${label}" is missing its npm script`);
    normalized.type = 'npm';
    normalized.executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    normalized.args = ['run', expandString(String(script), variableContext)];
    const extraArgs = normalizeArgs(task.args, variableContext);
    if (extraArgs.length) normalized.args.push('--', ...extraArgs);
    normalized.useShell = true;
    normalized.commandLine = buildCommandLine('process', normalized.executable, normalized.args);
    return normalized;
  }

  if (type !== 'shell' && type !== 'process') {
    normalized.supported = false;
    normalized.error = `Task type "${type}" is not supported yet`;
    return normalized;
  }

  const command = valueOf(task.command);
  if (command == null || command === '') throw new Error(`Task "${label}" is missing its command`);
  normalized.executable = expandString(String(command), variableContext);
  if (context.fallbackWorkspaceFolder
      && path.isAbsolute(normalized.executable)
      && !existsSync(normalized.executable)) {
    const fallbackExecutable = expandString(String(command), {
      ...variableContext,
      workspaceFolder: context.fallbackWorkspaceFolder,
    });
    if (existsSync(fallbackExecutable)) normalized.executable = fallbackExecutable;
  }
  normalized.args = normalizeArgs(task.args, variableContext);
  normalized.useShell = type === 'shell';
  normalized.commandLine = buildCommandLine(normalized.type, normalized.executable, normalized.args);
  return normalized;
}

// Editor-context variables (${file}, ${relativeFile}, ${lineNumber}, ...) have no
// value outside a focused editor, so a headless run can never resolve them. Keep
// that task visible but unrunnable instead of failing the whole file with it.
function unsupportedTask(rawTask, label, cwd, message) {
  const detail = typeof rawTask?.detail === 'string' && !rawTask.detail.includes('${')
    ? rawTask.detail
    : '';
  return {
    label,
    type: 'shell',
    detail,
    dependsOn: [],
    dependsOrder: 'parallel',
    isBackground: false,
    cwd,
    env: {},
    envKeys: [],
    envFile: null,
    envFingerprint: hashHex('unsupported'),
    presentation: rawTask?.presentation || {},
    problemMatcher: undefined,
    commandLine: '',
    supported: false,
    error: message,
  };
}

function loadTasksFromText(text, options) {
  const workspaceFolder = path.resolve(options.workspaceFolder);
  const filePath = options.filePath || path.join(workspaceFolder, TASKS_RELATIVE_PATH);
  const root = parseJsonc(text, filePath);
  if (root.version && root.version !== '2.0.0') {
    throw new Error(`${filePath}: only tasks.json version 2.0.0 is supported`);
  }
  if (!Array.isArray(root.tasks)) throw new Error(`${filePath}: expected a tasks array`);

  const context = {
    workspaceFolder,
    userHome: options.userHome,
    env: options.env || process.env,
    readFile: options.readFile || fs.readFileSync,
    realpath: options.realpath,
    existsSync: options.existsSync,
    fallbackWorkspaceFolder: options.fallbackWorkspaceFolder,
  };
  const key = platformKey(options.platform);
  const tasks = root.tasks.map(rawTask => {
    try {
      return normalizeTask(rawTask, root, context, key);
    } catch (error) {
      const label = rawTask?.label || rawTask?.taskName;
      // Without a label there is no row to degrade into, so let it fail the file.
      if (!error?.unsupportedVariable || !label || typeof label !== 'string') throw error;
      return unsupportedTask(rawTask, label, workspaceFolder, error.message);
    }
  });
  const duplicate = tasks.find((task, index) => tasks.findIndex(other => other.label === task.label) !== index);
  if (duplicate) throw new Error(`${filePath}: duplicate task label "${duplicate.label}"`);
  return tasks;
}

function worktreeParentPath(workspaceFolder) {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const markerIndex = workspaceFolder.indexOf(marker);
  if (markerIndex === -1) return null;
  const branchPart = workspaceFolder.slice(markerIndex + marker.length);
  if (!branchPart || branchPart.includes(path.sep)) return null;
  return workspaceFolder.slice(0, markerIndex);
}

// A worktree without its own tasks.json inherits its parent repo's. The parent
// is either known to the caller (a project worktree under <project>/repos/,
// whose source repo is recorded in the database) or inferred from the
// `.claude/worktrees/<name>` layout the Claude CLI uses.
function taskFileForWorkspace(workspaceFolder, existsSync = fs.existsSync, knownParentPath = null) {
  const localFile = path.join(workspaceFolder, TASKS_RELATIVE_PATH);
  if (existsSync(localFile)) return { filePath: localFile, inherited: false };

  const parentPath = knownParentPath || worktreeParentPath(workspaceFolder);
  if (!parentPath) return null;
  const parentFile = path.join(parentPath, TASKS_RELATIVE_PATH);
  if (!existsSync(parentFile)) return null;
  return { filePath: parentFile, inherited: true, parentPath };
}

function loadProjectTasks(workspaceFolder, options = {}) {
  const source = taskFileForWorkspace(workspaceFolder, fs.existsSync, options.parentPath || null);
  if (!source) return [];
  const { filePath } = source;
  const text = fs.readFileSync(filePath, 'utf8');
  return loadTasksFromText(text, {
    ...options,
    workspaceFolder,
    filePath,
    fallbackWorkspaceFolder: source.inherited ? source.parentPath : options.fallbackWorkspaceFolder,
  });
}

function resolveTaskGraph(tasks, label) {
  const byLabel = new Map(tasks.map(task => [task.label, task]));
  const visiting = new Set();

  function visit(taskLabel) {
    const task = byLabel.get(taskLabel);
    if (!task) throw new Error(`Task "${taskLabel}" was not found`);
    if (!task.supported) throw new Error(task.error);
    if (visiting.has(taskLabel)) {
      throw new Error(`Task dependency cycle detected at "${taskLabel}"`);
    }
    visiting.add(taskLabel);
    const dependencies = task.dependsOn.map(visit);
    visiting.delete(taskLabel);
    return { task, dependencies };
  }

  return visit(label);
}

// -- (a)+(c) what will actually run, and its fingerprint ------------------

// Exactly the fields a human needs to decide whether to allow this, and
// nothing that carries a secret value.
function describeResolvedTask(task) {
  return {
    label: task.label,
    type: task.type,
    commandLine: task.commandLine || '',
    cwd: task.cwd || '',
    envFile: task.envFile
      ? {
        declared: task.envFile.declared,
        resolved: task.envFile.resolved,
        status: task.envFile.status,
        keys: task.envFile.keys,
      }
      : null,
    envKeys: task.envKeys || [],
  };
}

// Every leaf the graph will spawn, in the order it will be spawned, deduped by
// label. A compound contributes no command of its own, so confirming "dev"
// shows what "dev" actually launches rather than the words "Compound task".
function flattenTaskGraph(node, seen = new Set(), out = []) {
  for (const dependency of node.dependencies) flattenTaskGraph(dependency, seen, out);
  if (node.task.type !== 'compound' && !seen.has(node.task.label)) {
    seen.add(node.task.label);
    out.push(node.task);
  }
  return out;
}

function describeTaskRun(tasks, label) {
  const graph = resolveTaskGraph(tasks, label);
  const steps = flattenTaskGraph(graph).map(describeResolvedTask);
  return { label, type: graph.task.type, steps };
}

// Stable across a re-parse of the same file; changes the moment the resolved
// command line, cwd, env-file identity or env NAMES change. That is why a
// confirmation is bound to it and not to the label: a label is attacker-
// authored, so "build", once trusted, must not silently become `curl | sh`
// after the next git pull.
function taskRunFingerprint(description, tasksByLabel) {
  const byLabel = tasksByLabel instanceof Map
    ? tasksByLabel
    : new Map((tasksByLabel || []).map(task => [task.label, task]));
  const payload = description.steps.map(step => [
    step.label,
    step.type,
    step.commandLine,
    step.cwd,
    step.envFile ? [step.envFile.resolved, step.envFile.status] : null,
    byLabel.get(step.label)?.envFingerprint || '',
  ]);
  return hashHex(JSON.stringify([description.label, description.type, payload]));
}

// -- (c) trust store ------------------------------------------------------
//
// A plain JSON-serializable object so the host can persist it wherever it
// keeps settings. Kept out of task-manager so it is testable without Electron.

function trustKey(projectPath, label) {
  return `${projectPath}\u0000${label}`;
}

function isTaskTrusted(store, projectPath, label, fingerprint) {
  if (!store || !fingerprint) return false;
  return store[trustKey(projectPath, label)] === fingerprint;
}

// Immutable: returns a new store rather than mutating the caller's, so a
// caller that persists on change can compare references.
function recordTaskTrust(store, projectPath, label, fingerprint) {
  return { ...(store || {}), [trustKey(projectPath, label)]: fingerprint };
}

function forgetTaskTrust(store, projectPath, label) {
  const next = { ...(store || {}) };
  delete next[trustKey(projectPath, label)];
  return next;
}

module.exports = {
  TASKS_RELATIVE_PATH,
  buildCommandLine,
  describeResolvedTask,
  describeTaskRun,
  expandString,
  flattenTaskGraph,
  forgetTaskTrust,
  isInsideRoot,
  isTaskTrusted,
  loadProjectTasks,
  loadTasksFromText,
  normalizeTask,
  parseEnvText,
  parseJsonc,
  platformKey,
  quoteForDisplay,
  recordTaskTrust,
  resolveEnvFile,
  resolveTaskGraph,
  taskFileForWorkspace,
  taskRunFingerprint,
  trustKey,
  worktreeParentPath,
};
