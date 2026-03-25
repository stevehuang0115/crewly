#!/bin/bash
# README Generator - Auto-generate README.md from package.json and project structure
set -euo pipefail

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && echo '{"error":"Usage: execute.sh \"{\\\"projectPath\\\":\\\"/path/to/project\\\",\\\"dryRun\\\":true}\""}' >&2 && exit 1

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
DRY_RUN=$(printf '%s' "$INPUT" | jq -r '.dryRun // "false"')
OUTPUT_PATH=$(printf '%s' "$INPUT" | jq -r '.outputPath // empty')

PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)
PKG_JSON="$PROJECT_PATH/package.json"

# Extract info from package.json if present
PKG_NAME=""
PKG_DESC=""
PKG_VERSION=""
PKG_LICENSE=""
PKG_SCRIPTS=""

if [ -f "$PKG_JSON" ]; then
  PKG_NAME=$(jq -r '.name // ""' "$PKG_JSON")
  PKG_DESC=$(jq -r '.description // ""' "$PKG_JSON")
  PKG_VERSION=$(jq -r '.version // ""' "$PKG_JSON")
  PKG_LICENSE=$(jq -r '.license // ""' "$PKG_JSON")
  PKG_SCRIPTS=$(jq -r '.scripts // {} | keys[]' "$PKG_JSON" 2>/dev/null | head -10 || true)
fi

# Detect project structure
DIRS=$(ls -d "$PROJECT_PATH"/*/ 2>/dev/null | xargs -I{} basename {} | head -15 || true)
HAS_TYPESCRIPT=$( [ -f "$PROJECT_PATH/tsconfig.json" ] && echo "true" || echo "false" )
HAS_DOCKER=$( [ -f "$PROJECT_PATH/Dockerfile" ] || [ -f "$PROJECT_PATH/docker-compose.yml" ] && echo "true" || echo "false" )
HAS_TESTS=$( (ls "$PROJECT_PATH"/**/*.test.* 2>/dev/null || ls "$PROJECT_PATH"/**/test* 2>/dev/null) | head -1 >/dev/null 2>&1 && echo "true" || echo "false" )

# Build README content
README="# ${PKG_NAME:-$(basename "$PROJECT_PATH")}

${PKG_DESC:-A project.}
"

if [ -n "$PKG_VERSION" ]; then
  README="${README}
## Version

${PKG_VERSION}
"
fi

README="${README}
## Getting Started

### Prerequisites

- Node.js >= 18
"

if [ "$HAS_TYPESCRIPT" = "true" ]; then
  README="${README}- TypeScript
"
fi

if [ "$HAS_DOCKER" = "true" ]; then
  README="${README}- Docker (optional)
"
fi

README="${README}
### Installation

\`\`\`bash
npm install
\`\`\`
"

if [ -n "$PKG_SCRIPTS" ]; then
  README="${README}
## Available Scripts

| Script | Command |
|--------|---------|"
  while IFS= read -r script; do
    [ -n "$script" ] && README="${README}
| \`${script}\` | \`npm run ${script}\` |"
  done <<< "$PKG_SCRIPTS"
  README="${README}
"
fi

if [ -n "$DIRS" ]; then
  README="${README}
## Project Structure

\`\`\`
$(basename "$PROJECT_PATH")/
$(echo "$DIRS" | while read -r d; do echo "├── ${d}/"; done)
\`\`\`
"
fi

if [ -n "$PKG_LICENSE" ]; then
  README="${README}
## License

${PKG_LICENSE}
"
fi

DEST="${OUTPUT_PATH:-${PROJECT_PATH}/README.md}"

if [ "$DRY_RUN" = "true" ]; then
  jq -n \
    --arg content "$README" \
    --arg dest "$DEST" \
    '{dryRun: true, outputPath: $dest, contentLength: ($content | length), preview: ($content | split("\n") | .[0:20] | join("\n"))}'
else
  echo "$README" > "$DEST"
  jq -n \
    --arg path "$DEST" \
    --arg lines "$(echo "$README" | wc -l | tr -d ' ')" \
    '{success: true, outputPath: $path, lines: ($lines | tonumber)}'
fi
