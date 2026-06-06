#!/bin/bash
# Record a learning or insight for team knowledge sharing.
# Supports CLI flags (preferred) and legacy JSON.
#
# Karpathy-lite preflight (ARCHIVIST-V2.f1):
#   Before persisting, the learning text is checked against the 4 rules of
#   the Karpathy-lite Entity-Centric format defined in SKILL.md:
#     1. [[Entity]] opener — HARD reject (always).
#     2. Sentence count 1..3 — soft warn (HARD with --strict).
#     3. Linked or sourced — soft warn (HARD with --strict).
#     4. No log-style "I/We …" opener — soft warn (HARD with --strict).
#
# Flags:
#   --strict           Escalate rules 2..4 to hard rejects (CI / Archivist v2).
#   --no-preflight     Skip the local preflight (escape hatch).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT_JSON=""
AGENT_ID=""
AGENT_ROLE=""
PROJECT_PATH=""
LEARNING=""
STRICT=0
SKIP_PREFLIGHT=0

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent|-a)
      AGENT_ID="$2"
      shift 2
      ;;
    --role|-r)
      AGENT_ROLE="$2"
      shift 2
      ;;
    --project|-p)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --learning|-l)
      LEARNING="$2"
      shift 2
      ;;
    --learning-file)
      LEARNING="$(cat "$2")"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --no-preflight)
      SKIP_PREFLIGHT=1
      shift
      ;;
    --json|-j)
      INPUT_JSON="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: execute.sh --agent <id> --role <role> --project <path> --learning '<text>' [--strict] [--no-preflight]

Karpathy-lite preflight rules (see SKILL.md):
  1. [[Entity]] opener (HARD)
  2. 1..3 sentences (soft, hard with --strict)
  3. Linked or sourced (soft, hard with --strict)
  4. No log-style "I/We" opener (soft, hard with --strict)

Flags:
  --strict        Escalate rules 2..4 to hard rejects.
  --no-preflight  Skip local preflight checks (escape hatch).
EOF
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

# Read from stdin if no learning yet
if [ -z "$INPUT_JSON" ] && [ -z "$LEARNING" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    LEARNING="$STDIN_DATA"
  fi
fi

# Parse JSON if provided
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$AGENT_ID" ] && AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agentId // empty')
  [ -z "$AGENT_ROLE" ] && AGENT_ROLE=$(printf '%s' "$INPUT" | jq -r '.agentRole // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$LEARNING" ] && LEARNING=$(printf '%s' "$INPUT" | jq -r '.learning // empty')
  if [ "$STRICT" -eq 0 ]; then
    JSON_STRICT=$(printf '%s' "$INPUT" | jq -r '.strict // empty')
    [ "$JSON_STRICT" = "true" ] && STRICT=1
  fi
fi

require_param "agentId (--agent)" "$AGENT_ID"
require_param "agentRole (--role)" "$AGENT_ROLE"
require_param "projectPath (--project)" "$PROJECT_PATH"
require_param "learning (--learning)" "$LEARNING"

# ---------- Karpathy-lite preflight ----------
# Local checks for fast feedback. Canonical implementation lives in
# backend/src/services/memory/learning-format.validator.ts (full Jest tests).
# This bash mirror covers the most common rules (1 + 4) so agents get immediate
# stderr feedback without paying an HTTP round-trip.
if [ "$SKIP_PREFLIGHT" -eq 0 ]; then
  PREFLIGHT_FAIL=0

  # Rule 1 — [[Entity]] opener (HARD always).
  TRIMMED_LEARNING="${LEARNING#"${LEARNING%%[![:space:]]*}"}"  # left-trim whitespace
  if ! [[ "$TRIMMED_LEARNING" =~ ^\[\[[^\]]+\]\] ]]; then
    SNIPPET="${TRIMMED_LEARNING:0:80}"
    [ "${#TRIMMED_LEARNING}" -gt 80 ] && SNIPPET="${SNIPPET}…"
    {
      echo "✗ record-learning rule 1 (entity_opener): missing leading [[Entity]] opener — required for Archivist v2 join key."
      echo "  Got:    \"${SNIPPET}\""
      echo "  Fix:    Lead with [[Entity Name]]. Example: \"[[Fts5IndexService]] FTS5 rank is negative; invert. PR #320\""
      echo "  See:    config/skills/agent/core/record-learning/SKILL.md § Mandated Format: Karpathy-lite"
    } >&2
    PREFLIGHT_FAIL=1
  fi

  # Rule 4 — log-style "I/We" opener (soft warn; hard with --strict).
  STRIPPED_LEARNING="${TRIMMED_LEARNING}"
  if [[ "$STRIPPED_LEARNING" =~ ^\[\[[^\]]+\]\][[:space:]]* ]]; then
    PREFIX_MATCH="${BASH_REMATCH[0]}"
    STRIPPED_LEARNING="${STRIPPED_LEARNING#"$PREFIX_MATCH"}"
  fi
  if [[ "$STRIPPED_LEARNING" =~ ^[Ii][[:space:]\'] ]] || [[ "$STRIPPED_LEARNING" =~ ^[Ww]e[[:space:]\'] ]]; then
    {
      echo "⚠ record-learning rule 4 (no_log_style): log-style opener detected (\"I …\" / \"We …\")."
      echo "  Fix:    Lead with [[Entity]] then state the insight. Avoid first-person narrative."
      echo "  See:    config/skills/agent/core/record-learning/SKILL.md § Mandated Format: Karpathy-lite"
    } >&2
    if [ "$STRICT" -eq 1 ]; then
      PREFLIGHT_FAIL=1
    fi
  fi

  if [ "$PREFLIGHT_FAIL" -eq 1 ]; then
    echo "record-learning preflight rejected. Re-run with corrected text, or use --no-preflight to bypass." >&2
    exit 2
  fi
fi
# ---------- end preflight ----------

# Build body using env vars for safe escaping
export _LRN_AGENT="$AGENT_ID"
export _LRN_ROLE="$AGENT_ROLE"
export _LRN_PROJECT="$PROJECT_PATH"
export _LRN_CONTENT="$LEARNING"
export _LRN_STRICT="$STRICT"

if [ "$STRICT" -eq 1 ]; then
  BODY=$(jq -n '{agentId: env._LRN_AGENT, agentRole: env._LRN_ROLE, projectPath: env._LRN_PROJECT, learning: env._LRN_CONTENT, strict: true}')
else
  BODY=$(jq -n '{agentId: env._LRN_AGENT, agentRole: env._LRN_ROLE, projectPath: env._LRN_PROJECT, learning: env._LRN_CONTENT}')
fi
unset _LRN_AGENT _LRN_ROLE _LRN_PROJECT _LRN_CONTENT _LRN_STRICT

api_call POST "/memory/record-learning" "$BODY"
