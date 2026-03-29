# Web Terminal

Mobile-friendly web terminal with tmux session management. Designed for controlling CLI tools (especially Claude Code) from a smartphone via Tailscale.

## Features

- ttyd iframe for real terminal interaction (Tab completion, arrow keys, etc.)
- Custom input area for comfortable Japanese/CJK IME input
- Special key buttons (Esc, Tab, arrows, Ctrl combos, PgUp/PgDn)
- Claude Code shortcut buttons
- File browser with cd-here
- tmux-based persistent sessions
- Responsive (mobile-first, works on tablet/desktop)

## Requirements

- Node.js 18+
- tmux
- ttyd ([install](https://github.com/tsl0922/ttyd/releases))

## Install ttyd

```bash
# Linux aarch64 (Raspberry Pi)
curl -sL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.aarch64
chmod +x /usr/local/bin/ttyd

# macOS
brew install ttyd
```

## Usage

```bash
# Default: listen on all interfaces, port 7681
node server.js

# Tailscale only
HOST=100.x.x.x node server.js

# Custom port
PORT=8080 node server.js
```

Then open `http://<host>:7681` in your browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `7681` | Web UI port |
| `TTYD_BASE_PORT` | `7700` | Starting port for ttyd instances |
