#!/bin/bash
# Marketplace Publish - package and submit skills to the marketplace
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"publish\",\"skillPath\":\"/path/to/skill\"}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "publish"')
SKILL_PATH=$(printf '%s' "$INPUT" | jq -r '.skillPath // empty')

case "$ACTION" in
  validate)
    # Validate a skill directory without packaging
    require_param "skillPath" "$SKILL_PATH"

    if [ ! -d "$SKILL_PATH" ]; then
      error_exit "Skill directory not found: ${SKILL_PATH}"
    fi

    ERRORS=()
    WARNINGS=()

    # Check required files
    for FILE in skill.json execute.sh instructions.md; do
      if [ ! -f "${SKILL_PATH}/${FILE}" ]; then
        ERRORS+=("Missing required file: ${FILE}")
      fi
    done

    # Validate skill.json if it exists
    if [ -f "${SKILL_PATH}/skill.json" ]; then
      MANIFEST=$(cat "${SKILL_PATH}/skill.json")

      for FIELD in id name description version category; do
        VALUE=$(echo "$MANIFEST" | jq -r ".${FIELD} // empty")
        if [ -z "$VALUE" ]; then
          ERRORS+=("skill.json missing required field: ${FIELD}")
        fi
      done

      # Check id is kebab-case
      ID=$(echo "$MANIFEST" | jq -r '.id // empty')
      if [ -n "$ID" ] && ! echo "$ID" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
        ERRORS+=("skill.json id must be kebab-case: ${ID}")
      fi

      # Check version is semver
      VERSION=$(echo "$MANIFEST" | jq -r '.version // empty')
      if [ -n "$VERSION" ] && ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        ERRORS+=("skill.json version must be semver (x.y.z): ${VERSION}")
      fi

      # Check assignableRoles
      ROLES_COUNT=$(echo "$MANIFEST" | jq '.assignableRoles | length // 0')
      if [ "$ROLES_COUNT" -eq 0 ]; then
        WARNINGS+=("skill.json should have a non-empty assignableRoles array")
      fi

      # Check tags
      TAGS_COUNT=$(echo "$MANIFEST" | jq '.tags | length // 0')
      if [ "$TAGS_COUNT" -eq 0 ]; then
        WARNINGS+=("skill.json should have a non-empty tags array")
      fi
    fi

    # Check execute.sh is executable
    if [ -f "${SKILL_PATH}/execute.sh" ] && [ ! -x "${SKILL_PATH}/execute.sh" ]; then
      WARNINGS+=("execute.sh is not executable — run chmod +x")
    fi

    # Build JSON response
    ERROR_JSON=$(printf '%s\n' "${ERRORS[@]:-}" | jq -R . | jq -s .)
    WARN_JSON=$(printf '%s\n' "${WARNINGS[@]:-}" | jq -R . | jq -s .)
    VALID="true"
    [ ${#ERRORS[@]} -gt 0 ] && VALID="false"

    echo "{\"valid\":${VALID},\"errors\":${ERROR_JSON},\"warnings\":${WARN_JSON}}"
    ;;

  publish)
    # Package skill and submit to local marketplace
    require_param "skillPath" "$SKILL_PATH"

    if [ ! -d "$SKILL_PATH" ]; then
      error_exit "Skill directory not found: ${SKILL_PATH}"
    fi

    if [ ! -f "${SKILL_PATH}/skill.json" ]; then
      error_exit "No skill.json found in ${SKILL_PATH}"
    fi

    MANIFEST=$(cat "${SKILL_PATH}/skill.json")
    SKILL_ID=$(echo "$MANIFEST" | jq -r '.id')
    SKILL_VERSION=$(echo "$MANIFEST" | jq -r '.version')
    SKILL_NAME=$(echo "$MANIFEST" | jq -r '.name')

    # Create temp directory for archive
    TMP_DIR=$(mktemp -d)
    ARCHIVE_NAME="${SKILL_ID}-${SKILL_VERSION}.tar.gz"
    ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE_NAME}"

    # Create tar.gz archive
    tar -czf "$ARCHIVE_PATH" -C "$(dirname "$SKILL_PATH")" "$(basename "$SKILL_PATH")"

    # Submit to local backend
    SUBMIT_RESULT=$(api_call POST "/marketplace/submit" "{\"archivePath\":\"${ARCHIVE_PATH}\"}")

    # Clean up temp
    rm -rf "$TMP_DIR"

    echo "{\"success\":true,\"message\":\"Published ${SKILL_NAME} v${SKILL_VERSION}\",\"submitResult\":${SUBMIT_RESULT}}"
    ;;

  publish-remote)
    # Submit to the LOCAL review queue AND publish to the PUBLIC marketplace.
    #
    # The public path goes through `crewly publish --cloud`, which carries the
    # user's Crewly Cloud token (from `crewly cloud login`); the cloud holds the
    # GitHub bot token and opens a PR. We deliberately do NOT write the registry
    # directly: the old `POST /api/registry/skills` path is an admin-only
    # endpoint and correctly rejects unauthenticated requests with 401 — sending
    # an admin token from a user skill would leak it to every machine.
    require_param "skillPath" "$SKILL_PATH"

    if [ ! -d "$SKILL_PATH" ]; then
      error_exit "Skill directory not found: ${SKILL_PATH}"
    fi

    if [ ! -f "${SKILL_PATH}/skill.json" ]; then
      error_exit "No skill.json found in ${SKILL_PATH}"
    fi

    MANIFEST=$(cat "${SKILL_PATH}/skill.json")
    SKILL_ID=$(echo "$MANIFEST" | jq -r '.id')
    SKILL_VERSION=$(echo "$MANIFEST" | jq -r '.version')
    SKILL_NAME=$(echo "$MANIFEST" | jq -r '.name')

    # 1. Local review queue (unchanged) — package + submit to the local backend.
    TMP_DIR=$(mktemp -d)
    ARCHIVE_PATH="${TMP_DIR}/${SKILL_ID}-${SKILL_VERSION}.tar.gz"
    tar -czf "$ARCHIVE_PATH" -C "$(dirname "$SKILL_PATH")" "$(basename "$SKILL_PATH")"
    LOCAL_RESULT=$(api_call POST "/marketplace/submit" "{\"archivePath\":\"${ARCHIVE_PATH}\"}" 2>&1 || true)
    rm -rf "$TMP_DIR"

    # 2. Public marketplace via the authenticated Crewly Cloud flow (opens a PR).
    if ! command -v crewly >/dev/null 2>&1; then
      echo "{\"success\":false,\"message\":\"Local submission done; crewly CLI not found, cannot publish to the public marketplace\",\"localResult\":${LOCAL_RESULT:-null}}"
      exit 0
    fi

    CLOUD_OUT=$(crewly publish "$SKILL_PATH" --cloud 2>&1 || true)
    PR_URL=$(printf '%s' "$CLOUD_OUT" | grep -oE 'https://github\.com/[^ ]+/pull/[0-9]+' | head -1)

    if [ -n "$PR_URL" ]; then
      echo "{\"success\":true,\"message\":\"Published ${SKILL_NAME} v${SKILL_VERSION}: local review queue + public marketplace PR\",\"localResult\":${LOCAL_RESULT:-null},\"prUrl\":\"${PR_URL}\"}"
    else
      # Most common failure: not logged in → `crewly cloud login`.
      CLOUD_MSG=$(printf '%s' "$CLOUD_OUT" | tr '\n' ' ' | sed 's/"/\\"/g')
      echo "{\"success\":false,\"message\":\"Local submission done; public publish failed\",\"localResult\":${LOCAL_RESULT:-null},\"cloudError\":\"${CLOUD_MSG}\",\"hint\":\"Run 'crewly cloud login' if not authenticated, then retry.\"}"
      exit 0
    fi
    ;;

  list-submissions)
    # List pending/reviewed submissions
    STATUS_FILTER=$(printf '%s' "$INPUT" | jq -r '.status // empty')
    ENDPOINT="/marketplace/submissions"
    [ -n "$STATUS_FILTER" ] && ENDPOINT="${ENDPOINT}?status=${STATUS_FILTER}"
    api_call GET "$ENDPOINT"
    ;;

  *)
    error_exit "Unknown action: ${ACTION}. Use: validate, publish, publish-remote, list-submissions"
    ;;
esac
