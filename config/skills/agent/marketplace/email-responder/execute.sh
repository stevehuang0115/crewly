#!/bin/bash
# Generate professional email response drafts
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"from\":\"sender@example.com\",\"subject\":\"Subject\",\"body\":\"Email body\",\"tone\":\"professional\",\"intent\":\"auto\",\"senderName\":\"Your Name\"}'"

# Parse parameters
FROM=$(printf '%s' "$INPUT" | jq -r '.from // empty')
SUBJECT=$(printf '%s' "$INPUT" | jq -r '.subject // empty')
BODY=$(printf '%s' "$INPUT" | jq -r '.body // empty')
TONE=$(printf '%s' "$INPUT" | jq -r '.tone // "professional"')
INTENT=$(printf '%s' "$INPUT" | jq -r '.intent // "auto"')
SENDER_NAME=$(printf '%s' "$INPUT" | jq -r '.senderName // "The Team"')

require_param "from" "$FROM"
require_param "subject" "$SUBJECT"
require_param "body" "$BODY"

# Extract sender first name for greeting
SENDER_FIRST=$(echo "$FROM" | sed 's/@.*//' | sed 's/[._-]/ /g' | awk '{print $1}' | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')

BODY_LOWER=$(echo "$BODY" | tr '[:upper:]' '[:lower:]')

# Auto-detect intent if set to auto
if [ "$INTENT" = "auto" ]; then
  if echo "$BODY_LOWER" | grep -qE '(\?|how|what|when|where|why|which|can you|could you tell|do you know)'; then
    INTENT="question"
  elif echo "$BODY_LOWER" | grep -qE '(problem|issue|broken|cannot|unable|error|bug|crash|frustrated|angry|terrible|worst|disappointed)'; then
    INTENT="complaint"
  elif echo "$BODY_LOWER" | grep -qE '(please|could you|would you|need|request|send me|provide|help me|looking for)'; then
    INTENT="request"
  elif echo "$BODY_LOWER" | grep -qE '(great|love|excellent|amazing|helpful|thank|suggestion|idea|nice|good job|well done)'; then
    INTENT="feedback"
  else
    INTENT="question"
  fi
fi

# Auto-adjust tone for complaints if not explicitly set
ORIGINAL_TONE="$TONE"
if [ "$INTENT" = "complaint" ] && [ "$TONE" = "professional" ]; then
  TONE="apologetic"
fi

# Build greeting based on tone
case "$TONE" in
  friendly)
    GREETING="Hi ${SENDER_FIRST}!"
    SIGNOFF="Cheers"
    ;;
  formal)
    GREETING="Dear ${SENDER_FIRST},"
    SIGNOFF="Sincerely"
    ;;
  apologetic)
    GREETING="Hi ${SENDER_FIRST},"
    SIGNOFF="Best regards"
    ;;
  *)
    GREETING="Hi ${SENDER_FIRST},"
    SIGNOFF="Best regards"
    ;;
esac

# Build response body based on intent
case "$INTENT" in
  question)
    ACKNOWLEDGMENT="Thank you for reaching out with your question."
    RESPONSE_BODY="Regarding your inquiry about \"${SUBJECT}\":\n\n[Answer the specific question here]\n\nIf you need any further clarification, please don't hesitate to ask."
    SUGGESTED_ACTIONS='["Provide specific answer","Follow up if no response in 48h"]'
    ;;
  complaint)
    ACKNOWLEDGMENT="Thank you for bringing this to our attention. I sincerely apologize for the inconvenience you've experienced."
    RESPONSE_BODY="I understand how frustrating this must be, and I want to assure you that we take this seriously.\n\nHere's what we're doing to resolve this:\n\n1. [Immediate action taken]\n2. [Investigation steps]\n3. [Expected resolution timeline]\n\nI'll personally follow up with you once this is resolved."
    SUGGESTED_ACTIONS='["Escalate to engineering","Investigate root cause","Follow up within 24h","Offer compensation if applicable"]'
    ;;
  request)
    ACKNOWLEDGMENT="Thank you for your request."
    RESPONSE_BODY="I've noted your request regarding \"${SUBJECT}\" and I'd be happy to help.\n\n[Address the specific request here]\n\nPlease let me know if you need anything else."
    SUGGESTED_ACTIONS='["Fulfill the request","Provide timeline if needed","Follow up on completion"]'
    ;;
  feedback)
    ACKNOWLEDGMENT="Thank you so much for taking the time to share your feedback!"
    RESPONSE_BODY="We really appreciate your input. Your feedback helps us improve and build a better experience.\n\n[Acknowledge specific feedback points]\n\nWe'll definitely take this into consideration for future updates."
    SUGGESTED_ACTIONS='["Log feedback in product backlog","Share with product team","Follow up on implementation"]'
    ;;
esac

# Assemble the full draft
DRAFT="${GREETING}\n\n${ACKNOWLEDGMENT}\n\n${RESPONSE_BODY}\n\n${SIGNOFF},\n${SENDER_NAME}"

# Reply subject
REPLY_SUBJECT="Re: ${SUBJECT}"

# Confidence level
CONFIDENCE="high"
if [ "$ORIGINAL_TONE" = "professional" ] && [ "$TONE" != "professional" ]; then
  CONFIDENCE="medium"
fi

# Output JSON
jq -n \
  --arg intent "$INTENT" \
  --arg tone "$TONE" \
  --arg subject "$REPLY_SUBJECT" \
  --arg draft "$DRAFT" \
  --argjson suggestedActions "$SUGGESTED_ACTIONS" \
  --arg confidence "$CONFIDENCE" \
  '{
    intent: $intent,
    tone: $tone,
    subject: $subject,
    draft: $draft,
    suggestedActions: $suggestedActions,
    confidence: $confidence
  }'
