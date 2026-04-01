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

info()   { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()   { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()  { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

LOG_DIR="${HOME}/.local/log/web-terminal"

# ---------------------------------------------------------------------------
# Confirmation prompt helper
# ---------------------------------------------------------------------------
confirm() {
    local prompt="$1"
    local answer
    read -r -p "$(echo -e "${YELLOW}${prompt}${RESET} [y/N] ")" answer
    [[ "${answer,,}" == "y" ]]
}

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"

header "Detected OS: ${OS}"

# ---------------------------------------------------------------------------
# macOS — launchd
# ---------------------------------------------------------------------------
uninstall_macos() {
    local PLIST_FILE="${HOME}/Library/LaunchAgents/com.web-terminal.plist"

    if [[ ! -f "${PLIST_FILE}" ]]; then
        warn "LaunchAgent plist not found: ${PLIST_FILE}"
        warn "Nothing to uninstall for macOS launchd."
        return
    fi

    echo ""
    echo -e "  Plist file : ${PLIST_FILE}"
    echo ""

    if ! confirm "Stop and remove the web-terminal LaunchAgent?"; then
        info "Aborted. No changes were made."
        exit 0
    fi

    info "Unloading LaunchAgent..."
    launchctl unload "${PLIST_FILE}" 2>/dev/null && info "Service stopped." || warn "Service was not running (or already stopped)."

    info "Removing plist file..."
    rm -f "${PLIST_FILE}"
    info "Plist removed: ${PLIST_FILE}"
}

# ---------------------------------------------------------------------------
# Linux — systemd
# ---------------------------------------------------------------------------
uninstall_linux() {
    local UNIT_FILE="${HOME}/.config/systemd/user/web-terminal.service"

    if [[ ! -f "${UNIT_FILE}" ]]; then
        warn "systemd unit file not found: ${UNIT_FILE}"
        warn "Nothing to uninstall for Linux systemd."
        return
    fi

    echo ""
    echo -e "  Unit file  : ${UNIT_FILE}"
    echo ""

    if ! confirm "Stop, disable, and remove the web-terminal systemd user service?"; then
        info "Aborted. No changes were made."
        exit 0
    fi

    info "Stopping and disabling service..."
    systemctl --user disable --now web-terminal 2>/dev/null && info "Service stopped and disabled." || warn "Service was not running (or already stopped)."

    info "Reloading systemd daemon..."
    systemctl --user daemon-reload

    info "Removing unit file..."
    rm -f "${UNIT_FILE}"
    info "Unit file removed: ${UNIT_FILE}"
}

# ---------------------------------------------------------------------------
# Log removal (common for both OS)
# ---------------------------------------------------------------------------
remove_logs() {
    if [[ ! -d "${LOG_DIR}" ]]; then
        return
    fi

    echo ""
    echo -e "  Log directory : ${LOG_DIR}"
    if confirm "Also delete log files in ${LOG_DIR}?"; then
        rm -rf "${LOG_DIR}"
        info "Logs removed: ${LOG_DIR}"
    else
        info "Logs kept: ${LOG_DIR}"
    fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "${OS}" in
    Darwin)
        uninstall_macos
        remove_logs
        ;;
    Linux)
        uninstall_linux
        remove_logs
        ;;
    *)
        error "Unsupported OS: ${OS}. Only macOS and Linux are supported."
        exit 1
        ;;
esac

header "Uninstall complete."
echo ""
info "web-terminal service has been removed."
echo ""
