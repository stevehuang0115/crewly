#!/bin/bash
# Stealth Browser Automation — Patchright + Chrome CDP
# Anti-detection browsing for platforms with bot detection (小红书, X, LinkedIn).
#
# Connects to a REAL Chrome browser via CDP (Chrome DevTools Protocol),
# avoiding headless fingerprint detection, navigator.webdriver checks, etc.
#
# Usage: execute.sh '{"url":"...","action":"read|screenshot|interact","selectors":[...]}'
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

CDP_PORT=9222
VENV_DIR="${HOME}/.crewly/patchright-venv"
PYTHON="${VENV_DIR}/bin/python3"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"url\":\"...\",\"action\":\"read|screenshot|interact\",\"selectors\":[...]}'"

URL=$(printf '%s' "$INPUT" | jq -r '.url // empty')
ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "read"')
SELECTORS_JSON=$(printf '%s' "$INPUT" | jq -c '.selectors // []')
WAIT_FOR=$(printf '%s' "$INPUT" | jq -r '.waitFor // empty')
WAIT_TIMEOUT=$(printf '%s' "$INPUT" | jq -r '.waitTimeout // empty')
CDP_PORT_OVERRIDE=$(printf '%s' "$INPUT" | jq -r '.cdpPort // empty')

require_param "url" "$URL"

[ -n "$CDP_PORT_OVERRIDE" ] && CDP_PORT="$CDP_PORT_OVERRIDE"

# ---------------------------------------------------------------------------
# Ensure patchright is installed
# ---------------------------------------------------------------------------
ensure_patchright() {
  # Create venv if it doesn't exist
  if [ ! -f "$PYTHON" ]; then
    echo '{"status":"creating_venv","path":"'"$VENV_DIR"'"}' >&2
    python3 -m venv "$VENV_DIR" \
      || error_exit "Failed to create Python venv at $VENV_DIR"
  fi

  # Install patchright if not present in venv
  if ! "$PYTHON" -c "import patchright" 2>/dev/null; then
    echo '{"status":"installing","dep":"patchright"}' >&2
    "$VENV_DIR/bin/pip" install patchright 2>/dev/null \
      || error_exit "Failed to install patchright. Run: $VENV_DIR/bin/pip install patchright"
  fi
}

# ---------------------------------------------------------------------------
# Build python command args
# ---------------------------------------------------------------------------
build_args() {
  local args=("--url" "$URL" "--action" "$ACTION" "--cdp-port" "$CDP_PORT")

  # Add wait-for selector if specified
  [ -n "$WAIT_FOR" ] && args+=("--wait-for" "$WAIT_FOR")
  [ -n "$WAIT_TIMEOUT" ] && args+=("--wait-timeout" "$WAIT_TIMEOUT")

  # Parse selectors array into individual --selectors args
  local count
  count=$(echo "$SELECTORS_JSON" | jq 'length')
  if [ "$count" -gt 0 ]; then
    args+=("--selectors")
    for i in $(seq 0 $((count - 1))); do
      local sel
      sel=$(echo "$SELECTORS_JSON" | jq -r ".[$i]")
      args+=("$sel")
    done
  fi

  echo "${args[@]}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

ensure_patchright

# Run the stealth browser script
ARGS=$(build_args)
# shellcheck disable=SC2086
"$PYTHON" "${SCRIPT_DIR}/stealth-browse.py" $ARGS
