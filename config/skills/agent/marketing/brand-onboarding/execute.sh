#!/usr/bin/env bash
# =============================================================================
# brand-onboarding — Interactive brand questionnaire & voice guide generator
#
# Manages the onboarding session via the Crewly API's BrandOnboardingService.
# Falls back to local file-based operation if API is not available.
#
# Usage:
#   bash execute.sh '{"action":"start","teamId":"team-123","templateId":"marketing-team"}'
#   bash execute.sh '{"action":"answer","sessionId":"uuid","value":"Sunrise Bakery"}'
#   bash execute.sh '{"action":"batch","teamId":"team-123","answers":{...}}'
#   bash execute.sh '{"action":"complete","sessionId":"uuid","outputDir":"/path/to/docs"}'
#   bash execute.sh '{"action":"question","sessionId":"uuid"}'
# =============================================================================

set -euo pipefail

INPUT="${1:-"{}"}"

# Parse input fields
ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "start"')
TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // ""')
TEMPLATE_ID=$(printf '%s' "$INPUT" | jq -r '.templateId // "marketing-team"')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.sessionId // ""')
VALUE=$(printf '%s' "$INPUT" | jq -r '.value // ""')
OUTPUT_DIR=$(printf '%s' "$INPUT" | jq -r '.outputDir // ""')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // ""')

# Crewly API base URL
API_BASE="${CREWLY_API_URL:-http://localhost:3000}"

# Local storage directory
LOCAL_DIR="${PROJECT_PATH:-.}/.crewly/onboarding"

# =============================================================================
# Questions definition (matches BrandOnboardingService)
# =============================================================================
QUESTIONS='[
  {"id":"business_name","text":"What is your business name?","required":true,"order":1},
  {"id":"industry","text":"What industry are you in? (e.g., Fashion, Food, Fitness, Tech, Education)","required":true,"order":2},
  {"id":"description","text":"Describe your business in one sentence.","required":true,"order":3},
  {"id":"target_customer","text":"Who is your target customer? (Age, interests, problems they have)","required":true,"order":4},
  {"id":"competitors","text":"What are your top 3 competitors?","required":false,"order":5},
  {"id":"personality","text":"Describe your brand personality in 3 words. (e.g., Professional, Friendly, Bold)","required":true,"order":6},
  {"id":"tone","text":"What tone should your content have? (Formal / Casual / Playful / Authoritative)","required":true,"order":7},
  {"id":"goals","text":"What are your marketing goals? (Brand awareness / Lead generation / Sales / Community)","required":true,"order":8},
  {"id":"platforms","text":"Which platforms do you use? (X / LinkedIn / Instagram / Facebook)","required":true,"order":9},
  {"id":"content_examples","text":"Share 2-3 examples of content you like (URLs or descriptions).","required":false,"order":10}
]'

# =============================================================================
# Helper: generate brand voice guide from answers
# =============================================================================
generate_guide() {
  local ANSWERS_FILE="$1"
  local OUT_DIR="$2"

  # Extract answers
  local BIZ_NAME=$(jq -r '.business_name // "Your Business"' "$ANSWERS_FILE")
  local INDUSTRY=$(jq -r '.industry // "General"' "$ANSWERS_FILE")
  local DESCRIPTION=$(jq -r '.description // ""' "$ANSWERS_FILE")
  local TARGET=$(jq -r '.target_customer // ""' "$ANSWERS_FILE")
  local COMPETITORS=$(jq -r '.competitors // "Not specified"' "$ANSWERS_FILE")
  local PERSONALITY=$(jq -r '.personality // "Professional, Friendly"' "$ANSWERS_FILE")
  local TONE=$(jq -r '.tone // "casual"' "$ANSWERS_FILE")
  local GOALS=$(jq -r '.goals // "Brand awareness"' "$ANSWERS_FILE")
  local PLATFORMS=$(jq -r '.platforms // "Instagram"' "$ANSWERS_FILE")
  local EXAMPLES=$(jq -r '.content_examples // "Not specified"' "$ANSWERS_FILE")

  # Generate tone-specific rules
  local DOS=""
  local DONTS=""
  case "$(echo "$TONE" | tr '[:upper:]' '[:lower:]')" in
    formal)
      DOS="- Use complete sentences and proper grammar\n- Cite data and statistics to support claims"
      DONTS="- Use slang, abbreviations, or internet speak\n- Use excessive emojis (max 1 per post)"
      ;;
    playful)
      DOS="- Use humor, wordplay, and pop culture references\n- Include emojis to add personality"
      DONTS="- Be serious or dry in tone\n- Make jokes that could offend or alienate"
      ;;
    authoritative)
      DOS="- Lead with expertise and industry knowledge\n- Share original insights and thought leadership"
      DONTS="- Hedge or use uncertain language (\"maybe\", \"perhaps\")\n- Copy competitor messaging or talking points"
      ;;
    *)
      DOS="- Write like you are talking to a friend\n- Use contractions and conversational language"
      DONTS="- Be overly corporate or stiff\n- Use jargon that your audience might not understand"
      ;;
  esac
  DOS="${DOS}\n- Stay consistent with the brand personality across all platforms\n- Engage authentically with comments and messages"
  DONTS="${DONTS}\n- Use generic AI-sounding language\n- Post identical content across all platforms (adapt per platform)"

  mkdir -p "$OUT_DIR"

  # Capitalize first letter of tone (compatible with bash 3.x)
  TONE_CAP="$(echo "$TONE" | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')"

  # Write guide using printf to avoid heredoc substitution issues
  {
    printf '# Brand Voice Guide — %s\n\n' "$BIZ_NAME"
    printf '> Auto-generated by Crewly AI Marketing Team onboarding.\n'
    printf '> Last updated: %s\n\n' "$(date +%Y-%m-%d)"
    printf '## Business Profile\n\n'
    printf '%s\n' "- **Name**: $BIZ_NAME"
    printf '%s\n' "- **Industry**: $INDUSTRY"
    printf '%s\n' "- **Description**: $DESCRIPTION"
    printf '%s\n' "- **Target Customer**: $TARGET"
    printf '%s\n\n' "- **Competitors**: $COMPETITORS"
    printf '## Brand Voice\n\n'
    printf '%s\n' "- **Personality**: $PERSONALITY"
    printf '%s\n\n' "- **Tone**: $TONE_CAP"
    printf "### Do's\n"
    printf '%b\n\n' "$DOS"
    printf "### Don'ts\n"
    printf '%b\n\n' "$DONTS"
    printf '## Content Strategy\n\n'
    printf '%s\n' "- **Goals**: $GOALS"
    printf '%s\n' "- **Platforms**: $PLATFORMS"
    printf '%s\n\n' "- **Content Mix**: 60% Educational, 20% Behind-the-scenes, 15% Promotional, 5% Interactive"
    printf '## Writing Rules\n\n'
    printf '1. Always write as if you ARE %s, not about %s.\n' "$BIZ_NAME" "$BIZ_NAME"
    printf '2. Match the %s tone consistently across all platforms.\n' "$TONE"
    printf '3. Use the brand personality (%s) to guide word choices.\n' "$PERSONALITY"
    printf '4. Never use generic AI cliches like "In today'\''s digital landscape" or "Unlock the power of".\n'
    printf '5. Every post must have a clear purpose: educate, entertain, sell, or engage.\n'
    printf '6. Include a call-to-action in at least 50%% of posts.\n'
    printf '7. Use hashtags strategically — 3-5 for Twitter/X, 10-15 for Instagram, 2-3 for LinkedIn.\n\n'
    printf '## Style Examples\n\n'
    echo "$EXAMPLES" | tr ',' '\n' | sed 's/^ */- /'
  } > "${OUT_DIR}/brand-voice-guide.md"

  echo "${OUT_DIR}/brand-voice-guide.md"
}

# =============================================================================
# Actions
# =============================================================================

case "$ACTION" in
  start)
    if [ -z "$TEAM_ID" ]; then
      echo '{"success":false,"error":"teamId is required"}'
      exit 1
    fi

    SESSION_ID="onboard-$(date +%s)-$RANDOM"
    mkdir -p "$LOCAL_DIR"

    # Create session file
    jq -n \
      --arg id "$SESSION_ID" \
      --arg teamId "$TEAM_ID" \
      --arg templateId "$TEMPLATE_ID" \
      --argjson questions "$QUESTIONS" \
      '{
        id: $id,
        teamId: $teamId,
        templateId: $templateId,
        status: "in_progress",
        currentQuestionIndex: 0,
        totalQuestions: ($questions | length),
        answers: {},
        createdAt: (now | todate)
      }' > "${LOCAL_DIR}/${SESSION_ID}.json"

    FIRST_Q=$(echo "$QUESTIONS" | jq -r '.[0].text')

    echo "{\"success\":true,\"sessionId\":\"${SESSION_ID}\",\"status\":\"in_progress\",\"totalQuestions\":10,\"currentQuestion\":1,\"questionText\":\"${FIRST_Q}\"}"
    ;;

  question)
    if [ -z "$SESSION_ID" ]; then
      echo '{"success":false,"error":"sessionId is required"}'
      exit 1
    fi

    SESSION_FILE="${LOCAL_DIR}/${SESSION_ID}.json"
    if [ ! -f "$SESSION_FILE" ]; then
      echo '{"success":false,"error":"Session not found"}'
      exit 1
    fi

    IDX=$(jq -r '.currentQuestionIndex' "$SESSION_FILE")
    TOTAL=$(echo "$QUESTIONS" | jq 'length')

    if [ "$IDX" -ge "$TOTAL" ]; then
      echo '{"success":true,"status":"completed","message":"All questions answered. Run action=complete to generate the Brand Voice Guide."}'
    else
      Q_TEXT=$(echo "$QUESTIONS" | jq -r ".[$IDX].text")
      Q_ID=$(echo "$QUESTIONS" | jq -r ".[$IDX].id")
      Q_REQ=$(echo "$QUESTIONS" | jq -r ".[$IDX].required")
      echo "{\"success\":true,\"questionNumber\":$((IDX + 1)),\"totalQuestions\":${TOTAL},\"questionId\":\"${Q_ID}\",\"questionText\":\"${Q_TEXT}\",\"required\":${Q_REQ}}"
    fi
    ;;

  answer)
    if [ -z "$SESSION_ID" ]; then
      echo '{"success":false,"error":"sessionId is required"}'
      exit 1
    fi

    SESSION_FILE="${LOCAL_DIR}/${SESSION_ID}.json"
    if [ ! -f "$SESSION_FILE" ]; then
      echo '{"success":false,"error":"Session not found"}'
      exit 1
    fi

    IDX=$(jq -r '.currentQuestionIndex' "$SESSION_FILE")
    Q_ID=$(echo "$QUESTIONS" | jq -r ".[$IDX].id")
    Q_REQ=$(echo "$QUESTIONS" | jq -r ".[$IDX].required")
    TOTAL=$(echo "$QUESTIONS" | jq 'length')

    # Validate required
    if [ "$Q_REQ" = "true" ] && [ -z "$VALUE" ]; then
      echo '{"success":false,"error":"This question requires an answer"}'
      exit 1
    fi

    # Save answer and advance
    jq --arg qid "$Q_ID" --arg val "$VALUE" \
      '.answers[$qid] = $val | .currentQuestionIndex += 1' \
      "$SESSION_FILE" > "${SESSION_FILE}.tmp" && mv "${SESSION_FILE}.tmp" "$SESSION_FILE"

    NEXT_IDX=$((IDX + 1))
    if [ "$NEXT_IDX" -ge "$TOTAL" ]; then
      jq '.status = "completed"' "$SESSION_FILE" > "${SESSION_FILE}.tmp" && mv "${SESSION_FILE}.tmp" "$SESSION_FILE"
      echo "{\"success\":true,\"status\":\"completed\",\"message\":\"All questions answered! Run action=complete to generate the Brand Voice Guide.\"}"
    else
      NEXT_Q=$(echo "$QUESTIONS" | jq -r ".[$NEXT_IDX].text")
      echo "{\"success\":true,\"questionNumber\":$((NEXT_IDX + 1)),\"totalQuestions\":${TOTAL},\"nextQuestion\":\"${NEXT_Q}\"}"
    fi
    ;;

  batch)
    if [ -z "$TEAM_ID" ]; then
      echo '{"success":false,"error":"teamId is required"}'
      exit 1
    fi

    SESSION_ID="onboard-$(date +%s)-$RANDOM"
    mkdir -p "$LOCAL_DIR"

    # Extract answers from input
    ANSWERS=$(printf '%s' "$INPUT" | jq '.answers // {}')

    # Create completed session
    echo "$ANSWERS" | jq --arg id "$SESSION_ID" --arg teamId "$TEAM_ID" \
      '{
        id: $id,
        teamId: $teamId,
        status: "completed",
        currentQuestionIndex: 10,
        totalQuestions: 10,
        answers: .,
        createdAt: (now | todate)
      }' > "${LOCAL_DIR}/${SESSION_ID}.json"

    # Auto-generate if outputDir provided
    if [ -n "$OUTPUT_DIR" ]; then
      ANSWERS_FILE="${LOCAL_DIR}/${SESSION_ID}-answers.json"
      echo "$ANSWERS" > "$ANSWERS_FILE"
      GUIDE_PATH=$(generate_guide "$ANSWERS_FILE" "$OUTPUT_DIR")
      rm -f "$ANSWERS_FILE"
      echo "{\"success\":true,\"sessionId\":\"${SESSION_ID}\",\"status\":\"done\",\"guidePath\":\"${GUIDE_PATH}\"}"
    else
      echo "{\"success\":true,\"sessionId\":\"${SESSION_ID}\",\"status\":\"completed\",\"message\":\"Answers saved. Run action=complete with outputDir to generate guide.\"}"
    fi
    ;;

  complete)
    if [ -z "$SESSION_ID" ]; then
      echo '{"success":false,"error":"sessionId is required"}'
      exit 1
    fi
    if [ -z "$OUTPUT_DIR" ]; then
      echo '{"success":false,"error":"outputDir is required"}'
      exit 1
    fi

    SESSION_FILE="${LOCAL_DIR}/${SESSION_ID}.json"
    if [ ! -f "$SESSION_FILE" ]; then
      echo '{"success":false,"error":"Session not found"}'
      exit 1
    fi

    STATUS=$(jq -r '.status' "$SESSION_FILE")
    if [ "$STATUS" != "completed" ]; then
      echo '{"success":false,"error":"Session is not complete. Answer all questions first."}'
      exit 1
    fi

    # Extract answers to temp file
    ANSWERS_FILE="${LOCAL_DIR}/${SESSION_ID}-answers.json"
    jq '.answers' "$SESSION_FILE" > "$ANSWERS_FILE"

    # Generate guide
    GUIDE_PATH=$(generate_guide "$ANSWERS_FILE" "$OUTPUT_DIR")
    rm -f "$ANSWERS_FILE"

    # Update session
    jq --arg path "$GUIDE_PATH" '.status = "done" | .guidePath = $path' \
      "$SESSION_FILE" > "${SESSION_FILE}.tmp" && mv "${SESSION_FILE}.tmp" "$SESSION_FILE"

    echo "{\"success\":true,\"sessionId\":\"${SESSION_ID}\",\"status\":\"done\",\"guidePath\":\"${GUIDE_PATH}\",\"message\":\"Brand Voice Guide generated successfully.\"}"
    ;;

  *)
    echo "{\"success\":false,\"error\":\"Unknown action: ${ACTION}. Use start, question, answer, batch, or complete.\"}"
    exit 1
    ;;
esac
