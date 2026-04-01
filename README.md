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

## Quick Setup

### macOS

```bash
# 1. Install dependencies
brew install tmux ttyd

# 2. Clone the repository
git clone https://github.com/<your-username>/web-terminal.git
cd web-terminal

# 3. Start the server
node server.js
```

### Linux (Debian/Ubuntu)

```bash
# 1. Install Node.js 18+ (if not installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# 2. Install tmux
sudo apt-get install -y tmux

# 3. Install ttyd
# aarch64 (Raspberry Pi)
sudo curl -sL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.aarch64
sudo chmod +x /usr/local/bin/ttyd

# x86_64
# sudo curl -sL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64
# sudo chmod +x /usr/local/bin/ttyd

# 4. Clone the repository
git clone https://github.com/<your-username>/web-terminal.git
cd web-terminal

# 5. Start the server
node server.js
```

### Verify installation

```bash
node -v     # v18.0.0 以上
tmux -V     # tmux 3.x
ttyd -v     # ttyd version 1.7.x
```

After starting the server, open `http://localhost:7681` in your browser.

## Usage

```bash
# Default: listen on all interfaces, port 7681
node server.js

# Tailscale only
HOST=100.x.x.x node server.js

# Custom port
PORT=8080 node server.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | Tailscale IP (auto) | Bind address. Auto-detects Tailscale IP for secure access. Falls back to `0.0.0.0` if Tailscale is not installed. |
| `PORT` | `7681` | Web UI port |
| `TTYD_BASE_PORT` | `7700` | Starting port for ttyd instances |

## Persistent Service (Auto-start)

```bash
# Install as a persistent service (auto-detected: launchd on macOS, systemd on Linux)
./install.sh

# Custom settings
HOST=100.x.x.x PORT=8080 ./install.sh

# Uninstall
./uninstall.sh
```
