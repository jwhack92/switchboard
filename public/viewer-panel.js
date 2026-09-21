/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown files
 *   - Wrap: always shown (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * Depends on: viewer-toolbar.js, codemirror-bundle.js, markdown-sanitize.js
 */

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._saving = false;

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      gotoLine: true,
      save: !!opts.onSave,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Create preview area. Used for the rendered markdown AND for the JSON
    // reader tree — both are "the other way to look at this text", and they
    // are mutually exclusive because a file is one or the other.
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Anything that is not text at all: an image, a PDF, a sandboxed HTML
    // render, or the placeholder for a real file that cannot be previewed.
    // main.js's read-file-for-panel now answers with these shapes
    // (project-files.js readPreviewFile), so without this branch an image
    // opens as an empty editor.
    this.mediaEl = document.createElement('div');
    this.mediaEl.className = 'viewer-panel-media';
    this.mediaEl.style.display = 'none';
    container.appendChild(this.mediaEl);

    // Object URLs handed to an <iframe>; revoked when the tab changes.
    this._objectUrls = [];
    // True while a non-text preview is on screen. Read by _save().
    this._mediaMode = false;
    // Expansion state for the JSON reader, kept per open file so collapsing a
    // big tree is not undone by a save.
    this._jsonState = null;

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath && !this._saving) {
        this._reloadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      window.api.onFileChanged(this._onFileChanged);
    }
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose());
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }
  }

  /**
   * Open a file in the viewer.
   *
   * @param {Object} [options]
   * @param {string} [options.previewType] 'text' | 'image' | 'pdf' | 'html' | 'pptx'
   * @param {string} [options.mimeType]    for image/pdf/pptx
   * @param {string} [options.base64]      for image/pdf/pptx
   * @param {string} [options.previewUrl]  switchboard-preview:// URL, html/pptx
   * @param {string} [options.unavailable] message for a real file that cannot
   *                                       be previewed (PREVIEW_UNAVAILABLE)
   * @param {Object} [options.target]      { line, column } to scroll to
   */
  open(title, filePath, content, options = {}) {
    this._unwatchFile();
    this._clearMedia();

    this.filePath = filePath;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);
    this._jsonState = null;

    // Not text: an image, a PDF, a sandboxed HTML render, or a file that is
    // real but cannot be shown. None of them have an editor, so every
    // text-only control is hidden and we stop here.
    if (options.unavailable || (options.previewType && options.previewType !== 'text')) {
      this._openMedia(filePath, options);
      return;
    }

    const isMd = this._isMarkdown(filePath);
    const isJson = this._isJson(filePath);

    this.editorEl.style.display = '';
    this.mediaEl.style.display = 'none';

    // The preview button is the second view of the file, whatever that means
    // for its type: rendered markdown, or the JSON reader tree.
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = (isMd || isJson) ? '' : 'none';
      this.toolbar.previewBtn.title = isJson
        ? 'Toggle JSON reader' : 'Toggle markdown preview';
    }
    this._restoreTextControls();

    // Save preview preference before resetting
    const wantPreview = isMd && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true';

    // Reset to edit mode before updating content (without touching localStorage)
    if (this.previewMode) {
      this.previewEl.style.display = 'none';
      this.editorEl.style.display = '';
      if (this.toolbar.previewBtn) this.toolbar.previewBtn.classList.remove('active');
      this.previewMode = false;
    }

    // Create or update editor
    if (!this.editorView) {
      this._createEditor(content, filePath);
    } else {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
      });
    }

    // Set wrap default based on file type
    this.wrapMode = isMd;
    this.toolbar.setWrapMode(this.wrapMode);
    if (this.editorView && this.editorView._wrapCompartment) {
      this.editorView.dispatch({
        effects: this.editorView._wrapCompartment.reconfigure(
          this.wrapMode ? window.CMEditorView.lineWrapping : []
        ),
      });
    }

    // Re-apply preview preference
    if (wantPreview) {
      this._setPreview(true);
    }

    // A location to land on — a terminal link clicked as `main.js:523`, or a
    // JSON reader row jumped to. Applied after the preview decision, because
    // scrolling the editor is pointless while the preview is covering it.
    if (options.target && options.target.line) {
      if (this.previewMode) this._setPreview(false);
      this.goTo(options.target.line, options.target.column);
    }

    // Watch for external changes
    this._watchFile(filePath);
  }

  _createEditor(content, filePath) {
    if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl);
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  _togglePreview() {
    // A .json/.jsonc file gets the reader tree where a .md file gets rendered
    // markdown. Same button, same slot, same "second view of this text".
    if (this._isJson(this.filePath)) {
      this.previewMode = this._toggleJsonReader();
      return;
    }
    this.previewMode = toggleMarkdownPreview({
      editorEl: this.editorEl,
      previewEl: this.previewEl,
      toggleBtn: this.toolbar.previewBtn,
      editorView: this.editorView,
      isPreview: this.previewMode,
      storageKey: this.opts.storageKey,
    });
  }

  _toggleJsonReader() {
    const { toolbar } = this;
    if (this.previewMode) {
      this.previewEl.style.display = 'none';
      this.editorEl.style.display = '';
      toolbar.previewBtn.classList.remove('active');
      toolbar.previewBtn.title = 'Toggle JSON reader';
      return false;
    }

    this.previewEl.innerHTML = '';
    this.previewEl.className = 'json-reader';
    // .jsonc allows comments and trailing commas; .json stays strict.
    const comments = /\.jsonc$/i.test(this.filePath || '');
    const parsed = window.JsonReader.parseJsonForReader(this.getContent(), { comments });

    if (!parsed.ok) {
      const error = document.createElement('div');
      error.className = 'json-reader-error';
      error.textContent = `Line ${parsed.line}, column ${parsed.column}: ${parsed.message}`;
      // The offending spot is more useful than the message, so make it
      // clickable back into the editor.
      const jump = document.createElement('button');
      jump.className = 'json-reader-jump';
      jump.textContent = 'Go to error';
      jump.addEventListener('click', () => {
        this._setPreview(false);
        this.goTo(parsed.line, parsed.column);
      });
      error.appendChild(jump);
      this.previewEl.appendChild(error);
    } else {
      if (parsed.degraded) {
        // Not an error: the tree is correct, it is just missing duplicate keys
        // and exact number text. Saying so beats quietly showing less.
        const note = document.createElement('div');
        note.className = 'json-reader-error';
        note.textContent = parsed.degraded;
        this.previewEl.appendChild(note);
      }
      this._jsonState = this._jsonState || {};
      window.JsonReader.renderTree(this.previewEl, parsed.root, this._jsonState);
    }

    this.editorEl.style.display = 'none';
    this.previewEl.style.display = 'block';
    toolbar.previewBtn.classList.add('active');
    toolbar.previewBtn.title = 'Back to editor';
    return true;
  }

  /** Put the cursor on a 1-based line/column and scroll it into view. */
  goTo(line, column) {
    if (!this.editorView || !line) return;
    const doc = this.editorView.state.doc;
    const lineNumber = Math.max(1, Math.min(Number(line) || 1, doc.lines));
    const lineInfo = doc.line(lineNumber);
    // A column past the end of the line clamps to its end rather than
    // spilling onto the next one.
    const position = column
      ? Math.min(lineInfo.from + Math.max(0, Number(column) - 1), lineInfo.to)
      : lineInfo.from;
    this.editorView.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    this.editorView.focus();
  }

  // ── Non-text previews ──────────────────────────────────────────────

  _openMedia(filePath, options) {
    const { toolbar } = this;
    this.editorEl.style.display = 'none';
    this.previewEl.style.display = 'none';
    this.mediaEl.style.display = 'block';
    this.mediaEl.innerHTML = '';
    this._mediaMode = true;

    // None of the text controls mean anything here.
    for (const btn of [toolbar.previewBtn, toolbar.wrapBtn, toolbar.gotoLineBtn, toolbar.saveBtn]) {
      if (btn) btn.style.display = 'none';
    }

    if (options.unavailable) {
      const placeholder = document.createElement('div');
      placeholder.className = 'viewer-panel-unavailable';
      // A real file that simply cannot be shown. Deliberately not an error:
      // main.js distinguishes the two with err.code === 'PREVIEW_UNAVAILABLE'.
      placeholder.textContent = options.unavailable;
      this.mediaEl.appendChild(placeholder);
      return;
    }

    if (options.previewType === 'image') {
      const img = document.createElement('img');
      img.className = 'viewer-panel-image';
      img.alt = filePath;
      // CSP img-src allows data: (index.html), so no object URL is needed.
      img.src = `data:${options.mimeType};base64,${options.base64}`;
      this.mediaEl.appendChild(img);
      return;
    }

    if (options.previewType === 'pdf') {
      // An <iframe> needs a URL the CSP's frame-src permits: that list has
      // blob: but not data:, so the bytes become an object URL.
      const frame = document.createElement('iframe');
      frame.className = 'viewer-panel-frame';
      frame.src = this._objectUrlFor(options.base64, options.mimeType || 'application/pdf');
      this.mediaEl.appendChild(frame);
      return;
    }

    if (options.previewUrl) {
      // html / pptx. ALWAYS previewUrl, never fileUrl: the preview scheme is
      // what keeps the document off a file:// origin, where it could read the
      // user's disk. Using fileUrl here would defeat the whole token design.
      const frame = document.createElement('iframe');
      frame.className = 'viewer-panel-frame';
      frame.setAttribute('sandbox', '');
      frame.src = options.previewUrl;
      this.mediaEl.appendChild(frame);
      return;
    }

    const unknown = document.createElement('div');
    unknown.className = 'viewer-panel-unavailable';
    unknown.textContent = 'Nothing to preview.';
    this.mediaEl.appendChild(unknown);
  }

  _objectUrlFor(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    this._objectUrls.push(url);
    return url;
  }

  _clearMedia() {
    // Revoke before dropping the DOM, or the blob stays resident for the life
    // of the window — a few PDFs is tens of megabytes.
    for (const url of this._objectUrls) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    this._objectUrls = [];
    this.mediaEl.innerHTML = '';
    this.mediaEl.style.display = 'none';
    this._mediaMode = false;
  }

  /** Undo what _openMedia hid, for the next file that is ordinary text. */
  _restoreTextControls() {
    const { toolbar, opts } = this;
    if (toolbar.wrapBtn) toolbar.wrapBtn.style.display = '';
    if (toolbar.gotoLineBtn) toolbar.gotoLineBtn.style.display = '';
    if (toolbar.saveBtn) toolbar.saveBtn.style.display = opts.onSave ? '' : 'none';
    // The markdown preview restores its own class; the JSON reader borrows the
    // same element and renames it.
    this.previewEl.className = this._isJson(this.filePath) ? 'json-reader' : 'markdown-preview';
  }

  _setPreview(show) {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save() {
    if (!this.opts.onSave || !this.filePath) return;
    // In media mode the editor still holds the PREVIOUS file's text while
    // this.filePath already points at the image or PDF. The save button is
    // hidden there, but the container also listens for 'cm-save' (Cmd/Ctrl+S),
    // and writing the old document over the new path would be silent data
    // loss. Refuse rather than rely on the button being out of reach.
    if (this._mediaMode) return;
    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (result && result.ok !== false) {
        this.toolbar.flashSave();
      }
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._unwatchFile();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    this.editorEl.innerHTML = '';
    this.previewEl.innerHTML = '';
    this.previewEl.style.display = 'none';
    this._jsonState = null;
    this._clearMedia();
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel) return;
    const result = await window.api.readFileForPanel(this.filePath);
    if (!result.ok) return;

    // read-file-for-panel now answers with project-files.js's shapes, and an
    // image or PDF has no `content` at all. Without this guard a watcher event
    // on a binary would dispatch `undefined` into the editor.
    if (typeof result.content !== 'string') return;

    const newContent = result.content;
    const currentContent = this.getContent();
    if (newContent === currentContent) return;

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: newContent },
      });
    }

    if (this.previewMode) {
      if (this._isJson(this.filePath)) {
        // Rebuild the tree from the new text, keeping which nodes were open.
        this.previewMode = false;
        this._toggleJsonReader();
        this.previewMode = true;
      } else {
        // Sanitised, not window.marked.parse(). This runs on a file-watcher
        // event, so it re-renders whatever was just written to disk without
        // anyone clicking anything. renderMarkdownSafe: markdown-sanitize.js.
        this.previewEl.innerHTML = renderMarkdownSafe(newContent);
      }
    }
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }

  _isJson(filePath) {
    if (!filePath || !window.JsonReader) return false;
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'json' || ext === 'jsonc';
  }
}

window.ViewerPanel = ViewerPanel;
