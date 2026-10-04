const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// A new project opens with a session in it.
//
// Jason: "When you start a new project a session should automatically open in
// that project". There are two ways to make one:
//   - Add project on the sidebar (public/dialogs.js showAddProjectDialog),
//     which also brings a hidden project back. That one already has sessions,
//     so it is only shown again;
//   - New project on the Projects tab (public/projects-view.js), which is
//     always new.
// Both end in dialogs.js openFirstSession.
//
// dialogs.js only declares functions, so it runs in a vm context with the few
// globals the Add dialog reaches. projects-view.js touches the DOM at load, so
// its side is pinned by reading the source.

const DIALOGS = path.join(__dirname, '..', 'public', 'dialogs.js');
const PROJECTS_VIEW = path.join(__dirname, '..', 'public', 'projects-view.js');

/** An element that accepts whatever the dialog does to it. */
function fakeEl() {
  const kids = new Map();
  return {
    className: '', innerHTML: '', textContent: '', value: '', style: {}, onclick: null,
    appendChild() {}, remove() {}, focus() {}, addEventListener() {},
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, fakeEl());
      return kids.get(sel);
    },
  };
}

/**
 * dialogs.js in a context of its own.
 *   addReply     what window.api.addProject resolves to
 *   afterLoad    the project list loadProjects() leaves in cachedAllProjects
 *   settings     what getEffectiveSettings resolves to (or a function that throws)
 */
function boot({ addReply, afterLoad = [], settings = {} } = {}) {
  const created = [];
  const calls = { addProject: [], loadProjects: 0, launches: [], errors: [], order: [] };
  const ctx = {
    console: { error: (...a) => calls.errors.push(a), log() {}, warn() {} },
    cachedAllProjects: [],
    cachedProjects: [],
    document: {
      createElement: () => { const el = fakeEl(); created.push(el); return el; },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      api: {
        addProject: async (p) => { calls.addProject.push(p); calls.order.push('add'); return addReply; },
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
  return {
    ctx, calls,
    /** Open the Add project dialog, type a path and press Add. */
    async add(typed) {
      ctx.showAddProjectDialog();
      const dialog = created[created.length - 1];   // overlay first, dialog second
      dialog.querySelector('#add-project-path').value = typed;
      await dialog.querySelector('.add-project-add-btn').onclick();
      return dialog;
    },
  };
}

test('findAddedProject: by folder, by path, and by folder in another case', () => {
  const { ctx } = boot();
  const a = { folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] };
  const b = { folder: 'C--work-beta', projectPath: 'C:\\work\\beta', sessions: [{ sessionId: 's1' }] };
  const list = [a, b];
  assert.equal(ctx.findAddedProject(list, { folder: 'C--work-beta', projectPath: 'x' }), b);
  assert.equal(ctx.findAddedProject(list, { folder: 'nope', projectPath: 'C:\\work\\alpha' }), a);
  // Windows: the path was typed in another case, the folder on disk keeps its own.
  assert.equal(ctx.findAddedProject(list, { folder: 'c--WORK-beta', projectPath: 'c:\\WORK\\beta' }), b);
  assert.equal(ctx.findAddedProject(list, { folder: 'C--work-gamma', projectPath: 'C:\\work\\gamma' }), null);
  for (const bad of [null, undefined, {}, { folder: 5 }, 'C--work-alpha']) {
    assert.equal(ctx.findAddedProject(list, bad), null);
  }
  for (const bad of [null, undefined, 'x', {}]) {
    assert.equal(ctx.findAddedProject(bad, { folder: 'C--work-alpha' }), null);
  }
  assert.equal(ctx.findAddedProject([null, undefined, a], { folder: 'C--work-alpha' }), a, 'holes in the list are skipped');
});

test('addedProjectHasSessions: only a row that is found and holds sessions', () => {
  const { ctx } = boot();
  const list = [
    { folder: 'new', projectPath: 'C:\\new', sessions: [] },
    { folder: 'old', projectPath: 'C:\\old', sessions: [{ sessionId: 's1' }] },
    { folder: 'odd', projectPath: 'C:\\odd' },
  ];
  assert.equal(ctx.addedProjectHasSessions(list, { folder: 'new' }), false);
  assert.equal(ctx.addedProjectHasSessions(list, { folder: 'old' }), true);
  assert.equal(ctx.addedProjectHasSessions(list, { folder: 'odd' }), false, 'no sessions list is no sessions');
  assert.equal(ctx.addedProjectHasSessions(list, { folder: 'missing' }), false, 'a row that is not in the list has no known sessions');
});

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

test('Add project on a new folder: the list is reloaded, then one session opens in it', async () => {
  const app = boot({
    addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha' },
    afterLoad: [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] }],
    settings: { permissionMode: 'acceptEdits' },
  });
  await app.add('  C:\\work\\alpha  ');
  assert.deepEqual(app.calls.addProject, ['C:\\work\\alpha'], 'the typed path is trimmed');
  assert.deepEqual(app.calls.order, ['add', 'load', 'settings', 'launch']);
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\alpha');
  assert.equal(app.calls.launches[0].options.permissionMode, 'acceptEdits');
});

test('Add project: the session opens under the path the list holds, not the one that was typed', async () => {
  const app = boot({
    addReply: { ok: true, folder: 'c--WORK-alpha', projectPath: 'c:\\WORK\\alpha' },
    afterLoad: [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] }],
  });
  await app.add('c:\\WORK\\alpha');
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\alpha');
});

test('Add project on a folder that is not in the reloaded list still opens a session there', async () => {
  const app = boot({ addReply: { ok: true, folder: 'C--work-new', projectPath: 'C:\\work\\new' }, afterLoad: [] });
  await app.add('C:\\work\\new');
  assert.equal(app.calls.launches.length, 1);
  assert.equal(app.calls.launches[0].project.projectPath, 'C:\\work\\new');
});

test('Add project on a folder that already has sessions only shows it again', async () => {
  const app = boot({
    addReply: { ok: true, folder: 'C--work-old', projectPath: 'C:\\work\\old' },
    afterLoad: [{ folder: 'C--work-old', projectPath: 'C:\\work\\old', sessions: [{ sessionId: 's1', archived: 1 }] }],
  });
  await app.add('C:\\work\\old');
  assert.equal(app.calls.loadProjects, 1);
  assert.equal(app.calls.launches.length, 0, 'a hidden project that was added back keeps to its history');
});

test('Add project that fails, or an empty path, starts nothing', async () => {
  const failed = boot({ addReply: { error: 'Path is not a directory' } });
  const dialog = await failed.add('C:\\work\\file.txt');
  assert.equal(dialog.querySelector('#add-project-error').textContent, 'Path is not a directory');
  assert.equal(failed.calls.loadProjects, 0);
  assert.equal(failed.calls.launches.length, 0);

  const empty = boot({ addReply: { ok: true, folder: 'x', projectPath: 'x' } });
  await empty.add('   ');
  assert.equal(empty.calls.addProject.length, 0);
  assert.equal(empty.calls.launches.length, 0);
});

test('a session that cannot be started does not undo the Add', async () => {
  const app = boot({
    addReply: { ok: true, folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha' },
    afterLoad: [{ folder: 'C--work-alpha', projectPath: 'C:\\work\\alpha', sessions: [] }],
    settings: () => { throw new Error('settings unavailable'); },
  });
  await app.add('C:\\work\\alpha');   // must not reject
  assert.equal(app.calls.loadProjects, 1);
  assert.equal(app.calls.launches.length, 0);
  assert.equal(app.calls.errors.length, 1);
});

test('New project on the Projects tab: a session opens once the project is made, unless a worktree failed', () => {
  const src = fs.readFileSync(PROJECTS_VIEW, 'utf8');
  const start = src.indexOf('async function showNewProjectDialog(');
  assert.ok(start >= 0, 'showNewProjectDialog is defined');
  const body = src.slice(start);
  const made = body.indexOf('window.api.createProject(');
  const loaded = body.indexOf('await loadProjects();', made);
  const failed = body.indexOf('if (result.errors?.length) {', loaded);
  const open = body.indexOf("await openFirstSession(launchTargetFor(created), { runtime: 'claude' });", failed);
  assert.ok(made >= 0 && loaded > made && failed > loaded && open > failed,
    'create, reload, the worktree-errors branch, then the session, in that order');
  // The errors branch leaves before the launch: the session's folder may be a
  // worktree that was not made.
  const branch = body.slice(failed, open);
  assert.match(branch, /alert\(/);
  assert.match(branch, /\n\s*return;\n\s*\}/, 'the worktree-errors branch returns before a session is started');
  assert.match(branch, /const created = findTreeProject\(result\.project\?\.id\);/);
  assert.match(body.slice(open - 40, open), /if \(created\) $/, 'no session without the project in the tree');
});
