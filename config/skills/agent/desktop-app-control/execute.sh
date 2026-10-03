#!/usr/bin/env bash
# =============================================================================
# Desktop App Control — Crewly Skill wrapping agent-browser (Vercel Labs)
#
# Controls Electron desktop apps and Chrome browsers via CDP using
# agent-browser's accessibility snapshot + ref system.
#
# Usage:
#   bash execute.sh <subcommand> [--options...]
#
# Subcommands:
#   scan                              Scan for controllable apps
#   launch    --app NAME --port N     Launch app with CDP enabled
#   connect   --port N                Connect to app via CDP
#   snapshot  [--interactive]         Accessibility snapshot with refs
#   click     --ref @eN               Click element by ref
#   fill      --ref @eN --text TEXT   Fill element with text
#   press     --key KEY               Press keyboard key
#   type-text --text TEXT             Type text with keystrokes
#   screenshot [--output PATH]        Take screenshot
#   get-text  --ref @eN               Get text content of element
#   scroll    [--direction DIR]       Scroll (up/down/left/right)
#   tabs                              List tabs/targets
#   tab       --index N               Switch to tab by index
#   eval      --code JS               Run JavaScript
#   close                             Close browser connection
#   status                            Check agent-browser status
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${HOME}/.crewly/logs"
LOG_FILE="${LOG_DIR}/desktop-app-control.log"
# Where `scan` looks for installed apps. Overridable so the scan can be
# exercised against a fixture directory on machines without /Applications.
APPLICATIONS_DIR="${CREWLY_APPLICATIONS_DIR:-/Applications}"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
log_action() {
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $*" >> "$LOG_FILE"
}

error_exit() {
  echo "{\"error\":\"$1\"}" >&2
  exit 1
}

require_agent_browser() {
  if ! command -v agent-browser &>/dev/null; then
    error_exit "agent-browser not installed. Run: npm install -g agent-browser && agent-browser install"
  fi
}

json_escape() {
  # Escape string for JSON embedding
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()), end="")'
}

# Known apps: "name|port" format (avoid associative arrays for set -u compat)
KNOWN_ELECTRON_APPS="Slack|9222
Visual Studio Code|9223
Discord|9225
Notion|9224
Figma|9227
Spotify|9228
Postman|9229
MongoDB Compass|0
Termius|0
FloPost|0
Antigravity|0"

KNOWN_BROWSERS="Google Chrome|9226
Brave Browser|0
Microsoft Edge|0
Arc|0"

# Get default port for an app name
get_default_port() {
  local name="$1"
  local entry
  entry=$(echo "$KNOWN_ELECTRON_APPS" | grep "^${name}|" || echo "$KNOWN_BROWSERS" | grep "^${name}|" || echo "")
  if [ -n "$entry" ]; then
    echo "$entry" | cut -d'|' -f2
  else
    echo "9222"
  fi
}

# -----------------------------------------------------------------------------
# scan — Find controllable apps on this machine
# -----------------------------------------------------------------------------
do_scan() {
  log_action "scan"

  local apps_json="["
  local first=true

  # Helper to add an app entry
  _add_app() {
    local name="$1" type="$2" running="$3" port="$4" cdp="$5"
    [ "$first" = true ] && first=false || apps_json+=","
    apps_json+="{\"name\":\"$name\",\"type\":\"$type\",\"installed\":true,\"running\":$running,\"defaultPort\":$port,\"cdpActive\":$cdp}"
  }

  # Scan for Electron apps by checking framework directory
  for app_dir in "$APPLICATIONS_DIR"/*.app; do
    [ ! -d "$app_dir" ] && continue
    if [ -d "$app_dir/Contents/Frameworks/Electron Framework.framework" ]; then
      local app_name
      app_name=$(basename "$app_dir" .app)
      local running="false"
      if pgrep -f "$(basename "$app_dir")" > /dev/null 2>&1; then
        running="true"
      fi

      local port
      port=$(get_default_port "$app_name")

      local cdp_active="false"
      if [ "$port" -gt 0 ] 2>/dev/null; then
        local cdp_check
        cdp_check=$(curl -s --connect-timeout 1 "http://127.0.0.1:${port}/json/version" 2>/dev/null || echo "")
        if [ -n "$cdp_check" ]; then
          cdp_active="true"
        fi
      fi

      _add_app "$app_name" "electron" "$running" "$port" "$cdp_active"
    fi
  done

  # Scan Chrome-based browsers (inline loop, no subshell)
  local browser port
  while IFS='|' read -r browser port; do
    [ -z "$browser" ] && continue
    if [ -d "$APPLICATIONS_DIR/$browser.app" ]; then
      local running="false"
      if pgrep -f "$browser" > /dev/null 2>&1; then
        running="true"
      fi
      local cdp_active="false"
      if [ "$port" -gt 0 ] 2>/dev/null; then
        local cdp_check
        cdp_check=$(curl -s --connect-timeout 1 "http://127.0.0.1:${port}/json/version" 2>/dev/null || echo "")
        if [ -n "$cdp_check" ]; then
          cdp_active="true"
        fi
      fi
      _add_app "$browser" "browser" "$running" "$port" "$cdp_active"
    fi
  done <<< "$KNOWN_BROWSERS"

  # Probe common CDP ports
  local active_ports="["
  local first_port=true
  for probe_port in 9222 9223 9224 9225 9226 9227 9228 9229; do
    local result
    result=$(curl -s --connect-timeout 1 "http://127.0.0.1:${probe_port}/json/version" 2>/dev/null || echo "")
    if [ -n "$result" ]; then
      local browser_name
      browser_name=$(echo "$result" | jq -r '.Browser // "unknown"' 2>/dev/null || echo "unknown")
      [ "$first_port" = true ] && first_port=false || active_ports+=","
      active_ports+="{\"port\":$probe_port,\"browser\":\"$browser_name\"}"
    fi
  done
  active_ports+="]"

  apps_json+="]"
  echo "{\"success\":true,\"action\":\"scan\",\"apps\":$apps_json,\"activeCdpPorts\":$active_ports}"
}

# -----------------------------------------------------------------------------
# launch — Launch an app with CDP enabled
# Params: appName, port
# -----------------------------------------------------------------------------
do_launch() {
  local app_name="$1"
  local port="$2"

  [ -z "$app_name" ] && error_exit "Missing --app parameter"
  [ -z "$port" ] && port=$(get_default_port "$app_name")

  # Check if already running with CDP
  local cdp_check
  cdp_check=$(curl -s --connect-timeout 1 "http://127.0.0.1:${port}/json/version" 2>/dev/null || echo "")
  if [ -n "$cdp_check" ]; then
    echo "{\"success\":true,\"action\":\"launch\",\"app\":\"$app_name\",\"port\":$port,\"status\":\"already_connected\",\"message\":\"App already running with CDP on port $port\"}"
    return 0
  fi

  # Launch the app
  log_action "launch app=$app_name port=$port"
  open -a "$app_name" --args --remote-debugging-port="$port" 2>/dev/null || {
    error_exit "Failed to launch '$app_name'. Is it installed?"
  }

  # Wait for CDP to become available
  local retries=10
  while [ $retries -gt 0 ]; do
    sleep 1
    cdp_check=$(curl -s --connect-timeout 1 "http://127.0.0.1:${port}/json/version" 2>/dev/null || echo "")
    if [ -n "$cdp_check" ]; then
      local browser_name
      browser_name=$(echo "$cdp_check" | jq -r '.Browser // "unknown"' 2>/dev/null || echo "unknown")
      echo "{\"success\":true,\"action\":\"launch\",\"app\":\"$app_name\",\"port\":$port,\"browser\":\"$browser_name\",\"status\":\"launched\"}"
      return 0
    fi
    retries=$((retries - 1))
  done

  echo "{\"success\":true,\"action\":\"launch\",\"app\":\"$app_name\",\"port\":$port,\"status\":\"launched_no_cdp\",\"message\":\"App launched but CDP not yet available. The app may need to be quit first and relaunched. Try: quit the app manually, then run this command again.\"}"
}

# -----------------------------------------------------------------------------
# Subcommands that wrap agent-browser
# -----------------------------------------------------------------------------

do_connect() {
  local port="$1"
  [ -z "$port" ] && error_exit "Missing --port parameter"
  require_agent_browser
  log_action "connect port=$port"

  local session="${SESSION_NAME:-}"
  local session_flag=""
  [ -n "$session" ] && session_flag="--session $session"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag connect "$port" 2>&1) || {
    echo "{\"success\":false,\"action\":\"connect\",\"port\":$port,\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"connect\",\"port\":$port,\"output\":$(json_escape "$output")}"
}

do_snapshot() {
  require_agent_browser
  log_action "snapshot interactive=$INTERACTIVE"

  local flags=""
  [ "$INTERACTIVE" = "true" ] && flags="-i"
  [ -n "$COMPACT" ] && flags="$flags -c"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag snapshot $flags 2>&1) || {
    echo "{\"success\":false,\"action\":\"snapshot\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"snapshot\",\"output\":$(json_escape "$output")}"
}

do_click() {
  local ref="$1"
  [ -z "$ref" ] && error_exit "Missing --ref parameter"
  require_agent_browser
  log_action "click ref=$ref"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag click "$ref" 2>&1) || {
    echo "{\"success\":false,\"action\":\"click\",\"ref\":\"$ref\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"click\",\"ref\":\"$ref\",\"output\":$(json_escape "$output")}"
}

do_fill() {
  local ref="$1"
  local text="$2"
  [ -z "$ref" ] && error_exit "Missing --ref parameter"
  [ -z "$text" ] && error_exit "Missing --text parameter"
  require_agent_browser
  log_action "fill ref=$ref"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag fill "$ref" "$text" 2>&1) || {
    echo "{\"success\":false,\"action\":\"fill\",\"ref\":\"$ref\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"fill\",\"ref\":\"$ref\"}"
}

do_press() {
  local key="$1"
  [ -z "$key" ] && error_exit "Missing --key parameter"
  require_agent_browser
  log_action "press key=$key"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag press "$key" 2>&1) || {
    echo "{\"success\":false,\"action\":\"press\",\"key\":\"$key\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"press\",\"key\":\"$key\"}"
}

do_type_text() {
  local text="$1"
  [ -z "$text" ] && error_exit "Missing --text parameter"
  require_agent_browser
  log_action "type-text chars=${#text}"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag keyboard type "$text" 2>&1) || {
    echo "{\"success\":false,\"action\":\"type-text\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"type-text\",\"characters\":${#text}}"
}

do_screenshot() {
  local output_path="${1:-/tmp/desktop-app-screenshot.png}"
  require_agent_browser
  log_action "screenshot output=$output_path"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local result
  # shellcheck disable=SC2086
  result=$(agent-browser $session_flag screenshot "$output_path" 2>&1) || {
    echo "{\"success\":false,\"action\":\"screenshot\",\"error\":$(json_escape "$result")}"
    return 1
  }

  if [ -f "$output_path" ]; then
    local size
    size=$(stat -f%z "$output_path" 2>/dev/null || stat -c%s "$output_path" 2>/dev/null || echo "0")
    echo "{\"success\":true,\"action\":\"screenshot\",\"file\":\"$output_path\",\"size\":$size}"
  else
    echo "{\"success\":true,\"action\":\"screenshot\",\"output\":$(json_escape "$result")}"
  fi
}

do_get_text() {
  local ref="$1"
  [ -z "$ref" ] && error_exit "Missing --ref parameter"
  require_agent_browser
  log_action "get-text ref=$ref"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag get text "$ref" 2>&1) || {
    echo "{\"success\":false,\"action\":\"get-text\",\"ref\":\"$ref\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"get-text\",\"ref\":\"$ref\",\"text\":$(json_escape "$output")}"
}

do_scroll() {
  local direction="${1:-down}"
  local amount="${2:-}"
  require_agent_browser
  log_action "scroll direction=$direction amount=${amount:-default}"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag scroll "$direction" $amount 2>&1) || {
    echo "{\"success\":false,\"action\":\"scroll\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"scroll\",\"direction\":\"$direction\"}"
}

do_tabs() {
  require_agent_browser
  log_action "tabs"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag tab 2>&1) || {
    echo "{\"success\":false,\"action\":\"tabs\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"tabs\",\"output\":$(json_escape "$output")}"
}

do_tab_switch() {
  local index="$1"
  [ -z "$index" ] && error_exit "Missing --index parameter"
  require_agent_browser
  log_action "tab index=$index"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag tab "$index" 2>&1) || {
    echo "{\"success\":false,\"action\":\"tab\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"tab\",\"index\":$index}"
}

do_eval() {
  local code="$1"
  [ -z "$code" ] && error_exit "Missing --code parameter"
  require_agent_browser
  log_action "eval"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag eval "$code" 2>&1) || {
    echo "{\"success\":false,\"action\":\"eval\",\"error\":$(json_escape "$output")}"
    return 1
  }
  echo "{\"success\":true,\"action\":\"eval\",\"result\":$(json_escape "$output")}"
}

do_close() {
  require_agent_browser
  log_action "close"

  local session_flag=""
  [ -n "${SESSION_NAME:-}" ] && session_flag="--session $SESSION_NAME"

  local output
  # shellcheck disable=SC2086
  output=$(agent-browser $session_flag close 2>&1) || true
  echo "{\"success\":true,\"action\":\"close\"}"
}

do_status() {
  require_agent_browser
  local version
  version=$(agent-browser --version 2>&1 || echo "unknown")

  local sessions
  sessions=$(agent-browser session list 2>&1 || echo "none")

  echo "{\"success\":true,\"action\":\"status\",\"version\":$(json_escape "$version"),\"sessions\":$(json_escape "$sessions")}"
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
SUBCOMMAND="${1:-}"
shift 2>/dev/null || true

APP_NAME=""
PORT=""
REF=""
TEXT=""
KEY=""
CODE=""
OUTPUT=""
DIRECTION=""
AMOUNT=""
INDEX=""
SESSION_NAME=""
INTERACTIVE="false"
COMPACT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app)         shift; APP_NAME="${1:-}" ;;
    --port)        shift; PORT="${1:-}" ;;
    --ref)         shift; REF="${1:-}" ;;
    --text)        shift; TEXT="${1:-}" ;;
    --key)         shift; KEY="${1:-}" ;;
    --code)        shift; CODE="${1:-}" ;;
    --output)      shift; OUTPUT="${1:-}" ;;
    --direction)   shift; DIRECTION="${1:-}" ;;
    --amount)      shift; AMOUNT="${1:-}" ;;
    --index)       shift; INDEX="${1:-}" ;;
    --session)     shift; SESSION_NAME="${1:-}" ;;
    --interactive|-i) INTERACTIVE="true" ;;
    --compact|-c)  COMPACT="true" ;;
    *)             ;; # Ignore unknown args
  esac
  shift 2>/dev/null || true
done

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------
if [ -z "$SUBCOMMAND" ]; then
  cat <<'USAGE'
Usage: bash execute.sh <subcommand> [--options...]

Subcommands:
  scan                                     Scan for controllable apps
  launch      --app NAME [--port N]        Launch app with CDP enabled
  connect     --port N                     Connect to app via CDP
  snapshot    [--interactive] [--compact]   Accessibility snapshot with refs
  click       --ref @eN                    Click element by ref
  fill        --ref @eN --text TEXT        Fill element with text
  press       --key KEY                    Press keyboard key
  type-text   --text TEXT                  Type text with keystrokes
  screenshot  [--output PATH]             Take screenshot
  get-text    --ref @eN                    Get text content
  scroll      [--direction DIR] [--amount] Scroll page
  tabs                                     List tabs/targets
  tab         --index N                    Switch tab
  eval        --code 'JS'                  Run JavaScript
  close                                    Close connection
  status                                   Check agent-browser status

Options:
  --session NAME    Use named session (for multi-app control)
USAGE
  exit 1
fi

case "$SUBCOMMAND" in
  scan)        do_scan ;;
  launch)      do_launch "$APP_NAME" "$PORT" ;;
  connect)     do_connect "$PORT" ;;
  snapshot)    do_snapshot ;;
  click)       do_click "$REF" ;;
  fill)        do_fill "$REF" "$TEXT" ;;
  press)       do_press "$KEY" ;;
  type-text)   do_type_text "$TEXT" ;;
  screenshot)  do_screenshot "$OUTPUT" ;;
  get-text)    do_get_text "$REF" ;;
  scroll)      do_scroll "$DIRECTION" "$AMOUNT" ;;
  tabs)        do_tabs ;;
  tab)         do_tab_switch "$INDEX" ;;
  eval)        do_eval "$CODE" ;;
  close)       do_close ;;
  status)      do_status ;;
  *)           error_exit "Unknown subcommand: $SUBCOMMAND" ;;
esac
