#!/bin/bash
# Crewly installer — one-liner install script
#
# Usage:
#   curl -fsSL https://crewlyai.com/install.sh | bash
#   curl -fsSL https://crewlyai.com/install.sh | bash -s -- --harness codex --yes
#
# Options (passed through to `crewly onboard`):
#   --harness <id>   Harness for the orchestrator: claude (default), codex, gemini
#   --yes            No prompts: defaults everywhere; prints the login link for your phone
#   --web            Continue setup in the web app
#   --cli            Continue setup in this terminal
#
# What it does:
#   1. Detects OS (macOS / Linux only)
#   2. Ensures Node.js >= 22 is available (offers nvm install if missing)
#   3. Installs crewly globally via npm
#   4. Runs `crewly onboard` to complete setup (harness, login, skills, team)
#
# Only jq is needed besides Node.js (agent sessions use node-pty; no tmux).
#
# NOTE: web/public/install.sh (crewlyai.com) is a copy of this file; keep them in sync.
#
# Under `curl ... | bash` this script arrives on stdin, so nothing here may
# read answers from stdin: prompts read from the terminal (/dev/tty). With no
# terminal at all the script stops with a non-zero exit and the command to
# run next, rather than "finishing" with nothing set up (#772).

set -euo pipefail

# ========================= Arguments =========================

# Flags forwarded to `crewly onboard`.
ONBOARD_ARGS=()
AUTO_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --harness)
      if [ $# -lt 2 ]; then
        echo "--harness needs a value: claude, codex or gemini" >&2
        exit 2
      fi
      ONBOARD_ARGS+=("--harness" "$2")
      shift 2
      ;;
    --harness=*)
      ONBOARD_ARGS+=("--harness" "${1#--harness=}")
      shift
      ;;
    -y|--yes)
      ONBOARD_ARGS+=("--yes")
      AUTO_YES=1
      shift
      ;;
    --web|--cli)
      ONBOARD_ARGS+=("$1")
      shift
      ;;
    *)
      echo "Unknown option: $1 (supported: --harness <id>, --yes, --web, --cli)" >&2
      exit 2
      ;;
  esac
done

# ========================= Colors =========================

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ========================= Banner =========================

echo ""
echo -e "${CYAN}"
echo "   ____                    _"
echo "  / ___|_ __ _____      _| |_   _"
echo " | |   | '__/ _ \\ \\ /\\ / / | | | |"
echo " | |___| | |  __/\\ V  V /| | |_| |"
echo "  \\____|_|  \\___| \\_/\\_/ |_|\\__, |"
echo "                              |___/"
echo -e "${NC}"
echo -e "${BOLD}  Quick Install${NC}"
echo ""

# ========================= OS Detection =========================

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    echo -e "${GREEN}  ✓ macOS detected (${ARCH})${NC}"
    ;;
  Linux)
    echo -e "${GREEN}  ✓ Linux detected (${ARCH})${NC}"
    ;;
  *)
    echo -e "${RED}  ✗ Unsupported OS: ${OS}${NC}"
    echo -e "  Use ${CYAN}npm install -g crewly${NC} instead."
    exit 1
    ;;
esac

# ========================= Terminal =========================

# True when a terminal can be opened for prompts. `[ -t 0 ]` is not enough:
# under `curl | bash` stdin is the pipe even when a terminal is present.
has_tty() {
  ( : </dev/tty ) 2>/dev/null
}

# ========================= Node.js Check =========================

MIN_NODE_VERSION=22

check_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge "$MIN_NODE_VERSION" ]; then
      echo -e "${GREEN}  ✓ Node.js $(node -v) detected${NC}"
      return 0
    else
      echo -e "${YELLOW}  ⚠ Node.js $(node -v) is too old (need >= ${MIN_NODE_VERSION})${NC}"
      return 1
    fi
  else
    echo -e "${YELLOW}  ⚠ Node.js not found${NC}"
    return 1
  fi
}

install_node_via_nvm() {
  echo -e "${BLUE}  Installing Node.js via nvm...${NC}"

  # Check if nvm is already installed
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo -e "${BLUE}  Installing nvm...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # Load nvm
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  nvm install --lts
  nvm use --lts

  echo -e "${GREEN}  ✓ Node.js $(node -v) installed via nvm${NC}"
}

if ! check_node; then
  echo ""
  echo -e "  Node.js >= ${MIN_NODE_VERSION} is required."
  if ! has_tty; then
    echo -e "${RED}  ✗ No terminal to ask whether to install Node.js via nvm.${NC}"
    echo -e "  Install Node.js >= ${MIN_NODE_VERSION} from https://nodejs.org, then run this installer again."
    exit 1
  fi
  echo -e "  Would you like to install Node.js via nvm? [Y/n] "
  # Read from the terminal: stdin is this script when piped from curl.
  read -r REPLY </dev/tty || REPLY=""
  REPLY="${REPLY:-Y}"

  if [[ "$REPLY" =~ ^[Yy]$ ]] || [[ -z "$REPLY" ]]; then
    install_node_via_nvm
  else
    echo -e "${RED}  ✗ Node.js is required. Install it from https://nodejs.org${NC}"
    exit 1
  fi
fi

echo ""

# ========================= npm Check =========================

if ! command -v npm &>/dev/null; then
  echo -e "${RED}  ✗ npm not found. It should come with Node.js.${NC}"
  echo -e "  Please reinstall Node.js from https://nodejs.org"
  exit 1
fi

# ========================= Install Crewly =========================

echo -e "${BLUE}  Installing Crewly...${NC}"

if npm install -g crewly; then
  echo -e "${GREEN}  ✓ Crewly installed${NC}"
else
  echo -e "${RED}  ✗ Failed to install Crewly.${NC}"
  echo -e "  Try running: ${CYAN}sudo npm install -g crewly${NC}"
  exit 1
fi

echo ""

# ========================= Run Onboarding =========================

# The wizard must read answers from the terminal, not from stdin: under
# `curl | bash` stdin is the rest of this script, every prompt got EOF and the
# install exited 0 with nothing configured (#772). `--yes` never prompts, so it
# runs without a terminal (agents, CI, SSH without a tty).
# ${ONBOARD_ARGS[@]+...} keeps `set -u` happy on bash 3.2 when no flags were given.
if [ "$AUTO_YES" -eq 1 ]; then
  echo -e "${BLUE}  Running setup with defaults (--yes)...${NC}"
  echo ""
  crewly onboard ${ONBOARD_ARGS[@]+"${ONBOARD_ARGS[@]}"} </dev/null
elif [ -t 0 ]; then
  echo -e "${BLUE}  Launching setup wizard...${NC}"
  echo ""
  crewly onboard ${ONBOARD_ARGS[@]+"${ONBOARD_ARGS[@]}"}
elif has_tty; then
  echo -e "${BLUE}  Launching setup wizard...${NC}"
  echo ""
  crewly onboard ${ONBOARD_ARGS[@]+"${ONBOARD_ARGS[@]}"} </dev/tty
else
  echo -e "${RED}  ✗ Crewly is installed, but setup did not run: no terminal is available for the setup wizard.${NC}"
  echo -e "  Run the wizard from a terminal:            ${CYAN}crewly onboard${NC}"
  echo -e "  Or set up with defaults, no prompts:       ${CYAN}crewly onboard --yes${NC}"
  exit 1
fi
