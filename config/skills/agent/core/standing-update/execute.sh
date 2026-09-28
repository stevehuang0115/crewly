#!/bin/bash
# Write one section of a standing-answer page (#816).
# Supports CLI flags (preferred) and legacy JSON.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

AGENT_PAGE_ID="unfinished-work"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  execute.sh --page decisions-in-force --project /path --heading "Prompt assembly" \
             --body-file /tmp/section.md --cites "dec:<id>,dec:<id>"
  execute.sh --page unfinished-work --session dev-1 --heading "PR #818" \
             --body "Waiting on review." --cites "mem:<id>"
  execute.sh --page open-gotchas --project /path --heading "Shell" --body ""   # remove the section

Options:
  --page     | -P   Page id: decisions-in-force, open-gotchas, owner-preferences, unfinished-work (required)
  --project  | -p   Project path for project pages (default: $CREWLY_PROJECT_PATH)
  --session  | -s   Session name for the unfinished-work page (default: $CREWLY_SESSION_NAME)
  --heading  | -H   Section heading, one line (required)
  --body     | -b   Section body; an empty body removes the section
  --body-file       Read the body from a file
  --cites    | -c   Comma-separated citations from the refresh brief (required unless removing)
  --json     | -j   Raw JSON payload
  --help     | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""
PAGE=""
PROJECT_PATH=""
SESSION=""
HEADING=""
BODY=""
BODY_SET="false"
CITES=""

if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --page|-P) PAGE="$2"; shift 2 ;;
    --project|-p) PROJECT_PATH="$2"; shift 2 ;;
    --session|-s) SESSION="$2"; shift 2 ;;
    --heading|-H) HEADING="$2"; shift 2 ;;
    --body|-b) BODY="$2"; BODY_SET="true"; shift 2 ;;
    --body-file)
      [ -f "$2" ] || error_exit "Body file not found: $2"
      BODY="$(cat "$2")"; BODY_SET="true"; shift 2 ;;
    --cites|-c) CITES="$2"; shift 2 ;;
    --json|-j) INPUT_JSON="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    --) shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        error_exit "Unknown argument: $1. Use --help for usage."
      fi
      ;;
  esac
done

if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$PAGE" ] && PAGE=$(printf '%s' "$INPUT" | jq -r '.page // .pageId // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$SESSION" ] && SESSION=$(printf '%s' "$INPUT" | jq -r '.sessionName // empty')
  [ -z "$HEADING" ] && HEADING=$(printf '%s' "$INPUT" | jq -r '.heading // empty')
  if [ "$BODY_SET" = "false" ] && printf '%s' "$INPUT" | jq -e 'has("body")' >/dev/null; then
    BODY=$(printf '%s' "$INPUT" | jq -r '.body'); BODY_SET="true"
  fi
  [ -z "$CITES" ] && CITES=$(printf '%s' "$INPUT" | jq -r 'if (.cites | type) == "array" then (.cites | join(",")) else (.cites // empty) end')
fi

require_param "page (--page)" "$PAGE"
require_param "heading (--heading)" "$HEADING"
[ "$BODY_SET" = "true" ] || error_exit "body is required (--body, --body-file, or --body \"\" to remove the section)"
[[ "$PAGE" =~ ^[a-z][a-z-]*$ ]] || error_exit "Invalid page id: $PAGE"

# The agent page is keyed by session; every other page by project.
if [ "$PAGE" = "$AGENT_PAGE_ID" ]; then
  [ -z "$SESSION" ] && SESSION="${CREWLY_SESSION_NAME:-}"
  require_param "session (--session, or CREWLY_SESSION_NAME)" "$SESSION"
else
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH="${CREWLY_PROJECT_PATH:-}"
  require_param "project (--project, or CREWLY_PROJECT_PATH)" "$PROJECT_PATH"
fi

BODY_JSON=$(jq -n \
  --arg projectPath "$PROJECT_PATH" \
  --arg sessionName "$SESSION" \
  --arg heading "$HEADING" \
  --arg body "$BODY" \
  --arg cites "$CITES" \
  '{heading: $heading, body: $body,
    cites: ($cites | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))}
   + (if $projectPath != "" then {projectPath: $projectPath} else {} end)
   + (if $sessionName != "" then {sessionName: $sessionName} else {} end)')

api_call PUT "/standing/${PAGE}/section" "$BODY_JSON"
