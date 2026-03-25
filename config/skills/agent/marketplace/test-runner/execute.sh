#!/bin/bash
# Test Runner - Detect test framework and run tests with coverage
set -euo pipefail

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && echo '{"error":"Usage: execute.sh \"{\\\"projectPath\\\":\\\".\\\",\\\"pattern\\\":\\\"src/\\\",\\\"coverage\\\":true}\""}' >&2 && exit 1

PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // "."')
PATTERN=$(printf '%s' "$INPUT" | jq -r '.pattern // empty')
COVERAGE=$(printf '%s' "$INPUT" | jq -r '.coverage // "false"')
FRAMEWORK=$(printf '%s' "$INPUT" | jq -r '.framework // empty')

PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)

# Auto-detect test framework if not specified
if [ -z "$FRAMEWORK" ]; then
  if [ -f "$PROJECT_PATH/vitest.config.ts" ] || [ -f "$PROJECT_PATH/vitest.config.js" ]; then
    FRAMEWORK="vitest"
  elif [ -f "$PROJECT_PATH/jest.config.js" ] || [ -f "$PROJECT_PATH/jest.config.ts" ] || jq -e '.jest' "$PROJECT_PATH/package.json" >/dev/null 2>&1; then
    FRAMEWORK="jest"
  elif [ -f "$PROJECT_PATH/pytest.ini" ] || [ -f "$PROJECT_PATH/pyproject.toml" ] || [ -f "$PROJECT_PATH/setup.cfg" ]; then
    FRAMEWORK="pytest"
  elif [ -f "$PROJECT_PATH/package.json" ]; then
    # Check if test script hints at a framework
    TEST_SCRIPT=$(jq -r '.scripts.test // ""' "$PROJECT_PATH/package.json")
    case "$TEST_SCRIPT" in
      *vitest*) FRAMEWORK="vitest" ;;
      *jest*) FRAMEWORK="jest" ;;
      *mocha*) FRAMEWORK="mocha" ;;
      *) FRAMEWORK="npm-test" ;;
    esac
  else
    echo '{"error":"Could not detect test framework. Specify with \"framework\" parameter."}' >&2
    exit 1
  fi
fi

# Build command based on framework
CMD=""
case "$FRAMEWORK" in
  jest)
    CMD="npx jest"
    [ -n "$PATTERN" ] && CMD="$CMD --testPathPattern='$PATTERN'"
    [ "$COVERAGE" = "true" ] && CMD="$CMD --coverage"
    CMD="$CMD --forceExit 2>&1"
    ;;
  vitest)
    CMD="npx vitest run"
    [ -n "$PATTERN" ] && CMD="$CMD $PATTERN"
    [ "$COVERAGE" = "true" ] && CMD="$CMD --coverage"
    CMD="$CMD 2>&1"
    ;;
  pytest)
    CMD="python -m pytest"
    [ -n "$PATTERN" ] && CMD="$CMD $PATTERN"
    [ "$COVERAGE" = "true" ] && CMD="$CMD --cov"
    CMD="$CMD 2>&1"
    ;;
  mocha)
    CMD="npx mocha"
    [ -n "$PATTERN" ] && CMD="$CMD '$PATTERN'"
    CMD="$CMD 2>&1"
    ;;
  npm-test)
    CMD="npm test 2>&1"
    ;;
  *)
    echo "{\"error\":\"Unsupported framework: $FRAMEWORK\"}" >&2
    exit 1
    ;;
esac

# Run tests
cd "$PROJECT_PATH"
OUTPUT=$(eval "$CMD" || true)
EXIT_CODE=${PIPESTATUS[0]:-$?}

# Extract summary from output (last 20 lines usually have the summary)
SUMMARY=$(echo "$OUTPUT" | tail -20)

jq -n \
  --arg framework "$FRAMEWORK" \
  --arg output "$SUMMARY" \
  --argjson exitCode "${EXIT_CODE:-0}" \
  --arg cmd "$CMD" \
  '{
    framework: $framework,
    command: $cmd,
    exitCode: $exitCode,
    passed: ($exitCode == 0),
    summary: $output
  }'
