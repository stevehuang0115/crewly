#!/bin/bash
# =============================================================================
# Tests for lib.sh — shared skills library
# Covers: --file preprocessor, read_json_input, require_param, error_exit
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo -e "${GREEN}PASS${NC}: $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC}: $test_name"
    echo "  Expected: $expected"
    echo "  Actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1" expected_substr="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected_substr"; then
    echo -e "${GREEN}PASS${NC}: $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC}: $test_name"
    echo "  Expected to contain: $expected_substr"
    echo "  Actual: $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit_code() {
  local test_name="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" >/dev/null 2>&1 || actual_code=$?
  TOTAL=$((TOTAL + 1))
  if [ "$expected_code" = "$actual_code" ]; then
    echo -e "${GREEN}PASS${NC}: $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC}: $test_name"
    echo "  Expected exit code: $expected_code"
    echo "  Actual exit code:   $actual_code"
    FAIL=$((FAIL + 1))
  fi
}

# Create a minimal test skill script that sources lib.sh and echoes $1
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cat > "$TEMP_DIR/test_skill.sh" << 'SKILL_EOF'
#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source lib.sh via the real path
source "$LIB_PATH"
# Output the first positional parameter (after preprocessor runs)
echo "$1"
SKILL_EOF
chmod +x "$TEMP_DIR/test_skill.sh"

# Also create a test skill that uses read_json_input
cat > "$TEMP_DIR/test_read_json.sh" << 'SKILL_EOF'
#!/bin/bash
set -euo pipefail
source "$LIB_PATH"
INPUT=$(read_json_input "${1:-}")
echo "$INPUT"
SKILL_EOF
chmod +x "$TEMP_DIR/test_read_json.sh"

export LIB_PATH="$SCRIPT_DIR/lib.sh"

echo "=== lib.sh Test Suite ==="
echo ""

# ---- Test 1: --file flag reads JSON from file ----
echo '{"key":"value","text":"hello world"}' > "$TEMP_DIR/input.json"
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/input.json")
assert_eq "--file reads JSON from file" '{"key":"value","text":"hello world"}' "$RESULT"

# ---- Test 2: --file with special characters (the whole point!) ----
printf '%s' '{"summary":"text with '\''quotes'\'' and (parens) and `backticks`"}' > "$TEMP_DIR/special.json"
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/special.json")
assert_contains "--file handles single quotes" "quotes" "$RESULT"
assert_contains "--file handles parentheses" "(parens)" "$RESULT"
assert_contains "--file handles backticks" "backticks" "$RESULT"

# ---- Test 3: --file with multiline JSON ----
cat > "$TEMP_DIR/multiline.json" << 'MULTI_EOF'
{"summary":"line 1\nline 2\nline 3","status":"done"}
MULTI_EOF
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/multiline.json")
assert_contains "--file handles multiline content" "line 1" "$RESULT"

# ---- Test 4: --file with nonexistent file fails ----
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "/tmp/nonexistent_crewly_test_file.json" 2>&1 || true)
assert_contains "--file with missing file reports error" "File not found" "$RESULT"

# ---- Test 5: Direct JSON argument still works (backward compat) ----
RESULT=$(bash "$TEMP_DIR/test_skill.sh" '{"key":"direct"}')
assert_eq "Direct JSON argument works" '{"key":"direct"}' "$RESULT"

# ---- Test 6: read_json_input with --file ----
echo '{"agentId":"dev-1","content":"test memory"}' > "$TEMP_DIR/read_input.json"
RESULT=$(bash "$TEMP_DIR/test_read_json.sh" --file "$TEMP_DIR/read_input.json")
assert_contains "read_json_input with --file" "dev-1" "$RESULT"

# ---- Test 7: read_json_input with @filepath ----
echo '{"agentId":"dev-2","content":"at-file test"}' > "$TEMP_DIR/at_input.json"
RESULT=$(bash "$TEMP_DIR/test_read_json.sh" "@$TEMP_DIR/at_input.json")
assert_contains "read_json_input with @filepath" "dev-2" "$RESULT"

# ---- Test 8: read_json_input with stdin pipe ----
RESULT=$(echo '{"agentId":"dev-3","content":"stdin test"}' | bash "$TEMP_DIR/test_read_json.sh")
assert_contains "read_json_input with stdin pipe" "dev-3" "$RESULT"

# ---- Test 9: read_json_input with direct JSON arg ----
RESULT=$(bash "$TEMP_DIR/test_read_json.sh" '{"agentId":"dev-4"}')
assert_contains "read_json_input with direct arg" "dev-4" "$RESULT"

# ---- Test 10: --file with Unicode content ----
printf '%s' '{"text":"Chinese: 你好世界, Japanese: こんにちは"}' > "$TEMP_DIR/unicode.json"
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/unicode.json")
assert_contains "--file handles Unicode" "你好世界" "$RESULT"

# ---- Test 11: --file with dollar signs and variables ----
printf '%s' '{"text":"Price is $100, env is ${HOME}"}' > "$TEMP_DIR/dollar.json"
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/dollar.json")
assert_contains "--file preserves dollar signs" '$100' "$RESULT"
assert_contains "--file preserves \\\${} syntax" '${HOME}' "$RESULT"

# ---- Test 12: --file with newlines in JSON values ----
printf '%s' '{"text":"line1\nline2\nline3"}' > "$TEMP_DIR/newlines.json"
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/newlines.json")
assert_contains "--file preserves escaped newlines" 'line1\\nline2' "$RESULT"

# ---- Test 13: --file with empty JSON ----
echo '{}' > "$TEMP_DIR/empty.json"
RESULT=$(bash "$TEMP_DIR/test_read_json.sh" --file "$TEMP_DIR/empty.json")
assert_eq "--file with empty JSON" '{}' "$RESULT"

# ---- Test 14: --file with heredoc-created file (single quotes in JSON) ----
# This simulates the exact pattern Gemini CLI agents now use:
#   cat > /tmp/file << 'CREWLY_EOF'
#   {"summary":"it's working — don't worry"}
#   CREWLY_EOF
cat > "$TEMP_DIR/heredoc_single_quotes.json" << 'CREWLY_EOF'
{"summary":"it's working — don't worry about 'edge cases'"}
CREWLY_EOF
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/heredoc_single_quotes.json")
assert_contains "heredoc with single quotes" "it's working" "$RESULT"
assert_contains "heredoc with multiple single quotes" "edge cases" "$RESULT"

# ---- Test 15: --file with heredoc-created file (backticks and $vars) ----
cat > "$TEMP_DIR/heredoc_special.json" << 'CREWLY_EOF'
{"text":"Use `jq` to parse $HOME and $(whoami) safely"}
CREWLY_EOF
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/heredoc_special.json")
assert_contains "heredoc preserves backticks" '`jq`' "$RESULT"
assert_contains "heredoc preserves \$HOME" '$HOME' "$RESULT"
assert_contains "heredoc preserves \$()" '$(whoami)' "$RESULT"

# ---- Test 16: --file with heredoc-created file (mixed quotes) ----
cat > "$TEMP_DIR/heredoc_mixed.json" << 'CREWLY_EOF'
{"text":"He said \"it's fine\" and she said 'OK'"}
CREWLY_EOF
RESULT=$(bash "$TEMP_DIR/test_skill.sh" --file "$TEMP_DIR/heredoc_mixed.json")
assert_contains "heredoc handles mixed quotes" "it's fine" "$RESULT"

echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
