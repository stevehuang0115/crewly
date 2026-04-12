#!/bin/bash
# Generate platform-optimized social media posts
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"topic\":\"Topic text\",\"platforms\":\"twitter,linkedin,reddit\",\"url\":\"https://...\",\"hashtags\":\"tag1,tag2\",\"tone\":\"professional\"}'"

# Parse parameters
TOPIC=$(printf '%s' "$INPUT" | jq -r '.topic // empty')
PLATFORMS=$(printf '%s' "$INPUT" | jq -r '.platforms // "twitter,linkedin,reddit"')
URL=$(printf '%s' "$INPUT" | jq -r '.url // empty')
HASHTAGS_INPUT=$(printf '%s' "$INPUT" | jq -r '.hashtags // empty')
TONE=$(printf '%s' "$INPUT" | jq -r '.tone // "professional"')

require_param "topic" "$TOPIC"

# Parse hashtags
HASHTAGS_STR=""
if [ -n "$HASHTAGS_INPUT" ]; then
  IFS=',' read -ra HT_ARRAY <<< "$HASHTAGS_INPUT"
  for ht in "${HT_ARRAY[@]}"; do
    ht=$(echo "$ht" | xargs)
    # Add # prefix if missing
    [[ "$ht" != \#* ]] && ht="#${ht}"
    HASHTAGS_STR="${HASHTAGS_STR} ${ht}"
  done
  HASHTAGS_STR=$(echo "$HASHTAGS_STR" | xargs)
fi

# Tone-specific opening phrases
case "$TONE" in
  casual)
    TWITTER_HOOK="Just shipped something cool:"
    LINKEDIN_HOOK="Hey everyone!"
    REDDIT_TONE="conversational"
    ;;
  technical)
    TWITTER_HOOK="New release:"
    LINKEDIN_HOOK="Technical update:"
    REDDIT_TONE="technical and detailed"
    ;;
  exciting)
    TWITTER_HOOK="Big news!"
    LINKEDIN_HOOK="Excited to share:"
    REDDIT_TONE="enthusiastic but informative"
    ;;
  *)
    TWITTER_HOOK="Introducing:"
    LINKEDIN_HOOK="I'm pleased to share:"
    REDDIT_TONE="professional and value-focused"
    ;;
esac

# Parse platforms
IFS=',' read -ra PLATFORM_ARRAY <<< "$PLATFORMS"

POSTS="[]"

for platform in "${PLATFORM_ARRAY[@]}"; do
  platform=$(echo "$platform" | xargs | tr '[:upper:]' '[:lower:]')

  case "$platform" in
    twitter)
      # Twitter: max 280 chars
      CONTENT="${TWITTER_HOOK} ${TOPIC}"
      [ -n "$URL" ] && CONTENT="${CONTENT}\n\n${URL}"
      [ -n "$HASHTAGS_STR" ] && CONTENT="${CONTENT}\n\n${HASHTAGS_STR}"

      # Measure length (count \n as 1 char each for display, URLs count as 23 chars on Twitter)
      DISPLAY_CONTENT=$(echo -e "$CONTENT")
      CHAR_COUNT=${#DISPLAY_CONTENT}

      POSTS=$(echo "$POSTS" | jq \
        --arg platform "twitter" \
        --arg content "$CONTENT" \
        --arg charCount "$CHAR_COUNT" \
        '. + [{"platform":$platform,"content":$content,"charCount":($charCount | tonumber),"maxChars":280}]')
      ;;

    linkedin)
      # LinkedIn: max 3000 chars, multi-paragraph
      CONTENT="${LINKEDIN_HOOK}\n\n${TOPIC}\n\nWhy this matters:\n\n- Saves time on repetitive tasks\n- Improves team coordination and visibility\n- Easy to get started — no complex setup required\n\nWhat do you think? Would love to hear your thoughts."
      [ -n "$URL" ] && CONTENT="${CONTENT}\n\nLearn more: ${URL}"
      [ -n "$HASHTAGS_STR" ] && CONTENT="${CONTENT}\n\n${HASHTAGS_STR}"

      DISPLAY_CONTENT=$(echo -e "$CONTENT")
      CHAR_COUNT=${#DISPLAY_CONTENT}

      POSTS=$(echo "$POSTS" | jq \
        --arg platform "linkedin" \
        --arg content "$CONTENT" \
        --arg charCount "$CHAR_COUNT" \
        '. + [{"platform":$platform,"content":$content,"charCount":($charCount | tonumber),"maxChars":3000}]')
      ;;

    reddit)
      # Reddit: title (300 chars) + body
      REDDIT_TITLE="${TOPIC}"
      if [ ${#REDDIT_TITLE} -gt 300 ]; then
        REDDIT_TITLE="${REDDIT_TITLE:0:297}..."
      fi

      REDDIT_BODY="I wanted to share ${TOPIC}.\n\nHere's what it does and why it might be useful:\n\n- Key benefit 1 (fill in)\n- Key benefit 2 (fill in)\n- Key benefit 3 (fill in)\n\nHappy to answer any questions or take feedback."
      [ -n "$URL" ] && REDDIT_BODY="${REDDIT_BODY}\n\nLink: ${URL}"

      DISPLAY_BODY=$(echo -e "$REDDIT_BODY")
      BODY_CHAR_COUNT=${#DISPLAY_BODY}

      POSTS=$(echo "$POSTS" | jq \
        --arg platform "reddit" \
        --arg title "$REDDIT_TITLE" \
        --arg content "$REDDIT_BODY" \
        --arg charCount "$BODY_CHAR_COUNT" \
        --arg tone "$REDDIT_TONE" \
        '. + [{"platform":$platform,"title":$title,"content":$content,"charCount":($charCount | tonumber),"tone":$tone,"subreddit_suggestions":["r/programming","r/artificial","r/SideProject"]}]')
      ;;

    *)
      POSTS=$(echo "$POSTS" | jq \
        --arg platform "$platform" \
        '. + [{"platform":$platform,"error":"Unsupported platform. Use twitter, linkedin, or reddit."}]')
      ;;
  esac
done

# Output JSON with publishing policy reminder
jq -n \
  --arg topic "$TOPIC" \
  --arg tone "$TONE" \
  --argjson posts "$POSTS" \
  '{
    topic: $topic,
    tone: $tone,
    posts: $posts,
    policy: "DRAFT ONLY. X/Twitter is Tier B — must be manually published by Steve. Share draft + compose URL via Slack. Unauthorized publishing = P0 incident."
  }'
