#!/bin/bash
# Submit a bug report via GitHub Issues or save locally
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"title\":\"...\",\"body\":\"...\",\"labels\":\"self-evolution,auto-triage\",\"repo\":\"owner/repo\"}'"

TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
BODY=$(printf '%s' "$INPUT" | jq -r '.body // empty')
LABELS=$(printf '%s' "$INPUT" | jq -r '.labels // "self-evolution,auto-triage"')
REPO=$(printf '%s' "$INPUT" | jq -r '.repo // empty')

require_param "title" "$TITLE"
require_param "body" "$BODY"

# Try gh CLI first for GitHub Issues submission
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  if [ -n "$REPO" ]; then
    gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" --label "$LABELS" 2>&1
  else
    # Try to use the current repo
    gh issue create --title "$TITLE" --body "$BODY" --label "$LABELS" 2>&1
  fi
  echo ""
  echo "Bug report submitted to GitHub Issues."
else
  # Fallback: save as local markdown file
  REPORT_DIR="$HOME/.crewly/bug-reports"
  mkdir -p "$REPORT_DIR"
  SAFE_TITLE=$(echo "$TITLE" | tr ' /:' '-' | tr -d '"'"'" | head -c 50)
  FILENAME="${REPORT_DIR}/$(date +%Y%m%d-%H%M%S)-${SAFE_TITLE}.md"

  cat > "$FILENAME" <<REPORT_EOF
---
title: "${TITLE}"
labels: ${LABELS}
date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
status: open
---

${BODY}
REPORT_EOF

  echo "Bug report saved to: $FILENAME"
  echo "GitHub CLI (gh) not available or not authenticated."
  echo "To submit manually, create an issue at your project's GitHub repo."
fi
