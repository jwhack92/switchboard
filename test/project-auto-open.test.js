const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { encodeProjectPath } = require('../encode-project-path');

// A new project opens with a session in it.
//
// Jason: "When you start a new project a session should automatically open in
// that project". There are two ways to make one:
//   - Add project on the sidebar (public/dialogs.js showAddProjectDialog). It
//     also brings back a folder Switchboard already knows, listed or hidden,
//     and Jason's answer for that one is "No session": a session opens only
//     when the Add created the project entry. Main says which it was
//     (`created` in the add-project reply, main.js);
//   - New project on the Projects tab (public/projects-view.js), which is
//     always new, and opens its session after worktree errors too ("Open the
//     session anyway").
// Both end in dialogs.js openFirstSession.
//
// None of the three files can simply be required. dialogs.js only declares
// functions, so it runs whole in a vm context with the few globals the Add
// dialog reaches. main.js needs Electron and projects-view.js touches the DOM
// at load, so the code under test is cut out of each by its markers and run in
// a vm context against fakes (the way test/main-token-wiring.test.js does it):
// what runs here is the text that ships.

const DIALOGS = path.join(__dirname, '..', 'public', 'dialogs.js');
const PROJECTS_VIEW = path.join(__dirname, '..', 'public', 'projects-view.js');
const MAIN = path.join(__dirname, '..', 'main.js');

/** The source from `start` up to `end`. Both markers must be there, `start` once. */
function cut(src, start, end, file) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `marker not found in ${file}: ${start}`);
  assert.equal(src.indexOf(start, a + 1), -1, `marker is not unique in ${file}: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `end marker not found after it in ${file}: ${end}`);
  return src.slice(a, b);
}

/** A promise and the function that settles it, for a reply that is still out. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** An element that accepts whatever the dialog does to it. */
function fakeEl() {
  const kids = new Map();
  return {
    className: '', innerHTML: '', textContent: '', value: '', style: {}, onclick: null, disabled: false,
    appendChild() {}, remove() {}, focus() {}, addEventListener() {},
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, fakeEl());
      return kids.get(sel);
    },
  };
}

// --- The sidebar's Add project dialog (public/dialogs.js) ---

/**
 * dialogs.js in a context of its own.
 *   addReply     what window.api.addProject resolves to, or a function of the
 *                path that returns it (or a promise of it, or throws)
 *   afterLoad    the project list loadProjects() leaves in cachedAllProjects
 *   settings     what getEffectiveSettings resolves to (or a function that throws)
 */
function boot({ addReply, afterLoad = [], settings = {} } = {}) {
  const created = [];
  const keydown = new Set();
  const calls = { addProject: [], loadProjects: 0, launches: [], errors: [], order: [] };
  const ctx = {
    console: { error: (...a) => calls.errors.push(a), log() {}, warn() {} },
    cachedAllProjects: [],
    cachedProjects: [],
    document: {
      createElement: () => { const el = fakeEl(); created.push(el); return el; },
      body: { appendChild() {} },
      addEventListener: (type, fn) => { if (type === 'keydown') keydown.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'keydown') keydown.delete(fn); },
    },
    window: {
      api: {
        addProject: async (p) => {
          calls.addProject.push(p);
          calls.order.push('add');
          return typeof addReply === 'function' ? addReply(p) : addReply;
        },
        browseFolder: async () => null,
        getEffectiveSettings: async (projectPath) => {
          calls.order.push('settings');
          if (typeof settings === 'function') return settings(projectPath);
          return settings;
        },
      },
    },
    loadProjects: async () => { calls.loadProjects++; calls.order.push('load'); ctx.cachedAllProjects = afterLoad; },
    launchNewSession: async (project, options) => { calls.order.push('launch'); calls.launches.push({ project, options }); },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(DIALOGS, 'utf8'), ctx, { filename: DIALOGS });
  const app = {
    ctx, calls,
    /** How many keydown listeners the page still holds (the dialog's is removed on close). */
    listeners: () => keydown.size,
    /** Open the Add project dialog with a path typed in it. */
    open(typed) {
      ctx.showAddProjectDialog();
      const dialog = created[created.length - 1];   // overlay first, dialog second
      dialog.querySelector('#add-project-path').value = typed;
      return dialog;
    },
    /** Press a key on the page: what the dialog's own keydown listener receives. */
    press(key) {
      for (const fn of [...keydown]) fn({ key, target: { matches: () => false } });
    },
    /** Open the Add project dialog, type a path and press Add. */
    async add(typed) {
      const dialog = app.open(typed);
      await dialog.querySelector('.add-project-add-btn').onclick();
      return dialog;
    },
  };
  return app;
}

/** Let everything that is already settled run. */
const settle = () => new Promise((r) => setImmediate(r));

test('openFirstSession: the folder defaults, an optional runtime, and it never throws', async () => {
  const ok = boot({ settings: { permissionMode: 'plan', chrome: true } });
  assert.equal(await ok.ctx.openFirstSession({ projectPath: 'C:\\p' }), true);
  assert.equal(ok.calls.launches.length, 1);
  assert.equal(ok.calls.launches[0].project.projectPath, 'C:\\p');
  assert.equal(ok.calls.launches[0].options.permissionMode, 'plan');
  assert.equal(ok.calls.launches[0].options.chrome, true);
  assert.equal('runtime' in ok.calls.launches[0].options, false, 'no runtime unless the caller names one');

  assert.equal(await ok.ctx.openFirstSession({ projectPath: 'C:\\p', projectId: 'p1' }, { runtime: 'claude' }), true);
  assert.equal(ok.calls.launches[1].options.runtime, 'claude');
  assert.equal(ok.calls.launches[1].project.projectId, 'p1');

  const bad = boot({ settings: () => { throw new Error('no handler'); } });
  assert.equal(await bad.ctx.openFirstSession({ projectPath: 'C:\\p' }), false);
  assert.equal(bad.calls.launches.length, 0);
  assert.equal(bad.calls.errors.length, 1, 'the reason is logged once');
});

test('Add project, created: the list is reloaded, then exactly one session opens in the path main returned', async () => {
  const app = boot({
    // Main put the typed path right: other slashes, no trailing separator.
    addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true },
    afterLoad: [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] }],
    settings: { permissionMode: 'acceptEdits' },
  });
  await app.add('  C:/work/alpha/  ');
  assert.deepEqual(app.calls.addProject, ['C:/work/alpha/'], 'the typed path is trimmed and sent as typed');
  assert.deepEqual(app.calls.order, ['add', 'load', 'settings', 'launch']);
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\alpha', 'the reply path, not the typed one');
  assert.equal(app.calls.launches[0].options.permissionMode, 'acceptEdits');
  assert.equal(app.listeners(), 0, 'the dialog took its key listener with it');
});

test('Add project, created: the project list is not consulted', async () => {
  // Whatever the reloaded list holds, `created` decides: the list was the guess
  // that got this wrong.
  for (const afterLoad of [
    [],
    [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [{ sessionId: 's1' }] }],
  ]) {
    const app = boot({ addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true }, afterLoad });
    await app.add('C:\\work\\alpha');
    assert.equal(app.calls.launches.length, 1);
    assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\alpha');
  }
});

test('Add project, not created: a folder Switchboard already knows is shown again and gets no session', async () => {
  // Jason: "No session". With no sessions, with sessions, and missing from the
  // reloaded list (the hidden project typed in another spelling) alike.
  for (const afterLoad of [
    [{ folder: 'C--work-old', projectPath: 'C:\\work\\old', sessions: [] }],
    [{ folder: 'C--work-old', projectPath: 'C:\\work\\old', sessions: [{ sessionId: 's1', archived: 1 }] }],
    [],
  ]) {
    const app = boot({ addReply: { ok: true, folder: 'C--work-old', projectPath: 'C:\\work\\old', created: false }, afterLoad });
    await app.add('C:\\work\\old');
    assert.equal(app.calls.loadProjects, 1, 'it is still shown again');
    assert.equal(app.calls.launches.length, 0);
    assert.equal(app.listeners(), 0, 'and the dialog is closed');
  }
});

test('Add project: only created === true opens a session', async () => {
  for (const created of [undefined, null, 1, 'true', 'yes']) {
    const app = boot({ addReply: { ok: true, folder: 'C--work-old', projectPath: 'C:\\work\\old', created } });
    await app.add('C:\\work\\old');
    assert.equal(app.calls.loadProjects, 1);
    assert.equal(app.calls.launches.length, 0, `created: ${String(created)}`);
  }
});

test('Add project that fails starts nothing, and a second attempt still works', async () => {
  const replies = [
    { error: 'Path is not a directory' },
    { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true },
  ];
  const app = boot({ addReply: () => replies.shift() });
  const dialog = app.open('C:\\work\\file.txt');
  const addBtn = dialog.querySelector('.add-project-add-btn');
  await addBtn.onclick();
  assert.equal(dialog.querySelector('#add-project-error').textContent, 'Path is not a directory');
  assert.equal(dialog.querySelector('#add-project-error').style.display, 'block');
  assert.equal(app.calls.loadProjects, 0);
  assert.equal(app.calls.launches.length, 0);
  assert.equal(addBtn.disabled, false, 'the button is given back');
  assert.equal(app.listeners(), 1, 'the dialog is still up');

  dialog.querySelector('#add-project-path').value = 'C:\\work\\alpha';
  await addBtn.onclick();
  assert.deepEqual(app.calls.addProject, ['C:\\work\\file.txt', 'C:\\work\\alpha']);
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\alpha');
});

test('Add project: a call that rejects, or answers nothing, is an error and not a dead dialog', async () => {
  const replies = [
    () => { throw new Error('ipc is gone'); },
    () => undefined,
    () => ({ ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true }),
  ];
  const app = boot({ addReply: () => replies.shift()() });
  const dialog = app.open('C:\\work\\alpha');
  const addBtn = dialog.querySelector('.add-project-add-btn');
  await addBtn.onclick();   // must not reject
  assert.equal(dialog.querySelector('#add-project-error').textContent, 'ipc is gone');
  assert.equal(addBtn.disabled, false);
  await addBtn.onclick();
  assert.equal(dialog.querySelector('#add-project-error').textContent, 'Could not add the project.');
  assert.equal(addBtn.disabled, false);
  assert.equal(app.calls.launches.length, 0);
  await addBtn.onclick();
  assert.equal(app.calls.addProject.length, 3);
  assert.equal(app.calls.launches.length, 1);
});

test('Add project with an empty path asks for one and does not use up the one attempt', async () => {
  const app = boot({ addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true } });
  const dialog = app.open('   ');
  const addBtn = dialog.querySelector('.add-project-add-btn');
  await addBtn.onclick();
  assert.equal(dialog.querySelector('#add-project-error').textContent, 'Please enter a folder path.');
  assert.equal(app.calls.addProject.length, 0);
  assert.equal(app.calls.launches.length, 0);
  assert.equal(addBtn.disabled, false);

  dialog.querySelector('#add-project-path').value = 'C:\\work\\alpha';
  await addBtn.onclick();
  assert.equal(app.calls.addProject.length, 1);
  assert.equal(app.calls.launches.length, 1);
});

test('Add project pressed twice while the first is out: one add-project call and one session', async () => {
  const reply = deferred();
  const app = boot({ addReply: () => reply.promise });
  const dialog = app.open('C:\\work\\alpha');
  const addBtn = dialog.querySelector('.add-project-add-btn');

  const first = addBtn.onclick();
  assert.equal(addBtn.disabled, true, 'the button is off while the request is out');
  // The dialog and its Enter listener are still up: Enter, Enter and a click.
  app.press('Enter');
  app.press('Enter');
  const second = addBtn.onclick();
  await settle();
  assert.equal(app.calls.addProject.length, 1, 'the request went out once');

  reply.resolve({ ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true });
  await Promise.all([first, second]);
  await settle();
  assert.equal(app.calls.addProject.length, 1);
  assert.equal(app.calls.loadProjects, 1);
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.listeners(), 0);
});

test('a session that cannot be started does not undo the Add', async () => {
  const app = boot({
    addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', created: true },
    afterLoad: [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] }],
    settings: () => { throw new Error('settings unavailable'); },
  });
  await app.add('C:\\work\\alpha');   // must not reject
  assert.equal(app.calls.loadProjects, 1);
  assert.equal(app.calls.launches.length, 0);
  assert.equal(app.calls.errors.length, 1);
});

// --- main.js: the add-project handler decides what "created" means ---

const MAIN_HANDLERS = cut(fs.readFileSync(MAIN, 'utf8'), '// --- IPC: add-project ---', '// --- IPC: projects ---', 'main.js');

/**
 * The add-project and remove-project handlers out of main.js, on a real temp
 * folder: `projectsDir` stands in for ~/.claude/projects and `work` holds the
 * folders being added.
 *   hidden     the hiddenProjects setting to start from
 *   platform   what process.platform reads as inside the handler
 */
function bootMain(t, { hidden, platform = process.platform } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-add-project-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projectsDir = path.join(base, 'claude-projects');
  const work = path.join(base, 'work');
  fs.mkdirSync(projectsDir);
  fs.mkdirSync(work);

  const settings = {};
  if (hidden) settings.global = { hiddenProjects: hidden };
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const handlers = {};
  const calls = { refreshed: [], notified: 0, saved: 0 };
  const ctx = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    fs, path, require,
    process: { platform },
    PROJECTS_DIR: projectsDir,
    encodeProjectPath,
    getSetting: (key) => copy(settings[key]),
    setSetting: (key, value) => { calls.saved++; settings[key] = copy(value); },
    deleteSetting: (key) => { delete settings[key]; },
    deleteCachedFolder() {}, deleteSearchFolder() {},
    refreshFolder: (folder) => calls.refreshed.push(folder),
    notifyRendererProjectsChanged: () => { calls.notified++; },
  };
  vm.createContext(ctx);
  vm.runInContext(MAIN_HANDLERS, ctx, { filename: MAIN });
  return {
    work, projectsDir, calls,
    /** A real folder under work/, made if it is not there. */
    dir(...parts) {
      const p = path.join(work, ...parts);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    add: (typed) => ({ ...handlers['add-project']({}, typed) }),
    remove: (projectPath) => ({ ...handlers['remove-project']({}, projectPath) }),
    hidden: () => (settings.global && settings.global.hiddenProjects) || [],
    /** Folder names under the stand-in ~/.claude/projects. */
    folders: () => fs.readdirSync(projectsDir),
    /** The parsed seed transcripts in one of them. */
    seeds: (folder) => fs.readdirSync(path.join(projectsDir, folder))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => JSON.parse(fs.readFileSync(path.join(projectsDir, folder, f), 'utf8'))),
  };
}

test('add-project on a folder Switchboard has never seen makes the entry: created is true', (t) => {
  const main = bootMain(t);
  const dir = main.dir('alpha');
  const reply = main.add(dir);
  assert.deepEqual(reply, { ok: true, folder: encodeProjectPath(dir), projectPath: dir, created: true });
  assert.deepEqual(main.folders(), [reply.folder]);
  const seeds = main.seeds(reply.folder);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].type, 'project-seed');
  assert.equal(seeds[0].cwd, dir);
  assert.deepEqual(main.calls.refreshed, [reply.folder]);
  assert.equal(main.calls.notified, 1);
});

test('add-project on a folder that is already listed, with no sessions: created is false', (t) => {
  // Jason: "No session" for a folder Switchboard already knows. Its entry is
  // the seed transcript from the first Add; nothing is written the second time.
  const main = bootMain(t);
  const dir = main.dir('alpha');
  assert.equal(main.add(dir).created, true);
  const again = main.add(dir);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.projectPath, dir);
  assert.equal(main.seeds(again.folder).length, 1, 'no second seed');
  assert.equal(main.calls.notified, 2, 'the sidebar is still told to reload');
});

test('add-project: a typed trailing separator is the same project, not a second folder', (t) => {
  const main = bootMain(t);
  const dir = main.dir('alpha');
  const first = main.add(dir);
  const seps = process.platform === 'win32' ? ['\\', '/', '\\\\'] : ['/', '//'];
  for (const sep of seps) {
    const again = main.add(dir + sep);
    assert.equal(again.created, false, `typed with ${sep} on the end`);
    assert.equal(again.projectPath, dir);
    assert.equal(again.folder, first.folder);
  }
  assert.deepEqual(main.folders(), [first.folder], 'one folder under ~/.claude/projects');
  assert.equal(main.seeds(first.folder).length, 1);

  // And a NEW folder typed that way is recorded without the separator.
  const beta = main.dir('beta');
  const made = main.add(beta + path.sep);
  assert.equal(made.created, true);
  assert.equal(made.projectPath, beta);
  assert.equal(made.folder, encodeProjectPath(beta));
  assert.equal(main.seeds(made.folder)[0].cwd, beta);
});

test('add-project on Windows: forward slashes or another case are the same project',
  { skip: process.platform !== 'win32' && 'needs Windows paths and a case-blind disk' }, (t) => {
    const main = bootMain(t);
    const dir = main.dir('Alpha');
    const first = main.add(dir);
    assert.equal(first.created, true);

    const slashed = main.add(dir.replace(/\\/g, '/'));
    assert.equal(slashed.created, false);
    assert.equal(slashed.projectPath, dir);
    assert.equal(slashed.folder, first.folder);

    assert.equal(main.add(dir.toUpperCase()).created, false);
    assert.equal(main.add(dir.toLowerCase()).created, false);
    assert.deepEqual(main.folders(), [first.folder]);
    assert.equal(main.seeds(first.folder).length, 1);
  });

test('add-project on a hidden project shows it again: created is false even when its entry had to be remade', (t) => {
  // The folder under ~/.claude/projects is empty here, so the seed IS written.
  // It is still not a new project: it was hidden, and Jason's answer for a
  // folder Switchboard already knows is "No session".
  const main = bootMain(t);
  const dir = main.dir('alpha');
  const other = main.dir('other');
  const fresh = bootMain(t, { hidden: [null, other, dir, 5, ''] });
  const reply = fresh.add(dir);
  assert.equal(reply.ok, true);
  assert.equal(reply.created, false);
  assert.equal(fresh.seeds(reply.folder).length, 1, 'the entry was made');
  assert.deepEqual(fresh.hidden(), [null, other, 5, ''], 'only this project is un-hidden');
  assert.equal(fresh.calls.saved, 1);

  // A project that is not hidden leaves the setting alone.
  const untouched = bootMain(t, { hidden: [other] });
  assert.equal(untouched.add(dir).created, true);
  assert.deepEqual(untouched.hidden(), [other]);
  assert.equal(untouched.calls.saved, 0);
});

test('add-project un-hides a project typed with a trailing separator', (t) => {
  const main = bootMain(t);
  const dir = main.dir('alpha');
  // Hide it the way the sidebar does, through remove-project.
  const first = main.add(dir);
  assert.equal(first.created, true);
  assert.equal(main.remove(first.projectPath).ok, true);
  assert.deepEqual(main.hidden(), [dir]);

  const back = main.add(dir + path.sep);
  assert.equal(back.created, false);
  assert.equal(back.projectPath, dir);
  assert.deepEqual(main.hidden(), [], 'it is shown again');

  // The hidden entry itself may be the odd spelling.
  const odd = bootMain(t, { hidden: [dir + path.sep] });
  assert.equal(odd.add(dir).created, false);
  assert.deepEqual(odd.hidden(), []);
});

test('add-project on Windows un-hides a project typed with forward slashes',
  { skip: process.platform !== 'win32' && 'forward and back slashes only mean the same on Windows' }, (t) => {
    const scratch = bootMain(t);
    const dir = scratch.dir('alpha');
    const main = bootMain(t, { hidden: [dir] });
    const reply = main.add(dir.replace(/\\/g, '/'));
    assert.equal(reply.created, false);
    assert.equal(reply.projectPath, dir);
    assert.deepEqual(main.hidden(), []);
  });

test('add-project un-hides a project typed in another case on Windows, and only there', (t) => {
  // The platform is the handler's own reading of process.platform, so both
  // rules run on any machine. Both spellings are made on disk: one folder where
  // the disk ignores case, two where it does not.
  const scratch = bootMain(t);
  const hiddenAs = scratch.dir('alpha');
  const typed = scratch.dir('ALPHA');

  const win = bootMain(t, { hidden: [hiddenAs], platform: 'win32' });
  const shown = win.add(typed);
  assert.equal(shown.ok, true);
  assert.equal(shown.created, false, 'a hidden project shown again');
  assert.deepEqual(win.hidden(), [], 'C:\\Work and c:\\work are one folder');

  const posix = bootMain(t, { hidden: [hiddenAs], platform: 'linux' });
  const separate = posix.add(typed);
  assert.equal(separate.ok, true);
  assert.equal(separate.created, true, 'another folder where case counts');
  assert.deepEqual(posix.hidden(), [hiddenAs], 'the other spelling stays hidden');
});

test('add-project refuses what is not a folder, and writes nothing', (t) => {
  const main = bootMain(t);
  const file = path.join(main.work, 'notes.txt');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(main.add(file), { error: 'Path is not a directory' });
  assert.match(main.add(path.join(main.work, 'missing')).error, /ENOENT/);
  // path.resolve('') is the app's own folder: nothing typed must not add it.
  for (const nothing of ['', '   ', undefined, null, 5]) {
    const reply = main.add(nothing);
    assert.equal(typeof reply.error, 'string', String(nothing));
    assert.equal('created' in reply, false);
  }
  assert.deepEqual(main.folders(), []);
  assert.deepEqual(main.calls.refreshed, []);
  assert.equal(main.calls.notified, 0);
  assert.equal(main.calls.saved, 0);
});

// --- New project on the Projects tab (public/projects-view.js) ---

const VIEW_SRC = fs.readFileSync(PROJECTS_VIEW, 'utf8');
// create() and its guard flag, out of showNewProjectDialog, with the two tree
// helpers it ends in. They are the shipped text; everything create() reaches
// in the dialog around it is a fake below.
const CREATE_BLOCK = [
  cut(VIEW_SRC, 'function findTreeProject(id) {', 'function selectedProject() {', 'projects-view.js'),
  cut(VIEW_SRC, 'function launchTargetFor(project, track = null) {', '/**', 'projects-view.js'),
  cut(VIEW_SRC, '  let creating = false;', "  q('#np-add-folder').onclick", 'projects-view.js'),
].join('\n');

/**
 * create() from the New project dialog.
 *   reply      what window.api.createProject answers: a value, or a function
 *              returning one (or a promise of it, or throwing)
 *   tree       the projects loadProjects() leaves in the tree
 */
function bootProjectsTab({ reply, tree = [], name = 'Alpha' } = {}) {
  const calls = { create: [], opened: [], alerts: [], errors: [], closed: 0, order: [] };
  const ctx = {
    nameInput: { value: name, focus() {} },
    branchInput: { value: '' },
    sharedBox: { checked: true },
    createBtn: { disabled: false, textContent: 'Create project' },
    folders: [],
    hasWorktree: () => false,
    showError: (text) => { if (text) calls.errors.push(text); },
    close: () => { calls.closed++; },
    projectsUi: { selectedProjectId: null },
    setProjectTab() {}, saveProjectsUi() {},
    cachedProjectTree: { projects: [] },
    cachedProjectTreeAll: { projects: [] },
    loadProjects: async () => { calls.order.push('load'); ctx.cachedProjectTree = { projects: tree }; },
    document: { querySelector: () => null },
    activeTab: 'projects',
    showProjectOverview: () => calls.order.push('overview'),
    alert: (text) => { calls.order.push('alert'); calls.alerts.push(text); },
    openFirstSession: async (target, opts) => {
      calls.order.push('open');
      calls.opened.push({ target: { ...target }, opts: { ...opts } });
      return true;
    },
    window: {
      api: {
        createProject: async (spec) => {
          calls.create.push(spec);
          calls.order.push('create');
          return typeof reply === 'function' ? reply(spec) : reply;
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CREATE_BLOCK, ctx, { filename: PROJECTS_VIEW });
  return { ctx, calls };
}

const PROJECT = { id: 'p1', name: 'Alpha', root: 'C:\\projects\\alpha', defaultCwd: null, folders: [] };
const TARGET = { projectPath: 'C:\\projects\\alpha', projectId: 'p1', trackId: null, projectName: 'Alpha' };

test('New project on the Projects tab: exactly one session opens in the project that was made', async () => {
  const app = bootProjectsTab({ reply: { ok: true, project: PROJECT, errors: [] }, tree: [PROJECT] });
  assert.deepEqual({ ...app.ctx.launchTargetFor(PROJECT) }, TARGET, 'a new project starts in its own folder');
  await app.ctx.create();
  assert.equal(app.calls.create.length, 1);
  assert.equal(app.calls.create[0].name, 'Alpha');
  assert.equal(app.calls.closed, 1);
  assert.deepEqual(app.calls.order, ['create', 'load', 'overview', 'open'], 'the tree is reloaded before the session');
  assert.deepEqual(app.calls.opened, [{ target: TARGET, opts: { runtime: 'claude' } }]);
  assert.equal(app.ctx.projectsUi.selectedProjectId, 'p1');
});

test('New project on the Projects tab: worktree errors are shown, then the session still opens', async () => {
  // Jason: "Open the session anyway".
  const app = bootProjectsTab({
    reply: { ok: true, project: PROJECT, errors: ['C:\\src\\repo: branch already exists'] },
    tree: [PROJECT],
  });
  await app.ctx.create();
  assert.equal(app.calls.alerts.length, 1);
  assert.match(app.calls.alerts[0], /some worktrees could not be made/);
  assert.match(app.calls.alerts[0], /branch already exists/);
  assert.deepEqual(app.calls.order, ['create', 'load', 'overview', 'alert', 'open'], 'after the alert');
  assert.deepEqual(app.calls.opened, [{ target: TARGET, opts: { runtime: 'claude' } }]);
});

test('New project on the Projects tab: no session when the project is not in the tree', async () => {
  for (const reply of [
    { ok: true, project: PROJECT, errors: [] },      // made, but the reloaded tree does not hold it
    { ok: true, project: null, errors: [] },         // no project in the reply at all
  ]) {
    const app = bootProjectsTab({ reply, tree: [{ ...PROJECT, id: 'someone-else' }] });
    await app.ctx.create();
    assert.equal(app.calls.closed, 1);
    assert.equal(app.calls.opened.length, 0);
  }
});

test('New project on the Projects tab: a failed create opens nothing and can be tried again', async () => {
  const replies = [
    () => ({ error: 'A folder named "alpha" already exists' }),
    () => { throw new Error('ipc is gone'); },
    () => ({ ok: true, project: PROJECT, errors: [] }),
  ];
  const app = bootProjectsTab({ reply: () => replies.shift()(), tree: [PROJECT] });
  await app.ctx.create();
  await app.ctx.create();
  assert.deepEqual(app.calls.errors, ['A folder named "alpha" already exists', 'ipc is gone']);
  assert.equal(app.calls.closed, 0);
  assert.equal(app.calls.opened.length, 0);
  assert.equal(app.ctx.createBtn.disabled, false);

  await app.ctx.create();
  assert.equal(app.calls.create.length, 3);
  assert.equal(app.calls.closed, 1);
  assert.equal(app.calls.opened.length, 1);

  // No name is not an attempt either.
  const unnamed = bootProjectsTab({ reply: { ok: true, project: PROJECT, errors: [] }, tree: [PROJECT], name: '  ' });
  await unnamed.ctx.create();
  assert.equal(unnamed.calls.create.length, 0);
  unnamed.ctx.nameInput.value = 'Alpha';
  await unnamed.ctx.create();
  assert.equal(unnamed.calls.create.length, 1);
  assert.equal(unnamed.calls.opened.length, 1);
});

test('New project on the Projects tab: confirmed twice while the first is out, one project and one session', async () => {
  const reply = deferred();
  const app = bootProjectsTab({ reply: () => reply.promise, tree: [PROJECT] });
  // Enter in the name box calls create() directly, twice.
  const first = app.ctx.create();
  const second = app.ctx.create();
  await settle();
  assert.equal(app.calls.create.length, 1, 'the request went out once');
  assert.equal(app.ctx.createBtn.disabled, true);

  reply.resolve({ ok: true, project: PROJECT, errors: [] });
  await Promise.all([first, second]);
  // And once more after it has closed.
  await app.ctx.create();
  assert.equal(app.calls.create.length, 1);
  assert.equal(app.calls.closed, 1);
  assert.equal(app.calls.opened.length, 1);
});
