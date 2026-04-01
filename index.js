const HOST = location.hostname;
let currentSession = null;

// Prevent page scroll on everything except iframe and textarea
document.addEventListener('touchmove', e => {
  if (e.target.closest('iframe') || e.target.closest('textarea') || e.target.closest('.btn-row')) return;
  e.preventDefault();
}, { passive: false });

// ========== Sidebar ==========
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');

function openSidebar() { sidebar.classList.add('open'); overlay.classList.add('show'); }
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('show'); }

document.getElementById('openSidebar').addEventListener('click', openSidebar);
document.getElementById('closeSidebar').addEventListener('click', closeSidebar);
overlay.addEventListener('click', closeSidebar);

// ========== Sessions ==========
async function fetchSessions() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  renderSessions(sessions);
  return sessions;
}

function renderSessions(sessions) {
  const list = document.getElementById('sessionList');
  list.innerHTML = sessions.map(s => `
    <div class="session-item ${s.name === currentSession ? 'active' : ''}" data-session="${s.name}">
      <span>${s.name}</span>
      <button class="del" data-del="${s.name}">&times;</button>
    </div>
  `).join('');

  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.del')) return;
      switchSession(el.dataset.session);
    });
  });
  list.querySelectorAll('.del').forEach(el => {
    el.addEventListener('click', () => deleteSession(el.dataset.del));
  });
}

// ========== Rename session (topbar pencil button) ==========
document.getElementById('renameBtn').addEventListener('click', () => {
  if (!currentSession) return;
  const label = document.getElementById('sessionName');
  const btn = document.getElementById('renameBtn');
  const oldName = currentSession;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-inline';
  input.value = oldName;
  label.replaceWith(input);
  btn.style.display = 'none';
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    const span = document.createElement('span');
    span.className = 'session-label';
    span.id = 'sessionName';

    if (newName && newName !== oldName) {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName })
      });
      const data = await res.json();
      if (data.ok) {
        currentSession = data.name;
        span.textContent = data.name;
        localStorage.setItem('lastSession', data.name);
        // Reconnect iframe to new ttyd port
        if (data.port) {
          currentPort = data.port;
          currentTtydHost = HOST;
          setTimeout(() => loadTermFrame(`http://${currentTtydHost}:${data.port}`), 500);
        }
        fetchSessions();
      } else {
        span.textContent = oldName;
      }
    } else {
      span.textContent = oldName;
    }

    input.replaceWith(span);
    btn.style.display = '';
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
});

let browserMode = 'browse'; // 'browse' or 'new-session'

document.getElementById('addSession').addEventListener('click', () => {
  // Switch to Browse tab in new-session mode
  browserMode = 'new-session';
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-panel="browserPanel"]').classList.add('active');
  document.getElementById('browserPanel').classList.add('active');
  // Show create button, hide cd button
  document.getElementById('cdBtn').style.display = 'none';
  document.getElementById('createSessionBtn').style.display = '';
  // Browse starting at home directory
  browseTo(HOME_DIR);
});

// When switching back to browse tab normally, reset mode
document.getElementById('createSessionBtn').addEventListener('click', async () => {
  if (!browserPath) return;
  const dirName = browserPath.split('/').filter(Boolean).pop() || 'main';
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: dirName, cwd: browserPath })
  });
  const data = await res.json();
  // Reset browser mode
  browserMode = 'browse';
  document.getElementById('cdBtn').style.display = '';
  document.getElementById('createSessionBtn').style.display = 'none';
  // Switch to sessions tab
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-panel="sessionsPanel"]').classList.add('active');
  document.getElementById('sessionsPanel').classList.add('active');
  await fetchSessions();
  switchSession(data.name);
});

async function deleteSession(name) {
  if (!confirm(`Delete "${name}"?`)) return;
  await fetch('/api/sessions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (currentSession === name) {
    currentSession = null;
    document.getElementById('termFrame').src = 'about:blank';
    document.getElementById('sessionName').textContent = '--';
  }
  fetchSessions();
}

let currentPort = null;
let currentTtydHost = null;

async function switchSession(name) {
  currentSession = name;
  document.getElementById('sessionName').textContent = name;
  localStorage.setItem('lastSession', name);
  fetchSessions();

  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: name })
  });
  const data = await res.json();
  if (data.ok) {
    currentPort = data.port;
    currentTtydHost = data.host || HOST;
    loadTermFrame(`http://${currentTtydHost}:${data.port}`);
  }
  if (window.innerWidth < 768) closeSidebar();
}

function loadTermFrame(url) {
  // Replace iframe entirely to avoid beforeunload dialog
  const wrap = document.getElementById('termWrap');
  const oldFrame = document.getElementById('termFrame');
  if (oldFrame) oldFrame.remove();
  const newFrame = document.createElement('iframe');
  newFrame.id = 'termFrame';
  newFrame.src = 'about:blank';
  wrap.insertBefore(newFrame, wrap.firstChild);
  setTimeout(() => {
    newFrame.src = url;
    document.getElementById('connDot').classList.remove('off');
  }, 300);
}

// Reload button - reload iframe
document.getElementById('reloadBtn').addEventListener('click', () => {
  if (currentPort) {
    loadTermFrame(`http://${currentTtydHost || HOST}:${currentPort}`);
  }
});

// Re-session button - kill session + tmux, recreate at same directory
document.getElementById('resessionBtn').addEventListener('click', async () => {
  if (!currentSession) return;
  const res = await fetch('/api/resession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: currentSession })
  });
  const data = await res.json();
  if (data.ok) {
    currentPort = data.port;
    currentTtydHost = data.host || HOST;
    setTimeout(() => loadTermFrame(`http://${currentTtydHost}:${data.port}`), 2000);
  }
});


// ========== Tap vs scroll detection for button rows ==========
function setupBtnRow(rowEl, handler) {
  rowEl.addEventListener('click', e => {
    const btn = e.target.closest('.kb');
    if (btn) {
      handler(btn);
      // Prevent iframe from getting focus and showing keyboard
      document.activeElement?.blur();
    }
  });
  rowEl.addEventListener('mousedown', e => {
    if (e.target.closest('.kb')) e.preventDefault();
  });
}

// ========== Key buttons ==========
// Menu button - direct event since setupBtnRow tap detection can be unreliable
document.getElementById('menuBtn2').addEventListener('click', openSidebar);

setupBtnRow(document.getElementById('keysRow'), btn => {
  if (btn.id === 'menuBtn2') {
    openSidebar();
  } else if (btn.id === 'claudeToggle') {
    toggleClaude();
  } else if (btn.dataset.key) {
    sendKey(btn.dataset.key);
  } else if (btn.dataset.scroll) {
    scrollTerminal(btn.dataset.scroll);
  }
});

let claudeRowLocked = false;
function toggleClaude() {
  const row = document.getElementById('claudeRow');
  const toggle = document.getElementById('claudeToggle');
  const opening = row.classList.contains('hidden');
  row.classList.toggle('hidden');
  toggle.classList.toggle('active');
  if (opening) {
    claudeRowLocked = true;
    row.style.pointerEvents = 'none';
    row.style.opacity = '0.5';
    setTimeout(() => {
      claudeRowLocked = false;
      row.style.pointerEvents = '';
      row.style.opacity = '';
    }, 400);
  }
}

async function scrollTerminal(direction) {
  if (!currentSession) return;
  await fetch('/api/scroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: currentSession, direction })
  });
  // After exiting copy-mode, reload iframe to restore input
  if (direction === 'exit' && currentPort) {
    setTimeout(() => loadTermFrame(`http://${currentTtydHost || HOST}:${currentPort}`), 300);
  }
}

// ========== Claude shortcuts ==========
document.getElementById('claudeRow').addEventListener('click', e => {
  const btn = e.target.closest('.kb');
  if (btn && btn.dataset.cmd) {
    insertClaudeCmd(btn.dataset.cmd);
  }
});

function insertClaudeCmd(cmd) {
  const input = document.getElementById('cmdInput');
  input.value = cmd;
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  input.focus();
}

// ========== Send keys ==========
async function flushInput() {
  const input = document.getElementById('cmdInput');
  const text = input.value;
  if (!text) return;
  try {
    const res = await fetch('/api/send-literal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession, text })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('send-literal failed:', data.error);
      return;
    }
  } catch (e) {
    console.error('send-literal error:', e);
    return;
  }
  input.value = '';
  input.style.height = 'auto';
}

async function sendKey(key) {
  if (!currentSession) return;
  await flushInput();
  await fetch('/api/send-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: currentSession, keys: key })
  });
}

// ========== Send / Run buttons ==========
document.getElementById('sendBtn').addEventListener('click', doSend);
document.getElementById('enterBtn').addEventListener('click', doRun);

// Send = flush text to terminal (no Enter)
async function doSend() {
  if (!currentSession) return;
  await flushInput();
}

// Run = flush text + Enter
async function doRun() {
  if (!currentSession) return;
  const input = document.getElementById('cmdInput');
  const text = input.value;
  if (text) {
    try {
      const res = await fetch('/api/send-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: currentSession, text })
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('send-text failed:', data.error);
        input.focus();
        return;
      }
    } catch (e) {
      console.error('send-text error:', e);
      input.focus();
      return;
    }
    input.value = '';
    input.style.height = 'auto';
  } else {
    // No text, just send Enter
    await fetch('/api/send-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: currentSession, keys: 'Enter' })
    });
  }
  input.focus();
}

// Auto-resize textarea
document.getElementById('cmdInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});

// ========== Sidebar tabs ==========
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'browserPanel' && !browserLoaded) {
      browseTo(HOME_DIR);
    }
    // Reset browser mode when manually switching tabs
    if (tab.dataset.panel === 'sessionsPanel') {
      browserMode = 'browse';
      document.getElementById('cdBtn').style.display = '';
      document.getElementById('createSessionBtn').style.display = 'none';
    }
  });
});

// ========== File browser ==========
let browserPath = '';
let browserLoaded = false;
let HOME_DIR = '/';
fetch('/api/home').then(r => r.json()).then(d => { HOME_DIR = d.home; browserPath = HOME_DIR; });
let showHidden = false;

async function browseTo(dirPath) {
  browserLoaded = true;
  const res = await fetch('/api/ls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, showHidden })
  });
  const data = await res.json();
  if (!data.ok) return;
  browserPath = data.path;
  renderBrowser(data);
}

function renderBrowser(data) {
  // Breadcrumbs
  const parts = data.path.split('/').filter(Boolean);
  let crumbHtml = '<button class="browser-crumb" data-path="/">/</button>';
  let accumulated = '';
  for (const p of parts) {
    accumulated += '/' + p;
    crumbHtml += ` <button class="browser-crumb" data-path="${accumulated}">${p}</button>/`;
  }
  const crumbsEl = document.getElementById('browserCrumbs');
  crumbsEl.innerHTML = crumbHtml;
  crumbsEl.querySelectorAll('.browser-crumb').forEach(el => {
    el.addEventListener('click', () => browseTo(el.dataset.path));
  });

  // Directory + file list
  const listEl = document.getElementById('browserList');
  let html = '';

  // Parent dir
  if (data.path !== '/') {
    const parent = data.path.split('/').slice(0, -1).join('/') || '/';
    html += `<div class="browser-item" data-dir="${parent}"><span class="icon">&#8617;</span> ..</div>`;
  }

  for (const d of data.dirs) {
    const full = data.path === '/' ? '/' + d : data.path + '/' + d;
    html += `<div class="browser-item" data-dir="${full}"><span class="icon">&#128193;</span> ${d}</div>`;
  }
  for (const f of data.files) {
    html += `<div class="browser-item file"><span class="icon">&#128196;</span> ${f}</div>`;
  }

  listEl.innerHTML = html;
  listEl.querySelectorAll('.browser-item[data-dir]').forEach(el => {
    el.addEventListener('click', () => browseTo(el.dataset.dir));
  });
}

document.getElementById('cdBtn').addEventListener('click', () => {
  if (!currentSession || !browserPath) return;
  fetch('/api/send-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: currentSession, text: `cd ${browserPath}` })
  });
  if (window.innerWidth < 768) closeSidebar();
});

document.getElementById('hiddenToggle').addEventListener('click', () => {
  showHidden = !showHidden;
  document.getElementById('hiddenToggle').classList.toggle('on', showHidden);
  browseTo(browserPath);
});

// ========== Theme ==========
const themeSelect = document.getElementById('themeSelect');
const savedTheme = localStorage.getItem('theme') || 'github-dark';
document.documentElement.setAttribute('data-theme', savedTheme);
themeSelect.value = savedTheme;

themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
});

// ========== Init ==========
async function init() {
  const sessions = await fetchSessions();
  const last = localStorage.getItem('lastSession');

  if (sessions.length === 0) {
    // No sessions - open sidebar in new-session mode
    openSidebar();
    document.getElementById('addSession').click();
  } else if (last && sessions.find(s => s.name === last)) {
    switchSession(last);
  } else {
    switchSession(sessions[0].name);
  }
}

init();
