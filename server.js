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
  const proc = spawn('ttyd', [
    '-i', HOST,
    '-p', String(port),
    '-W',
    '-t', 'scrollback=0',
    '-t', 'fontFamily=MesloLGS NF,Hack Nerd Font,FiraCode Nerd Font,JetBrainsMono Nerd Font,Menlo,Monaco,Consolas,monospace',
    'tmux', 'new-session', '-A', '-s', sessionName
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
    if (direction === 'up') {
      tmuxExec(['copy-mode', '-t', name]);
      tmuxExec(['send-keys', '-t', name, '-X', 'halfpage-up']);
    } else if (direction === 'down') {
      try { tmuxExec(['send-keys', '-t', name, '-X', 'halfpage-down']); } catch {}
    } else if (direction === 'exit') {
      // Exit copy mode
      try { tmuxExec(['send-keys', '-t', name, '-X', 'cancel']); } catch {}
    }
    return { ok: true };
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

// --- HTTP server ---

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

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

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
      res.writeHead(200, { 'Content-Type': contentType });
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

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
