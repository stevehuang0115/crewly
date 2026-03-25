#!/usr/bin/env bash
# =============================================================================
# submit-for-approval — Submit marketing content for human approval
#
# Submits content to the ContentApprovalService via the Crewly API.
# The approval message is sent to the configured Slack channel.
#
# Usage:
#   bash execute.sh '{"action":"submit","platform":"Instagram","contentType":"post","content":"...","hashtags":["#tag"]}'
#   bash execute.sh '{"action":"status","approvalId":"abc-123"}'
#   bash execute.sh '{"action":"list"}'
# =============================================================================

set -euo pipefail

INPUT="${1:-"{}"}"

# Parse input fields
ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "submit"')
PLATFORM=$(printf '%s' "$INPUT" | jq -r '.platform // ""')
CONTENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.contentType // "post"')
CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // ""')
HASHTAGS=$(printf '%s' "$INPUT" | jq -r '.hashtags // [] | join(", ")')
VISUAL_DIRECTION=$(printf '%s' "$INPUT" | jq -r '.visualDirection // ""')
SCHEDULED_TIME=$(printf '%s' "$INPUT" | jq -r '.scheduledTime // ""')
APPROVAL_ID=$(printf '%s' "$INPUT" | jq -r '.approvalId // ""')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // ""')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // ""')

# Crewly API base URL
API_BASE="${CREWLY_API_URL:-http://localhost:3000}"

case "$ACTION" in
  submit)
    # Validate required fields
    if [ -z "$PLATFORM" ]; then
      echo '{"success":false,"error":"platform is required"}'
      exit 1
    fi
    if [ -z "$CONTENT" ]; then
      echo '{"success":false,"error":"content is required"}'
      exit 1
    fi

    # Build the approval request payload
    PAYLOAD=$(jq -n \
      --arg teamId "$TEAM_ID" \
      --arg submittedBy "${CREWLY_SESSION_NAME:-unknown}" \
      --arg platform "$PLATFORM" \
      --arg contentType "$CONTENT_TYPE" \
      --arg content "$CONTENT" \
      --arg hashtags "$HASHTAGS" \
      --arg visualDirection "$VISUAL_DIRECTION" \
      --arg scheduledTime "$SCHEDULED_TIME" \
      '{
        teamId: $teamId,
        submittedBy: $submittedBy,
        platform: $platform,
        contentType: $contentType,
        content: $content,
        hashtags: (if $hashtags == "" then [] else ($hashtags | split(", ")) end),
        visualDirection: (if $visualDirection == "" then null else $visualDirection end),
        scheduledTime: (if $scheduledTime == "" then null else $scheduledTime end)
      }')

    # Submit via API
    RESPONSE=$(curl -s -X POST "${API_BASE}/api/content-approvals" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" 2>/dev/null || echo '{"error":"API unreachable"}')

    # Check if API call succeeded
    if echo "$RESPONSE" | jq -e '.id' >/dev/null 2>&1; then
      APPROVAL_ID=$(echo "$RESPONSE" | jq -r '.id')
      echo "{\"success\":true,\"approvalId\":\"${APPROVAL_ID}\",\"status\":\"pending\",\"message\":\"Content submitted for approval. The business owner will review via Slack.\"}"
    else
      # Fallback: store locally if API is not available
      APPROVAL_ID="local-$(date +%s)-$RANDOM"
      APPROVAL_DIR="${PROJECT_PATH:-.}/.crewly/content-approvals"
      mkdir -p "$APPROVAL_DIR"

      echo "$PAYLOAD" | jq --arg id "$APPROVAL_ID" --arg status "pending" \
        '. + {id: $id, status: $status, submittedAt: (now | todate)}' \
        > "${APPROVAL_DIR}/${APPROVAL_ID}.json"

      echo "{\"success\":true,\"approvalId\":\"${APPROVAL_ID}\",\"status\":\"pending\",\"message\":\"Content saved locally for approval (API not available). File: ${APPROVAL_DIR}/${APPROVAL_ID}.json\"}"
    fi
    ;;

  status)
    if [ -z "$APPROVAL_ID" ]; then
      echo '{"success":false,"error":"approvalId is required"}'
      exit 1
    fi

    # Check via API
    RESPONSE=$(curl -s "${API_BASE}/api/content-approvals/${APPROVAL_ID}" 2>/dev/null || echo '{"error":"API unreachable"}')

    if echo "$RESPONSE" | jq -e '.id' >/dev/null 2>&1; then
      STATUS=$(echo "$RESPONSE" | jq -r '.status')
      FEEDBACK=$(echo "$RESPONSE" | jq -r '.feedback // "none"')
      echo "{\"success\":true,\"approvalId\":\"${APPROVAL_ID}\",\"status\":\"${STATUS}\",\"feedback\":\"${FEEDBACK}\"}"
    else
      # Fallback: check local file
      APPROVAL_DIR="${PROJECT_PATH:-.}/.crewly/content-approvals"
      LOCAL_FILE="${APPROVAL_DIR}/${APPROVAL_ID}.json"
      if [ -f "$LOCAL_FILE" ]; then
        STATUS=$(jq -r '.status' "$LOCAL_FILE")
        echo "{\"success\":true,\"approvalId\":\"${APPROVAL_ID}\",\"status\":\"${STATUS}\",\"source\":\"local\"}"
      else
        echo "{\"success\":false,\"error\":\"Approval ${APPROVAL_ID} not found\"}"
      fi
    fi
    ;;

  list)
    # List pending approvals via API
    RESPONSE=$(curl -s "${API_BASE}/api/content-approvals?teamId=${TEAM_ID}&status=pending" 2>/dev/null || echo '[]')

    if echo "$RESPONSE" | jq -e '.[0]' >/dev/null 2>&1; then
      COUNT=$(echo "$RESPONSE" | jq 'length')
      echo "{\"success\":true,\"count\":${COUNT},\"approvals\":${RESPONSE}}"
    else
      # Fallback: list local files
      APPROVAL_DIR="${PROJECT_PATH:-.}/.crewly/content-approvals"
      if [ -d "$APPROVAL_DIR" ]; then
        COUNT=$(ls -1 "$APPROVAL_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
        echo "{\"success\":true,\"count\":${COUNT},\"source\":\"local\",\"directory\":\"${APPROVAL_DIR}\"}"
      else
        echo "{\"success\":true,\"count\":0,\"approvals\":[]}"
      fi
    fi
    ;;

  *)
    echo "{\"success\":false,\"error\":\"Unknown action: ${ACTION}. Use submit, status, or list.\"}"
    exit 1
    ;;
esac
