// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = sessionStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};
    // The app's real defaults. Every fallback below comes from here so the panel
    // can never show a value the app would not itself have used — the literals
    // that used to be inline had already drifted (visibleSessionCount was 10
    // here and 5 in main.js).
    let appDefaults = {};
    try {
      if (typeof window.api.getSettingDefaults === 'function') {
        appDefaults = (await window.api.getSettingDefaults()) || {};
      }
    } catch { appDefaults = {}; }

    const shortName = isProject
      ? shortProjectPath(projectPath)
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName, fallback) {
      const base = appDefaults[fieldName] !== undefined ? appDefaults[fieldName] : fallback;
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : base;
      }
      return current[fieldName] !== undefined ? current[fieldName] : base;
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    // Sentinel for the --dangerously-skip-permissions option in the Permission
    // Mode picker. Not a real permission mode: it maps to its own claude flag.
    const DANGEROUS_SKIP = '__dangerous_skip__';
    const dangerSkipValue = fieldValue('dangerouslySkipPermissions', false);
    const permModeValue = dangerSkipValue
      ? DANGEROUS_SKIP
      : fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    // Fall back to the theme that is actually rendering, not a hardcoded name.
    // With a literal here, the dropdown could show a different theme than the
    // terminal was using, and saving any unrelated setting would silently
    // switch the user's theme out from under them.
    const themeValue = fieldValue('terminalTheme',
      typeof currentThemeName === 'string' ? currentThemeName : 'switchboard');
    const uiScaleValue = fieldValue('uiScale', 1);
    const projectBaseValue = fieldValue('projectBaseDir', '');
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    const speakRepliesValue = fieldValue('speakReplies', 'focused');
    const speakAlertsValue = fieldValue('speakAlerts', true);
    const speechVoiceValue = fieldValue('speechVoice', '');
    const speechRateValue = fieldValue('speechRate', 1);
    const speechWindowValue = fieldValue('speechWindowSec', 30);

    // What the form is about to be rendered with. Compared against the form's
    // contents on save so an untouched field is not written out as an explicit
    // override. permissionMode is paired with dangerouslySkipPermissions here
    // because the two are one control in the UI.
    const renderedValues = {
      dangerouslySkipPermissions: dangerSkipValue,
      permissionMode: dangerSkipValue ? null : (permModeValue || null),
      worktree: worktreeValue,
      worktreeName: worktreeNameValue,
      chrome: chromeValue,
      preLaunchCmd: preLaunchValue,
      addDirs: addDirsValue,
      visibleSessionCount: visCountValue,
      sessionMaxAgeDays: maxAgeValue,
      terminalTheme: themeValue,
      uiScale: uiScaleValue,
      projectBaseDir: projectBaseValue,
      mcpEmulation: mcpEmulationValue,
      shellProfile: shellProfileValue,
      speakReplies: speakRepliesValue,
      speakAlerts: speakAlertsValue,
      speechVoice: speechVoiceValue,
      speechRate: speechRateValue,
      speechWindowSec: speechWindowValue,
    };
    // min/max on a number input is advisory only, and the other read-backs in
    // this file do no clamping, so an out-of-range value would be stored.
    const clampNum = (n, lo, hi, fallback) =>
      (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback);
    const unchanged = (a, b) =>
      a === b || (a == null && b == null) || String(a) === String(b);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};
    // Chromium fills the voice list about a second after load, so ask the engine
    // rather than reading getVoices() directly here.
    let speechVoices = [];
    try { if (window.tts) speechVoices = await window.tts.loadVoices(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Default (none)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
              <option value="${DANGEROUS_SKIP}" ${permModeValue === DANGEROUS_SKIP ? 'selected' : ''}>Dangerous Skip (--dangerously-skip-permissions)</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">New project folder</span>
            <div class="settings-description">Where "Add project" opens. You can create a new
              folder from inside the picker. Leave empty to reopen wherever you last added
              a project from.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-project-base"
                   placeholder="remember last used"
                   value="${escapeHtml(String(projectBaseValue || ''))}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Text size</span>
            <div class="settings-description">Scales the whole interface. Bigger text is
              measurably easier to read, and the best size differs enough between people
              that it is worth trying a step up from whatever looks normal.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-ui-scale">
              ${[['0.9', 'Small (90%)'], ['1', 'Default (100%)'], ['1.1', 'Large (110%)'],
                 ['1.2', 'Larger (120%)'], ['1.35', 'Largest (135%)']]
                .map(([v, l]) => `<option value="${v}" ${String(uiScaleValue) === v ? 'selected' : ''}>${l}</option>`)
                .join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Speak Replies</span>
            <div class="settings-description">Read the focused session's reply aloud when it finishes a turn. Long replies are summarised to fit the window below.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-speak-replies">
              <option value="off"${speakRepliesValue === 'off' ? ' selected' : ''}>Off</option>
              <option value="focused"${speakRepliesValue === 'focused' ? ' selected' : ''}>Focused session</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Speak Alerts</span>
            <div class="settings-description">Announce background sessions that finish or need your input</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-speak-alerts"${speakAlertsValue ? ' checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Voice</span>
            <div class="settings-description">${speechVoices.length ? 'Windows voices available to this build' : 'No voices detected — speech will be unavailable'}</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-speech-voice">
              <option value=""${!speechVoiceValue ? ' selected' : ''}>System default</option>
              ${speechVoices.map(v => `<option value="${escapeHtml(v.name)}"${speechVoiceValue === v.name ? ' selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Speech Rate</span>
            <div class="settings-description">1 is normal. Higher is faster; 0.5 to 3 allowed.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-speech-rate" min="0.5" max="3" step="0.1" value="${speechRateValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Spoken Window (seconds)</span>
            <div class="settings-description">How long a spoken reply may run before it is summarised instead. A typical reply is about 90 seconds read in full.</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-speech-window" min="5" max="300" value="${speechWindowValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
      </div>
    </div>
  `;

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
        // permissionMode and dangerouslySkipPermissions are one choice in the
        // UI and mutually exclusive in main.js, so write them together.
        const pmCb = settingsViewerBody.querySelector('.use-global-cb[data-field="permissionMode"]');
        if (pmCb && !pmCb.checked) {
          const pm = settingsViewerBody.querySelector('#sv-perm-mode').value;
          settings.dangerouslySkipPermissions = pm === DANGEROUS_SKIP;
          settings.permissionMode = pm === DANGEROUS_SKIP ? null : (pm || null);
        }
      } else {
        const pm = settingsViewerBody.querySelector('#sv-perm-mode').value;
        settings.dangerouslySkipPermissions = pm === DANGEROUS_SKIP;
        settings.permissionMode = pm === DANGEROUS_SKIP ? null : (pm || null);
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.uiScale = parseFloat(settingsViewerBody.querySelector('#sv-ui-scale').value) || 1;
        settings.projectBaseDir = settingsViewerBody.querySelector('#sv-project-base').value.trim();
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        settings.speakReplies = settingsViewerBody.querySelector('#sv-speak-replies').value || 'off';
        settings.speakAlerts = settingsViewerBody.querySelector('#sv-speak-alerts').checked;
        settings.speechVoice = settingsViewerBody.querySelector('#sv-speech-voice').value || '';
        settings.speechRate = clampNum(parseFloat(settingsViewerBody.querySelector('#sv-speech-rate').value), 0.5, 3, 1);
        settings.speechWindowSec = clampNum(parseInt(settingsViewerBody.querySelector('#sv-speech-window').value), 5, 300, 30);
      }

      // An absent setting means "use the app default". Writing every field on
      // every Save turned that into a permanent explicit override for settings
      // the user never chose — which is how dangerouslySkipPermissions ended up
      // pinned to false. Keep only fields that were already stored or actually
      // edited, so a Save with no changes is a real no-op.
      if (!isProject) {
        for (const key of Object.keys(settings)) {
          if (current[key] === undefined && unchanged(settings[key], renderedValues[key])) {
            delete settings[key];
          }
        }
      }

      // Merge inside a transaction rather than read-modify-write out here.
      // The old sequence (getSetting -> spread -> setSetting) drops any key a
      // second window wrote in between, which is how a tightened setting could
      // silently revert to its default.
      if (typeof window.api.mergeSetting === 'function') {
        await window.api.mergeSetting(settingsKey, settings);
      } else {
        if (!isProject) {
          const existing = (await window.api.getSetting('global')) || {};
          settings = { ...existing, ...settings };
        }
        await window.api.setSetting(settingsKey, settings);
      }

      // Apply immediately — a size control whose effect you cannot see is
      // useless for finding your own optimum.
      if (!isProject && settings.uiScale && typeof window.api.setZoomFactor === 'function') {
        window.api.setZoomFactor(settings.uiScale);
      }

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== undefined
          && settings.mcpEmulation !== mcpEmulationValue) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      closeSettingsViewer();
    });

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
          case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
