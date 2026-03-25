#!/bin/bash
# Content Writer — generate and manage content drafts
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"draft|save|get|list\",\"topic\":\"...\",\"platform\":\"x-thread\",...}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "draft"')
PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')

# Resolve content directory
if [ -n "$PROJECT_PATH" ]; then
  CONTENT_DIR="${PROJECT_PATH}/.crewly/content/drafts"
else
  CONTENT_DIR="${HOME}/.crewly/content/drafts"
fi
mkdir -p "$CONTENT_DIR"

case "$ACTION" in

  # ─────────────────────────────────────────────
  # DRAFT: Generate a writing brief / prompt for a content piece
  # ─────────────────────────────────────────────
  draft)
    TOPIC=$(printf '%s' "$INPUT" | jq -r '.topic // empty')
    PLATFORM=$(printf '%s' "$INPUT" | jq -r '.platform // empty')
    LINE=$(printf '%s' "$INPUT" | jq -r '.line // "crewly"')
    TONE=$(printf '%s' "$INPUT" | jq -r '.tone // "professional"')
    LENGTH=$(printf '%s' "$INPUT" | jq -r '.length // "medium"')
    AUDIENCE=$(printf '%s' "$INPUT" | jq -r '.audience // empty')
    CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
    REFERENCES=$(printf '%s' "$INPUT" | jq -r '.references // empty')
    CTA=$(printf '%s' "$INPUT" | jq -r '.cta // empty')

    require_param "topic" "$TOPIC"
    require_param "platform" "$PLATFORM"

    # Platform-specific writing specs
    PLATFORM_SPEC=""
    CHAR_LIMIT=""
    FORMAT_GUIDE=""
    HASHTAG_GUIDE=""

    case "$PLATFORM" in
      x-thread)
        CHAR_LIMIT="280 chars per tweet, 3-7 tweets total"
        FORMAT_GUIDE="Start with a powerful hook tweet that stops scrolling. Each tweet should have one clear idea. Use [1/N] format. Line breaks between logical sections within tweets. Last tweet = CTA + hashtags."
        HASHTAG_GUIDE="2-3 hashtags on the final tweet only. Suggested: #AIAgent #BuildInPublic #Automation"
        ;;
      x-single)
        CHAR_LIMIT="280 chars total"
        FORMAT_GUIDE="One punchy insight or announcement. No fluff. Include a hook and a takeaway in the same breath."
        HASHTAG_GUIDE="1-2 hashtags max, integrated into the text if possible."
        ;;
      linkedin)
        CHAR_LIMIT="1500-2500 chars"
        FORMAT_GUIDE="Bold opening line (acts as preview). Short paragraphs (1-2 sentences). Use line breaks generously. Include data or specific examples. End with a question or CTA to drive comments. Structure: Hook > Problem > Insight > Evidence > Takeaway > CTA."
        HASHTAG_GUIDE="3-5 hashtags at the very end, separated from body. Suggested: #AIAgents #SMBAutomation #BuildInPublic #AITeam"
        ;;
      xiaohongshu)
        CHAR_LIMIT="500-1000 chars (Chinese)"
        FORMAT_GUIDE="Write in Simplified Chinese. Catchy title with emoji in first line. Relatable and conversational. Use bullet points. Include personal anecdote or experience. End with engagement prompt (ask a question or invite comments)."
        HASHTAG_GUIDE="5-8 hashtags in #topic[话题]# format at the end. Core tags: #创业MVP[话题]# #用好ai拿捏职场[话题]# #职场smalltalk[话题]# #vibecoding[话题]#"
        ;;
      substack)
        CHAR_LIMIT="2000-8000 chars"
        FORMAT_GUIDE="Newsletter format. Compelling subject line + subtitle. Structured with H2/H3 sections. Personal voice — write as Steve talking to subscribers. Include one 'aha moment' insight. Reference specific tools/data. End with: what to try this week + teaser for next issue."
        HASHTAG_GUIDE="No hashtags. Use SEO-friendly title instead."
        ;;
      youtube-desc)
        CHAR_LIMIT="2000-4000 chars"
        FORMAT_GUIDE="First 2 lines = video summary (shown before 'Show more'). Include timestamps: [00:00] Intro, [01:30] Topic A, etc. Links section: relevant tools, socials, subscribe CTA. Bottom: 15-20 keyword tags comma-separated."
        HASHTAG_GUIDE="No hashtags in description. Use keyword tags at the bottom."
        ;;
      blog)
        CHAR_LIMIT="3000-10000 chars"
        FORMAT_GUIDE="SEO-optimized blog post. H1 title with primary keyword. H2/H3 section structure. Include code examples where relevant. Add meta description (155 chars) at the top. Internal + external links. Conclusion with CTA."
        HASHTAG_GUIDE="No hashtags. Focus on SEO keywords in headers and first paragraph."
        ;;
      *)
        error_exit "Unsupported platform: $PLATFORM. Valid: x-thread, x-single, linkedin, xiaohongshu, substack, youtube-desc, blog"
        ;;
    esac

    # Brand voice
    BRAND_VOICE=""
    case "$LINE" in
      crewly)
        BRAND_VOICE="Crewly brand voice. Technical but accessible. Developer-first audience. Honest about limitations. Concrete examples > abstract claims. Core positioning: 'Your AI Team, Ready in Days — Not Months.' Key differentiators: PTY isolation, Quality Gates, live terminal streaming, multi-agent orchestration."
        ;;
      personal)
        BRAND_VOICE="Steve Huang's personal voice. Google PM (7 years). 24 side projects veteran. AI-native builder. Build in Public advocate. Bilingual EN/CN. Persona: smart friend sharing real experience, not guru lecturing. Key themes: one-person company, AI as leverage, side hustle strategy, shipping fast."
        ;;
    esac

    # Tone
    TONE_SPEC=""
    case "$TONE" in
      professional) TONE_SPEC="Authoritative and measured. Data-driven. Confident but not arrogant." ;;
      casual)       TONE_SPEC="Conversational. Like texting a smart friend. Humor welcome. Short sentences." ;;
      technical)    TONE_SPEC="Precise. Assumes reader is a developer. Use specific terms, code refs, architecture details." ;;
      inspiring)    TONE_SPEC="Forward-looking. Personal stories as evidence. Empowering. 'You can do this too' energy." ;;
      provocative)  TONE_SPEC="Contrarian takes. Challenge assumptions. Bold opinions backed by reasoning. 'Here is what everyone gets wrong' framing." ;;
      educational)  TONE_SPEC="Step-by-step. Clear explanations. Assume reader is learning. Use analogies." ;;
      *)            TONE_SPEC="Professional and clear." ;;
    esac

    # Length
    LENGTH_SPEC=""
    case "$LENGTH" in
      short)  LENGTH_SPEC="Keep it tight. Minimum viable content. Every word earns its place." ;;
      medium) LENGTH_SPEC="Standard length for the platform. Develop 2-3 key points." ;;
      long)   LENGTH_SPEC="In-depth treatment. Multiple sections. Comprehensive but not padded." ;;
      *)      LENGTH_SPEC="Standard length for the platform." ;;
    esac

    # Audience
    AUDIENCE_SPEC=""
    if [ -n "$AUDIENCE" ]; then
      AUDIENCE_SPEC="Target audience: ${AUDIENCE}."
    else
      case "$LINE" in
        crewly)   AUDIENCE_SPEC="Target audience: SMB founders, content agency owners, tech leads looking for AI automation. Decision makers who evaluate tools." ;;
        personal) AUDIENCE_SPEC="Target audience: Tech professionals, aspiring entrepreneurs, side-hustle builders, AI enthusiasts. People who want to build things." ;;
      esac
    fi

    # Build the writing brief
    DRAFT_ID="draft-$(date +%s)-$((RANDOM % 1000))"
    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    BRIEF=$(jq -n \
      --arg draftId "$DRAFT_ID" \
      --arg topic "$TOPIC" \
      --arg platform "$PLATFORM" \
      --arg line "$LINE" \
      --arg charLimit "$CHAR_LIMIT" \
      --arg formatGuide "$FORMAT_GUIDE" \
      --arg hashtagGuide "$HASHTAG_GUIDE" \
      --arg brandVoice "$BRAND_VOICE" \
      --arg toneSpec "$TONE_SPEC" \
      --arg lengthSpec "$LENGTH_SPEC" \
      --arg audienceSpec "$AUDIENCE_SPEC" \
      --arg context "$CONTEXT" \
      --arg references "$REFERENCES" \
      --arg cta "$CTA" \
      --arg createdAt "$NOW" \
      '{
        draftId: $draftId,
        topic: $topic,
        platform: $platform,
        contentLine: $line,
        createdAt: $createdAt,
        writingBrief: {
          charLimit: $charLimit,
          formatGuide: $formatGuide,
          hashtagGuide: $hashtagGuide,
          brandVoice: $brandVoice,
          tone: $toneSpec,
          length: $lengthSpec,
          audience: $audienceSpec,
          additionalContext: $context,
          references: $references,
          callToAction: $cta
        },
        instruction: "Use this writing brief to generate the actual content. Write the full draft based on these specs, then use the save action to store it."
      }')

    echo "$BRIEF"
    ;;

  # ─────────────────────────────────────────────
  # SAVE: Save a completed content draft to disk
  # ─────────────────────────────────────────────
  save)
    DRAFT_ID=$(printf '%s' "$INPUT" | jq -r '.draftId // empty')
    TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
    PLATFORM=$(printf '%s' "$INPUT" | jq -r '.platform // empty')
    LINE=$(printf '%s' "$INPUT" | jq -r '.line // "crewly"')
    CONTENT=$(printf '%s' "$INPUT" | jq -r '.content // empty')
    CALENDAR_ID=$(printf '%s' "$INPUT" | jq -r '.calendarId // empty')

    require_param "title" "$TITLE"
    require_param "platform" "$PLATFORM"
    require_param "content" "$CONTENT"

    # Generate draft ID if not provided
    if [ -z "$DRAFT_ID" ]; then
      DRAFT_ID="draft-$(date +%s)-$((RANDOM % 1000))"
    fi

    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    TODAY=$(date -u +%Y-%m-%d)

    # Create platform subdirectory
    PLATFORM_DIR="${CONTENT_DIR}/${PLATFORM}"
    mkdir -p "$PLATFORM_DIR"

    # Generate filename
    SAFE_TITLE=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 50)
    FILENAME="${TODAY}-${SAFE_TITLE}.md"
    FILE_PATH="${PLATFORM_DIR}/${FILENAME}"

    # Write the draft as markdown
    cat > "$FILE_PATH" <<DRAFT_EOF
---
draftId: ${DRAFT_ID}
title: ${TITLE}
platform: ${PLATFORM}
line: ${LINE}
calendarId: ${CALENDAR_ID}
createdAt: ${NOW}
status: draft
---

${CONTENT}
DRAFT_EOF

    CHAR_COUNT=${#CONTENT}

    jq -n \
      --arg draftId "$DRAFT_ID" \
      --arg title "$TITLE" \
      --arg platform "$PLATFORM" \
      --arg filePath "$FILE_PATH" \
      --argjson charCount "$CHAR_COUNT" \
      --arg calendarId "$CALENDAR_ID" \
      '{"success":true,"action":"save","draftId":$draftId,"title":$title,"platform":$platform,"filePath":$filePath,"charCount":$charCount,"calendarId":$calendarId}'
    ;;

  # ─────────────────────────────────────────────
  # GET: Read a saved draft
  # ─────────────────────────────────────────────
  get)
    FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.filePath // empty')
    DRAFT_ID=$(printf '%s' "$INPUT" | jq -r '.draftId // empty')

    if [ -n "$FILE_PATH" ] && [ -f "$FILE_PATH" ]; then
      CONTENT=$(cat "$FILE_PATH")
      jq -n --arg content "$CONTENT" --arg filePath "$FILE_PATH" \
        '{"success":true,"action":"get","filePath":$filePath,"content":$content}'
    elif [ -n "$DRAFT_ID" ]; then
      # Search by draft ID in all files
      FOUND=""
      for f in "$CONTENT_DIR"/*/*.md "$CONTENT_DIR"/*.md; do
        [ -f "$f" ] || continue
        if grep -q "draftId: ${DRAFT_ID}" "$f" 2>/dev/null; then
          FOUND="$f"
          break
        fi
      done
      if [ -n "$FOUND" ]; then
        CONTENT=$(cat "$FOUND")
        jq -n --arg content "$CONTENT" --arg filePath "$FOUND" \
          '{"success":true,"action":"get","filePath":$filePath,"content":$content}'
      else
        error_exit "Draft not found: $DRAFT_ID"
      fi
    else
      error_exit "Provide filePath or draftId"
    fi
    ;;

  # ─────────────────────────────────────────────
  # LIST: List saved drafts
  # ─────────────────────────────────────────────
  list)
    FILTER_PLATFORM=$(printf '%s' "$INPUT" | jq -r '.platform // empty')
    LIMIT=$(printf '%s' "$INPUT" | jq -r '.limit // "20"')

    DRAFTS="[]"

    SEARCH_DIRS="$CONTENT_DIR"
    if [ -n "$FILTER_PLATFORM" ]; then
      SEARCH_DIRS="${CONTENT_DIR}/${FILTER_PLATFORM}"
    fi

    for f in $(find "$SEARCH_DIRS" -name "*.md" -type f 2>/dev/null | sort -r | head -"$LIMIT"); do
      [ -f "$f" ] || continue
      BASENAME=$(basename "$f")
      DIR_PLATFORM=$(basename "$(dirname "$f")")
      # Extract frontmatter fields
      D_TITLE=$(grep "^title:" "$f" 2>/dev/null | head -1 | sed 's/^title: //')
      D_PLATFORM=$(grep "^platform:" "$f" 2>/dev/null | head -1 | sed 's/^platform: //')
      D_LINE=$(grep "^line:" "$f" 2>/dev/null | head -1 | sed 's/^line: //')
      D_STATUS=$(grep "^status:" "$f" 2>/dev/null | head -1 | sed 's/^status: //')
      D_CREATED=$(grep "^createdAt:" "$f" 2>/dev/null | head -1 | sed 's/^createdAt: //')
      FILE_SIZE=$(wc -c < "$f" | tr -d ' ')

      DRAFTS=$(echo "$DRAFTS" | jq \
        --arg file "$f" \
        --arg title "${D_TITLE:-$BASENAME}" \
        --arg platform "${D_PLATFORM:-$DIR_PLATFORM}" \
        --arg line "${D_LINE:-unknown}" \
        --arg status "${D_STATUS:-draft}" \
        --arg created "${D_CREATED:-unknown}" \
        --arg size "$FILE_SIZE" \
        '. + [{"filePath":$file,"title":$title,"platform":$platform,"line":$line,"status":$status,"createdAt":$created,"fileSize":($size|tonumber)}]')
    done

    COUNT=$(echo "$DRAFTS" | jq 'length')
    jq -n --argjson drafts "$DRAFTS" --argjson count "$COUNT" \
      '{"success":true,"action":"list","count":$count,"drafts":$drafts}'
    ;;

  *)
    error_exit "Unknown action: $ACTION. Valid: draft, save, get, list"
    ;;
esac
