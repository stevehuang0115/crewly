#!/bin/bash
# Analyze customer feedback for sentiment, topics, and actionability
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"feedback\":\"Feedback text\",\"source\":\"survey\",\"customerName\":\"John\"}'"

# Parse parameters
FEEDBACK=$(printf '%s' "$INPUT" | jq -r '.feedback // empty')
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // "unknown"')
CUSTOMER_NAME=$(printf '%s' "$INPUT" | jq -r '.customerName // "Anonymous"')

require_param "feedback" "$FEEDBACK"

FEEDBACK_LOWER=$(echo "$FEEDBACK" | tr '[:upper:]' '[:lower:]')

# Sentiment analysis — count positive and negative keywords
POSITIVE_WORDS="love great excellent amazing helpful fast wonderful good nice perfect happy pleased impressed thank awesome fantastic beautiful smooth"
NEGATIVE_WORDS="hate terrible broken slow frustrating worst awful bad poor confusing hard difficult annoying useless disappointing ugly crash error"

POS_COUNT=0
NEG_COUNT=0

for word in $POSITIVE_WORDS; do
  MATCHES=$(echo "$FEEDBACK_LOWER" | grep -ci "$word" || true)
  POS_COUNT=$((POS_COUNT + MATCHES))
done

for word in $NEGATIVE_WORDS; do
  MATCHES=$(echo "$FEEDBACK_LOWER" | grep -ci "$word" || true)
  NEG_COUNT=$((NEG_COUNT + MATCHES))
done

SENTIMENT_SCORE=$((POS_COUNT - NEG_COUNT))

# Determine sentiment label
if [ "$POS_COUNT" -gt 0 ] && [ "$NEG_COUNT" -gt 0 ]; then
  SENTIMENT="mixed"
elif [ "$SENTIMENT_SCORE" -gt 0 ]; then
  SENTIMENT="positive"
elif [ "$SENTIMENT_SCORE" -lt 0 ]; then
  SENTIMENT="negative"
else
  SENTIMENT="neutral"
fi

# Topic detection
TOPICS="[]"

if echo "$FEEDBACK_LOWER" | grep -qE '(bug|error|crash|broken|not working|fails|exception)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["bug-report"]')
fi

if echo "$FEEDBACK_LOWER" | grep -qE '(feature|wish|would be nice|please add|could you add|should have|missing)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["feature-request"]')
fi

if echo "$FEEDBACK_LOWER" | grep -qE '(slow|performance|loading|lag|speed|timeout|latency)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["performance"]')
fi

if echo "$FEEDBACK_LOWER" | grep -qE '(price|cost|expensive|cheap|pricing|subscription|plan|billing|payment)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["pricing"]')
fi

if echo "$FEEDBACK_LOWER" | grep -qE '(confusing|hard to|documentation|docs|unclear|learn|tutorial|guide|how to)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["ux-documentation"]')
fi

if echo "$FEEDBACK_LOWER" | grep -qE '(love|great|thank|excellent|amazing|awesome|helpful|impressed)'; then
  TOPICS=$(echo "$TOPICS" | jq '. + ["praise"]')
fi

# Default topic if none detected
TOPIC_COUNT=$(echo "$TOPICS" | jq 'length')
if [ "$TOPIC_COUNT" -eq 0 ]; then
  TOPICS='["general-feedback"]'
fi

# Priority based on sentiment + topics
PRIORITY="low"
if echo "$TOPICS" | jq -e 'index("bug-report")' > /dev/null 2>&1; then
  if [ "$SENTIMENT" = "negative" ]; then
    PRIORITY="high"
  else
    PRIORITY="medium"
  fi
elif echo "$TOPICS" | jq -e 'index("performance")' > /dev/null 2>&1; then
  PRIORITY="medium"
elif echo "$TOPICS" | jq -e 'index("feature-request")' > /dev/null 2>&1; then
  PRIORITY="medium"
elif [ "$SENTIMENT" = "negative" ]; then
  PRIORITY="medium"
fi

# Actionability — feedback is actionable if it contains specific topics beyond praise
ACTIONABLE="false"
if echo "$TOPICS" | jq -e '. - ["praise","general-feedback"] | length > 0' > /dev/null 2>&1; then
  ACTIONABLE="true"
fi

# Generate suggested actions based on topics
ACTIONS="[]"
if echo "$TOPICS" | jq -e 'index("bug-report")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Create bug ticket and assign to engineering"]')
fi
if echo "$TOPICS" | jq -e 'index("feature-request")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Add to feature request backlog for prioritization"]')
fi
if echo "$TOPICS" | jq -e 'index("performance")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Investigate performance bottleneck in reported area"]')
fi
if echo "$TOPICS" | jq -e 'index("pricing")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Review pricing feedback with product team"]')
fi
if echo "$TOPICS" | jq -e 'index("ux-documentation")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Improve documentation or UI for reported confusion area"]')
fi
if echo "$TOPICS" | jq -e 'index("praise")' > /dev/null 2>&1; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Share positive feedback with team"]')
fi
if [ "$SENTIMENT" = "negative" ] || [ "$SENTIMENT" = "mixed" ]; then
  ACTIONS=$(echo "$ACTIONS" | jq '. + ["Follow up with customer to acknowledge concerns"]')
fi

# Determine category
CATEGORY="general"
if echo "$TOPICS" | jq -e 'index("bug-report")' > /dev/null 2>&1; then
  CATEGORY="bug-report"
elif echo "$TOPICS" | jq -e 'index("feature-request")' > /dev/null 2>&1; then
  CATEGORY="product-improvement"
elif echo "$TOPICS" | jq -e 'index("performance")' > /dev/null 2>&1; then
  CATEGORY="product-improvement"
elif echo "$TOPICS" | jq -e 'index("praise")' > /dev/null 2>&1; then
  CATEGORY="positive-feedback"
fi

# Output JSON
jq -n \
  --arg feedback "$FEEDBACK" \
  --arg source "$SOURCE" \
  --arg customerName "$CUSTOMER_NAME" \
  --arg sentiment "$SENTIMENT" \
  --arg sentimentScore "$SENTIMENT_SCORE" \
  --argjson topics "$TOPICS" \
  --arg priority "$PRIORITY" \
  --arg actionable "$ACTIONABLE" \
  --argjson suggestedActions "$ACTIONS" \
  --arg category "$CATEGORY" \
  '{
    feedback: $feedback,
    source: $source,
    customerName: $customerName,
    sentiment: $sentiment,
    sentimentScore: ($sentimentScore | tonumber),
    topics: $topics,
    priority: $priority,
    actionable: ($actionable == "true"),
    suggestedActions: $suggestedActions,
    category: $category
  }'
