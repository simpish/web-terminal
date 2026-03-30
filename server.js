const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HOST = process.env.HOST || '0.0.0.0';
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
  if (result.status !== 0 && result.stderr) throw new Error(result.stderr);
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
    'tmux', 'new-session', '-A', '-s', sessionName
  ], { stdio: 'ignore', detached: true });
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
  let cwd = '/home';
  try {
    cwd = safeExec(`tmux display-message -t "${sessionName}" -p '#{pane_current_path}'`).trim();
  } catch {}
  // Kill everything
  stopTtyd(sessionName);
  try { safeExec(`tmux kill-session -t "${sessionName}"`); } catch {}
  // Create fresh session and cd into the directory
  const port = startTtyd(sessionName);
  if (cwd && cwd !== '/home') {
    setTimeout(() => {
      try {
        safeExec(`tmux send-keys -t "${sessionName}" -l -- ${JSON.stringify('cd ' + cwd)}`);
        safeExec(`tmux send-keys -t "${sessionName}" Enter`);
      } catch {}
    }, 1500);
  }
  return { ok: true, port };
}

// --- tmux helpers ---

function tmuxList() {
  try {
    const out = safeExec('tmux list-sessions -F "#{session_name}"');
    return out.trim().split('\n').filter(Boolean).map(name => {
      const ttyd = ttydProcesses.get(name);
      return { name, port: ttyd ? ttyd.port : null };
    });
  } catch {
    return [];
  }
}

function tmuxCreate(name, cwd) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const port = startTtyd(safeName);
  // Send cd command after a short delay to let ttyd/tmux start
  if (cwd) {
    setTimeout(() => {
      try {
        safeExec(`tmux send-keys -t "${safeName}" -l -- ${JSON.stringify('cd ' + cwd)}`);
        safeExec(`tmux send-keys -t "${safeName}" Enter`);
      } catch {}
    }, 1500);
  }
  return { ok: true, name: safeName, port };
}

function tmuxKill(name) {
  stopTtyd(name);
  try {
    safeExec(`tmux kill-session -t "${name}"`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendKeys(name, keys) {
  try {
    safeExec(`tmux send-keys -t "${name}" ${keys}`);
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
    safeExec(`tmux send-keys -t "${name}" -l -- ${JSON.stringify(chunk)}`);
  }
}

function tmuxSendText(name, text) {
  try {
    tmuxSendChunked(name, text);
    safeExec(`tmux send-keys -t "${name}" Enter`);
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
      safeExec(`tmux copy-mode -t "${name}" && tmux send-keys -t "${name}" -X halfpage-up`);
    } else if (direction === 'down') {
      safeExec(`tmux send-keys -t "${name}" -X halfpage-down 2>/dev/null || true`);
    } else if (direction === 'exit') {
      // Exit copy mode
      safeExec(`tmux send-keys -t "${name}" -X cancel 2>/dev/null || true`);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listDir(dirPath) {
  try {
    const resolved = path.resolve(dirPath || '/home');
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
    const resolved = path.resolve(dirPath || '/home');
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

  if (pathname === '/api/sessions' && req.method === 'GET') {
    return json(res, tmuxList());
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, tmuxCreate(body.name || 'main', body.cwd));
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
    return json(res, { ok: true, port });
  }

  if (pathname === '/api/restart' && req.method === 'POST') {
    // Kill and restart ttyd for a session (tmux session preserved)
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    return json(res, restartTtyd(name));
  }

  if (pathname === '/api/resession' && req.method === 'POST') {
    // Kill session entirely and recreate at same directory
    const body = await parseBody(req);
    const name = body.session;
    if (!name) return json(res, { error: 'session required' }, 400);
    return json(res, resession(name));
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
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
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
