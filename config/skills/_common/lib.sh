#!/bin/bash
# =============================================================================
# Crewly Shared Skills Common Library
# Provides common utilities for all bash skills (agent and orchestrator).
# =============================================================================

# Base URL for the Crewly backend API
CREWLY_API_URL="${CREWLY_API_URL:-http://localhost:8787}"

# -----------------------------------------------------------------------------
# api_call METHOD endpoint [json_body]
#
# Makes an HTTP request to the Crewly backend API.
# Outputs the response body on success (stdout).
# Outputs a JSON error object on failure (stderr) and returns 1.
# -----------------------------------------------------------------------------
api_call() {
  local method="$1" endpoint="$2" body="${3:-}"
  local url="${CREWLY_API_URL}/api${endpoint}"
  local args=(-s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json")
  # Include agent session identity header for heartbeat tracking
  # Use ${VAR:-} pattern to avoid 'unbound variable' error under set -u (nounset)
  [ -n "${CREWLY_SESSION_NAME:-}" ] && args+=(-H "X-Agent-Session: $CREWLY_SESSION_NAME")
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
    echo "$body_content"
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
  echo '{"error":"'"$1"'"}' >&2
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
