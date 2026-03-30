# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Mobile-friendly web terminal for controlling CLI tools (especially Claude Code) from a smartphone via Tailscale. Wraps ttyd in an iframe with a custom UI for session management, CJK/IME input, and special key buttons.

## Running

```bash
node server.js                    # default: 0.0.0.0:7681
HOST=100.x.x.x PORT=8080 node server.js  # custom bind
```

Requires: Node.js 18+, tmux, ttyd (external binary).

## Architecture

Two-file application — `server.js` (Node.js HTTP server) and `index.html` (single-page frontend).

**server.js**: Vanilla Node.js HTTP server (no frameworks, no package.json). Manages ttyd child processes and tmux sessions. Each session gets a ttyd process on an auto-assigned port (starting at TTYD_BASE_PORT=7700). API routes:
- `GET/POST/DELETE /api/sessions` — list/create/kill tmux sessions
- `POST /api/connect` — ensure ttyd is running for a session, returns port
- `POST /api/send-keys`, `/api/send-text`, `/api/send-literal` — send input to tmux
- `POST /api/scroll` — tmux copy-mode scrolling (up/down/exit)
- `POST /api/ls` — file browser directory listing

**index.html**: Self-contained SPA (HTML+CSS+JS, no build step). Dark theme, mobile-first layout with:
- Slide-out sidebar with two tabs: session list and file browser
- ttyd iframe for terminal display
- Bottom bar with scrollable key buttons (special keys, Ctrl combos, Claude Code shortcuts)
- Text input area with Send (literal) and Run (+ Enter) buttons
- Claude shortcut row (toggled) for common Claude Code commands

The frontend communicates with the server exclusively via JSON fetch calls to `/api/*` endpoints. Terminal interaction flows through tmux — the UI sends keystrokes/text to tmux, which forwards them to the shell running inside ttyd.
