// Clickable file paths in terminal output, for the references a CLI prints as
// plain text rather than as an OSC 8 hyperlink.
//
// Everything here works on xterm's buffer cells and never rewrites the PTY
// stream: the text on screen is exactly what the program wrote, and a link is
// only a range of cells laid over it.
//
// Nothing is opened on the strength of the text alone. `resolve` (the main
// process, terminal-file-links.js) parses each candidate and stats it, so a
// path that does not exist is never underlined and never clicked open. That
// also means detection can afford to be generous: a false positive costs one
// stat, not a wrong file.
(function (root) {
  function looksLikeFile(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return false;
    // No session-directory inference: only absolute paths, home paths and
    // explicit local/editor URIs. The main process validates the target.
    return /^(?:\/(?![/\\])|~[/\\]|[a-z]:[/\\]|(?:file|vscode|vscode-insiders|cursor|windsurf):\/\/)/i.test(value);
  }

  function findFileReferences(text) {
    const references = [];
    const occupied = [];
    const add = (value, start, quoted = false) => {
      if (!quoted) {
        const leading = value.match(/^[([{*]+/)?.[0].length || 0;
        value = value.slice(leading); start += leading;
        value = value.replace(/[.,;:!?*]+$/, '');
        for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
          while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
        }
      }
      if (looksLikeFile(value)) references.push({ reference: value, start, end: start + value.length });
    };
    // A Markdown link is matched first so a target containing spaces survives
    // and its label is not read as a second path.
    const markdown = /\[[^\]\r\n]*\]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;
    for (const match of text.matchAll(markdown)) {
      const target = match[1];
      const start = match.index + match[0].indexOf('](') + 2;
      occupied.push([match.index, match.index + match[0].length]);
      add(target.startsWith('<') ? target.slice(1, -1) : target, start + (target.startsWith('<') ? 1 : 0), true);
    }
    const tokens = /(?<![\p{L}\p{N}])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|<([^<>\r\n]+)>)|[^\s"'`<>]+/gu;
    for (const match of text.matchAll(tokens)) {
      if (occupied.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
      const quoted = match.slice(1).find(value => value !== undefined);
      add(quoted ?? match[0], match.index + (quoted !== undefined ? 1 : 0), quoted !== undefined);
    }
    return references.sort((a, b) => a.start - b.start).slice(0, 32);
  }

  // Rebuild the logical (pre-wrap) line that row `y` belongs to, plus the cell
  // each character occupies, so a match's range can be expressed in display
  // cells — which is not the same as string indices once wide or combining
  // characters are involved.
  function logicalLine(terminal, y) {
    const buffer = terminal.buffer.active;
    let first = y - 1;
    if (!buffer.getLine(first)) return null;
    while (first > 0 && y - first <= 16 && buffer.getLine(first)?.isWrapped) first--;
    const positions = [];
    let text = '';
    const cell = buffer.getNullCell();
    for (let row = first; row < buffer.length && row < first + 32 && text.length < 8192; row++) {
      const line = buffer.getLine(row);
      if (!line || (row > first && !line.isWrapped)) break;
      const next = buffer.getLine(row + 1);
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (!width) continue;
        const chars = cell.getChars();
        // A wide character can wrap early, leaving a padding cell behind.
        if (!chars && x === line.length - 1 && next?.isWrapped && next.getCell(0)?.getWidth() === 2) continue;
        const value = chars || ' ';
        const position = { start: { x: x + 1, y: row + 1 }, end: { x: x + width, y: row + 1 } };
        for (let i = 0; i < value.length; i++) positions.push(position);
        text += value;
      }
    }
    return { text, positions, first, cols: terminal.cols, buffer };
  }

  // An xterm link provider for paths in the buffer. `resolve` is async, so the
  // line is re-read once it answers: output that has already been replaced must
  // not get a link pointing at what used to be there.
  function createFileLinkProvider(terminal, { getSession, resolve, openFile, showTooltip = () => {}, hideTooltip = () => {} }) {
    const cache = new Map();
    let disposed = false;
    return {
      dispose() { disposed = true; cache.clear(); hideTooltip(); },
      async provideLinks(y, callback) {
        if (disposed) { callback([]); return; }
        const context = logicalLine(terminal, y);
        if (!context || disposed) { callback([]); return; }
        const matches = findFileReferences(context.text).filter(match =>
          context.positions[match.start]?.start.y <= y && context.positions[match.end - 1]?.end.y >= y);
        const key = JSON.stringify(matches.map(match => match.reference));
        let cached = cache.get(key);
        if (!cached || cached.until < Date.now()) {
          const promise = matches.length ? Promise.resolve().then(() => resolve(matches.map(match => match.reference))).catch(() => []) : Promise.resolve([]);
          cached = { promise, until: Date.now() + 1500 };
          cache.set(key, cached);
          if (cache.size > 128) cache.delete(cache.keys().next().value);
        }
        const targets = await cached.promise;
        if (disposed) { callback([]); return; }
        const current = logicalLine(terminal, y);
        if (disposed || !current || current.text !== context.text ||
            current.first !== context.first || current.cols !== context.cols || current.buffer !== context.buffer) { callback([]); return; }
        callback(matches.flatMap((match, index) => {
          const target = targets?.[index];
          if (!target?.filePath) return [];
          return [{ text: match.reference,
            range: { start: context.positions[match.start].start, end: context.positions[match.end - 1].end },
            // The session is read at click time, not at creation: a session's
            // id is replaced once the real one is detected and again on a fork
            // (public/app.js rekeying). The third argument carries line/column;
            // an opener that ignores it just opens the file at the top.
            activate: () => { hideTooltip(); return openFile(getSession().sessionId, target.filePath, target); },
            hover: event => showTooltip(event, formatTarget(target)),
            leave: hideTooltip,
            dispose: hideTooltip,
          }];
        }));
      },
    };
  }

  function formatTarget(target) {
    return target.filePath + (target.line ? `:${target.line}${target.column ? ':' + target.column : ''}` : '');
  }

  // The counterpart for links the program marks up itself (OSC 8) and for web
  // links: xterm hands over a URI, and the same validation decides whether it
  // opens a local file, opens externally, or does nothing at all.
  function createLinkHandler({ getSession, resolve, openFile, openExternal, showTooltip, hideTooltip }) {
    let generation = 0;
    let disposed = false;
    let hovered = null;
    const cache = new Map();
    const targetFor = uri => {
      if (/^https?:\/\//i.test(uri)) return Promise.resolve({ url: uri });
      if (!looksLikeFile(uri)) return Promise.resolve(null);
      let cached = cache.get(uri);
      if (!cached || cached.until < Date.now()) {
        cached = { until: Date.now() + 1500,
          promise: Promise.resolve().then(() => resolve([uri])).then(targets => targets?.[0] || null).catch(() => null) };
        cache.set(uri, cached);
        if (cache.size > 64) cache.delete(cache.keys().next().value);
      }
      return cached.promise;
    };
    const leave = () => { generation++; hovered = null; hideTooltip(); };
    return {
      async activate(_event, uri) {
        if (disposed) return;
        // Use the same target that was shown on hover, including its location.
        const targetPromise = hovered?.uri === uri ? hovered.promise : targetFor(uri);
        leave();
        const target = await targetPromise;
        if (disposed || !target) return;
        if (target.url) await openExternal(target.url);
        else if (target.filePath) await openFile(getSession().sessionId, target.filePath, target);
      },
      async hover(event, uri) {
        leave();
        if (disposed) return;
        const version = generation;
        const promise = targetFor(uri);
        hovered = { uri, promise };
        const target = await promise;
        if (disposed || version !== generation) return;
        if (target) showTooltip(event, target.url || formatTarget(target));
        else if (looksLikeFile(uri)) showTooltip(event, `File unavailable: ${uri}`);
      },
      leave,
      dispose() { disposed = true; leave(); cache.clear(); },
    };
  }

  // A tooltip showing the full destination. It is positioned in viewport
  // coordinates, so it needs `.terminal-link-tooltip { position: fixed }` from
  // the stylesheet; without that rule it would lay itself out inside the
  // terminal instead of floating over it.
  function createTooltip(container) {
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    let element = null;
    let disposed = false;
    const hide = () => { element?.remove(); element = null; };
    return {
      show(event, text) {
        hide();
        if (disposed || !container.isConnected) return;
        element = doc.createElement('div');
        element.className = 'xterm-hover terminal-link-tooltip';
        element.setAttribute('role', 'tooltip');
        element.textContent = text;
        element.style.left = '0px';
        element.style.top = '0px';
        (container.querySelector('.xterm') || container).appendChild(element);
        const rect = element.getBoundingClientRect();
        const x = Math.max(8, Math.min(event.clientX + 12, view.innerWidth - rect.width - 8));
        let y = event.clientY + 20;
        if (y + rect.height > view.innerHeight - 8) y = event.clientY - rect.height - 12;
        element.style.left = `${x}px`;
        element.style.top = `${Math.max(8, y)}px`;
      },
      hide,
      dispose() { disposed = true; hide(); },
    };
  }

  const api = { findFileReferences, logicalLine, createFileLinkProvider, createLinkHandler, createTooltip, formatTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TerminalFileLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
