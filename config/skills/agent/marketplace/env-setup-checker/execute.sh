#!/bin/bash
# Environment Setup Checker - Validate runtime versions, deps, and env vars
set -euo pipefail

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && echo '{"error":"Usage: execute.sh \"{\\\"projectPath\\\":\\\".\\\"}\""}' >&2 && exit 1

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)

CHECKS='[]'
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Helper to add a check result
add_check() {
  local name="$1" status="$2" detail="$3"
  CHECKS=$(echo "$CHECKS" | jq \
    --arg name "$name" \
    --arg status "$status" \
    --arg detail "$detail" \
    '. + [{"name": $name, "status": $status, "detail": $detail}]')
  case "$status" in
    pass) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    fail) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    warn) WARN_COUNT=$((WARN_COUNT + 1)) ;;
  esac
}

# Check Node.js
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    add_check "Node.js" "pass" "$NODE_VER"
  else
    add_check "Node.js" "warn" "$NODE_VER (recommended >= 18)"
  fi
else
  add_check "Node.js" "fail" "not installed"
fi

# Check npm
if command -v npm >/dev/null 2>&1; then
  add_check "npm" "pass" "$(npm --version)"
else
  add_check "npm" "fail" "not installed"
fi

# Check Python (optional)
if command -v python3 >/dev/null 2>&1; then
  add_check "Python" "pass" "$(python3 --version 2>&1)"
elif command -v python >/dev/null 2>&1; then
  add_check "Python" "pass" "$(python --version 2>&1)"
else
  add_check "Python" "warn" "not installed (optional)"
fi

# Check Git
if command -v git >/dev/null 2>&1; then
  add_check "Git" "pass" "$(git --version | awk '{print $3}')"
else
  add_check "Git" "fail" "not installed"
fi

# Check node_modules
if [ -f "$PROJECT_PATH/package.json" ]; then
  if [ -d "$PROJECT_PATH/node_modules" ]; then
    DEP_COUNT=$(ls "$PROJECT_PATH/node_modules" | wc -l | tr -d ' ')
    add_check "node_modules" "pass" "${DEP_COUNT} packages installed"
  else
    add_check "node_modules" "fail" "missing - run npm install"
  fi
fi

# Check package-lock.json
if [ -f "$PROJECT_PATH/package.json" ]; then
  if [ -f "$PROJECT_PATH/package-lock.json" ]; then
    add_check "package-lock.json" "pass" "present"
  else
    add_check "package-lock.json" "warn" "missing - consider running npm install"
  fi
fi

# Check .env file (if .env.example exists)
if [ -f "$PROJECT_PATH/.env.example" ]; then
  if [ -f "$PROJECT_PATH/.env" ]; then
    # Check for missing vars
    MISSING=""
    while IFS= read -r line; do
      VAR_NAME=$(echo "$line" | cut -d= -f1 | tr -d ' ')
      [ -z "$VAR_NAME" ] && continue
      [[ "$VAR_NAME" == \#* ]] && continue
      if ! grep -q "^${VAR_NAME}=" "$PROJECT_PATH/.env" 2>/dev/null; then
        MISSING="${MISSING}${VAR_NAME}, "
      fi
    done < "$PROJECT_PATH/.env.example"

    if [ -n "$MISSING" ]; then
      add_check ".env variables" "warn" "missing: ${MISSING%, }"
    else
      add_check ".env variables" "pass" "all variables set"
    fi
  else
    add_check ".env" "fail" "missing - copy from .env.example"
  fi
fi

# Check TypeScript
if [ -f "$PROJECT_PATH/tsconfig.json" ]; then
  if command -v npx >/dev/null 2>&1 && npx tsc --version >/dev/null 2>&1; then
    add_check "TypeScript" "pass" "$(npx tsc --version 2>/dev/null)"
  else
    add_check "TypeScript" "warn" "tsconfig.json found but tsc not available"
  fi
fi

jq -n \
  --argjson checks "$CHECKS" \
  --argjson passed "$PASS_COUNT" \
  --argjson failed "$FAIL_COUNT" \
  --argjson warnings "$WARN_COUNT" \
  '{
    passed: $passed,
    failed: $failed,
    warnings: $warnings,
    healthy: ($failed == 0),
    checks: $checks
  }'
