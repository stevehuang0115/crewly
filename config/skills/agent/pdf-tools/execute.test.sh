#!/bin/bash
# Tests for pdf-tools — run with: bash execute.test.sh </dev/null
# Chrome and WeasyPrint are fakes on an isolated PATH; Markdown uses a stub
# `markdown` module. Reading uses real pypdf when some Python has it
# (PDF_TOOLS_TEST_PYTHON, then the pdf-tools venv), else pdftotext, else it
# checks the needsSetup answer. Nothing is installed. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0; SKIP=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
contains() {
  local name="$1"; local hay="$2"; local needle="$3"
  case "$hay" in *"$needle"*) PASS=$((PASS+1)) ;; *) FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  missing: $needle"; echo "  in: ${hay:0:400}" ;; esac
}

JQ="$(command -v jq)"; BASH_BIN="${TEST_BASH:-$(command -v bash)}"; SYS_PY="$(command -v python3)"
[ -n "$JQ" ] && [ -n "$SYS_PY" ] || { echo "jq and python3 are required to run these tests"; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home" "$T/stub/markdown" "$T/docs/img"
for tool in bash jq python3 mktemp cat rm tail head dirname mkdir sed tr wc sleep kill id awk grep basename cp uname date; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$T/bin/$tool"
done

# A real one-page PDF with the text "Hello Crewly PDF".
cat > "$T/mkpdf.py" <<'PY'
import sys
text = sys.argv[2].encode()
content = b"BT /F1 18 Tf 20 70 Td (" + text + b") Tj ET"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
out = b"%PDF-1.4\n"
offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offsets:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(sys.argv[1], "wb").write(out)
PY
"$SYS_PY" "$T/mkpdf.py" "$T/fixture.pdf" "Hello Crewly PDF"

# Fake Chrome: records its argv, "prints" the fixture to --print-to-pdf.
cat > "$T/fake-chrome" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$T/chrome.args"
for a in "\$@"; do case "\$a" in --print-to-pdf=*) cp "$T/fixture.pdf" "\${a#--print-to-pdf=}" ;; esac; done
EOF
chmod 755 "$T/fake-chrome"
# Chrome that crashes without output.
printf '#!/bin/bash\nexit 1\n' > "$T/broken-chrome"; chmod 755 "$T/broken-chrome"

# Stub python-markdown: wraps each line in <p>, enough to prove the pipeline.
cat > "$T/stub/markdown/__init__.py" <<'PY'
import html
def markdown(text, **_kw):
    return "\n".join("<p>%s</p>" % html.escape(line) for line in text.splitlines() if line.strip())
PY

run() {
  env -i HOME="$T/home" PATH="$T/bin" CREWLY_HOME="$T/home/.crewly" PYTHONPATH="$T/stub" \
    PDF_TOOLS_CHROME_PATHS="" PDF_TOOLS_CHROME_TIMEOUT_SEC=10 "$@" "$BASH_BIN" "$EXEC" "$JSON" 2>/dev/null </dev/null
}

printf '# 季度报告\n\nRevenue grew **12%%**.\n\n![chart](img/c.png)\n' > "$T/docs/report.md"
printf '<html><head><style>h1{color:red}</style></head><body><h1>Brief</h1></body></html>\n' > "$T/docs/brief.html"

# 1. Markdown → PDF with (fake) Chrome.
JSON="{\"action\":\"render\",\"input\":\"$T/docs/report.md\",\"title\":\"Q3 报告\"}"
OUT=$(run CHROME_BIN="$T/fake-chrome")
check "md: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
check "md: engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "chrome"
check "md: default output path" "$(printf '%s' "$OUT" | "$JQ" -r .pdf)" "$T/docs/report.pdf"
check "md: output is a PDF" "$(head -c 4 "$T/docs/report.pdf")" "%PDF"
ARGS="$(cat "$T/chrome.args" 2>/dev/null)"
contains "chrome: headless new" "$ARGS" "--headless=new"
contains "chrome: no header/footer" "$ARGS" "--no-pdf-header-footer"
contains "chrome: print target" "$ARGS" "--print-to-pdf=$T/docs/report.pdf"
case "$ARGS" in *--user-data-dir*) FAIL=$((FAIL+1)); echo "FAIL: chrome: no --user-data-dir (it makes Chrome hang on macOS)";; *) PASS=$((PASS+1));; esac
HTML_URL="$(tail -n 1 "$T/chrome.args")"
check "chrome: renders a file:// URL" "${HTML_URL:0:7}" "file://"
check "md: nothing written next to the markdown" "$(ls -A "$T/docs" | tr '\n' ' ')" "brief.html img report.md report.pdf "

# The generated HTML (captured by a Chrome that copies it) carries the stylesheet, title and <base>.
cat > "$T/capture-chrome" <<EOF
#!/bin/bash
for a in "\$@"; do case "\$a" in file://*) f="\${a#file://}"; cp "\$(printf '%b' "\${f//%/\\\\x}")" "$T/captured.html" ;; --print-to-pdf=*) cp "$T/fixture.pdf" "\${a#--print-to-pdf=}" ;; esac; done
EOF
chmod 755 "$T/capture-chrome"
OUT=$(run CHROME_BIN="$T/capture-chrome")
CAP="$(cat "$T/captured.html" 2>/dev/null)"
contains "md html: CJK font stack" "$CAP" '"PingFang SC"'
contains "md html: A4 page rule" "$CAP" "size: A4"
contains "md html: title" "$CAP" "<title>Q3 报告</title>"
contains "md html: base href to the markdown dir" "$CAP" "<base href=\"file://$T/docs/\">"
contains "md html: body converted" "$CAP" "<p># 季度报告</p>"

# Chrome that writes the PDF and then hangs (seen with Chrome 153 on macOS) is
# stopped once the PDF is complete instead of blocking until the timeout.
cat > "$T/hanging-chrome" <<EOF
#!/bin/bash
for a in "\$@"; do case "\$a" in --print-to-pdf=*) cp "$T/fixture.pdf" "\${a#--print-to-pdf=}" ;; esac; done
exec sleep 60
EOF
chmod 755 "$T/hanging-chrome"
START=$(date +%s)
JSON="{\"action\":\"render\",\"input\":\"$T/docs/report.md\",\"output\":\"$T/out/hang.pdf\"}"
OUT=$(run CHROME_BIN="$T/hanging-chrome")
ELAPSED=$(( $(date +%s) - START ))
check "hanging chrome: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
[ "$ELAPSED" -lt 9 ] && OK=yes || OK="no (${ELAPSED}s)"
check "hanging chrome: stopped after the grace period, not the timeout" "$OK" "yes"

# 2. Styled HTML is printed as-is (the original file, not a copy).
JSON="{\"action\":\"render\",\"input\":\"$T/docs/brief.html\",\"output\":\"$T/out/brief.pdf\"}"
OUT=$(run CHROME_BIN="$T/fake-chrome")
check "html: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
check "html: printed the original file" "$(tail -n 1 "$T/chrome.args")" "file://$T/docs/brief.html"
check "html: output dir created" "$(head -c 4 "$T/out/brief.pdf")" "%PDF"

# 3. addDefaultStyle prepends the stylesheet to a copy.
JSON="{\"action\":\"render\",\"input\":\"$T/docs/brief.html\",\"output\":\"$T/out/b2.pdf\",\"addDefaultStyle\":true}"
OUT=$(run CHROME_BIN="$T/capture-chrome")
CAP="$(cat "$T/captured.html")"
contains "addDefaultStyle: stylesheet added" "$CAP" '"PingFang SC"'
contains "addDefaultStyle: document kept" "$CAP" "h1{color:red}"

# 4. engine=chrome with no Chrome → needsSetup.
JSON="{\"action\":\"render\",\"input\":\"$T/docs/brief.html\",\"engine\":\"chrome\"}"
OUT=$(run)
check "no chrome: needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r .needsSetup)" "true"
check "no chrome: skill" "$(printf '%s' "$OUT" | "$JQ" -r .skill)" "pdf-tools"
check "no chrome: missing" "$(printf '%s' "$OUT" | "$JQ" -c .missing)" '["chrome"]'

# 5. No engine at all → needsSetup naming both engines.
JSON="{\"action\":\"render\",\"input\":\"$T/docs/brief.html\"}"
OUT=$(run)
check "no engine: missing" "$(printf '%s' "$OUT" | "$JQ" -c .missing)" '["chrome","weasyprint-libs"]'

# 6. Chrome crashes → WeasyPrint fallback (fake weasyprint CLI).
printf '#!/bin/bash\ncp "%s" "$2"\n' "$T/fixture.pdf" > "$T/bin/weasyprint"; chmod 755 "$T/bin/weasyprint"
JSON="{\"action\":\"render\",\"input\":\"$T/docs/brief.html\",\"output\":\"$T/out/w.pdf\"}"
OUT=$(run CHROME_BIN="$T/broken-chrome")
check "fallback: engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "weasyprint"
check "fallback: pdf" "$(head -c 4 "$T/out/w.pdf")" "%PDF"
rm -f "$T/bin/weasyprint"

# 7. Bad input.
JSON='{"action":"render"}'
check "no input: error" "$(run | "$JQ" -r .error)" "input (a .md/.html file) or inputs (a list of .md/.html/.pdf parts) is required"
JSON='{"action":"explode"}'
check "unknown action" "$(run | "$JQ" -r .error)" "unknown action: explode (use render, merge, read, info or check)"
JSON="{\"action\":\"read\",\"input\":\"$T/docs/report.md\"}"
check "read non-pdf" "$(run | "$JQ" -r .error)" "not a PDF (or empty): $T/docs/report.md"

# 8. Reading + merging with real pypdf when available.
PYPDF_PY=""
for cand in "${PDF_TOOLS_TEST_PYTHON:-}" "${CREWLY_HOME:-$HOME/.crewly}/venv/pdf-tools/bin/python3" "$SYS_PY"; do
  [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import pypdf" >/dev/null 2>&1 && { PYPDF_PY="$cand"; break; }
done
if [ -n "$PYPDF_PY" ]; then
  JSON="{\"action\":\"read\",\"input\":\"$T/fixture.pdf\"}"
  OUT=$(run PDF_TOOLS_PYTHON="$PYPDF_PY")
  check "read: engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "pypdf"
  check "read: pages" "$(printf '%s' "$OUT" | "$JQ" -r .pages)" "1"
  contains "read: text" "$(printf '%s' "$OUT" | "$JQ" -r .text)" "Hello Crewly PDF"
  JSON="{\"action\":\"read\",\"input\":\"$T/fixture.pdf\",\"maxChars\":5,\"textFile\":\"$T/all.txt\"}"
  OUT=$(run PDF_TOOLS_PYTHON="$PYPDF_PY")
  check "read: truncated" "$(printf '%s' "$OUT" | "$JQ" -r .truncated)" "true"
  contains "read: full text on disk" "$(cat "$T/all.txt")" "Hello Crewly PDF"

  "$SYS_PY" "$T/mkpdf.py" "$T/second.pdf" "Second part"
  JSON="{\"action\":\"render\",\"inputs\":[\"$T/docs/brief.html\",\"$T/second.pdf\"],\"output\":\"$T/out/merged.pdf\"}"
  OUT=$(run PDF_TOOLS_PYTHON="$PYPDF_PY" CHROME_BIN="$T/fake-chrome")
  check "multi-part: success" "$(printf '%s' "$OUT" | "$JQ" -r .success)" "true"
  check "multi-part: parts" "$(printf '%s' "$OUT" | "$JQ" -r .parts)" "2"
  JSON="{\"action\":\"info\",\"input\":\"$T/out/merged.pdf\"}"
  check "multi-part: 2 pages" "$(run PDF_TOOLS_PYTHON="$PYPDF_PY" | "$JQ" -r .pages)" "2"
  JSON="{\"action\":\"read\",\"input\":\"$T/out/merged.pdf\",\"pages\":\"2\"}"
  contains "multi-part: order kept" "$(run PDF_TOOLS_PYTHON="$PYPDF_PY" | "$JQ" -r .text)" "Second part"
else
  SKIP=$((SKIP+1)); echo "SKIP: pypdf not available (set PDF_TOOLS_TEST_PYTHON) — checking the needsSetup answer instead"
  JSON="{\"action\":\"merge\",\"inputs\":[\"$T/fixture.pdf\",\"$T/fixture.pdf\"],\"output\":\"$T/out/m.pdf\"}"
  OUT=$(run)
  check "merge without pypdf: needsSetup" "$(printf '%s' "$OUT" | "$JQ" -r .needsSetup)" "true"
fi

# 9. Reading without pypdf falls back to pdftotext when the machine has it.
if command -v pdftotext >/dev/null 2>&1; then
  ln -sf "$(command -v pdftotext)" "$T/bin/pdftotext"
  JSON="{\"action\":\"read\",\"input\":\"$T/fixture.pdf\"}"
  OUT=$(run PDF_TOOLS_PYTHON="$SYS_PY")
  if "$SYS_PY" -c "import pypdf" >/dev/null 2>&1; then EXPECT=pypdf; else EXPECT=pdftotext; fi
  check "read fallback: engine" "$(printf '%s' "$OUT" | "$JQ" -r .engine)" "$EXPECT"
  contains "read fallback: text" "$(printf '%s' "$OUT" | "$JQ" -r .text)" "Hello Crewly PDF"
  rm -f "$T/bin/pdftotext"
fi

# 10. check action + the shipped setup block.
JSON='{"action":"check"}'
OUT=$(run CHROME_BIN="$T/fake-chrome")
check "check: canRender" "$(printf '%s' "$OUT" | "$JQ" -r .canRender)" "true"
check "setup: venv name reuses pdf-tools" "$("$JQ" -r '.setup.steps[] | select(.type=="python") | .venv' "$HERE/skill.json")" "pdf-tools"

echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ]
