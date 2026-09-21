// Shared definitions, validation and inheritance for session and schedule settings.
// Add supported fields here once; both configuration forms use this registry.
//
// FORK NOTE — one CLI. Upstream branches this registry per runtime (`claude`
// and `codex`) and the form grows a whole model-catalog subsystem to narrow
// Codex's reasoning efforts per model. This fork ships Claude only, so the
// codex branch is gone rather than carried as a dead runtime parameter. What
// is kept is the SHAPE: FIELDS is still keyed by runtime and every entry point
// still takes `runtime`, so adding a second CLI is a new key in FIELDS, not a
// rewrite of the forms. Nothing here is Claude-specific except FIELDS.claude.
(function (root) {
  // Kept identical to the copy in public/utils.js:27, which predates this file
  // and is still what dialogs.js and settings-panel.js read. Two copies of one
  // list is exactly the drift utils.js's own comment warns about — the fix is
  // to make utils.js alias SessionConfig.PERMISSION_MODES, which is a change to
  // a file this change does not own. See needsWiring.
  const PERMISSION_MODES = [
    { value: null, label: 'Default', desc: 'Prompt for all actions' },
    { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
    { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
    { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
  ];
  // Effort levels. Not decorative: harnesses/claude.js:339 holds
  // EFFORT_LEVELS = new Set(['low','medium','high','xhigh','max']) and
  // buildLaunchArgs (harnesses/claude.js:407) emits --effort ONLY for a value
  // in that set. A level offered here but missing there is a control that
  // silently does nothing. This list is that set plus the empty "Default",
  // which means "emit no flag". Keep the two in step.
  const CLAUDE_EFFORTS = [
    { value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra High' }, { value: 'max', label: 'Max' },
  ];
  // Every field below was checked against what this fork actually consumes:
  //   permissionMode / dangerouslySkipPermissions  harnesses/claude.js:398-402
  //   model                                        harnesses/claude.js:404-406
  //   effort                                       harnesses/claude.js:407-409
  //   allowedTools                                 harnesses/claude.js:365
  //   appendSystemPrompt                           harnesses/claude.js:415-417
  //   worktree / worktreeName                      harnesses/claude.js:383-388
  //   chrome                                       harnesses/claude.js:410-412
  //   addDirs                                      harnesses/claude.js:366-369
  //   preLaunchCmd                                 main.js:1384-1390 — prepended to the command
  //                                                string, NOT an argv flag, so buildLaunchArgs
  //                                                never sees it
  //   mcpEmulation                                 main.js:1394 — `!== false` starts the MCP
  //                                                server and appends --ide
  const FIELDS = {
    claude: [
      { key: 'permissionMode', label: 'Permission Mode', type: 'permission', default: null, choices: PERMISSION_MODES },
      { key: 'dangerouslySkipPermissions', type: 'boolean', default: false, hidden: true },
      { key: 'model', label: 'Model', type: 'text', default: '', more: true, placeholder: 'default', suggestions: ['fable', 'opus', 'sonnet'], description: "Blank uses Claude's default. An alias or a full model name" },
      { key: 'effort', label: 'Effort', type: 'select', default: '', more: true, choices: CLAUDE_EFFORTS, description: "Default uses Claude's own setting" },
      { key: 'allowedTools', label: 'Allowed Tools', type: 'text', default: '', more: true, wide: true, description: 'Tools allowed without a permission prompt (comma-separated)' },
      { key: 'appendSystemPrompt', label: 'Additional System Prompt', type: 'textarea', default: '', more: true, wide: true, description: "Instructions appended to Claude's system prompt" },
      { key: 'worktree', label: 'Worktree', type: 'boolean', default: false, description: 'Run each new session in an isolated git worktree' },
      { key: 'worktreeName', label: 'Worktree Name', type: 'text', default: '', placeholder: 'name (optional)' },
      { key: 'chrome', label: 'Chrome', type: 'boolean', default: false, description: 'Enable Chrome browser automation' },
      // Hidden, and default FALSE on purpose. Upstream defaults this true; this
      // fork's own default is false (main.js:1094, SETTING_DEFAULTS), while the
      // launch path treats a MISSING value as on (main.js:1394, `!== false`).
      // The default here is consulted only when the caller passes no folder
      // defaults at all — and there, upstream's `true` would quietly start an
      // MCP server and append --ide to a run the app's own defaults say should
      // have neither. Agreeing with main.js is the conservative read.
      { key: 'mcpEmulation', type: 'boolean', default: false, hidden: true },
    ],
  };
  const COMMON_FIELDS = [
    { key: 'preLaunchCmd', label: 'Pre-launch Command', type: 'text', default: '', more: true, wide: true, placeholder: 'e.g. aws-vault exec profile --', description: 'Prepended to the CLI command' },
    { key: 'addDirs', label: 'Additional Directories', type: 'text', default: '', more: true, wide: true, placeholder: '/path/to/dir1, /path/to/dir2', description: 'Extra directories (comma-separated). Project attachments are included automatically.' },
  ];
  const DEFAULT_RUNTIME = 'claude';
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

  /**
   * The full field list for a CLI: its own fields, then the ones every CLI has.
   *
   * An unknown runtime throws rather than degrading to COMMON_FIELDS alone.
   * Upstream returns `[...(FIELDS[runtime] || []), ...COMMON_FIELDS]`, so a typo
   * renders a settings form with no permission mode and validates away every
   * real setting as "unsupported" — a silent wrong answer. With one CLI a bad
   * runtime is always a bug, so it is loud. `own()` guards the lookup, which
   * makes fieldsFor('constructor') that same clean error instead of a spread of
   * something inherited from Object.prototype.
   */
  function fieldsFor(runtime = DEFAULT_RUNTIME) {
    if (!own(FIELDS, runtime)) throw new Error(`Unknown CLI: ${runtime}`);
    return [...FIELDS[runtime], ...COMMON_FIELDS];
  }

  /**
   * Keys of the optional fields (more: true) that wait behind "More options":
   * those without a value. A value from saved overrides or folder defaults
   * keeps its field in view, so nothing already set is ever tucked away.
   */
  function fieldsBehindMore(runtime = DEFAULT_RUNTIME, values = {}) {
    const hasValue = (field, value) => field.type === 'boolean' ? value === true : value !== undefined && value !== null && value !== '';
    return fieldsFor(runtime).filter(f => f.more && !f.hidden && !hasValue(f, values[f.key])).map(f => f.key);
  }

  function normalizeOverrides(runtime = DEFAULT_RUNTIME, input = {}) {
    if (!isObject(input)) throw new Error('Session settings must be an object');
    const fields = new Map(fieldsFor(runtime).map(f => [f.key, f]));
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const field = fields.get(key);
      if (!field) throw new Error(`Unsupported ${runtime} setting: ${key}`);
      if (field.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${key} must be on or off`);
        out[key] = value;
      } else if (field.choices) {
        if (!field.choices.some(c => c.value === value)) throw new Error(`Invalid ${field.label}`);
        out[key] = value;
      } else {
        if (typeof value !== 'string') throw new Error(`${field.label} must be text`);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${field.label} contains unsafe characters`);
        if (field.type !== 'textarea' && /[\r\n]/.test(value)) throw new Error(`${field.label} must be a single line`);
        out[key] = field.type === 'textarea' ? value : value.trim();
      }
    }
    return out;
  }

  /**
   * Schedule settings keyed by CLI id: { claude: { ...overrides } }.
   *
   * NOTE the name collision with this fork's existing schedules. A schedule's
   * markdown frontmatter also carries a `cli:` block, but that one is a flat map
   * of kebab-case CLI FLAGS (`permission-mode`, `model`, `allowed-tools`,
   * `append-system-prompt`, `add-dirs`, `max-budget-usd`) read by
   * schedule-runner.js buildScheduleCommand (schedule-runner.js:200-232). The
   * two shapes are unrelated. Do not feed one to the other.
   */
  function normalizeByCli(input = {}) {
    if (!isObject(input)) throw new Error('Schedule settings must be an object');
    const out = {};
    for (const [runtime, values] of Object.entries(input)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(runtime) || ['constructor', 'prototype', '__proto__'].includes(runtime)) throw new Error('Invalid CLI');
      out[runtime] = normalizeOverrides(runtime, values);
    }
    return out;
  }

  function resolveOptions(runtime = DEFAULT_RUNTIME, defaults = {}, overrides = {}) {
    const clean = normalizeOverrides(runtime, overrides);
    const out = {};
    for (const field of fieldsFor(runtime)) {
      let value = own(clean, field.key) ? clean[field.key] : defaults?.[field.key];
      // Null means a CLI's own default for selects/text, and off for toggles.
      if (value === undefined) value = field.default;
      if (value === null && field.type !== 'permission') value = field.type === 'boolean' ? false : '';
      out[field.key] = value;
    }
    return normalizeOverrides(runtime, out);
  }

  const api = { PERMISSION_MODES, CLAUDE_EFFORTS, FIELDS, COMMON_FIELDS, DEFAULT_RUNTIME,
    fieldsFor, fieldsBehindMore, normalizeOverrides, normalizeByCli, resolveOptions, own };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
