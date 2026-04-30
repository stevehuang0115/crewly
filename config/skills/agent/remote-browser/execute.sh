#!/bin/bash
# Remote Browser Skill — control the user's real Chrome browser via
# the Crewly Chrome Extension.
#
# Sends commands to the backend /api/browser/* HTTP endpoints, which
# forward them to the Chrome Extension over WebSocket.
#
# Per-tab dispatch (§3.2 of the per-tab-fix spec):
#   When `CREWLY_SESSION_NAME` is set in the agent's environment,
#   `_common/lib.sh::api_call` automatically forwards it as the
#   `X-Agent-Session` header. Backend uses this to dispatch each
#   command to the agent's bound Chrome tab instead of the user's
#   currently-active tab.
#
#   The first command from a fresh agent triggers backend auto-bind
#   (creates a new background tab). The skill caches the resulting
#   tabId in `~/.crewly/runtime/<agentSession>/browser-tab-id` so
#   subsequent calls skip the auto-bind round-trip.
#
#   Backward compat: when `CREWLY_SESSION_NAME` is unset OR the
#   `--no-bind` flag is given, behavior reverts to the legacy
#   active-tab path (existing scripts work unchanged).
#
# Usage:
#   bash execute.sh '{"action":"navigate","url":"https://example.com"}'
#   bash execute.sh '{"action":"screenshot"}'
#   bash execute.sh '{"action":"read-text"}'
#   bash execute.sh '{"action":"status"}'
#   bash execute.sh --action navigate --url https://example.com
#
# Per-tab actions:
#   bind-tab            — Explicitly bind a tab for this agent.
#                         Returns { tabId }. Caches tabId locally.
#                         Optional flag: --active (foreground new tab; default off)
#   unbind-tab          — Release this agent's bound tab and (by
#                         default) close it.
#
# Per-tab flags (apply to any action):
#   --tab-id <number>   Pin the call to a specific tabId. Skips
#                       binding lookup. Used for tests + debugging.
#   --no-bind           Force the legacy active-tab path for this
#                       call (drops the X-Agent-Session header).
#   --active            Only meaningful with `bind-tab`: foreground
#                       the new tab on creation.
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
#   select-option       — { selector: string, value?: string, label?: string,
#                           index?: number, strategy?: "native" | "aria" }
#   set-file-input      — { selector: string, filePaths: string[] }
#   bind-tab            — bind a fresh tab for this agent
#   unbind-tab          — release this agent's bound tab

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
TAB_ID=""        # --tab-id <N>: explicit override
NO_BIND="false"  # --no-bind: drop X-Agent-Session for this call
FOREGROUND="false" # --active: only meaningful with bind-tab

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
    --tab-id)
      TAB_ID="$2"
      shift 2
      ;;
    --no-bind)
      NO_BIND="true"
      shift
      ;;
    --active)
      FOREGROUND="true"
      shift
      ;;
    --help|-h)
      echo "Usage: execute.sh --action navigate --url https://example.com"
      echo "       execute.sh '{\"action\":\"screenshot\"}'"
      echo ""
      echo "Actions: status, navigate, screenshot, read-text, click, fill, type,"
      echo "         scroll, hover, press-key, get-element, wait-for-selector,"
      echo "         execute-js, tabs, cookies, console, local-storage,"
      echo "         get-interactive-elements, search-text, full-page-screenshot,"
      echo "         list-options, select-option, set-file-input"
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
  # Per-tab dispatch fields surfaced in JSON input. CLI flags win over JSON
  # (CLI is more explicit). Empty string = "not provided".
  if [ -z "$TAB_ID" ]; then
    TAB_ID=$(printf '%s' "$INPUT" | jq -r '.tabId // empty')
  fi
  if [ "$NO_BIND" = "false" ]; then
    json_no_bind=$(printf '%s' "$INPUT" | jq -r '.noBind // empty')
    [ "$json_no_bind" = "true" ] && NO_BIND="true"
  fi
  if [ "$FOREGROUND" = "false" ]; then
    json_active=$(printf '%s' "$INPUT" | jq -r '.active // empty')
    [ "$json_active" = "true" ] && FOREGROUND="true"
  fi
  # Capture all extra fields from JSON input as pass-through params (strip
  # per-tab fields too — they're handled by the dedicated branches below).
  if [ -z "$EXTRA_PARAMS" ]; then
    EXTRA_PARAMS=$(printf '%s' "$INPUT" | jq -c 'del(.action, .url, .selector, .value, .text, .code, .tabId, .noBind, .active) | if length == 0 then empty else . end' 2>/dev/null || true)
  fi
fi

require_param "action (--action)" "$ACTION"

# ---- Per-tab dispatch helpers (§3.2) ----
#
# Cache file lives under each agent's runtime dir so concurrent agents on
# the same machine don't stomp each other:
#   ~/.crewly/runtime/<agentSession>/browser-tab-id
#
# Override-able via $CREWLY_RUNTIME_DIR for test harnesses.
_tab_cache_path() {
  local agent_session="${1:-}"
  [ -z "$agent_session" ] && return 1
  local runtime_dir="${CREWLY_RUNTIME_DIR:-${HOME}/.crewly/runtime}"
  printf '%s/%s/browser-tab-id' "$runtime_dir" "$agent_session"
}

_load_cached_tab() {
  local cache_path
  cache_path=$(_tab_cache_path "${CREWLY_SESSION_NAME:-}") || return 1
  [ -f "$cache_path" ] || return 1
  local cached
  cached=$(cat "$cache_path" 2>/dev/null | tr -d '[:space:]')
  # Reject non-numeric / empty caches as a defensive measure.
  if [[ "$cached" =~ ^[0-9]+$ ]]; then
    printf '%s' "$cached"
    return 0
  fi
  return 1
}

_store_cached_tab() {
  local tab_id="$1"
  local cache_path
  cache_path=$(_tab_cache_path "${CREWLY_SESSION_NAME:-}") || return 1
  mkdir -p "$(dirname "$cache_path")" 2>/dev/null || true
  printf '%s' "$tab_id" > "$cache_path"
}

_purge_cached_tab() {
  local cache_path
  cache_path=$(_tab_cache_path "${CREWLY_SESSION_NAME:-}") || return 0
  rm -f "$cache_path" 2>/dev/null || true
}

# Returns the JSON body to send: $1 if non-empty, otherwise the canonical
# empty-object literal `{}`. This replaces the `${EXTRA_PARAMS:-{}}` pattern,
# which is mis-parsed by bash: the closing `}` of the parameter expansion is
# the FIRST `}` it sees, so `${EXTRA_PARAMS:-{}}` becomes `${EXTRA_PARAMS:-{}`
# (default = the literal `{`) followed by a stray literal `}`. The bug only
# surfaces when EXTRA_PARAMS is set — then the body is `<value>}` with a
# trailing extra `}` that fails JSON parse server-side, triggering 400 errors
# on scroll / press-key / local-storage / get-interactive-elements / set-file-input
# / scroll-in-element / execute-js fallback. When EXTRA_PARAMS is empty, the
# bug masks itself by accident (the `{` default + stray `}` happen to spell
# `{}`).
#
# @stdout the JSON body string (no trailing newline)
# @example  BODY=$(_body_or_empty "$EXTRA_PARAMS")
_body_or_empty() {
  local v="${1:-}"
  if [ -n "$v" ]; then
    printf '%s' "$v"
  else
    printf '%s' '{}'
  fi
}

# Inject `tabId` into a JSON body if we have one, leaving an explicit override
# alone. Reads BODY as input, sets BODY to the augmented version. Always emits
# compact (single-line) JSON via `jq -c` so downstream consumers and test
# assertions see a stable wire shape.
_augment_body_with_tab_id() {
  local tab_id="$1"
  if [ -z "$tab_id" ]; then return 0; fi
  if [ -z "$BODY" ] || [ "$BODY" = "{}" ]; then
    BODY=$(jq -n -c --argjson t "$tab_id" '{tabId: $t}')
  else
    BODY=$(printf '%s' "$BODY" | jq -c --argjson t "$tab_id" '. + {tabId: $t}')
  fi
}

# Effective tabId for this call: explicit --tab-id wins; otherwise look up
# the local cache when CREWLY_SESSION_NAME is set and --no-bind is NOT in
# effect. Empty string when nothing is determined.
_effective_tab_id() {
  if [ -n "$TAB_ID" ]; then
    printf '%s' "$TAB_ID"
    return 0
  fi
  if [ "$NO_BIND" = "true" ]; then
    return 0
  fi
  if [ -z "${CREWLY_SESSION_NAME:-}" ]; then
    return 0
  fi
  _load_cached_tab || true
}

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
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
    ;;
  scroll-in-element)
    ENDPOINT="/browser/scroll-in-element"
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
    ;;
  hover)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/hover"
    BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    ;;
  press-key)
    ENDPOINT="/browser/press-key"
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
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
      BODY=$(_body_or_empty "$EXTRA_PARAMS")
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
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
    ;;
  get-interactive-elements)
    ENDPOINT="/browser/get-interactive-elements"
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
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
  select-option)
    # Select an option in a native <select> by value / label / index.
    # Resolution priority: value > label > index. The selector itself is
    # always required. When --params is supplied we accept it as the
    # canonical body source (lets agents pass {label,...} or {index,...}
    # without dedicated CLI flags); otherwise we project --selector +
    # --value into the body.
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/select-option"
    if [ -n "$EXTRA_PARAMS" ]; then
      # Merge --selector into the supplied params so callers don't have
      # to duplicate it. `jq` overwrites EXTRA_PARAMS.selector if absent.
      BODY=$(printf '%s' "$EXTRA_PARAMS" | jq -c --arg s "$SELECTOR" '. + {selector: ($s)}')
    elif [ -n "$VALUE" ]; then
      BODY=$(jq -n -c --arg s "$SELECTOR" --arg v "$VALUE" '{selector: $s, value: $v}')
    else
      error_exit "select-option requires --value (or --params with value/label/index)"
    fi
    ;;
  set-file-input)
    ENDPOINT="/browser/set-file-input"
    BODY=$(_body_or_empty "$EXTRA_PARAMS")
    ;;
  proxy-connect)
    ENDPOINT="/browser/proxy/connect"
    BODY="{}"
    ;;
  instances)
    METHOD="GET"
    ENDPOINT="/browser/instances"
    ;;
  bind-tab)
    ENDPOINT="/browser/bind"
    if [ "$FOREGROUND" = "true" ]; then
      BODY=$(jq -n -c '{active: true}')
    else
      BODY="{}"
    fi
    ;;
  unbind-tab)
    ENDPOINT="/browser/unbind"
    BODY="{}"
    ;;
  *)
    error_exit "Unknown action: $ACTION. Run with --help for supported actions."
    ;;
esac

# ---- Per-tab dispatch: tabId injection + cache handling -----------------
#
# For data-plane actions (everything other than bind/unbind/status/instances),
# fold a tabId into the request body when we know one. The backend treats
# `tabId` in the body as an explicit override and skips its own binding
# lookup, so this also covers the cached-tabId fast path.
case "$ACTION" in
  status|instances|tabs|bind-tab|unbind-tab)
    : # control-plane / read-only — leave BODY alone
    ;;
  *)
    EFFECTIVE_TAB_ID=$(_effective_tab_id || true)
    if [ -n "$EFFECTIVE_TAB_ID" ]; then
      _augment_body_with_tab_id "$EFFECTIVE_TAB_ID"
    fi
    ;;
esac

# ---- Execute the API call ------------------------------------------------
#
# `--no-bind` short-circuits backend per-tab routing by stripping the
# X-Agent-Session header for this single call (api_call reads it from the
# env). Using a subshell to scope the unset.

run_api_call() {
  if [ "$METHOD" = "GET" ]; then
    api_call GET "$ENDPOINT"
  else
    api_call POST "$ENDPOINT" "$BODY"
  fi
}

if [ "$NO_BIND" = "true" ]; then
  ( unset CREWLY_SESSION_NAME; run_api_call )
  RESPONSE_EXIT=$?
else
  set +e
  RESPONSE=$(run_api_call 2>/tmp/remote-browser-stderr-$$)
  RESPONSE_EXIT=$?
  set -e
  STDERR_CAPTURE=""
  [ -f /tmp/remote-browser-stderr-$$ ] && STDERR_CAPTURE=$(cat /tmp/remote-browser-stderr-$$)
  rm -f /tmp/remote-browser-stderr-$$ 2>/dev/null || true
fi

# When NO_BIND was true, the call already streamed to stdout/stderr — exit
# carrying its status. Otherwise, post-process: cache management on
# bind/unbind, plus a single 404 retry for stale cached tabIds.
if [ "$NO_BIND" = "true" ]; then
  exit "$RESPONSE_EXIT"
fi

# 404 with `tab_not_found` indicates our cached tabId is stale (Extension
# closed the tab while we weren't looking). Purge cache and retry the call
# WITHOUT a cached tabId so the backend auto-binds a fresh one.
if [ "$RESPONSE_EXIT" -ne 0 ] \
   && [ -n "$STDERR_CAPTURE" ] \
   && printf '%s' "$STDERR_CAPTURE" | grep -q '"status":404' \
   && printf '%s' "$STDERR_CAPTURE" | grep -q 'tab_not_found' \
   && [ -n "${CREWLY_SESSION_NAME:-}" ]; then
  _purge_cached_tab
  # Drop tabId from BODY for the retry — fall through to backend auto-bind.
  if [ -n "$BODY" ] && [ "$BODY" != "{}" ]; then
    BODY=$(printf '%s' "$BODY" | jq -c 'del(.tabId)' 2>/dev/null || printf '%s' "$BODY")
  fi
  set +e
  RESPONSE=$(run_api_call 2>/tmp/remote-browser-stderr-$$)
  RESPONSE_EXIT=$?
  set -e
  STDERR_CAPTURE=""
  [ -f /tmp/remote-browser-stderr-$$ ] && STDERR_CAPTURE=$(cat /tmp/remote-browser-stderr-$$)
  rm -f /tmp/remote-browser-stderr-$$ 2>/dev/null || true
fi

# On a successful bind-tab, persist the new tabId. On unbind-tab, purge.
if [ "$RESPONSE_EXIT" -eq 0 ] && [ -n "${CREWLY_SESSION_NAME:-}" ]; then
  case "$ACTION" in
    bind-tab)
      new_tab=$(printf '%s' "$RESPONSE" | jq -r '.data.tabId // empty' 2>/dev/null || true)
      if [[ "$new_tab" =~ ^[0-9]+$ ]]; then
        _store_cached_tab "$new_tab"
      fi
      ;;
    unbind-tab)
      _purge_cached_tab
      ;;
  esac
fi

# Re-emit captured streams so the caller sees the same shape api_call
# would have produced. stdout always goes through; stderr only on failure.
if [ -n "$RESPONSE" ]; then
  printf '%s\n' "$RESPONSE"
fi
if [ "$RESPONSE_EXIT" -ne 0 ] && [ -n "$STDERR_CAPTURE" ]; then
  printf '%s\n' "$STDERR_CAPTURE" >&2
fi
exit "$RESPONSE_EXIT"
