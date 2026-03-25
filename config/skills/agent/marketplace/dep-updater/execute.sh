#!/bin/bash
# Dependency Updater - Check for outdated npm packages
set -euo pipefail

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && echo '{"error":"Usage: execute.sh \"{\\\"projectPath\\\":\\\".\\\",\\\"type\\\":\\\"all\\\"}\""}' >&2 && exit 1

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
DEP_TYPE=$(printf '%s' "$INPUT" | jq -r '.type // "all"')
UPDATE=$(printf '%s' "$INPUT" | jq -r '.update // "false"')

PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)

if [ ! -f "$PROJECT_PATH/package.json" ]; then
  echo '{"error":"No package.json found in project path"}' >&2
  exit 1
fi

cd "$PROJECT_PATH"

# Get outdated packages as JSON
OUTDATED_RAW=$(npm outdated --json 2>/dev/null || true)

if [ -z "$OUTDATED_RAW" ] || [ "$OUTDATED_RAW" = "{}" ]; then
  jq -n '{
    outdatedCount: 0,
    packages: [],
    message: "All dependencies are up to date!"
  }'
  exit 0
fi

# Parse and classify updates
PACKAGES=$(echo "$OUTDATED_RAW" | jq -r '
  [to_entries[] | {
    name: .key,
    current: .value.current,
    wanted: .value.wanted,
    latest: .value.latest,
    type: .value.type,
    changeType: (
      if (.value.current | split(".")[0]) != (.value.latest | split(".")[0]) then "major"
      elif (.value.current | split(".")[1]) != (.value.latest | split(".")[1]) then "minor"
      else "patch"
      end
    )
  }]
')

# Filter by dependency type if specified
case "$DEP_TYPE" in
  dev)
    PACKAGES=$(echo "$PACKAGES" | jq '[.[] | select(.type == "devDependencies")]')
    ;;
  prod)
    PACKAGES=$(echo "$PACKAGES" | jq '[.[] | select(.type == "dependencies")]')
    ;;
  major)
    PACKAGES=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "major")]')
    ;;
  minor)
    PACKAGES=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "minor")]')
    ;;
  patch)
    PACKAGES=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "patch")]')
    ;;
esac

COUNT=$(echo "$PACKAGES" | jq 'length')
MAJOR_COUNT=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "major")] | length')
MINOR_COUNT=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "minor")] | length')
PATCH_COUNT=$(echo "$PACKAGES" | jq '[.[] | select(.changeType == "patch")] | length')

if [ "$UPDATE" = "true" ]; then
  # Only update patch and minor by default (safe updates)
  npm update 2>/dev/null
  jq -n \
    --argjson count "$COUNT" \
    --argjson packages "$PACKAGES" \
    '{
      outdatedCount: $count,
      updated: true,
      message: "Ran npm update (patch + minor updates applied)",
      packages: $packages
    }'
else
  jq -n \
    --argjson count "$COUNT" \
    --argjson major "$MAJOR_COUNT" \
    --argjson minor "$MINOR_COUNT" \
    --argjson patch "$PATCH_COUNT" \
    --argjson packages "$PACKAGES" \
    '{
      outdatedCount: $count,
      major: $major,
      minor: $minor,
      patch: $patch,
      packages: $packages
    }'
fi
