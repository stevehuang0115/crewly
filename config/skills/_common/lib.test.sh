#!/bin/bash
# =============================================================================
# Tests for lib.sh — shared skills library
# Covers: --file preprocessor, read_json_input, require_param, error_exit,
#         api_call output cap (CREWLY_SKILL_MAX_OUTPUT_BYTES)
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

# =============================================================================
# api_call output cap (CREWLY_SKILL_MAX_OUTPUT_BYTES)
# curl is mocked with a shell function that returns $MOCK_BODY + "\n200".
# =============================================================================
mkdir -p "$TEMP_DIR/skills/fake-skill"
cat > "$TEMP_DIR/skills/fake-skill/execute.sh" << 'SKILL_EOF'
#!/bin/bash
set -euo pipefail
source "$LIB_PATH"
# Mock curl: emit the canned body followed by the http code line, like
# `curl -w '\n%{http_code}'` does.
curl() {
  printf '%s\n%s' "$MOCK_BODY" "${MOCK_CODE:-200}"
}
api_call GET "/anything"
SKILL_EOF
chmod +x "$TEMP_DIR/skills/fake-skill/execute.sh"

export CREWLY_HOME="$TEMP_DIR/crewly-home"
CAP_DIR="$CREWLY_HOME/tmp/skill-output"

# ---- Test 17: small body passes through untouched ----
export MOCK_BODY='{"ok":true,"items":[1,2,3]}'
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=100 bash "$TEMP_DIR/skills/fake-skill/execute.sh")
assert_eq "api_call: body under cap passes through" '{"ok":true,"items":[1,2,3]}' "$RESULT"

# ---- Test 18: oversized body becomes a valid JSON envelope ----
BIG=$(jq -nc '{ok:true, rows:[range(0;400)|{id:., text:"row-\(.)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]}')
export MOCK_BODY="$BIG"
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=1000 bash "$TEMP_DIR/skills/fake-skill/execute.sh")
assert_eq "api_call: oversized body -> truncated=true" "true" "$(printf '%s' "$RESULT" | jq -r '.truncated')"
assert_eq "api_call: envelope bytes == real byte count" "$(printf '%s' "$BIG" | LC_ALL=C wc -c | tr -d ' ')" "$(printf '%s' "$RESULT" | jq -r '.bytes')"
assert_contains "api_call: envelope hint present" "pass --full or read the file" "$(printf '%s' "$RESULT" | jq -r '.hint')"
assert_eq "api_call: head is the first 4000 chars" "${BIG:0:4000}" "$(printf '%s' "$RESULT" | jq -r '.head')"
CAP_FILE=$(printf '%s' "$RESULT" | jq -r '.file')
assert_contains "api_call: file lands under CREWLY_HOME/tmp/skill-output" "$CAP_DIR/fake-skill-" "$CAP_FILE"
assert_eq "api_call: parked file holds the full body" "$BIG" "$(cat "$CAP_FILE")"

# ---- Test 19: --full bypasses the cap (flag is detected at source time) ----
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=1000 bash "$TEMP_DIR/skills/fake-skill/execute.sh" --full)
assert_eq "api_call: --full returns the raw body" "$BIG" "$RESULT"

# ---- Test 20: CREWLY_SKILL_FULL_OUTPUT=1 bypasses the cap ----
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=1000 CREWLY_SKILL_FULL_OUTPUT=1 bash "$TEMP_DIR/skills/fake-skill/execute.sh")
assert_eq "api_call: CREWLY_SKILL_FULL_OUTPUT=1 returns the raw body" "$BIG" "$RESULT"

# ---- Test 21: cap of 0 disables truncation ----
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=0 bash "$TEMP_DIR/skills/fake-skill/execute.sh")
assert_eq "api_call: CREWLY_SKILL_MAX_OUTPUT_BYTES=0 disables the cap" "$BIG" "$RESULT"

# ---- Test 22: parked files older than the TTL are pruned at the start of any api_call ----
mkdir -p "$CAP_DIR"
touch -t 202001010000 "$CAP_DIR/old-skill-stale.json"
touch "$CAP_DIR/fresh-skill-recent.json"
export MOCK_BODY='{"ok":true}'
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=1000 bash "$TEMP_DIR/skills/fake-skill/execute.sh")
assert_eq "api_call: prune runs even when the body is small" '{"ok":true}' "$RESULT"
assert_eq "api_call: stale parked output is deleted" "missing" "$([ -f "$CAP_DIR/old-skill-stale.json" ] && echo present || echo missing)"
assert_eq "api_call: fresh parked output is kept" "present" "$([ -f "$CAP_DIR/fresh-skill-recent.json" ] && echo present || echo missing)"

# ---- Test 23: error responses are untouched by the cap ----
export MOCK_BODY='{"error":"nope"}' MOCK_CODE=500
RESULT=$(CREWLY_SKILL_MAX_OUTPUT_BYTES=5 bash "$TEMP_DIR/skills/fake-skill/execute.sh" 2>&1 || true)
assert_contains "api_call: non-2xx still reports the error object" '"status":500' "$RESULT"
unset MOCK_BODY MOCK_CODE CREWLY_HOME

echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
