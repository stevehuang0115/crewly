#!/bin/bash
# Tests for generate-pdf (wrapper over pdf-tools) — run with: bash execute.test.sh </dev/null
# Uses a fake Chrome and a stub python-markdown on an isolated PATH. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
JQ="$(command -v jq)"; BASH_BIN="${TEST_BASH:-$(command -v bash)}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/stub/markdown"
for tool in bash jq python3 mktemp cat rm tail head dirname mkdir sed tr wc sleep kill id awk grep basename cp uname date; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$T/bin/$tool"
done
printf '%%PDF-1.4\n%% fake\n%%%%EOF\n' > "$T/fixture.pdf"
cat > "$T/chrome" <<EOT
#!/bin/bash
for a in "\$@"; do case "\$a" in --print-to-pdf=*) cp "$T/fixture.pdf" "\${a#--print-to-pdf=}" ;; esac; done
EOT
chmod 755 "$T/chrome"
printf 'def markdown(text, **kw):\n    return "<p>" + text + "</p>"\n' > "$T/stub/markdown/__init__.py"
printf '# 报告\n' > "$T/report.md"
run() { env -i HOME="$T" PATH="$T/bin" CREWLY_HOME="$T/.crewly" PYTHONPATH="$T/stub" PDF_TOOLS_CHROME_PATHS="" "$@" "$BASH_BIN" "$EXEC" "$JSON" 2>/dev/null </dev/null; }

JSON="{\"input\":\"$T/report.md\",\"title\":\"报告\"}"
OUT=$(run CHROME_BIN="$T/chrome")
check "same output shape" "$(printf '%s' "$OUT" | "$JQ" -c 'keys')" '["engine","pdf","size","success"]'
check "success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
check "default output path" "$(printf '%s' "$OUT" | "$JQ" -r .pdf)" "$T/report.pdf"
check "engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "chrome"

JSON="{\"input\":\"$T/report.md\",\"output\":\"$T/x/out.pdf\"}"
OUT=$(run); RC=$?
check "no engine: exit 1" "$RC" "1"
check "no engine: needsSetup from pdf-tools" "$(printf '%s' "$OUT" | "$JQ" -r '.needsSetup, .skill' | tr '\n' ' ')" "true pdf-tools "

JSON='{"title":"x"}'
ERR=$(env -i HOME="$T" PATH="$T/bin" "$BASH_BIN" "$EXEC" "$JSON" 2>&1 >/dev/null </dev/null)
check "missing input" "$(printf '%s' "$ERR" | "$JQ" -rs 'last.error')" "Missing required parameter: input"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
