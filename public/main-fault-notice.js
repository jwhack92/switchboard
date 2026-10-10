// The corner notice and the status bar chip. This file draws the main process's
// list of faults (main-faults.js) bottom-left in every window, as one notice that
// stays until it is dismissed, and the dismissed ones as a small count in the
// status bar.
//
// It brings its own styles: nothing in style.css is needed for it. A click on the
// notice or on the chip never moves the keyboard: nothing here takes it, and no
// button can be reached with Tab.
//
// test/main-fault-notice.test.js reads the text of this file, comments included,
// for the things it must never contain: a call that moves the keyboard, a key
// listener, the class of the in-page box, and markup written from a text.

(function () {
  'use strict';

  const NOTICE_KINDS = {
    internal: {
      heading: 'Switchboard hit an internal error',
      line: (firstLine) => firstLine,
      buttons: ['Show details', 'Open log folder', 'Dismiss'],
    },
    'stop-stalled': {
      heading: 'A session did not stop',
      line: (firstLine, title) => `${title} was still running 8 seconds after Stop. It takes no typing while that lasts. Press Stop on its row or in its header to try once more.`,
      buttons: ['Dismiss'],
    },
    'stop-failed': {
      heading: 'A session did not stop',
      line: (firstLine, title) => `${title} could not be stopped${firstLine ? ': ' + firstLine : ''}. It is still open and takes no typing. Press Stop again to try once more.`,
      buttons: ['Show details', 'Open log folder', 'Dismiss'],
    },
    'last-run': {
      heading: 'Switchboard did not close normally last time',
      line: () => 'It crashed or was ended from outside (Task Manager, or Windows shutting down).',
      buttons: ['Open log folder', 'Dismiss'],
    },
    pty: {
      heading: 'A terminal reported an error',
      line: (firstLine, title) => (firstLine ? `${title}: ${firstLine}` : title),
      buttons: ['Show details', 'Open log folder', 'Dismiss'],
    },
  };

  const CHIP_TITLE = 'Notices you dismissed. Click to show them.';

  function kindOf(record) {
    return Object.prototype.hasOwnProperty.call(NOTICE_KINDS, record.kind) ? record.kind : 'internal';
  }

  function noticeText(record, title) {
    const kind = kindOf(record);
    const row = NOTICE_KINDS[kind];
    const firstLine = typeof record.firstLine === 'string' ? record.firstLine : '';
    const lines = [];
    const line = row.line(firstLine, title == null ? '' : String(title));
    if (line) lines.push(line);
    if (kind === 'internal' && record.count > 1) lines.push(`Happened ${record.count} times`);
    if (kind === 'last-run' && record.runErrors > 0) {
      lines.push(record.runErrors === 1 ? '1 error was recorded in that run.' : `${record.runErrors} errors were recorded in that run.`);
    }
    return { heading: row.heading, lines, buttons: row.buttons.slice() };
  }

  function rowTitle(sessionId, sessions, clean) {
    const fallback = String(sessionId).slice(0, 8);
    try {
      const row = sessions.get(sessionId);
      if (!row) return fallback;
      const text = row.name || row.aiTitle || row.summary;
      if (!text) return fallback;
      const shown = typeof clean === 'function' ? clean(text) : text;
      return shown ? String(shown) : fallback;
    } catch {
      return fallback;
    }
  }

  const isDismissed = (record) => record.dismissed === true;
  const fromLastRun = (record) => record.previousRun === true || record.kind === 'last-run';
  const asRecords = (records) => (Array.isArray(records) ? records : []).filter((r) => r !== null && typeof r === 'object');

  function chipText(records) {
    const dismissed = asRecords(records).filter(isDismissed);
    if (dismissed.length === 0) return '';
    const count = dismissed.length === 1 ? '1 notice' : `${dismissed.length} notices`;
    return dismissed.every(fromLastRun) ? `${count} · last run` : count;
  }

  const at = (record) => (typeof record.firstAt === 'number' && Number.isFinite(record.firstAt) ? record.firstAt : 0);
  function newestFirst(a, b) {
    if (at(a) !== at(b)) return at(b) - at(a);
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }

  function noticeModel(records, ui, titleOf) {
    const list = asRecords(records).slice().sort(newestFirst);
    const state = ui || {};
    const chip = chipText(list);
    const dismissed = list.filter(isDismissed);
    const open = list.filter((r) => !isDismissed(r));
    let record = null;
    let more = '';
    let fromChip = false;
    if (state.chipOpen && dismissed.length > 0) {
      const index = Number.isInteger(state.chipIndex) && state.chipIndex > 0 ? state.chipIndex : 0;
      record = dismissed[index % dismissed.length];
      fromChip = true;
    } else if (open.length > 0) {
      record = open[0];
      more = open.length > 1 ? `+${open.length - 1} more` : '';
    }
    if (!record) return { chip, panel: null };
    const hasSession = typeof record.sessionId === 'string' && record.sessionId !== '';
    const title = hasSession && typeof titleOf === 'function' ? titleOf(record.sessionId) : '';
    const text = noticeText(record, title);
    let buttons = text.buttons;
    if (fromChip) {
      buttons = buttons.flatMap((b) => (b === 'Dismiss' ? (dismissed.length > 1 ? ['Next', 'Clear'] : ['Clear']) : [b]));
    }
    let details = null;
    if (state.detailsFor === record.id && buttons.includes('Show details')) {
      details = record.stack || record.firstLine;
      const copyLabel = state.copyLabel || 'Copy';
      buttons = buttons.flatMap((b) => (b === 'Show details' ? [copyLabel, 'Hide details'] : [b]));
    }
    return { chip, panel: { id: record.id, heading: text.heading, lines: text.lines, more, details, buttons } };
  }

  function noticeWidth(sidebarWidth, collapsed) {
    if (collapsed || typeof sidebarWidth !== 'number' || !(sidebarWidth > 0)) return 320;
    return Math.min(420, sidebarWidth - 24);
  }

  const NOTICE_LAYER = 98000;

  const NOTICE_STYLES = `
#main-fault-notice {
  position: fixed; left: 12px; bottom: 32px; z-index: ${NOTICE_LAYER};
  box-sizing: border-box; padding: 12px 14px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #e8e8ea; background: #22232a;
  border: 1px solid rgba(255,255,255,0.14); border-left: 3px solid #ffd166; border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.5);
}
#main-fault-notice .mfn-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
#main-fault-notice .mfn-line { margin: 0 0 8px; color: #a9abb5; word-break: break-all; }
#main-fault-notice .mfn-details {
  max-height: 40vh; overflow: auto; margin: 0 0 8px;
  font-family: monospace; white-space: pre-wrap; word-break: break-all;
}
#main-fault-notice .mfn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
#main-fault-notice .mfn-more { color: #a9abb5; }
#main-fault-notice button {
  font: inherit; padding: 5px 10px; cursor: pointer;
  color: #e8e8ea; background: #32343d;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
}
#main-fault-notice button:hover { background: #3c3f4a; }
#status-bar-notices {
  font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 2px;
  color: #ffd166; border: 1px solid rgba(255,209,102,0.6); background: rgba(255,209,102,0.14);
  white-space: nowrap; cursor: pointer;
}
`;

  const COPY_LABELS = ['Copy', 'Copied', 'Not copied'];
  const isRecord = (value) => value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id !== '';

  let drawMounted = null;

  function mount(env) {
    const document = env.document;
    const main = env.api || {};
    const titleOf = env.titleOf;
    const later = env.setTimeout;
    const cancel = env.clearTimeout;
    const records = new Map();
    const delivered = new Set();
    const cleared = new Set();
    const ui = { chipOpen: false, chipIndex: 0, detailsFor: null, copyLabel: 'Copy' };
    let shownId = null;
    let copyTimer = null;
    let copyTurn = 0;

    function noTab(el) { el.setAttribute('tabindex', '-1'); }

    function makeButton(label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      noTab(button);
      button.addEventListener('click', onClick);
      return button;
    }

    function part(tag, className, text) {
      const el = document.createElement(tag);
      el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }

    function call(name, ...args) {
      try {
        if (typeof main[name] !== 'function') return;
        const answer = main[name](...args);
        if (answer && typeof answer.then === 'function') answer.then(undefined, () => {});
      } catch {}
    }

    function stopCopyTimer() {
      if (copyTimer !== null) {
        try { cancel(copyTimer); } catch {}
        copyTimer = null;
      }
    }

    function resetCopy() {
      copyTurn++;
      ui.copyLabel = 'Copy';
      stopCopyTimer();
    }

    const style = document.createElement('style');
    style.textContent = NOTICE_STYLES;
    document.head.appendChild(style);

    const notice = part('div', '');
    notice.id = 'main-fault-notice';
    notice.style.display = 'none';
    notice.addEventListener('mousedown', (event) => event.preventDefault());
    document.body.appendChild(notice);

    let chip = null;
    const info = document.getElementById('status-bar-info');
    if (info) {
      chip = part('span', '');
      chip.id = 'status-bar-notices';
      chip.title = CHIP_TITLE;
      chip.style.display = 'none';
      chip.addEventListener('mousedown', (event) => event.preventDefault());
      chip.addEventListener('click', () => {
        ui.chipOpen = !ui.chipOpen;
        ui.chipIndex = 0;
        ui.detailsFor = null;
        resetCopy();
        draw();
      });
      info.insertAdjacentElement('afterend', chip);
    }

    function sizeNotice() {
      const sidebar = document.getElementById('sidebar');
      const width = sidebar ? sidebar.getBoundingClientRect().width : NaN;
      const collapsed = sidebar ? sidebar.classList.contains('collapsed') : true;
      notice.style.width = noticeWidth(width, collapsed) + 'px';
    }

    function copy(id, details) {
      stopCopyTimer();
      const turn = ++copyTurn;
      const settle = (ok) => {
        if (turn !== copyTurn || shownId !== id || ui.detailsFor !== id) return;
        ui.copyLabel = ok ? 'Copied' : 'Not copied';
        copyTimer = later(() => {
          copyTimer = null;
          resetCopy();
          draw();
        }, 2000);
        draw();
      };
      if (typeof main.writeClipboard !== 'function') { settle(false); return; }
      let answer;
      try {
        answer = main.writeClipboard(details);
      } catch {
        settle(false);
        return;
      }
      Promise.resolve(answer).then(() => settle(true), () => settle(false));
    }

    function press(label, panel) {
      const id = panel.id;
      if (label === 'Show details') {
        ui.detailsFor = id;
      } else if (label === 'Hide details') {
        ui.detailsFor = null;
        resetCopy();
      } else if (label === 'Open log folder') {
        call('openMainLog');
      } else if (label === 'Dismiss') {
        call('dismissMainFault', id);
      } else if (label === 'Clear') {
        call('clearMainFault', id);
      } else if (label === 'Next') {
        ui.chipIndex += 1;
        ui.detailsFor = null;
        resetCopy();
      } else if (COPY_LABELS.includes(label)) {
        copy(id, panel.details);
      }
      draw();
    }

    function draw() {
      const list = [...records.values()];
      if (ui.chipOpen && !list.some(isDismissed)) ui.chipOpen = false;
      let model = noticeModel(list, ui, titleOf);
      const id = model.panel ? model.panel.id : null;
      if (id !== shownId) {
        shownId = id;
        resetCopy();
        model = noticeModel(list, ui, titleOf);
      }
      sizeNotice();
      if (chip) {
        chip.textContent = model.chip;
        chip.style.display = model.chip === '' ? 'none' : '';
      }
      const panel = model.panel;
      if (!panel) {
        notice.replaceChildren();
        notice.style.display = 'none';
        return;
      }
      const kids = [part('div', 'mfn-heading', panel.heading)];
      for (const line of panel.lines) kids.push(part('div', 'mfn-line', line));
      if (panel.details !== null) {
        const box = part('div', 'mfn-details', panel.details);
        noTab(box);
        kids.push(box);
      }
      const actions = part('div', 'mfn-actions');
      for (const label of panel.buttons) actions.appendChild(makeButton(label, () => press(label, panel)));
      if (panel.more) actions.appendChild(part('span', 'mfn-more', panel.more));
      kids.push(actions);
      notice.replaceChildren(...kids);
      notice.style.display = '';
    }

    function take(event) {
      if (!isRecord(event)) return;
      delivered.add(event.id);
      if (event.cleared === true) {
        records.delete(event.id);
        cleared.add(event.id);
        return;
      }
      if (cleared.has(event.id)) return;
      const before = records.get(event.id);
      if (event.dismissed !== true && (!before || before.dismissed === true)) ui.chipOpen = false;
      records.set(event.id, { ...event });
    }

    function takeList(answer) {
      if (!Array.isArray(answer)) return;
      for (const record of answer) {
        if (isRecord(record) && !delivered.has(record.id) && !cleared.has(record.id)) records.set(record.id, { ...record });
      }
    }

    draw();
    drawMounted = draw;

    if (typeof env.ResizeObserver === 'function') {
      try {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) new env.ResizeObserver(() => { try { draw(); } catch {} }).observe(sidebar);
      } catch {}
    }

    if (typeof main.onMainFault === 'function') {
      try {
        main.onMainFault((event) => {
          try {
            take(event);
            draw();
          } catch {}
        });
      } catch {}
    }

    if (typeof main.getMainFaults === 'function') {
      try {
        Promise.resolve(main.getMainFaults()).then((answer) => {
          try {
            takeList(answer);
            draw();
          } catch {}
        }, () => {});
      } catch {}
    }
  }

  function redraw() {
    try {
      if (drawMounted) drawMounted();
    } catch {}
  }

  const api = {
    NOTICE_LAYER, NOTICE_STYLES, CHIP_TITLE, NOTICE_KINDS,
    noticeText, chipText, noticeModel, noticeWidth, rowTitle, mount, redraw,
  };

  if (typeof window !== 'undefined') window.MainFaultNotice = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') {
    mount({
      document,
      api: (typeof window !== 'undefined' && window.api) || {},
      setTimeout,
      clearTimeout,
      ResizeObserver: typeof ResizeObserver === 'function' ? ResizeObserver : null,
      titleOf: (id) => {
        try {
          return rowTitle(id,
            typeof sessionMap !== 'undefined' ? sessionMap : undefined,
            typeof cleanDisplayName !== 'undefined' ? cleanDisplayName : undefined);
        } catch {
          return String(id).slice(0, 8);
        }
      },
    });
  }
})();
