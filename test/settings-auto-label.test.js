const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Task L, part e: the Settings panel's Shell Profile option for "auto" names the
// shell Auto picks, and the two descriptions say what the launch now does.
// public/settings-panel.js runs whole in a vm context against a fake window and
// document, so what is tested is the text that ships.

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings-panel.js'), 'utf8');

const PRE_LAUNCH_TEXT = 'Prepended to the claude command (e.g. "aws-vault exec profile --"). On Windows it runs in Git Bash unless the project picks another shell.';
const SHELL_TEXT = 'Shell for plain terminals, shell tasks and pre-launch commands. On Windows, Claude sessions start claude.exe directly, and PowerShell profiles are not loaded.';

async function renderPanel(profiles) {
  const fakeEl = () => ({
    style: {},
    textContent: '',
    innerHTML: '',
    addEventListener() {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  });
  const body = fakeEl();
  const elements = { 'settings-viewer-body': body };
  const window = {
    api: {
      getSetting: async () => ({}),
      getSettingDefaults: async () => ({}),
      getShellProfiles: async () => profiles,
      getAppVersion: async () => '0.0.0',
      onUpdaterEvent() {},
      updaterCheck() {},
    },
  };
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => elements[id] || (elements[id] = fakeEl()) },
    escapeHtml: (s) => String(s),
    shortProjectPath: (p) => String(p),
    TERMINAL_THEMES: {},
    PERMISSION_MODES: [],
    sessionStorage: { getItem: () => null },
  });
  vm.runInContext(SOURCE, context, { filename: 'public/settings-panel.js' });
  await window.openSettingsViewer('global');
  return body.innerHTML;
}

test('settings-auto-label: the Auto option reads "Auto (PowerShell 7)" when a profile has autoPick', async () => {
  const html = await renderPanel([
    { id: 'git-bash', name: 'Git Bash', path: 'C:\\Git\\bin\\bash.exe' },
    { id: 'pwsh', name: 'PowerShell 7', path: 'C:\\pwsh.exe', autoPick: true },
  ]);
  assert.match(html, /<option value="auto"[^>]*>Auto \(PowerShell 7\)<\/option>/);
  assert.doesNotMatch(html, /Auto \(detect\)/);
});

test('settings-auto-label: the Auto option reads "Auto (detect)" when no profile has autoPick', async () => {
  const html = await renderPanel([
    { id: 'bash', name: 'bash', path: '/bin/bash' },
    { id: 'zsh', name: 'zsh', path: '/bin/zsh' },
  ]);
  assert.match(html, /<option value="auto"[^>]*>Auto \(detect\)<\/option>/);
  assert.doesNotMatch(html, /Auto \(PowerShell 7\)/);
});

test('settings-auto-label: the Pre-launch and Shell Profile descriptions hold the new strings exactly', async () => {
  const html = await renderPanel([]);
  assert.ok(html.includes(`<div class="settings-description">${PRE_LAUNCH_TEXT}</div>`), 'pre-launch description');
  assert.ok(html.includes(`<div class="settings-description">${SHELL_TEXT}</div>`), 'shell profile description');
});
