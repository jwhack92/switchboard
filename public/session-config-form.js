// The same settings form is mounted by New Session and Create/Edit Schedule.
//
// FORK NOTE — one CLI. Upstream's copy carries a second subsystem for Codex:
// a model catalog fetched over IPC (`api.getCodexModels`), a `catalog` field
// flag, a `modelField` back-reference, per-model disabling of reasoning-effort
// options and a `.session-config-note` that explains a silently-reset choice.
// All of it exists only because Codex's efforts depend on the chosen model.
// Claude's do not — harnesses/claude.js:339 accepts one fixed set — so the
// whole block is gone rather than left as a dead runtime parameter.
//
// What stays runtime-agnostic: this file reads nothing but the field registry.
// Every branch below keys off a field's `type`/`more`/`wide`/`suggestions`, not
// off which CLI is in play, and `runtime` is passed straight through to
// SessionConfig. A second CLI is a new key in SessionConfig.FIELDS, not a
// change here.
(function (root) {
  let mounts = 0;
  function mount(container, { runtime, defaults = {}, overrides = {}, inherit = false, onChange = () => {} }) {
    const uid = ++mounts;
    let saved = SessionConfig.normalizeOverrides(runtime, overrides);
    let values = SessionConfig.resolveOptions(runtime, defaults, saved);
    const fields = SessionConfig.fieldsFor(runtime).filter(f => !f.hidden);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const listId = field => `session-config-${uid}-${field.key}`;
    const keys = field => field.type === 'permission' ? [field.key, 'dangerouslySkipPermissions'] : [field.key];
    function permissionButtons(field) {
      return field.choices.map(c => `<button type="button" class="permission-option${!values.dangerouslySkipPermissions && values[field.key] === c.value ? ' selected' : ''}" data-permission="${esc(c.value ?? '')}"><span class="perm-name">${esc(c.label)}</span><span class="perm-desc">${esc(c.desc)}</span></button>`).join('') +
        `<button type="button" class="permission-option dangerous${values.dangerouslySkipPermissions ? ' selected' : ''}" data-permission="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all permission prompts</span></button>`;
    }
    function control(field) {
      const value = values[field.key];
      if (field.type === 'permission') return `<div class="permission-grid">${permissionButtons(field)}</div>`;
      if (field.type === 'boolean') return `<label class="settings-toggle"><input type="checkbox" data-config-input ${value ? 'checked' : ''} aria-label="${esc(field.label)}"><span class="settings-toggle-slider"></span></label>`;
      if (field.type === 'select') return `<select class="settings-select" data-config-input aria-label="${esc(field.label)}">${field.choices.map(c => `<option value="${esc(c.value)}" ${c.value === value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
      if (field.type === 'textarea') return `<textarea class="settings-input" rows="3" data-config-input aria-label="${esc(field.label)}">${esc(value)}</textarea>`;
      // Suggestions offer known names without limiting the field to them.
      const suggest = field.suggestions;
      return `<input type="text" class="settings-input" data-config-input aria-label="${esc(field.label)}" placeholder="${esc(field.placeholder || '')}" value="${esc(value)}"${suggest ? ` list="${listId(field)}"` : ''}>` +
        (suggest ? `<datalist id="${listId(field)}">${suggest.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>` : '');
    }
    const fieldRow = field => `<div class="settings-field${field.wide || field.type === 'permission' ? ' settings-field-wide' : ''}" data-config-field="${field.key}">
      <div class="settings-field-info"><span class="settings-label">${esc(field.label)}</span>${field.description ? `<div class="settings-description">${esc(field.description)}</div>` : ''}${inherit ? '<div class="session-config-inheritance"></div>' : ''}</div>
      <div class="settings-field-control">${control(field)}</div></div>`;
    // Optional settings without a value wait behind "More options". Revealing
    // them is one-way, so a field typed into can never be tucked away again.
    const behindMore = new Set(SessionConfig.fieldsBehindMore(runtime, values));
    const tucked = fields.filter(f => behindMore.has(f.key));
    container.innerHTML = fields.filter(f => !behindMore.has(f.key)).map(fieldRow).join('') + (tucked.length
      ? `<button type="button" class="session-config-more-toggle"><span class="session-config-more-label">More options</span><span class="session-config-more-names">${esc(tucked.map(f => f.label).join(', '))}</span></button>` +
        `<div class="session-config-more" hidden>${tucked.map(fieldRow).join('')}</div>`
      : '');
    const moreToggle = container.querySelector('.session-config-more-toggle');
    if (moreToggle) moreToggle.onclick = () => {
      container.querySelector('.session-config-more').hidden = false;
      moreToggle.remove();
    };
    function inheritance(row, field) {
      if (!inherit) return;
      const custom = keys(field).some(key => SessionConfig.own(saved, key));
      row.querySelector('.session-config-inheritance').innerHTML = custom
        ? '<button type="button" class="session-config-reset">Use folder default</button>' : '<span>Folder default</span>';
    }
    for (const field of fields) {
      const row = container.querySelector(`[data-config-field="${field.key}"]`);
      inheritance(row, field);
      const changed = () => { inheritance(row, field); onChange({ ...saved }); };
      row.addEventListener('click', e => {
        if (e.target.closest('.session-config-reset')) {
          for (const key of keys(field)) delete saved[key];
          values = SessionConfig.resolveOptions(runtime, defaults, saved);
          const input = row.querySelector('[data-config-input]');
          if (field.type === 'permission') row.querySelector('.permission-grid').innerHTML = permissionButtons(field);
          else if (field.type === 'boolean') input.checked = values[field.key];
          else input.value = values[field.key];
          changed();
          return;
        }
        const button = e.target.closest('[data-permission]');
        if (!button) return;
        const mode = button.dataset.permission;
        saved.dangerouslySkipPermissions = mode === 'dangerous-skip' && !values.dangerouslySkipPermissions;
        saved.permissionMode = mode === 'dangerous-skip' ? null : mode || null;
        values = SessionConfig.resolveOptions(runtime, defaults, saved);
        row.querySelector('.permission-grid').innerHTML = permissionButtons(field);
        changed();
      });
      const input = row.querySelector('[data-config-input]');
      if (input) input.addEventListener('input', () => {
        saved[field.key] = field.type === 'boolean' ? input.checked : input.value;
        values[field.key] = saved[field.key];
        changed();
      });
    }
    return {
      // What the user explicitly set — for storing on a schedule or a folder.
      getOverrides: () => SessionConfig.normalizeOverrides(runtime, saved),
      // Every field resolved against the defaults — for launching. Both can
      // throw on invalid input; callers render the message rather than launch.
      getOptions: () => SessionConfig.resolveOptions(runtime, defaults, saved),
    };
  }
  root.SessionConfigForm = { mount };
})(window);
