#!/usr/bin/env bash
# Crewly Git Hooks Installer
#
# Copies Crewly git hooks into the project's .git/hooks/ directory.
# Safe to run multiple times — existing Crewly hooks are overwritten,
# non-Crewly hooks are preserved with a backup.
#
# Usage:
#   bash config/hooks/install-hooks.sh
#   bash config/hooks/install-hooks.sh /path/to/project

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# Resolve project root
if [ -n "${1:-}" ]; then
  PROJECT_ROOT="$1"
else
  # Find the repo root relative to this script
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

HOOKS_SOURCE="$PROJECT_ROOT/config/hooks"
HOOKS_TARGET="$PROJECT_ROOT/.git/hooks"

# Validate we're in a git repo
if [ ! -d "$PROJECT_ROOT/.git" ]; then
  echo -e "${RED}[CREWLY] Error: $PROJECT_ROOT is not a git repository${NC}"
  echo -e "${RED}[CREWLY] Run this script from the project root or pass the path as an argument${NC}"
  exit 1
fi

# Validate source hooks exist
if [ ! -d "$HOOKS_SOURCE" ]; then
  echo -e "${RED}[CREWLY] Error: Hooks source directory not found at $HOOKS_SOURCE${NC}"
  exit 1
fi

# Create hooks target directory if needed
mkdir -p "$HOOKS_TARGET"

# Track what we install
INSTALLED=0

# Install each hook
for HOOK_FILE in "$HOOKS_SOURCE"/*; do
  HOOK_NAME=$(basename "$HOOK_FILE")

  # Skip this installer script and non-executable hook files
  if [ "$HOOK_NAME" = "install-hooks.sh" ]; then
    continue
  fi

  TARGET_PATH="$HOOKS_TARGET/$HOOK_NAME"

  # If a non-Crewly hook already exists, back it up
  if [ -f "$TARGET_PATH" ]; then
    if grep -q "CREWLY" "$TARGET_PATH" 2>/dev/null; then
      # Existing Crewly hook — overwrite silently
      :
    else
      # Non-Crewly hook — back up before overwriting
      BACKUP_PATH="${TARGET_PATH}.pre-crewly.bak"
      cp "$TARGET_PATH" "$BACKUP_PATH"
      echo -e "${YELLOW}[CREWLY] Backed up existing ${HOOK_NAME} to ${HOOK_NAME}.pre-crewly.bak${NC}"
    fi
  fi

  # Copy and make executable
  cp "$HOOK_FILE" "$TARGET_PATH"
  chmod +x "$TARGET_PATH"
  INSTALLED=$((INSTALLED + 1))
  echo -e "${GREEN}[CREWLY] Installed hook: ${HOOK_NAME}${NC}"
done

if [ "$INSTALLED" -eq 0 ]; then
  echo -e "${YELLOW}[CREWLY] No hooks found to install${NC}"
else
  echo ""
  echo -e "${GREEN}[CREWLY] Successfully installed ${INSTALLED} hook(s)${NC}"
  echo -e "${GREEN}[CREWLY] Hooks are active in: ${HOOKS_TARGET}${NC}"
fi
