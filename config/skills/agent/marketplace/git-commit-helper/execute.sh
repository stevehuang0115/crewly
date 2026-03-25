#!/bin/bash
# Git Commit Helper - Analyze staged changes and create a conventional commit
set -euo pipefail

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && echo '{"error":"Usage: execute.sh \"{\\\"message\\\":\\\"feat: add login\\\",\\\"scope\\\":\\\"auth\\\",\\\"dryRun\\\":true}\""}' >&2 && exit 1

MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // empty')
SCOPE=$(printf '%s' "$INPUT" | jq -r '.scope // empty')
DRY_RUN=$(printf '%s' "$INPUT" | jq -r '.dryRun // "false"')
BODY=$(printf '%s' "$INPUT" | jq -r '.body // empty')

# Check if inside a git repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '{"error":"Not inside a git repository"}' >&2
  exit 1
fi

# Check for staged changes
STAGED=$(git diff --cached --stat 2>/dev/null || true)
if [ -z "$STAGED" ]; then
  echo '{"error":"No staged changes found. Run git add first."}' >&2
  exit 1
fi

# Build commit message
if [ -z "$MESSAGE" ]; then
  # Auto-generate from staged diff summary
  FILES_CHANGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
  INSERTIONS=$(git diff --cached --numstat | awk '{s+=$1} END {print s+0}')
  DELETIONS=$(git diff --cached --numstat | awk '{s+=$1} END {print s+0}')
  MESSAGE="chore: update ${FILES_CHANGED} file(s) (+${INSERTIONS}/-${DELETIONS})"
fi

# Add scope if provided
if [ -n "$SCOPE" ]; then
  # Insert scope: "feat: msg" -> "feat(scope): msg"
  TYPE=$(echo "$MESSAGE" | cut -d: -f1)
  REST=$(echo "$MESSAGE" | cut -d: -f2-)
  MESSAGE="${TYPE}(${SCOPE}):${REST}"
fi

FULL_MESSAGE="$MESSAGE"
if [ -n "$BODY" ]; then
  FULL_MESSAGE="${MESSAGE}

${BODY}"
fi

if [ "$DRY_RUN" = "true" ]; then
  DIFF_STAT=$(git diff --cached --stat)
  jq -n \
    --arg message "$FULL_MESSAGE" \
    --arg stat "$DIFF_STAT" \
    '{dryRun: true, message: $message, stagedChanges: $stat}'
else
  git commit -m "$FULL_MESSAGE" >/dev/null 2>&1
  COMMIT_HASH=$(git rev-parse --short HEAD)
  jq -n \
    --arg message "$FULL_MESSAGE" \
    --arg hash "$COMMIT_HASH" \
    '{success: true, message: $message, commitHash: $hash}'
fi
