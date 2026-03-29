const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '7681');
const TTYD_BASE_PORT = parseInt(process.env.TTYD_BASE_PORT || '7700');

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
    try { process.kill(entry.process.pid); } catch {}
    ttydProcesses.delete(sessionName);
  }
}

// --- tmux helpers ---

function tmuxList() {
  try {
    const out = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean).map(name => {
      const ttyd = ttydProcesses.get(name);
      return { name, port: ttyd ? ttyd.port : null };
    });
  } catch {
    return [];
  }
}

function tmuxCreate(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  // startTtyd will create tmux session via "tmux new-session -A -s"
  const port = startTtyd(safeName);
  return { ok: true, name: safeName, port };
}

function tmuxKill(name) {
  stopTtyd(name);
  try {
    execSync(`tmux kill-session -t "${name}"`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendKeys(name, keys) {
  try {
    execSync(`tmux send-keys -t "${name}" ${keys}`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendText(name, text) {
  try {
    execSync(`tmux send-keys -t "${name}" -l -- ${JSON.stringify(text)}`, { encoding: 'utf8', timeout: 5000 });
    execSync(`tmux send-keys -t "${name}" Enter`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxSendLiteral(name, text) {
  try {
    execSync(`tmux send-keys -t "${name}" -l -- ${JSON.stringify(text)}`, { encoding: 'utf8', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tmuxScroll(name, direction) {
  try {
    if (direction === 'up') {
      execSync(`tmux copy-mode -t "${name}" && tmux send-keys -t "${name}" -X halfpage-up`, { encoding: 'utf8', timeout: 5000 });
    } else if (direction === 'down') {
      execSync(`tmux send-keys -t "${name}" -X halfpage-down 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
    } else if (direction === 'exit') {
      // Exit copy mode
      execSync(`tmux send-keys -t "${name}" -X cancel 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
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
    return json(res, tmuxCreate(body.name || 'main'));
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
