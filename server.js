const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const HOST = process.env.HOST || (() => {
  try {
    return require('child_process').execSync('tailscale ip -4', { encoding: 'utf8' }).trim();
  } catch {
    return '0.0.0.0';
  }
})();
const HOME = os.homedir();
const PORT = parseInt(process.env.PORT || '7681');
const TTYD_BASE_PORT = parseInt(process.env.TTYD_BASE_PORT || '7700');

// --- Basic Auth (single login gate for the dashboard, the /api control plane, and the proxied terminals) ---
function loadAuth() {
  if (process.env.TTYD_AUTH_USER && process.env.TTYD_AUTH_PASS) {
    return { user: process.env.TTYD_AUTH_USER, pass: process.env.TTYD_AUTH_PASS };
  }
  try {
    const raw = fs.readFileSync(path.join(HOME, '.config', 'ttyd-term', 'credentials'), 'utf8').trim();
    const i = raw.indexOf(':');
    if (i > 0) return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  } catch {}
  return null;
}
const AUTH = loadAuth();
if (!AUTH) {
  console.error('[ttyd-term] ERROR: no credentials at ~/.config/ttyd-term/credentials (and no TTYD_AUTH_* env) — FAILING CLOSED, refusing all requests. Create the file as "user:pass" (mode 600) and restart.');
}
function eq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ab, bb);
}
function checkAuth(req) {
  if (!AUTH) return false; // fail closed: no credentials configured => deny everyone (not open to the tailnet)
  const m = /^Basic (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  let dec;
  try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  const okU = eq(dec.slice(0, i), AUTH.user);
  const okP = eq(dec.slice(i + 1), AUTH.pass);
  return okU && okP;
}
function send401(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ttyd-term", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Authentication required');
}

// Resolve a /term/<session> path to a safe tmux session key (URL-decode, then restrict to the charset sessions are named with)
function termSeg(pathname) {
  let s = (pathname.split('/')[2] || '');
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Headers for the localhost ttyd backend — strip client auth/cookies so our dashboard credential is never forwarded
const STRIP_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
function backendHeaders(req, port) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_HEADERS.has(k.toLowerCase())) continue;
    h[k] = v;
  }
  h.host = '127.0.0.1:' + port;
  return h;
}

// --- Reverse-proxy a terminal request to its localhost ttyd (HTTP) ---
function proxyTerminal(req, res, port) {
  const proxyReq = http.request({
    hostname: '127.0.0.1', port, path: req.url, method: req.method,
    headers: backendHeaders(req, port),
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.destroy());
  });
  proxyReq.setTimeout(60000, () => proxyReq.destroy());
  proxyReq.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); } catch {} });
  req.on('error', () => proxyReq.destroy());
  res.on('close', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

// Safe exec with killOnTimeout (prevents zombie send-keys)
function safeExec(cmd, timeoutMs = 3000) {
  const result = require('child_process').spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Command failed with exit code ${result.status}`);
  return result.stdout;
}

// Direct tmux invocation via spawnSync args (avoids shell injection)
function tmuxExec(args, timeoutMs = 3000) {
  const result = require('child_process').spawnSync('tmux', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `tmux failed with exit code ${result.status}`);
  return result.stdout;
}

// --- ttyd process management ---
// Map: sessionName -> { port, process }
const ttydProcesses = new Map();
let nextPort = TTYD_BASE_PORT;

function startTtyd(sessionName) {
  if (ttydProcesses.has(sessionName)) {
    return ttydProcesses.get(sessionName).port;
  }
  const port = nextPort++;
  const safeBase = String(sessionName).replace(/[^a-zA-Z0-9_-]/g, '');
  const proc = spawn('ttyd', [
    '-i', '127.0.0.1',
    '-p', String(port),
    '-b', '/term/' + safeBase,
    '-W',
    // xterm.js must keep NO local scrollback: tmux redraws leave stale garbage
    // frames in it, so swiping up shows ancient broken history. Real history
    // lives in tmux (copy-mode via the ▲▼ buttons / /api/scroll).
    '-t', 'scrollback=0',
    '-t', 'fontFamily=MesloLGS NF,Hack Nerd Font,FiraCode Nerd Font,JetBrainsMono Nerd Font,Menlo,Monaco,Consolas,monospace',
    'tmux', 'set-option', '-g', 'history-limit', '10000', ';',
    'new-session', '-A', '-s', sessionName
  ], { stdio: 'ignore', detached: true, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  proc.unref();
  ttydProcesses.set(sessionName, { port, process: proc });
  return port;
}

function stopTtyd(sessionName) {
  const entry = ttydProcesses.get(sessionName);
  if (entry) {
    try { process.kill(entry.process.pid, 'SIGKILL'); } catch {}
    ttydProcesses.delete(sessionName);
  }
}

function restartTtyd(sessionName) {
  stopTtyd(sessionName);
  const port = startTtyd(sessionName);
  return { ok: true, port };
}

function resession(sessionName) {
  // Get current working directory from tmux pane before killing
  let cwd = HOME;
  try {
    cwd = tmuxExec(['display-message', '-t', sessionName, '-p', '#{pane_current_path}']).trim();
  } catch {}
  // Kill everything
  stopTtyd(sessionName);
  try { tmuxExec(['kill-session', '-t', sessionName]); } catch {}
  // Create fresh session and cd into the directory
  const port = startTtyd(sessionName);
  if (cwd && cwd !== '/home') {
    setTimeout(() => {
      try {
        tmuxExec(['send-keys', '-t', sessionName, '-l', '--', 'cd ' + cwd]);
        tmuxExec(['send-keys', '-t', sessionName, 'Enter']);
      } catch {}
    }, 1500);
  }
  return { ok: true, port };
}

// --- session persistence (remember each tmux session's name + working dir across reboots) ---
const STATE_FILE = path.join(HOME, '.config', 'ttyd-term', 'sessions.json');

function saveSessionState() {
  try {
    const names = tmuxExec(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean);
    if (names.length === 0) {
      // Never overwrite a non-empty memory with nothing (e.g. tmux server not ready yet at boot) — that would erase the restore data
      try { if (Object.keys(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))).length > 0) return; } catch {}
    }
    const state = {};
    for (const name of names) {
      let cwd = HOME;
      try { cwd = tmuxExec(['display-message', '-t', name, '-p', '#{pane_current_path}']).trim() || HOME; } catch {}
      state[name] = { cwd };
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // Atomic write: a crash/power-loss mid-write can't corrupt or empty the file
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

function restoreSessionState() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  let existing = [];
  try { existing = tmuxExec(['list-sessions', '-F', '#{session_name}']).trim().split('\n').filter(Boolean); } catch {}
  for (const [name, info] of Object.entries(saved)) {
    if (existing.includes(name)) continue;
    let cwd = HOME;
    try { if (info && info.cwd && fs.statSync(info.cwd).isDirectory()) cwd = info.cwd; } catch {}
    try { tmuxExec(['new-session', '-d', '-s', name, '-c', cwd]); } catch {}
  }
}

// --- tmux helpers ---

function tmuxList() {
  try {
    const out = tmuxExec(['list-sessions', '-F', '#{session_name}']);
    return out.trim().split('\n').filter(Boolean).map(name => {
      const ttyd = ttydProcesses.get(name);
      return { name, port: ttyd ? ttyd.port : null };
    });
  } catch {
    return [];
  }
}

function tmuxCreate(name, cwd) {
  let safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  // If session already exists, append -2, -3, etc.
  const existing = tmuxList().map(s => s.name);
  if (existing.includes(safeName)) {
    let i = 2;
    while (existing.includes(`${safeName}-${i}`)) i++;
    safeName = `${safeName}-${i}`;
  }
  const port = startTtyd(safeName);
  // Send cd command after a short delay to let ttyd/tmux start
  if (cwd) {
    setTimeout(() => {
      try {
        tmuxExec(['send-keys', '-t', safeName, '-l', '--', 'cd ' + cwd]);
        tmuxExec(['send-keys', '-t', safeName, 'Enter']);
      } catch {}
    }, 1500);
  }
  return { ok: true, name: safeName, port };
}

function tmuxKill(name) {
  stopTtyd(name);
  try {
    tmuxExec(['kill-session', '-t', name]);
    saveSessionState();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxRename(oldName, newName) {
  let safeName = newName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) return { ok: false, error: 'invalid name' };
  if (safeName === oldName) return { ok: true, name: safeName };
  const existing = tmuxList().map(s => s.name);
  if (existing.includes(safeName)) {
    return { ok: false, error: 'name already exists' };
  }
  try {
    tmuxExec(['rename-session', '-t', oldName, safeName]);
    // Restart ttyd so it connects with the new session name
    stopTtyd(oldName);
    const port = startTtyd(safeName);
    return { ok: true, name: safeName, port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendKeys(name, keys) {
  try {
    tmuxExec(['send-keys', '-t', name, keys]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendChunked(name, text) {
  // Send text in small chunks to prevent tmux hangs with long/CJK text
  const CHUNK = 64;
  for (let i = 0; i < text.length; i += CHUNK) {
    const chunk = text.slice(i, i + CHUNK);
    tmuxExec(['send-keys', '-t', name, '-l', '--', chunk]);
  }
}

function tmuxSendText(name, text) {
  try {
    tmuxSendChunked(name, text);
    tmuxExec(['send-keys', '-t', name, 'Enter']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendLiteral(name, text) {
  try {
    tmuxSendChunked(name, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxScroll(name, direction) {
  try {
    // Full-screen apps (Claude Code etc.) run on the alternate screen: tmux
    // history is empty there, so copy-mode has nothing to scroll. Scroll the
    // app itself instead — via mouse-wheel events if it tracks the mouse.
    let alt = false, mouse = false, inMode = false;
    try {
      const f = tmuxExec(['display-message', '-p', '-t', name,
        '#{alternate_on} #{mouse_any_flag} #{pane_in_mode}']).trim().split(' ');
      alt = f[0] === '1'; mouse = f[1] === '1'; inMode = f[2] === '1';
    } catch {}

    if (alt && direction !== 'exit') {
      if (inMode) {
        try { tmuxExec(['send-keys', '-t', name, '-X', 'cancel']); } catch {}
      }
      if (mouse) {
        const btn = direction === 'up' ? 64 : 65; // SGR wheel up/down
        tmuxExec(['send-keys', '-t', name, '-l', '--', `\x1b[<${btn};5;5M`.repeat(5)]);
      } else {
        tmuxExec(['send-keys', '-t', name, direction === 'up' ? 'PageUp' : 'PageDown']);
      }
      return { ok: true, alt: true };
    }

    if (direction === 'up') {
      tmuxExec(['copy-mode', '-t', name]);
      tmuxExec(['send-keys', '-t', name, '-X', 'halfpage-up']);
    } else if (direction === 'down') {
      try { tmuxExec(['send-keys', '-t', name, '-X', 'halfpage-down']); } catch {}
    } else if (direction === 'exit') {
      // Exit copy mode
      try { tmuxExec(['send-keys', '-t', name, '-X', 'cancel']); } catch {}
    }
    return { ok: true, alt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listDir(dirPath) {
  try {
    const resolved = path.resolve(dirPath || HOME);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip hidden by default
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    dirs.sort();
    files.sort();
    return { ok: true, path: resolved, dirs, files };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listDirAll(dirPath) {
  try {
    const resolved = path.resolve(dirPath || HOME);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    dirs.sort();
    files.sort();
    return { ok: true, path: resolved, dirs, files };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function readFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(HOME)) {
      return { ok: false, error: 'Access denied' };
    }
    const stat = fs.statSync(resolved);
    if (stat.size > 1024 * 1024) {
      return { ok: false, error: 'File too large (max 1MB)' };
    }
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, content, name: path.basename(resolved), path: resolved };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- HTTP server ---

// --- Upload directory ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type']?.match(/boundary=(.+)/)?.[1];
    if (!boundary) return reject(new Error('No boundary'));
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const sep = Buffer.from('--' + boundary);
      const parts = [];
      let start = 0;
      while (true) {
        const idx = buf.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) {
          // Extract part between previous boundary and this one
          // Skip \r\n after boundary, and \r\n before next boundary
          let partStart = start;
          let partEnd = idx - 2; // skip trailing \r\n
          if (partEnd > partStart) {
            const partBuf = buf.slice(partStart, partEnd);
            const headerEnd = partBuf.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
              const headers = partBuf.slice(0, headerEnd).toString();
              const body = partBuf.slice(headerEnd + 4);
              const nameMatch = headers.match(/name="([^"]+)"/);
              const filenameMatch = headers.match(/filename="([^"]+)"/);
              parts.push({
                name: nameMatch?.[1],
                filename: filenameMatch?.[1],
                data: body,
                headers,
              });
            }
          }
        }
        start = idx + sep.length + 2; // skip boundary + \r\n
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Single auth gate — covers the dashboard, every /api/* control route, and the terminal proxy
  if (!checkAuth(req)) return send401(res);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // --- Terminal reverse-proxy: /term/<session>/... -> 127.0.0.1:<ttyd-port> ---
  if (pathname.startsWith('/term/')) {
    const entry = ttydProcesses.get(termSeg(pathname));
    if (!entry) { res.writeHead(404); return res.end('No such terminal'); }
    return proxyTerminal(req, res, entry.port);
  }

  // --- API routes ---

  if (pathname === '/api/home' && req.method === 'GET') {
    return json(res, { home: HOME });
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    return json(res, tmuxList());
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxCreate(body.name || 'main', body.cwd));
  }

  if (pathname === '/api/sessions' && req.method === 'PATCH') {
    const body = await parseBody(req);
    return json(res, tmuxRename(body.oldName, body.newName));
  }

  if (pathname === '/api/sessions' && req.method === 'DELETE') {
    const body = await parseBody(req);
    return json(res, tmuxKill(body.name));
  }

  if (pathname === '/api/connect' && req.method === 'POST') {
    // Ensure ttyd is running for this session, return port
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    const port = startTtyd(name);
    return json(res, { ok: true, port, host: HOST });
  }

  if (pathname === '/api/restart' && req.method === 'POST') {
    // Kill and restart ttyd for a session (tmux session preserved)
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    const restartResult = restartTtyd(name);
    return json(res, { ...restartResult, host: HOST });
  }

  if (pathname === '/api/resession' && req.method === 'POST') {
    // Kill session entirely and recreate at same directory
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    const resessionResult = resession(name);
    return json(res, { ...resessionResult, host: HOST });
  }

  if (pathname === '/api/ls' && req.method === 'POST') {
    const body = await parseBody(req);
    const showHidden = body.showHidden || false;
    return json(res, showHidden ? listDirAll(body.path) : listDir(body.path));
  }

  if (pathname === '/api/read-file' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.path) return json(res, { ok: false, error: 'path required' }, 400);
    return json(res, readFile(body.path));
  }

  if (pathname === '/api/capture' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    try {
      const text = tmuxExec(['capture-pane', '-t', name, '-p']);
      return json(res, { ok: true, text });
    } catch (e) {
      return json(res, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/send-keys' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxSendKeys(body.session, body.keys));
  }

  if (pathname === '/api/scroll' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxScroll(body.session, body.direction));
  }

  if (pathname === '/api/send-text' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxSendText(body.session, body.text));
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    try {
      const parts = await parseMultipart(req);
      const filePart = parts.find(p => p.name === 'file');
      if (!filePart || !filePart.filename) {
        return json(res, { ok: false, error: 'no file' }, 400);
      }
      // Session subdirectory for organization
      const sessionPart = parts.find(p => p.name === 'session');
      const sessionName = sessionPart ? sessionPart.data.toString().replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
      const sessionDir = path.join(UPLOAD_DIR, sessionName);
      fs.mkdirSync(sessionDir, { recursive: true });
      // Sanitize filename: keep original name, prepend timestamp to avoid collisions
      const origName = filePart.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeName = `${Date.now()}_${origName}`;
      const filePath = path.join(sessionDir, safeName);
      fs.writeFileSync(filePath, filePart.data);
      // Return ~/... path so it doesn't start with / (avoids Claude Code slash command)
      const displayPath = filePath.replace(HOME, '~');
      return json(res, { ok: true, path: displayPath, name: safeName });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/send-literal' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxSendLiteral(body.session, body.text));
  }

  // --- Static files ---
  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  const safePath = pathname === '/' ? '/index.html' : pathname;
  const ext = path.extname(safePath);
  const contentType = STATIC_TYPES[ext];

  if (contentType) {
    const filePath = path.join(__dirname, safePath);
    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch {
      // fall through to 404
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

// Cleanup on exit
function cleanup() {
  for (const [name] of ttydProcesses) {
    stopTtyd(name);
  }
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// --- WebSocket upgrade proxy for ttyd terminals (/term/<session>/ws) ---
server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="ttyd-term"\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const pathname = req.url.split('?')[0];
  if (!pathname.startsWith('/term/')) return socket.destroy();
  const entry = ttydProcesses.get(termSeg(pathname));
  if (!entry) return socket.destroy();

  const proxyReq = http.request({
    hostname: '127.0.0.1', port: entry.port, path: req.url, method: req.method,
    headers: backendHeaders(req, entry.port),
  });
  // Guard only the connect/handshake phase; cleared once the WS is established
  const connectTimer = setTimeout(() => { proxyReq.destroy(); socket.destroy(); }, 10000);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    clearTimeout(connectTimer);
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(proxyRes.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => { proxySocket.destroy(); socket.destroy(); });
    socket.on('error', () => { socket.destroy(); proxySocket.destroy(); });
    proxySocket.on('close', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());
  });
  proxyReq.on('error', () => { clearTimeout(connectTimer); socket.destroy(); });
  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

// Restore saved tmux sessions (name + working dir) after a reboot, then persist periodically
setTimeout(() => { restoreSessionState(); saveSessionState(); }, 1000);
setInterval(saveSessionState, 30000);
