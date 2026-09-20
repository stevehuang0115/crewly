#!/bin/bash
# =============================================================================
# Crewly Shared Skills Common Library
# Provides common utilities for all bash skills (agent and orchestrator).
# =============================================================================

# Base URL for the Crewly backend API
CREWLY_API_URL="${CREWLY_API_URL:-http://localhost:8787}"

# -----------------------------------------------------------------------------
# Skill output cap (context-cost control)
#
# A single unbounded `api_call` response (70k+ chars from get-team-status,
# wiki-migrate scan, list endpoints, ...) lands verbatim in the calling LLM's
# context and is re-read on every turn until the session is compacted. Any
# body larger than CREWLY_SKILL_MAX_OUTPUT_BYTES is therefore parked on disk
# under $CREWLY_HOME/tmp/skill-output/ and replaced on stdout by a small,
# VALID JSON envelope (so downstream `| jq` still parses):
#   {"truncated":true,"bytes":N,"file":"<path>","head":"<first 4000 chars>","hint":"..."}
#
# Opt out per invocation with CREWLY_SKILL_FULL_OUTPUT=1 or by passing --full
# to a skill (detected at source time below; the flag is NOT stripped, so
# skills that already parse --full keep working). Set
# CREWLY_SKILL_MAX_OUTPUT_BYTES=0 to disable the cap entirely.
# -----------------------------------------------------------------------------
CREWLY_SKILL_MAX_OUTPUT_BYTES="${CREWLY_SKILL_MAX_OUTPUT_BYTES:-60000}"
# Characters of the body preserved inline in the envelope's `head` field.
CREWLY_SKILL_OUTPUT_HEAD_CHARS="${CREWLY_SKILL_OUTPUT_HEAD_CHARS:-4000}"
# Parked outputs older than this (minutes) are deleted on the next api_call.
CREWLY_SKILL_OUTPUT_TTL_MINUTES="${CREWLY_SKILL_OUTPUT_TTL_MINUTES:-1440}"
# Hint printed inside the envelope so the caller knows how to get the rest.
CREWLY_SKILL_OUTPUT_HINT="pass --full or read the file; use jq to select fields"

for _crewly_arg in "$@"; do
  if [ "$_crewly_arg" = "--full" ]; then export CREWLY_SKILL_FULL_OUTPUT=1; fi
done
unset _crewly_arg

# -----------------------------------------------------------------------------
# Universal --file flag preprocessor (#EOF-fix)
#
# Fixes Gemini CLI's "unexpected EOF while looking for matching `'" errors.
#
# Root cause: When an LLM CLI passes JSON as a shell argument, special chars
# inside the JSON (single quotes, backticks, parentheses, $variables) get
# interpreted by the shell BEFORE the script runs, causing parse errors.
#
# Solution: The LLM writes JSON to a temp file, then passes --file <path>.
# This preprocessor detects --file as the first argument, reads the file,
# and replaces the script's positional parameters with the file contents.
# All downstream parsing (read_json_input, custom arg loops) works unchanged.
#
# Usage (by LLM CLI — use heredoc to avoid single-quote EOF issues):
#   cat > /tmp/crewly_input.json << 'CREWLY_EOF'
#   {"summary":"text with 'quotes' and special chars"}
#   CREWLY_EOF
#   bash execute.sh --file /tmp/crewly_input.json
#
# This runs at source-time, so every script that sources lib.sh gets it for free.
# -----------------------------------------------------------------------------
if [ "${1:-}" = "--file" ] && [ -n "${2:-}" ]; then
  if [ -f "$2" ]; then
    _CREWLY_FILE_CONTENT="$(cat "$2")"
    set -- "$_CREWLY_FILE_CONTENT"
    unset _CREWLY_FILE_CONTENT
  else
    echo '{"error":"File not found: '"$2"'"}' >&2
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# read_json_input [arg]
#
# Reads JSON input from either:
#   1. The provided command-line argument ($1)
#   2. A file path prefixed with @ (e.g. @/tmp/input.json)
#   3. Standard input (stdin) — for piped or heredoc usage
#
# This solves Gemini CLI's run_shell_command escaping issues (#292, #293):
# special characters in JSON (parentheses, quotes, newlines) are mangled
# when passed as shell arguments. Piping via stdin bypasses shell parsing.
#
# Usage in skill scripts:
#   INPUT=$(read_json_input "${1:-}")
# -----------------------------------------------------------------------------
read_json_input() {
  local arg="${1:-}"

  # Option 1: Direct argument provided (non-empty)
  if [ -n "$arg" ]; then
    # Support @filepath syntax: read JSON from file
    if [[ "$arg" == @* ]]; then
      local filepath="${arg:1}"
      if [ -f "$filepath" ]; then
        cat "$filepath"
      else
        echo '{}' >&2
        echo "File not found: $filepath" >&2
        return 1
      fi
    else
      printf '%s' "$arg"
    fi
    return 0
  fi

  # Option 2: Read from stdin (pipe or heredoc)
  if [ ! -t 0 ]; then
    cat
    return 0
  fi

  # Option 3: No input available
  echo ''
  return 0
}

# -----------------------------------------------------------------------------
# _skill_output_dir
# Echoes the directory where oversized skill outputs are parked.
# $CREWLY_HOME falls back to ~/.crewly.
# -----------------------------------------------------------------------------
_skill_output_dir() {
  echo "${CREWLY_HOME:-${HOME}/.crewly}/tmp/skill-output"
}

# -----------------------------------------------------------------------------
# _skill_name
# Best-effort name of the running skill (its directory name, e.g.
# "get-team-status") for the parked-output filename. Falls back to "skill"
# when sourced interactively.
# -----------------------------------------------------------------------------
_skill_name() {
  local script="${BASH_SOURCE[${#BASH_SOURCE[@]}-1]:-$0}"
  local name
  name=$(basename "$(dirname "$script")" 2>/dev/null)
  case "$name" in
    ""|"."|"/"|"_common") name=$(basename "$script" .sh) ;;
  esac
  case "$name" in
    ""|"bash"|"-bash"|"sh"|"zsh") name="skill" ;;
  esac
  printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_'
}

# -----------------------------------------------------------------------------
# _prune_skill_output
# Cheap housekeeping run at the start of every api_call: delete parked
# outputs older than CREWLY_SKILL_OUTPUT_TTL_MINUTES (default 24h). No-op
# when the directory does not exist yet.
# -----------------------------------------------------------------------------
_prune_skill_output() {
  local dir
  dir=$(_skill_output_dir)
  [ -d "$dir" ] || return 0
  find "$dir" -type f -name '*.json' -mmin "+${CREWLY_SKILL_OUTPUT_TTL_MINUTES:-1440}" -delete 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# _cap_skill_output body
#
# Prints `body` unchanged when it is within CREWLY_SKILL_MAX_OUTPUT_BYTES (or
# the cap is disabled / bypassed). Otherwise parks the full body in
# $CREWLY_HOME/tmp/skill-output/<skill>-<timestamp>.json, prunes parked files
# older than CREWLY_SKILL_OUTPUT_TTL_MINUTES, and prints a valid JSON envelope
# describing where the full payload went. Never fails the caller: if the
# envelope cannot be built (no jq, unwritable dir) the raw body is printed.
# -----------------------------------------------------------------------------
_cap_skill_output() {
  local body="$1"
  local max="${CREWLY_SKILL_MAX_OUTPUT_BYTES:-60000}"

  if [ "${CREWLY_SKILL_FULL_OUTPUT:-}" = "1" ] || ! [ "$max" -gt 0 ] 2>/dev/null; then
    echo "$body"
    return 0
  fi

  local bytes
  bytes=$(printf '%s' "$body" | LC_ALL=C wc -c | tr -d ' ')
  if [ "$bytes" -le "$max" ]; then
    echo "$body"
    return 0
  fi

  local dir
  dir=$(_skill_output_dir)
  if ! mkdir -p "$dir" 2>/dev/null || ! command -v jq >/dev/null 2>&1; then
    echo "$body"
    return 0
  fi

  local file
  file="${dir}/$(_skill_name)-$(date +%Y%m%dT%H%M%S)-$$.json"
  if ! printf '%s' "$body" > "$file" 2>/dev/null; then
    echo "$body"
    return 0
  fi

  local head_chars="${CREWLY_SKILL_OUTPUT_HEAD_CHARS:-4000}"
  jq -n \
    --argjson bytes "$bytes" \
    --arg file "$file" \
    --arg head "${body:0:$head_chars}" \
    --arg hint "$CREWLY_SKILL_OUTPUT_HINT" \
    '{truncated: true, bytes: $bytes, file: $file, head: $head, hint: $hint}'
}

# -----------------------------------------------------------------------------
# api_call METHOD endpoint [json_body]
#
# Makes an HTTP request to the Crewly backend API.
# Outputs the response body on success (stdout), subject to the output cap
# (see _cap_skill_output: oversized bodies are parked on disk and replaced by
# a {"truncated":true,...} envelope).
# Outputs a JSON error object on failure (stderr) and returns 1.
# -----------------------------------------------------------------------------
api_call() {
  local method="$1" endpoint="$2" body="${3:-}"
  local url="${CREWLY_API_URL}/api${endpoint}"
  _prune_skill_output
  local args=(-s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json")
  # Include agent session identity header for heartbeat tracking
  # Use ${VAR:-} pattern to avoid 'unbound variable' error under set -u (nounset)
  if [ -n "${CREWLY_SESSION_NAME:-}" ]; then
    args+=(-H "X-Agent-Session: $CREWLY_SESSION_NAME")
  else
    # Without the identity header the backend treats the call as anonymous:
    # membership checks fail with a misleading 404 and heartbeats are lost.
    # Say so once per call instead of failing silently (2026-09-18, Think
    # Tank: every reply-channel call 404'd for want of this variable).
    echo '{"warning":"CREWLY_SESSION_NAME is not set in this shell — the request is sent without X-Agent-Session; channel replies and heartbeats will not be attributed to you. Prefix the call with CREWLY_SESSION_NAME=<your session name> or restart the agent."}' >&2
  fi
  # Which connected Google account the call acts as. One Crewly account can
  # connect several (two Gmail logins, say); without this the backend uses
  # whichever is the default, which is what a single-account install wants.
  if [ -n "${CREWLY_GOOGLE_ACCOUNT:-}" ]; then
    args+=(-H "X-Google-Account: $CREWLY_GOOGLE_ACCOUNT")
  fi
  [ -n "$body" ] && args+=(-d "$body")

  local response
  response=$(curl "${args[@]}" "$url")
  local curl_exit=$?

  if [ $curl_exit -ne 0 ]; then
    echo '{"error":true,"status":0,"details":"curl failed with exit code '"$curl_exit"'"}' >&2
    return 1
  fi

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body_content
  body_content=$(echo "$response" | sed '$d')

  if [ "$http_code" -ge 200 ] 2>/dev/null && [ "$http_code" -lt 300 ] 2>/dev/null; then
    _cap_skill_output "$body_content"
  else
    echo '{"error":true,"status":'"${http_code}"',"details":'"${body_content:-\"Request failed\"}"'}' >&2
    return 1
  fi
}

# -----------------------------------------------------------------------------
# error_exit message
# Prints a JSON error to stderr and exits with code 1.
# -----------------------------------------------------------------------------
error_exit() {
  # Use jq to safely encode the error message (handles quotes, special chars)
  local msg
  msg=$(jq -n --arg e "$1" '{"error": $e}')
  echo "$msg" >&2
  exit 1
}

# -----------------------------------------------------------------------------
# require_param name value
# Exits with error if value is empty.
# -----------------------------------------------------------------------------
require_param() {
  if [ -z "$2" ]; then
    error_exit "Missing required parameter: $1"
  fi
}

# -----------------------------------------------------------------------------
# resolve_team_id [session_name]
#
# Resolve the team ID that owns the given session. Defaults to
# $CREWLY_SESSION_NAME. Echoes the team id on stdout and returns 0 on success,
# or returns 1 without output if the session cannot be mapped.
#
# Used by team-scoped skills (schedule-followup, cancel-followup,
# list-my-followups, watch-for-event) to scope lookups and prevent cross-team
# interference.
# -----------------------------------------------------------------------------
resolve_team_id() {
  local session="${1:-${CREWLY_SESSION_NAME:-}}"
  [ -z "$session" ] && return 1
  local teams_dir="${HOME}/.crewly/teams"
  [ ! -d "$teams_dir" ] && return 1
  for config in "$teams_dir"/*/config.json; do
    [ -f "$config" ] || continue
    local found
    found=$(jq -r --arg s "$session" '.members[]? | select(.sessionName == $s) | "found"' "$config" 2>/dev/null | head -1)
    if [ "$found" = "found" ]; then
      basename "$(dirname "$config")"
      return 0
    fi
  done
  return 1
}

# -----------------------------------------------------------------------------
# auto_remember agentId content [category] [scope] [projectPath]
#
# Fire-and-forget persistence of a learning to project memory.
# Non-blocking, non-fatal — errors are logged but do not block execution.
#
# Valid categories:
#   agent scope: fact, pattern, preference
#   project scope: pattern, decision, gotcha, relationship, user_preference
# -----------------------------------------------------------------------------
auto_remember() {
  local agent_id="$1" content="$2"
  local category="${3:-pattern}" scope="${4:-project}"
  local project_path="${5:-}"

  # #187: If scope is "project" but projectPath is empty, fall back to "agent" scope
  # to avoid 400 errors from the memory API.
  if [ "$scope" = "project" ] && [ -z "$project_path" ]; then
    scope="agent"
  fi

  local body
  if [ -n "$project_path" ]; then
    body=$(jq -n \
      --arg agentId "$agent_id" \
      --arg content "$content" \
      --arg category "$category" \
      --arg scope "$scope" \
      --arg projectPath "$project_path" \
      '{agentId: $agentId, content: $content, category: $category, scope: $scope, projectPath: $projectPath}')
  else
    body=$(jq -n \
      --arg agentId "$agent_id" \
      --arg content "$content" \
      --arg category "$category" \
      --arg scope "$scope" \
      '{agentId: $agentId, content: $content, category: $category, scope: $scope}')
  fi
  local result
  if ! result=$(api_call POST "/memory/remember" "$body" 2>&1); then
    echo "[auto_remember] Warning: failed to persist knowledge (non-fatal): $result" >&2
  fi
}

# -----------------------------------------------------------------------------
# _skill_heartbeat
#
# Fire-and-forget lightweight API heartbeat at the start of every skill
# execution. This ensures the orchestrator heartbeat monitor recognizes that
# a skill is running, preventing false-positive timeout restarts (#194).
# The background curl is non-blocking (~5ms) and errors are silently ignored.
# -----------------------------------------------------------------------------
_skill_heartbeat() {
  curl -s -X POST "${CREWLY_API_URL}/api/heartbeat" \
    -H "X-Agent-Session: ${CREWLY_SESSION_NAME:-}" \
    -H "Content-Type: application/json" \
    -d '{"source":"skill-start"}' >/dev/null 2>&1 &
}

# Auto-heartbeat on skill entry when running inside a Crewly agent session
# Use if/fi instead of && to avoid returning exit code 1 when CREWLY_SESSION_NAME
# is empty — that would kill callers running under set -e (pipefail).
if [ -n "${CREWLY_SESSION_NAME:-}" ]; then _skill_heartbeat; fi
