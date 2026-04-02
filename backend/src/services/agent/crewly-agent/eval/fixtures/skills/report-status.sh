#!/bin/bash
# Eval skill shim: report-status
#
# Reports task/team status. Writes a structured report to
# .crewly/reports/ for eval verification.
#
# Usage:
#   bash skills/report-status.sh '{"status":"complete","summary":"All tasks delegated successfully"}'
#
# Output: JSON with reportId

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_log.sh"

INPUT="${1:-'{}'}"
log_tool_call "report-status" "$INPUT"

STATUS=$(echo "$INPUT" | jq -r '.status // "unknown"')
SUMMARY=$(echo "$INPUT" | jq -r '.summary // ""')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
REPORT_ID="report-$(date +%s)-$$"

mkdir -p .crewly/reports

cat > ".crewly/reports/${REPORT_ID}.json" <<EOF
{
  "reportId": "$REPORT_ID",
  "status": "$STATUS",
  "summary": $(echo "$SUMMARY" | jq -Rs .),
  "reportedBy": "eval-tl-sam",
  "reportedAt": "$TIMESTAMP"
}
EOF

echo "{\"success\":true,\"reportId\":\"$REPORT_ID\",\"status\":\"$STATUS\"}"
