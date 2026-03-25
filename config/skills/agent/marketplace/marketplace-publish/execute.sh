#!/bin/bash
# Marketplace Publish - package and submit skills to the marketplace
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"publish\",\"skillPath\":\"/path/to/skill\"}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "publish"')
SKILL_PATH=$(printf '%s' "$INPUT" | jq -r '.skillPath // empty')
REMOTE_URL=$(printf '%s' "$INPUT" | jq -r '.remoteUrl // "https://crewlyai.com"')

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
    # Package skill and submit to both local and remote registries
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
    LOCAL_RESULT=$(api_call POST "/marketplace/submit" "{\"archivePath\":\"${ARCHIVE_PATH}\"}" 2>&1 || true)

    # Submit to remote registry
    CHECKSUM=$(shasum -a 256 "$ARCHIVE_PATH" | cut -d ' ' -f1)
    SIZE=$(stat -f%z "$ARCHIVE_PATH" 2>/dev/null || stat -c%s "$ARCHIVE_PATH" 2>/dev/null)
    REMOTE_PAYLOAD=$(jq -n \
      --arg id "$SKILL_ID" \
      --arg name "$SKILL_NAME" \
      --arg desc "$(echo "$MANIFEST" | jq -r '.description')" \
      --arg author "$(echo "$MANIFEST" | jq -r '.author // "Community"')" \
      --arg version "$SKILL_VERSION" \
      --arg category "$(echo "$MANIFEST" | jq -r '.category')" \
      --argjson tags "$(echo "$MANIFEST" | jq '.tags // []')" \
      --arg license "$(echo "$MANIFEST" | jq -r '.license // "MIT"')" \
      --arg checksum "sha256:${CHECKSUM}" \
      --argjson size "$SIZE" \
      '{id:$id,name:$name,description:$desc,author:$author,version:$version,category:$category,tags:$tags,license:$license,checksum:$checksum,sizeBytes:($size|tonumber)}')

    REMOTE_RESULT=$(curl -s -w '\n%{http_code}' -X POST \
      -H "Content-Type: application/json" \
      -d "$REMOTE_PAYLOAD" \
      "${REMOTE_URL}/api/registry/skills" 2>&1 || true)

    REMOTE_HTTP=$(echo "$REMOTE_RESULT" | tail -1)
    REMOTE_BODY=$(echo "$REMOTE_RESULT" | sed '$d')

    # Clean up temp
    rm -rf "$TMP_DIR"

    echo "{\"success\":true,\"message\":\"Published ${SKILL_NAME} v${SKILL_VERSION} to local + remote\",\"localResult\":${LOCAL_RESULT:-null},\"remoteStatus\":\"${REMOTE_HTTP}\",\"remoteResult\":${REMOTE_BODY:-null}}"
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
