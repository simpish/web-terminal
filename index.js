// ============================================================
// API Layer — all fetch() calls in one place
// ============================================================
const Api = {
  host: location.hostname,

  _post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
  },

  getHome() { return fetch('/api/home').then(r => r.json()); },
  fetchSessions() { return fetch('/api/sessions').then(r => r.json()); },

  createSession(name, cwd) { return this._post('/api/sessions', { name, cwd }); },
  deleteSession(name) {
    return fetch('/api/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(r => r.json());
  },
  renameSession(oldName, newName) {
    return fetch('/api/sessions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName, newName }),
    }).then(r => r.json());
  },

  connect(session) { return this._post('/api/connect', { session }); },
  resession(session) { return this._post('/api/resession', { session }); },
  sendKeys(session, keys) { return this._post('/api/send-keys', { session, keys }); },
  sendText(session, text) { return this._post('/api/send-text', { session, text }); },
  sendLiteral(session, text) { return this._post('/api/send-literal', { session, text }); },
  scroll(session, direction) { return this._post('/api/scroll', { session, direction }); },
  capture(session) { return this._post('/api/capture', { session }); },
  ls(path, showHidden) { return this._post('/api/ls', { path, showHidden }); },

  uploadImage(file, session) {
    const form = new FormData();
    form.append('file', file);
    if (session) form.append('session', session);
    return fetch('/api/upload', { method: 'POST', body: form }).then(r => r.json());
  },
};

// ============================================================
// Model — single source of truth + pub/sub
// ============================================================
const AppModel = {
  // State
  currentSession: null,
  currentPort: null,
  currentTtydHost: null,
  termZoom: parseFloat(localStorage.getItem('termZoom')) || 1.0,
  inScrollMode: false,
  browserPath: '',
  browserLoaded: false,
  browserMode: 'browse',
  showHidden: false,
  homeDir: '/',
  claudeRowLocked: false,
  theme: localStorage.getItem('theme') || 'github-dark',

  // Pub/sub
  _listeners: {},
  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  },

  // Setters — mutate + emit
  setSession(name, port, host) {
    this.currentSession = name;
    this.currentPort = port;
    this.currentTtydHost = host;
    this.inScrollMode = false;
    if (name) localStorage.setItem('lastSession', name);
    this.emit('session-changed', { name, port, host });
  },
  setTermZoom(zoom) {
    this.termZoom = zoom;
    localStorage.setItem('termZoom', zoom);
    this.emit('zoom-changed', zoom);
  },
  setScrollMode(on) {
    this.inScrollMode = on;
    this.emit('scroll-mode-changed', on);
  },
  setBrowserPath(path) {
    this.browserPath = path;
    this.emit('browser-path-changed', path);
  },
  setBrowserMode(mode) {
    this.browserMode = mode;
    this.emit('browser-mode-changed', mode);
  },
  setShowHidden(val) {
    this.showHidden = val;
    this.emit('show-hidden-changed', val);
  },
  setTheme(theme) {
    this.theme = theme;
    localStorage.setItem('theme', theme);
    this.emit('theme-changed', theme);
  },
};

// ============================================================
// SidebarPresenter
// ============================================================
const SidebarPresenter = {
  init(model) {
    this.model = model;
    this.el = document.getElementById('sidebar');
    this.overlay = document.getElementById('overlay');

    document.getElementById('openSidebar').addEventListener('click', () => this.open());
    document.getElementById('closeSidebar').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', () => this.close());

    model.on('sidebar:open', () => this.open());
    model.on('session-changed', () => {
      if (window.innerWidth < 768) this.close();
    });
  },
  open() { this.el.classList.add('open'); this.overlay.classList.add('show'); },
  close() { this.el.classList.remove('open'); this.overlay.classList.remove('show'); },
};

// ============================================================
// SessionPresenter
// ============================================================
const SessionPresenter = {
  init(model) {
    this.model = model;
    this.listEl = document.getElementById('sessionList');
    this.nameEl = document.getElementById('sessionName');
    this.renameBtn = document.getElementById('renameBtn');

    document.getElementById('addSession').addEventListener('click', () => {
      model.setBrowserMode('new-session');
      model.emit('sidebar:open');
      TabsPresenter.switchTo('browserPanel');
      BrowserPresenter.browseTo(model.homeDir);
    });

    this.renameBtn.addEventListener('click', () => this._startRename());
    model.on('session-changed', () => this._onSessionChanged());
    model.on('sessions-loaded', sessions => this._render(sessions));
  },

  async switchTo(name) {
    const data = await Api.connect(name);
    if (data.ok) {
      this.model.setSession(name, data.port, data.host || Api.host);
    }
  },

  async reload() {
    const sessions = await Api.fetchSessions();
    this.model.emit('sessions-loaded', sessions);
    return sessions;
  },

  _onSessionChanged() {
    this.nameEl.textContent = this.model.currentSession || '--';
    this.reload();
  },

  _render(sessions) {
    const current = this.model.currentSession;
    this.listEl.innerHTML = sessions.map(s => `
      <div class="session-item ${s.name === current ? 'active' : ''}" data-session="${s.name}">
        <span>${s.name}</span>
        <button class="del" data-del="${s.name}">&times;</button>
      </div>
    `).join('');

    this.listEl.querySelectorAll('.session-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.del')) return;
        this.switchTo(el.dataset.session);
      });
    });
    this.listEl.querySelectorAll('.del').forEach(el => {
      el.addEventListener('click', () => this._delete(el.dataset.del));
    });
  },

  async _delete(name) {
    if (!confirm(`Delete "${name}"?`)) return;
    await Api.deleteSession(name);
    if (this.model.currentSession === name) {
      this.model.currentSession = null;
      document.getElementById('termFrame').src = 'about:blank';
      this.nameEl.textContent = '--';
    }
    this.reload();
  },

  _startRename() {
    const model = this.model;
    if (!model.currentSession) return;
    const oldName = model.currentSession;
    const btn = this.renameBtn;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-inline';
    input.value = oldName;
    this.nameEl.replaceWith(input);
    btn.style.display = 'none';
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      const span = document.createElement('span');
      span.className = 'session-label';
      span.id = 'sessionName';

      if (newName && newName !== oldName) {
        const data = await Api.renameSession(oldName, newName);
        if (data.ok) {
          span.textContent = data.name;
          model.setSession(data.name, data.port || model.currentPort, Api.host);
        } else {
          span.textContent = oldName;
        }
      } else {
        span.textContent = oldName;
      }

      input.replaceWith(span);
      this.nameEl = span;
      btn.style.display = '';
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
  },
};

// ============================================================
// TerminalPresenter
// ============================================================
const TerminalPresenter = {
  init(model) {
    this.model = model;
    this.wrap = document.getElementById('termWrap');
    this.dot = document.getElementById('connDot');
    this.fontLabel = document.getElementById('fontLabel');

    this._updateLabel();

    document.getElementById('reloadBtn').addEventListener('click', () => this.reload());
    document.getElementById('fontPlus').addEventListener('click', () => {
      model.setTermZoom(Math.min(model.termZoom + 0.1, 3.0));
    });
    document.getElementById('fontMinus').addEventListener('click', () => {
      model.setTermZoom(Math.max(model.termZoom - 0.1, 0.3));
    });
    document.getElementById('resessionBtn').addEventListener('click', () => this._resession());

    model.on('session-changed', ({ port, host }) => {
      if (port && host) this.load(`http://${host}:${port}`);
    });
    model.on('zoom-changed', () => {
      this._applyZoom();
      this._updateLabel();
    });
  },

  load(url) {
    const old = document.getElementById('termFrame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'termFrame';
    frame.src = 'about:blank';
    this.wrap.insertBefore(frame, this.wrap.firstChild);
    setTimeout(() => {
      frame.src = url;
      this._applyZoom();
      this.dot.classList.remove('off');
    }, 300);
  },

  reload() {
    const m = this.model;
    if (m.currentPort) this.load(`http://${m.currentTtydHost}:${m.currentPort}`);
  },

  _applyZoom() {
    const frame = document.getElementById('termFrame');
    if (!frame) return;
    const z = this.model.termZoom;
    frame.style.transform = `scale(${z})`;
    frame.style.transformOrigin = 'top left';
    frame.style.width = (100 / z) + '%';
    frame.style.height = (100 / z) + '%';
  },

  _updateLabel() {
    this.fontLabel.textContent = Math.round(this.model.termZoom * 100) + '%';
  },

  async _resession() {
    const m = this.model;
    if (!m.currentSession) return;
    const data = await Api.resession(m.currentSession);
    if (data.ok) {
      setTimeout(() => {
        m.setSession(m.currentSession, data.port, data.host || Api.host);
      }, 2000);
    }
  },
};

// ============================================================
// InputPresenter
// ============================================================
const InputPresenter = {
  init(model) {
    this.model = model;
    this.textarea = document.getElementById('cmdInput');

    document.getElementById('sendBtn').addEventListener('click', () => this.doSend());
    document.getElementById('enterBtn').addEventListener('click', () => this.doRun());

    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 100) + 'px';
    });

    model.on('insert-command', cmd => {
      this.textarea.value = cmd;
      this.textarea.style.height = 'auto';
      this.textarea.style.height = this.textarea.scrollHeight + 'px';
      // Only focus if keyboard is already open
      if (document.activeElement === this.textarea) this.textarea.focus();
    });
  },

  async exitScrollIfNeeded() {
    if (!this.model.inScrollMode) return;
    await Api.scroll(this.model.currentSession, 'exit');
    this.model.setScrollMode(false);
  },

  async flush() {
    const text = this.textarea.value;
    if (!text) return;
    await this.exitScrollIfNeeded();
    try {
      const data = await Api.sendLiteral(this.model.currentSession, text);
      if (!data.ok) { console.error('send-literal failed:', data.error); return; }
    } catch (e) { console.error('send-literal error:', e); return; }
    this.textarea.value = '';
    this.textarea.style.height = 'auto';
  },

  async doSend() {
    if (!this.model.currentSession) return;
    await this.flush();
  },

  async doRun() {
    const session = this.model.currentSession;
    if (!session) return;
    const text = this.textarea.value;
    if (text) {
      await this.exitScrollIfNeeded();
      try {
        const data = await Api.sendText(session, text);
        if (!data.ok) { console.error('send-text failed:', data.error); this.textarea.focus(); return; }
      } catch (e) { console.error('send-text error:', e); this.textarea.focus(); return; }
      this.textarea.value = '';
      this.textarea.style.height = 'auto';
    } else {
      await Api.sendKeys(session, 'Enter');
    }
  },

  async sendKey(key) {
    if (!this.model.currentSession) return;
    await this.flush();
    await Api.sendKeys(this.model.currentSession, key);
  },
};

// ============================================================
// KeysPresenter
// ============================================================
const KeysPresenter = {
  init(model) {
    this.model = model;

    document.getElementById('keysRow').addEventListener('click', e => {
      const btn = e.target.closest('.kb');
      if (!btn) return;
      if (btn.id === 'menuBtn2') model.emit('sidebar:open');
      else if (btn.id === 'reloadBtn' || btn.id === 'copyBtn') { /* handled by own presenter */ }
      else if (btn.id === 'claudeToggle') this._toggleClaude();
      else if (btn.dataset.key) InputPresenter.sendKey(btn.dataset.key);
      else if (btn.dataset.scroll) this._scroll(btn.dataset.scroll);
    });

    document.getElementById('claudeRow').addEventListener('click', e => {
      const btn = e.target.closest('.kb');
      if (btn && btn.dataset.cmd) model.emit('insert-command', btn.dataset.cmd);
    });
  },

  _toggleClaude() {
    const row = document.getElementById('claudeRow');
    const toggle = document.getElementById('claudeToggle');
    const opening = row.classList.contains('hidden');
    row.classList.toggle('hidden');
    toggle.classList.toggle('active');
    if (opening) {
      row.style.pointerEvents = 'none';
      row.style.opacity = '0.5';
      setTimeout(() => {
        row.style.pointerEvents = '';
        row.style.opacity = '';
      }, 400);
    }
  },

  async _scroll(direction) {
    const session = this.model.currentSession;
    if (!session) return;
    await Api.scroll(session, direction);
    if (direction === 'exit') {
      this.model.setScrollMode(false);
      setTimeout(() => TerminalPresenter.reload(), 300);
    } else {
      this.model.setScrollMode(true);
    }
  },
};

// ============================================================
// BrowserPresenter
// ============================================================
const BrowserPresenter = {
  init(model) {
    this.model = model;
    this.crumbsEl = document.getElementById('browserCrumbs');
    this.listEl = document.getElementById('browserList');
    this.cdBtn = document.getElementById('cdBtn');
    this.createBtn = document.getElementById('createSessionBtn');

    this.cdBtn.addEventListener('click', () => this._cdHere());
    this.copyPathBtn = document.getElementById('copyPathBtn');
    this.copyPathBtn.addEventListener('click', () => this._copyPath(model.browserPath));
    this.createBtn.addEventListener('click', () => this._createSession());
    document.getElementById('hiddenToggle').addEventListener('click', () => {
      model.setShowHidden(!model.showHidden);
      document.getElementById('hiddenToggle').classList.toggle('on', model.showHidden);
      this.browseTo(model.browserPath);
    });

    model.on('browser-mode-changed', mode => {
      this.cdBtn.style.display = mode === 'new-session' ? 'none' : '';
      this.createBtn.style.display = mode === 'new-session' ? '' : 'none';
    });
  },

  async browseTo(path) {
    this.model.browserLoaded = true;
    const data = await Api.ls(path, this.model.showHidden);
    if (!data.ok) return;
    this.model.setBrowserPath(data.path);
    this._render(data);
  },

  _render(data) {
    // Breadcrumbs
    const parts = data.path.split('/').filter(Boolean);
    let crumbHtml = '<button class="browser-crumb" data-path="/">/</button>';
    let acc = '';
    for (const p of parts) {
      acc += '/' + p;
      crumbHtml += ` <button class="browser-crumb" data-path="${acc}">${p}</button>/`;
    }
    this.crumbsEl.innerHTML = crumbHtml;
    this.crumbsEl.querySelectorAll('.browser-crumb').forEach(el => {
      el.addEventListener('click', () => this.browseTo(el.dataset.path));
    });

    // File list
    let html = '';
    if (data.path !== '/') {
      const parent = data.path.split('/').slice(0, -1).join('/') || '/';
      html += `<div class="browser-item" data-dir="${parent}"><span class="icon">&#8617;</span> ..</div>`;
    }
    for (const d of data.dirs) {
      const full = data.path === '/' ? '/' + d : data.path + '/' + d;
      html += `<div class="browser-item" data-dir="${full}"><span class="icon">&#128193;</span> ${d}</div>`;
    }
    for (const f of data.files) {
      const full = data.path === '/' ? '/' + f : data.path + '/' + f;
      html += `<div class="browser-item file" data-path="${full}"><span class="icon">&#128196;</span> ${f}</div>`;
    }
    this.listEl.innerHTML = html;
    this.listEl.querySelectorAll('.browser-item[data-dir]').forEach(el => {
      el.addEventListener('click', () => this.browseTo(el.dataset.dir));
    });
    // Tap file to copy its path
    this.listEl.querySelectorAll('.browser-item.file').forEach(el => {
      el.addEventListener('click', () => this._copyPath(el.dataset.path));
    });
  },

  _copyPath(p) {
    const done = () => {
      const prev = this.copyPathBtn.textContent;
      this.copyPathBtn.textContent = 'Copied!';
      setTimeout(() => { this.copyPathBtn.textContent = prev; }, 1000);
    };
    // Try modern clipboard API first
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(p).then(done).catch(() => this._fallbackCopy(p, done));
    } else {
      this._fallbackCopy(p, done);
    }
  },

  _fallbackCopy(text, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      if (onSuccess) onSuccess();
    } catch {
      // Last resort: insert into input
      const input = document.getElementById('cmdInput');
      input.value += text;
      input.dispatchEvent(new Event('input'));
    }
    document.body.removeChild(ta);
  },

  _cdHere() {
    const m = this.model;
    if (!m.currentSession || !m.browserPath) return;
    Api.sendText(m.currentSession, `cd ${m.browserPath}`);
    SidebarPresenter.close();
  },

  async _createSession() {
    const m = this.model;
    if (!m.browserPath) return;
    const dirName = m.browserPath.split('/').filter(Boolean).pop() || 'main';
    const data = await Api.createSession(dirName, m.browserPath);
    m.setBrowserMode('browse');
    TabsPresenter.switchTo('sessionsPanel');
    SessionPresenter.switchTo(data.name);
  },
};

// ============================================================
// CapturePresenter
// ============================================================
const CapturePresenter = {
  init(model) {
    this.model = model;
    this.modal = document.getElementById('captureModal');
    this.textEl = document.getElementById('captureText');

    document.getElementById('copyBtn').addEventListener('click', () => this._capture());
    document.getElementById('captureClose').addEventListener('click', () => {
      this.modal.classList.remove('open');
    });
  },

  async _capture() {
    if (!this.model.currentSession) return;
    try {
      const data = await Api.capture(this.model.currentSession);
      if (data.ok && data.text) {
        this.textEl.textContent = data.text.replace(/\s+$/, '');
        this.modal.classList.add('open');
      }
    } catch (e) {
      console.error('capture failed:', e);
    }
  },
};

// ============================================================
// ThemePresenter
// ============================================================
const ThemePresenter = {
  init(model) {
    const select = document.getElementById('themeSelect');
    document.documentElement.setAttribute('data-theme', model.theme);
    select.value = model.theme;
    select.addEventListener('change', () => model.setTheme(select.value));
    model.on('theme-changed', theme => {
      document.documentElement.setAttribute('data-theme', theme);
    });
  },
};

// ============================================================
// TabsPresenter
// ============================================================
const TabsPresenter = {
  init(model) {
    this.model = model;
    this.tabs = document.querySelectorAll('.sidebar-tab');
    this.panels = document.querySelectorAll('.sidebar-panel');

    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTo(tab.dataset.panel);
        if (tab.dataset.panel === 'browserPanel' && !model.browserLoaded) {
          BrowserPresenter.browseTo(model.homeDir);
        }
        if (tab.dataset.panel === 'sessionsPanel') {
          model.setBrowserMode('browse');
        }
      });
    });
  },

  switchTo(panelId) {
    this.tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
    this.panels.forEach(p => p.classList.toggle('active', p.id === panelId));
  },
};

// ============================================================
// ImageUploadPresenter
// ============================================================
const ImageUploadPresenter = {
  init(model) {
    this.model = model;
    this.fileInput = document.getElementById('imageInput');

    document.getElementById('imgBtn').addEventListener('click', () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files[0];
      if (file) this._upload(file);
      this.fileInput.value = '';
    });
  },

  async _upload(file) {
    const session = this.model.currentSession;
    const data = await Api.uploadImage(file, session);
    if (!data.ok) {
      console.error('Upload failed:', data.error);
      return;
    }
    // Insert path into textarea and done — no lingering thumbnail
    const textarea = document.getElementById('cmdInput');
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);
    textarea.value = before + data.path + ' ' + after;
    textarea.dispatchEvent(new Event('input')); // auto-resize
  },

};

// ============================================================
// Bootstrap
// ============================================================
async function init() {
  const homeData = await Api.getHome();
  AppModel.homeDir = homeData.home;
  AppModel.browserPath = homeData.home;

  // Focus guard — buttons never steal focus from textarea (keyboard stays as-is)
  document.querySelectorAll('button, .kb, .act-btn').forEach(el => {
    el.setAttribute('tabindex', '-1');
  });
  // Also apply to dynamically created buttons via MutationObserver
  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('button, .kb, .act-btn')) {
          node.setAttribute('tabindex', '-1');
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('button, .kb, .act-btn').forEach(el => {
            el.setAttribute('tabindex', '-1');
          });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Initialize all presenters
  SidebarPresenter.init(AppModel);
  SessionPresenter.init(AppModel);
  TerminalPresenter.init(AppModel);
  InputPresenter.init(AppModel);
  KeysPresenter.init(AppModel);
  BrowserPresenter.init(AppModel);
  CapturePresenter.init(AppModel);
  ImageUploadPresenter.init(AppModel);
  ThemePresenter.init(AppModel);
  TabsPresenter.init(AppModel);

  // Load sessions
  const sessions = await Api.fetchSessions();
  AppModel.emit('sessions-loaded', sessions);
  const last = localStorage.getItem('lastSession');

  if (sessions.length === 0) {
    SidebarPresenter.open();
    AppModel.setBrowserMode('new-session');
    TabsPresenter.switchTo('browserPanel');
    BrowserPresenter.browseTo(AppModel.homeDir);
  } else if (last && sessions.find(s => s.name === last)) {
    SessionPresenter.switchTo(last);
  } else {
    SessionPresenter.switchTo(sessions[0].name);
  }
}

init();
