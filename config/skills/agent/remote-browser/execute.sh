#!/bin/bash
# Remote Browser Skill — control the user's real Chrome browser via
# the Crewly Chrome Extension.
#
# Sends commands to the backend /api/browser/* HTTP endpoints, which
# forward them to the Chrome Extension over WebSocket.
#
# Usage:
#   bash execute.sh '{"action":"navigate","url":"https://example.com"}'
#   bash execute.sh '{"action":"screenshot"}'
#   bash execute.sh '{"action":"read-text"}'
#   bash execute.sh '{"action":"status"}'
#   bash execute.sh --action navigate --url https://example.com
#
# Supported actions and their parameters:
#   status              — connection status (no params)
#   navigate            — { url: string }
#   screenshot          — (no params)
#   full-page-screenshot— (no params)
#   read-text           — { selector?: string }
#   click               — { selector?: string, x?: number, y?: number }
#   fill                — { selector: string, value: string }
#   type                — { selector: string, text: string, delay?: number }
#   scroll              — { direction?: string, amount?: number, selector?: string }
#   hover               — { selector: string }
#   press-key           — { key: string, modifiers?: string[] }
#   get-element         — { selector: string }
#   wait-for-selector   — { selector: string, timeout?: number }
#   execute-js          — { code: string }
#   tabs                — (no params)
#   cookies             — { domain?: string }
#   console             — { clear?: boolean }
#   local-storage       — { keys?: string[] }
#   get-interactive-elements — { textContains?: string }
#   search-text         — { text: string, exact?: boolean }
#   list-options        — { selector: string }
#   set-file-input      — { selector: string, filePaths: string[] }

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT_JSON=""
ACTION=""
URL=""
SELECTOR=""
VALUE=""
TEXT=""
CODE=""
EXTRA_PARAMS=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --action|-a)
      ACTION="$2"
      shift 2
      ;;
    --url|-u)
      URL="$2"
      shift 2
      ;;
    --selector|-s)
      SELECTOR="$2"
      shift 2
      ;;
    --value|-v)
      VALUE="$2"
      shift 2
      ;;
    --text|-t)
      TEXT="$2"
      shift 2
      ;;
    --code|-c)
      CODE="$2"
      shift 2
      ;;
    --params|-P)
      EXTRA_PARAMS="$2"
      shift 2
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: execute.sh --action navigate --url https://example.com"
      echo "       execute.sh '{\"action\":\"screenshot\"}'"
      echo ""
      echo "Actions: status, navigate, screenshot, read-text, click, fill, type,"
      echo "         scroll, hover, press-key, get-element, wait-for-selector,"
      echo "         execute-js, tabs, cookies, console, local-storage,"
      echo "         get-interactive-elements, search-text, full-page-screenshot,"
      echo "         list-options, set-file-input"
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"
        shift
      else
        error_exit "Unknown argument: $1"
      fi
      ;;
  esac
done

# Read from stdin if no input yet
if [ -z "$INPUT_JSON" ] && [ -z "$ACTION" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    ACTION="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$ACTION" ] && ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
  [ -z "$URL" ] && URL=$(printf '%s' "$INPUT" | jq -r '.url // empty')
  [ -z "$SELECTOR" ] && SELECTOR=$(printf '%s' "$INPUT" | jq -r '.selector // empty')
  [ -z "$VALUE" ] && VALUE=$(printf '%s' "$INPUT" | jq -r '.value // empty')
  [ -z "$TEXT" ] && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // empty')
  [ -z "$CODE" ] && CODE=$(printf '%s' "$INPUT" | jq -r '.code // empty')
  # Capture all extra fields from JSON input as pass-through params
  if [ -z "$EXTRA_PARAMS" ]; then
    EXTRA_PARAMS=$(printf '%s' "$INPUT" | jq -c 'del(.action, .url, .selector, .value, .text, .code) | if length == 0 then empty else . end' 2>/dev/null || true)
  fi
fi

require_param "action (--action)" "$ACTION"

# ---- Map action to HTTP method + endpoint + body ----

METHOD="POST"
ENDPOINT=""
BODY=""

case "$ACTION" in
  status)
    METHOD="GET"
    ENDPOINT="/browser/status"
    ;;
  navigate)
    require_param "url (--url)" "$URL"
    ENDPOINT="/browser/navigate"
    BODY=$(jq -n --arg url "$URL" '{url: $url}')
    ;;
  screenshot)
    ENDPOINT="/browser/screenshot"
    BODY="{}"
    ;;
  full-page-screenshot)
    ENDPOINT="/browser/full-page-screenshot"
    BODY="{}"
    ;;
  read-text)
    ENDPOINT="/browser/read-text"
    if [ -n "$SELECTOR" ]; then
      BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    else
      BODY="{}"
    fi
    ;;
  click)
    ENDPOINT="/browser/click"
    if [ -n "$SELECTOR" ]; then
      BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    elif [ -n "$EXTRA_PARAMS" ]; then
      BODY="$EXTRA_PARAMS"
    else
      BODY="{}"
    fi
    ;;
  fill)
    require_param "selector (--selector)" "$SELECTOR"
    require_param "value (--value)" "$VALUE"
    ENDPOINT="/browser/fill"
    BODY=$(jq -n --arg s "$SELECTOR" --arg v "$VALUE" '{selector: $s, value: $v}')
    ;;
  type)
    require_param "selector (--selector)" "$SELECTOR"
    require_param "text (--text)" "$TEXT"
    ENDPOINT="/browser/type"
    BODY=$(jq -n --arg s "$SELECTOR" --arg t "$TEXT" '{selector: $s, text: $t}')
    ;;
  scroll)
    ENDPOINT="/browser/scroll"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  scroll-in-element)
    ENDPOINT="/browser/scroll-in-element"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  hover)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/hover"
    BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    ;;
  press-key)
    ENDPOINT="/browser/press-key"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  get-element)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/get-element"
    BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    ;;
  wait-for-selector)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/wait-for-selector"
    BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    ;;
  execute|execute-js)
    ENDPOINT="/browser/execute-js"
    if [ -n "$CODE" ]; then
      BODY=$(jq -n --arg c "$CODE" '{code: $c}')
    else
      BODY="${EXTRA_PARAMS:-{}}"
    fi
    ;;
  tabs)
    METHOD="GET"
    ENDPOINT="/browser/tabs"
    ;;
  cookies)
    METHOD="GET"
    ENDPOINT="/browser/cookies"
    ;;
  console)
    METHOD="GET"
    ENDPOINT="/browser/console"
    ;;
  local-storage)
    ENDPOINT="/browser/local-storage"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  get-interactive-elements)
    ENDPOINT="/browser/get-interactive-elements"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  search-text)
    require_param "text (--text)" "$TEXT"
    ENDPOINT="/browser/search-text"
    BODY=$(jq -n --arg t "$TEXT" '{text: $t}')
    ;;
  list-options)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/list-options"
    BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    ;;
  set-file-input)
    ENDPOINT="/browser/set-file-input"
    BODY="${EXTRA_PARAMS:-{}}"
    ;;
  proxy-connect)
    ENDPOINT="/browser/proxy/connect"
    BODY="{}"
    ;;
  instances)
    METHOD="GET"
    ENDPOINT="/browser/instances"
    ;;
  *)
    error_exit "Unknown action: $ACTION. Run with --help for supported actions."
    ;;
esac

# ---- Execute the API call ----

if [ "$METHOD" = "GET" ]; then
  api_call GET "$ENDPOINT"
else
  api_call POST "$ENDPOINT" "$BODY"
fi
