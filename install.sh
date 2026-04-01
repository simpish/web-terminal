#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# Configuration — override via environment variables or edit here
# ---------------------------------------------------------------------------
# Tailscale IP auto-detection: bind to Tailscale only by default for security
if [[ -z "${HOST:-}" ]]; then
    TAILSCALE_IP="$(tailscale ip -4 2>/dev/null || true)"
    if [[ -n "${TAILSCALE_IP}" ]]; then
        HOST="${TAILSCALE_IP}"
        info "Auto-detected Tailscale IP: ${HOST} (binding to Tailscale only)"
    else
        HOST="0.0.0.0"
        warn "Tailscale not found. Binding to 0.0.0.0 (all interfaces)."
        warn "This exposes the server to your local network!"
        warn "Set HOST=<tailscale-ip> or install Tailscale for secure access."
    fi
else
    HOST="${HOST}"
fi
PORT="${PORT:-7681}"
TTYD_BASE_PORT="${TTYD_BASE_PORT:-7700}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_JS="${SCRIPT_DIR}/server.js"
NODE_PATH="$(which node 2>/dev/null || true)"

LOG_DIR="${HOME}/.local/log/web-terminal"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
header "Checking dependencies..."

MISSING=()

if [[ -z "${NODE_PATH}" ]]; then
    MISSING+=("node")
else
    info "node   : ${NODE_PATH} ($(node --version))"
fi

if ! command -v tmux &>/dev/null; then
    MISSING+=("tmux")
else
    info "tmux   : $(which tmux) ($(tmux -V))"
fi

if ! command -v ttyd &>/dev/null; then
    MISSING+=("ttyd")
else
    info "ttyd   : $(which ttyd)"
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
    error "Missing required dependencies: ${MISSING[*]}"
    echo ""
    echo "  macOS  : brew install ${MISSING[*]}"
    echo "  Debian : sudo apt-get install -y ${MISSING[*]}"
    echo "           (for ttyd see https://github.com/tsl0922/ttyd/releases)"
    exit 1
fi

if [[ ! -f "${SERVER_JS}" ]]; then
    error "server.js not found at ${SERVER_JS}"
    exit 1
fi

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"

header "Detected OS: ${OS}"

# ---------------------------------------------------------------------------
# macOS — launchd
# ---------------------------------------------------------------------------
install_macos() {
    local PLIST_DIR="${HOME}/Library/LaunchAgents"
    local PLIST_FILE="${PLIST_DIR}/com.web-terminal.plist"
    local LOG_OUT="${LOG_DIR}/stdout.log"
    local LOG_ERR="${LOG_DIR}/stderr.log"

    info "Creating log directory: ${LOG_DIR}"
    mkdir -p "${LOG_DIR}"

    info "Creating LaunchAgent plist: ${PLIST_FILE}"
    mkdir -p "${PLIST_DIR}"

    # Build PATH that includes actual locations of all required binaries
    local EXTRA_PATHS=""
    for cmd in node tmux ttyd; do
        local cmd_dir
        cmd_dir="$(dirname "$(which "$cmd")")"
        EXTRA_PATHS="${EXTRA_PATHS:+${EXTRA_PATHS}:}${cmd_dir}"
    done
    # Deduplicate and merge with standard paths
    local SERVICE_PATH
    SERVICE_PATH="$(echo "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${EXTRA_PATHS}" | tr ':' '\n' | awk '!seen[$0]++' | tr '\n' ':' | sed 's/:$//')"

    cat > "${PLIST_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.web-terminal</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SERVER_JS}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOST</key>
        <string>${HOST}</string>
        <key>PORT</key>
        <string>${PORT}</string>
        <key>TTYD_BASE_PORT</key>
        <string>${TTYD_BASE_PORT}</string>
        <key>PATH</key>
        <string>${SERVICE_PATH}</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
        <key>LC_ALL</key>
        <string>en_US.UTF-8</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>

    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

    # Unload first if already loaded (ignore errors)
    launchctl unload "${PLIST_FILE}" 2>/dev/null || true

    info "Registering and starting service via launchctl..."
    launchctl load "${PLIST_FILE}"

    header "Installation complete!"
    echo ""
    echo -e "  ${BOLD}Access URL      :${RESET} http://${HOST}:${PORT}"
    if [[ "${HOST}" == "0.0.0.0" ]]; then
        LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || echo "<your-ip>")"
        echo -e "  ${BOLD}Local network   :${RESET} http://${LOCAL_IP}:${PORT}"
    fi
    echo ""
    echo -e "  ${BOLD}Stop service    :${RESET} launchctl unload ~/Library/LaunchAgents/com.web-terminal.plist"
    echo -e "  ${BOLD}Start service   :${RESET} launchctl load   ~/Library/LaunchAgents/com.web-terminal.plist"
    echo -e "  ${BOLD}Uninstall       :${RESET} ./uninstall.sh"
    echo ""
    echo -e "  ${BOLD}Logs (stdout)   :${RESET} ${LOG_DIR}/stdout.log"
    echo -e "  ${BOLD}Logs (stderr)   :${RESET} ${LOG_DIR}/stderr.log"
    echo -e "  ${BOLD}Follow logs     :${RESET} tail -f ${LOG_DIR}/stdout.log ${LOG_DIR}/stderr.log"
    echo ""
}

# ---------------------------------------------------------------------------
# Linux — systemd (user service)
# ---------------------------------------------------------------------------
install_linux() {
    local UNIT_DIR="${HOME}/.config/systemd/user"
    local UNIT_FILE="${UNIT_DIR}/web-terminal.service"
    local LOG_OUT="${LOG_DIR}/stdout.log"
    local LOG_ERR="${LOG_DIR}/stderr.log"

    info "Creating log directory: ${LOG_DIR}"
    mkdir -p "${LOG_DIR}"

    info "Creating systemd user unit: ${UNIT_FILE}"
    mkdir -p "${UNIT_DIR}"

    # Build PATH that includes actual locations of all required binaries
    local EXTRA_PATHS=""
    for cmd in node tmux ttyd; do
        local cmd_dir
        cmd_dir="$(dirname "$(which "$cmd")")"
        EXTRA_PATHS="${EXTRA_PATHS:+${EXTRA_PATHS}:}${cmd_dir}"
    done
    local SERVICE_PATH
    SERVICE_PATH="$(echo "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${EXTRA_PATHS}" | tr ':' '\n' | awk '!seen[$0]++' | tr '\n' ':' | sed 's/:$//')"

    cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Web Terminal (mobile-friendly ttyd/tmux UI)
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_PATH} ${SERVER_JS}
Restart=on-failure
RestartSec=5

Environment=PATH=${SERVICE_PATH}
Environment=HOST=${HOST}
Environment=PORT=${PORT}
Environment=TTYD_BASE_PORT=${TTYD_BASE_PORT}
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

StandardOutput=append:${LOG_OUT}
StandardError=append:${LOG_ERR}

[Install]
WantedBy=default.target
EOF

    info "Enabling and starting systemd user service..."
    systemctl --user daemon-reload
    systemctl --user enable --now web-terminal

    header "Installation complete!"
    echo ""
    echo -e "  ${BOLD}Access URL      :${RESET} http://${HOST}:${PORT}"
    if [[ "${HOST}" == "0.0.0.0" ]]; then
        LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<your-ip>")"
        echo -e "  ${BOLD}Local network   :${RESET} http://${LOCAL_IP}:${PORT}"
    fi
    echo ""
    echo -e "  ${BOLD}Status          :${RESET} systemctl --user status web-terminal"
    echo -e "  ${BOLD}Stop service    :${RESET} systemctl --user stop web-terminal"
    echo -e "  ${BOLD}Start service   :${RESET} systemctl --user start web-terminal"
    echo -e "  ${BOLD}Disable autorun :${RESET} systemctl --user disable web-terminal"
    echo -e "  ${BOLD}Uninstall       :${RESET} ./uninstall.sh"
    echo ""
    echo -e "  ${BOLD}Logs (stdout)   :${RESET} ${LOG_DIR}/stdout.log"
    echo -e "  ${BOLD}Logs (stderr)   :${RESET} ${LOG_DIR}/stderr.log"
    echo -e "  ${BOLD}Follow logs     :${RESET} journalctl --user -u web-terminal -f"
    echo ""
    echo -e "  ${YELLOW}[TIP]${RESET} To keep the service running after logout:"
    echo -e "        loginctl enable-linger \$(whoami)"
    echo ""
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "${OS}" in
    Darwin)
        install_macos
        ;;
    Linux)
        install_linux
        ;;
    *)
        error "Unsupported OS: ${OS}. Only macOS and Linux are supported."
        exit 1
        ;;
esac
