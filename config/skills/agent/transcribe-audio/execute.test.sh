#!/bin/bash
# Tests for transcribe-audio — run with: bash execute.test.sh </dev/null
# Uses fake ffmpeg / ffprobe / whisper-cli on an isolated PATH and HOME, so it
# never touches a real model or the network. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

JQ="$(command -v jq)"
BASH_BIN="${TEST_BASH:-$(command -v bash)}"
[ -n "$JQ" ] || { echo "jq is required to run these tests"; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
# Minimal PATH: basic tools + jq, but no ffmpeg / whisper-cli.
for tool in bash jq mktemp cat rm tail dirname mkdir sed tr sysctl nproc uname basename; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$T/bin/$tool"
done
echo "fake audio" > "$T/clip.m4a"

run() {
  env -i HOME="$T/home" PATH="$1" CREWLY_HOME="$T/home/.crewly" CREWLY_API_URL="http://127.0.0.1:9" \
    TRANSCRIBE_WHISPER_BIN_CANDIDATES="" "$BASH_BIN" "$EXEC" "$2" 2>/dev/null </dev/null
}

# 1. ffmpeg missing → needsSetup, machine-readable.
OUT=$(run "$T/bin" "{\"audioFile\":\"$T/clip.m4a\"}"); RC=$?
check "no ffmpeg: exit 1" "$RC" "1"
check "no ffmpeg: needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r .needsSetup)" "true"
check "no ffmpeg: skill" "$(printf '%s' "$OUT" | "$JQ" -r .skill)" "transcribe-audio"
check "no ffmpeg: missing" "$(printf '%s' "$OUT" | "$JQ" -c .missing)" '["ffmpeg"]'
check "no ffmpeg: hint names install-skill" "$(printf '%s' "$OUT" | "$JQ" -r '.hint | test("install-skill --id transcribe-audio")')" "true"

# Fake ffmpeg (writes the last argument, the WAV) and ffprobe.
cat > "$T/bin/ffmpeg" <<'EOF'
#!/bin/bash
for a in "$@"; do last="$a"; done
echo "RIFF" > "$last"
EOF
printf '#!/bin/bash\necho 1.5\n' > "$T/bin/ffprobe"
chmod 755 "$T/bin/ffmpeg" "$T/bin/ffprobe"

# 2. engine=local without whisper-cli or model → needsSetup listing both.
OUT=$(run "$T/bin" "{\"audioFile\":\"$T/clip.m4a\",\"engine\":\"local\"}"); RC=$?
check "local missing: exit 1" "$RC" "1"
check "local missing: needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r .needsSetup)" "true"
check "local missing: missing parts" "$(printf '%s' "$OUT" | "$JQ" -c .missing)" '["whisper-cli","whisper-model"]'

# 3. auto engine, no local engine, no OpenAI key → needsSetup (not a bare error).
ln -sf "$(command -v curl)" "$T/bin/curl"
OUT=$(run "$T/bin" "{\"audioFile\":\"$T/clip.m4a\"}"); RC=$?
check "auto no engine: exit 1" "$RC" "1"
check "auto no engine: needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r .needsSetup)" "true"
check "auto no engine: message" "$(printf '%s' "$OUT" | "$JQ" -r '.error | test("no OpenAI API key")')" "true"

# 4. engine=openai explicitly without a key → plain error, no needsSetup (installing does not help).
OUT=$(run "$T/bin" "{\"audioFile\":\"$T/clip.m4a\",\"engine\":\"openai\"}")
check "openai no key: not needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r '.needsSetup // false')" "false"

# 5. Everything present (whisper-cli in $CREWLY_HOME/bin, model in ~/.cache) → transcript.
mkdir -p "$T/home/.crewly/bin" "$T/home/.cache/whisper-models"
: > "$T/home/.cache/whisper-models/ggml-large-v3-turbo-q5_0.bin"
cat > "$T/home/.crewly/bin/whisper-cli" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -of) prefix="$2"; shift 2 ;; *) shift ;; esac; done
printf '{"result":{"language":"zh"},"transcription":[{"offsets":{"from":0,"to":1500},"text":" 你好，今天开会"},{"offsets":{"from":1500,"to":1600},"text":" [BLANK_AUDIO]"}]}' > "${prefix}.json"
EOF
chmod 755 "$T/home/.crewly/bin/whisper-cli"
OUT=$(run "$T/bin" "{\"audioFile\":\"$T/clip.m4a\",\"outputFile\":\"$T/out.md\"}"); RC=$?
check "local ok: exit 0" "$RC" "0"
check "local ok: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
check "local ok: engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "whisper.cpp"
check "local ok: text" "$(printf '%s' "$OUT" | "$JQ" -r .text)" "你好，今天开会"
check "local ok: blank tag dropped" "$(printf '%s' "$OUT" | "$JQ" -r .segmentCount)" "1"
check "local ok: markdown written" "$(grep -c '你好，今天开会' "$T/out.md")" "2"

# 6. The shipped setup block is valid JSON and names the skill's own install script.
check "setup: whisper linux script" "$("$JQ" -r '.setup.steps[] | select(.id=="whisper-cli") | .install.linux.script' "$HERE/skill.json")" "install-whisper-cpp.sh"
[ -f "$HERE/install-whisper-cpp.sh" ] && OK=yes || OK=no
check "setup: install script exists" "$OK" "yes"
bash -n "$HERE/install-whisper-cpp.sh" && OK=yes || OK=no
check "setup: install script parses" "$OK" "yes"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
