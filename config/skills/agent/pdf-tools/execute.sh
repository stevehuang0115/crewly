#!/bin/bash
# =============================================================================
# pdf-tools — make and read PDFs.
#
#   render : Markdown / HTML (one or several parts) → one PDF.
#            Engine: headless Chrome/Chromium (preferred) → WeasyPrint (fallback).
#            Markdown gets a clean A4 stylesheet with CJK fonts (style.css).
#   merge  : concatenate PDFs (pypdf).
#   read   : extract text from a PDF (pypdf, falls back to pdftotext).
#   info   : page count + metadata.
#   check  : which engines are available here.
#
# Usage:
#   bash execute.sh '{"action":"render","input":"/tmp/report.md","output":"/tmp/report.pdf","title":"Q3 报告"}'
#   bash execute.sh '{"action":"render","inputs":["cover.html","body.md","appendix.pdf"],"output":"/tmp/all.pdf"}'
#   bash execute.sh '{"action":"read","input":"/tmp/contract.pdf","pages":"1-3"}'
#   bash execute.sh '{"action":"merge","inputs":["a.pdf","b.pdf"],"output":"/tmp/ab.pdf"}'
#   bash execute.sh --file /tmp/input.json        (JSON in a file)
#
# Dependencies are declared in skill.json → setup (install-skill --id pdf-tools).
# A missing dependency fails with "needsSetup": true, "skill": "pdf-tools".
#
# Test hooks: PDF_TOOLS_PYTHON (interpreter), CHROME_BIN (browser),
# PDF_TOOLS_CHROME_PATHS (browser paths searched before PATH, colon separated).
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ID="pdf-tools"
HELPER="${SCRIPT_DIR}/pdf_tools.py"
DEFAULT_CSS="${SCRIPT_DIR}/style.css"
CREWLY_HOME_DIR="${CREWLY_HOME:-${HOME}/.crewly}"
VENV_PYTHON="${CREWLY_HOME_DIR}/venv/${SKILL_ID}/bin/python3"
CHROME_TIMEOUT_SEC="${PDF_TOOLS_CHROME_TIMEOUT_SEC:-120}"
CHROME_EXIT_GRACE_SEC=3
CHROME_APP_PATHS="${PDF_TOOLS_CHROME_PATHS-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome:${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome:/Applications/Chromium.app/Contents/MacOS/Chromium:/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
CHROME_COMMANDS="google-chrome google-chrome-stable chromium chromium-browser microsoft-edge"

json_str() { printf '%s' "$1" | jq -Rsa .; }
err_json() { printf '{"success":false,"error":%s}\n' "$(json_str "$1")"; exit 1; }
needs_setup() {
  # needs_setup <message> <missing...>
  local msg="$1"; shift
  jq -cn --arg e "$msg" --arg s "$SKILL_ID" --args '{success:false,error:$e,needsSetup:true,skill:$s,missing:$ARGS.positional,
    hint:("Run install-skill --id " + $s + " (installs in the background and messages you when done), then retry.")}' "$@"
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  printf '{"success":false,"error":"jq is required but not installed","needsSetup":true,"skill":"%s","missing":["jq"]}\n' "$SKILL_ID"; exit 1; }

# ── Input: JSON argument, --file <path>, or stdin ────────────────────────────────
INPUT=""
if [ "${1:-}" = "--file" ] && [ -n "${2:-}" ]; then
  [ -f "$2" ] || err_json "File not found: $2"
  INPUT="$(cat "$2")"
elif [ -n "${1:-}" ]; then
  INPUT="$1"
elif [ ! -t 0 ]; then
  INPUT="$(cat)"
fi
[ -z "$INPUT" ] && err_json "Usage: execute.sh '{\"action\":\"render\",\"input\":\"/tmp/report.md\"}' (actions: render, merge, read, info, check)"
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || err_json "input must be a JSON object"

field() { printf '%s' "$INPUT" | jq -r "$1 // empty"; }
ACTION="$(field .action)"; [ -z "$ACTION" ] && ACTION="render"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pdf-tools-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ── Tool discovery ────────────────────────────────────────────────────────────────
# Python with the skill's packages: override → skill venv → system python3
# (stdlib only; enough for `read` via pdftotext).
python_bin() {
  if [ -n "${PDF_TOOLS_PYTHON:-}" ]; then echo "$PDF_TOOLS_PYTHON"; return; fi
  if [ -x "$VENV_PYTHON" ]; then echo "$VENV_PYTHON"; return; fi
  command -v python3 2>/dev/null || true
}
py_has() { local py; py="$(python_bin)"; [ -n "$py" ] && "$py" -c "import $1" >/dev/null 2>&1; }

find_chrome() {
  if [ -n "${CHROME_BIN:-}" ]; then [ -x "$CHROME_BIN" ] && echo "$CHROME_BIN"; return; fi
  local IFS=':' p c
  for p in $CHROME_APP_PATHS; do [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return; }; done
  IFS=' '
  for c in $CHROME_COMMANDS; do command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return; }; done
}

weasy_available() { py_has weasyprint || command -v weasyprint >/dev/null 2>&1; }

file_url() { printf 'file://%s' "$(printf '%s' "$1" | jq -sRr @uri | sed 's/%2F/\//g')"; }

abs_path() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd)" "$1" ;; esac; }

is_pdf() { [ -s "$1" ] && [ "$(head -c 4 "$1")" = "%PDF" ]; }

# ── Engines ───────────────────────────────────────────────────────────────────────
# A PDF Chrome has finished writing: starts with %PDF, ends with %%EOF.
pdf_complete() { is_pdf "$1" && tail -c 64 "$1" | grep -q '%%EOF'; }

# Headless print. No --user-data-dir: with a fresh profile dir Chrome 15x on
# macOS writes the PDF and then never exits. As a guard against any other
# hang, once the PDF is complete Chrome gets CHROME_EXIT_GRACE_SEC to exit
# before it is stopped; CHROME_TIMEOUT_SEC bounds the whole run.
render_chrome() {
  local html="$1" out="$2" chrome="$3"
  local args=(--headless=new --disable-gpu --no-pdf-header-footer --no-first-run --no-default-browser-check
    --disable-extensions --run-all-compositor-stages-before-draw "--print-to-pdf=${out}")
  # Chrome refuses to run as root without this (servers / containers).
  [ "$(id -u)" = "0" ] && args+=(--no-sandbox)
  rm -f "$out"
  "$chrome" "${args[@]}" "$(file_url "$html")" </dev/null >"${WORK}/cmd.out" 2>&1 &
  local pid=$! waited=0 done_at=-1
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$done_at" -lt 0 ] && pdf_complete "$out"; then done_at=$waited; fi
    if [ "$waited" -ge "$((CHROME_TIMEOUT_SEC * 2))" ] || { [ "$done_at" -ge 0 ] && [ "$((waited - done_at))" -ge "$((CHROME_EXIT_GRACE_SEC * 2))" ]; }; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || true
  pdf_complete "$out"
}

render_weasy() {
  local html="$1" out="$2" py
  py="$(python_bin)"
  if [ -n "$py" ] && "$py" -c "import weasyprint" >/dev/null 2>&1; then
    "$py" "$HELPER" weasyprint "$html" "$out" >"${WORK}/weasy.out" 2>&1 || true
  elif command -v weasyprint >/dev/null 2>&1; then
    weasyprint "$html" "$out" >"${WORK}/weasy.out" 2>&1 || true
  fi
  is_pdf "$out"
}

# html_to_pdf <html> <out> → sets USED_ENGINE
USED_ENGINE=""
html_to_pdf() {
  local html="$1" out="$2" engine="$3" chrome
  chrome="$(find_chrome || true)"
  if [ "$engine" != "weasyprint" ] && [ -n "$chrome" ]; then
    if render_chrome "$html" "$out" "$chrome"; then USED_ENGINE="chrome"; return 0; fi
    [ "$engine" = "chrome" ] && err_json "Chrome failed to print ${html}: $(tail -c 300 "${WORK}/cmd.out" 2>/dev/null)"
    echo '{"status":"fallback","message":"Chrome failed; trying WeasyPrint"}' >&2
  elif [ "$engine" = "chrome" ]; then
    needs_setup "engine=chrome requested but no Chrome/Chromium was found (set CHROME_BIN or install Chrome)" chrome
  fi
  if weasy_available; then
    if render_weasy "$html" "$out"; then USED_ENGINE="weasyprint"; return 0; fi
    err_json "WeasyPrint failed to render ${html}: $(tail -c 400 "${WORK}/weasy.out" 2>/dev/null)"
  fi
  needs_setup "No PDF engine is available: no Chrome/Chromium and no working WeasyPrint" chrome weasyprint-libs
}

# md_to_html <md> <html> <title> — relative images resolve from the Markdown's
# own directory through a <base href>, so nothing is written next to it.
md_to_html() {
  local md="$1" html="$2" title="$3" py base
  base="$(file_url "$(dirname "$md")")/"
  local args=("$HELPER" md2html "$md" "$html" --lang "$LANG_ATTR" --base "$base")
  [ -n "$title" ] && args+=(--title "$title")
  [ -f "$DEFAULT_CSS" ] && args+=(--css "$DEFAULT_CSS")
  [ -n "$EXTRA_CSS" ] && args+=(--css "$EXTRA_CSS")
  py="$(python_bin)"
  if [ -n "$py" ] && "$py" -c "import markdown" >/dev/null 2>&1; then
    "$py" "${args[@]}" >"${WORK}/md.out" 2>&1 || err_json "Markdown conversion failed: $(tail -c 300 "${WORK}/md.out")"
  elif command -v pandoc >/dev/null 2>&1; then
    local body; body="$(pandoc -f gfm -t html "$md")" || err_json "pandoc failed on ${md}"
    {
      printf '<!DOCTYPE html>\n<html lang="%s"><head><meta charset="utf-8"><base href="%s"><title>%s</title><style>\n' "$LANG_ATTR" "$base" "$title"
      [ -f "$DEFAULT_CSS" ] && cat "$DEFAULT_CSS"
      [ -n "$EXTRA_CSS" ] && cat "$EXTRA_CSS"
      printf '\n</style></head>\n<body><main class="doc">\n%s\n</main></body></html>\n' "$body"
    } > "$html"
  else
    needs_setup "Markdown needs python-markdown (pdf-tools venv) or pandoc" python-packages
  fi
}

# Copy an HTML file into the work dir with the default stylesheet (and the
# optional extra css) added first, so the document's own rules still win.
# A <base href> keeps its relative links pointing at the original directory.
style_html() {
  local src="$1" dest="$2"
  {
    printf '<base href="%s/">\n<style>\n' "$(file_url "$(dirname "$src")")"
    cat "$DEFAULT_CSS"
    [ -n "$EXTRA_CSS" ] && cat "$EXTRA_CSS"
    printf '\n</style>\n'
    cat "$src"
  } > "$dest"
}

run_helper() {
  local py; py="$(python_bin)"
  [ -n "$py" ] || needs_setup "python3 is not installed" python3
  "$py" "$HELPER" "$@"
}

# ── Actions ───────────────────────────────────────────────────────────────────────
EXTRA_CSS="$(field .css)"
[ -n "$EXTRA_CSS" ] && [ ! -f "$EXTRA_CSS" ] && err_json "css file not found: ${EXTRA_CSS}"
LANG_ATTR="$(field .lang)"; [ -z "$LANG_ATTR" ] && LANG_ATTR="zh"

case "$ACTION" in
  render)
    ENGINE="$(field .engine)"; [ -z "$ENGINE" ] && ENGINE="auto"
    case "$ENGINE" in auto|chrome|weasyprint) ;; *) err_json "engine must be auto, chrome or weasyprint (got: ${ENGINE})" ;; esac
    TITLE="$(field .title)"
    ADD_STYLE="$(printf '%s' "$INPUT" | jq -r '.addDefaultStyle // false')"
    PARTS=()
    while IFS= read -r p; do [ -n "$p" ] && PARTS+=("$p"); done < <(printf '%s' "$INPUT" | jq -r 'if (.inputs|type) == "array" then .inputs[] else (.input // empty) end')
    [ ${#PARTS[@]} -eq 0 ] && err_json "input (a .md/.html file) or inputs (a list of .md/.html/.pdf parts) is required"
    OUTPUT="$(field .output)"
    if [ -z "$OUTPUT" ]; then
      [ ${#PARTS[@]} -gt 1 ] && err_json "output is required when rendering several parts"
      OUTPUT="${PARTS[0]%.*}.pdf"
    fi
    OUTPUT="$(abs_path "$OUTPUT")"
    mkdir -p "$(dirname "$OUTPUT")"
    PDF_PARTS=(); ENGINES=()
    i=0
    for part in "${PARTS[@]}"; do
      i=$((i + 1))
      [ -f "$part" ] || err_json "input not found: ${part}"
      part="$(abs_path "$part")"
      case "$(printf '%s' "${part##*.}" | tr '[:upper:]' '[:lower:]')" in
        md|markdown)
          html="${WORK}/part-${i}.html"
          part_title="$TITLE"; [ -z "$part_title" ] && part_title="$(basename "${part%.*}")"
          md_to_html "$part" "$html" "$part_title"
          ;;
        html|htm)
          html="$part"
          if [ "$ADD_STYLE" = "true" ]; then
            html="${WORK}/part-${i}.html"
            style_html "$part" "$html"
          fi
          ;;
        pdf) PDF_PARTS+=("$part"); ENGINES+=("pdf"); continue ;;
        *) err_json "unsupported input type: ${part} (use .md, .html or .pdf)" ;;
      esac
      out="${WORK}/part-${i}.pdf"; [ ${#PARTS[@]} -eq 1 ] && out="$OUTPUT"
      html_to_pdf "$html" "$out" "$ENGINE"
      PDF_PARTS+=("$out"); ENGINES+=("$USED_ENGINE")
    done
    if [ ${#PARTS[@]} -gt 1 ] || [ "${PDF_PARTS[0]}" != "$OUTPUT" ]; then
      MERGED="$(run_helper merge "$OUTPUT" "${PDF_PARTS[@]}" 2>&1)" || {
        printf '%s' "$MERGED" | jq -e .needsSetup >/dev/null 2>&1 && { printf '%s\n' "$MERGED"; exit 1; }
        err_json "merging the parts failed: $(printf '%s' "$MERGED" | tail -c 300)"
      }
    fi
    is_pdf "$OUTPUT" || err_json "no PDF was produced at ${OUTPUT}"
    SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
    jq -cn --arg pdf "$OUTPUT" --argjson size "$SIZE" --argjson parts "${#PARTS[@]}" \
      --arg engines "$(IFS=,; echo "${ENGINES[*]}")" \
      '{success:true, pdf:$pdf, size:$size, parts:$parts, engine:($engines | split(",") | unique | map(select(. != "pdf")) | join(","))}'
    ;;

  merge)
    OUTPUT="$(field .output)"; [ -z "$OUTPUT" ] && err_json "output is required"
    INPUTS=()
    while IFS= read -r p; do [ -n "$p" ] && INPUTS+=("$p"); done < <(printf '%s' "$INPUT" | jq -r '(.inputs // [])[]')
    [ ${#INPUTS[@]} -lt 2 ] && err_json "inputs must list at least two PDFs"
    for p in "${INPUTS[@]}"; do is_pdf "$p" || err_json "not a PDF: ${p}"; done
    mkdir -p "$(dirname "$OUTPUT")"
    run_helper merge "$OUTPUT" "${INPUTS[@]}"
    ;;

  read)
    IN="$(field .input)"; [ -z "$IN" ] && err_json "input (a PDF path) is required"
    is_pdf "$IN" || err_json "not a PDF (or empty): ${IN}"
    ARGS=(read "$IN")
    PAGES="$(field .pages)"; [ -n "$PAGES" ] && ARGS+=(--pages "$PAGES")
    MAXC="$(field .maxChars)"; [ -n "$MAXC" ] && ARGS+=(--max-chars "$MAXC")
    TF="$(field .textFile)"; [ -n "$TF" ] && ARGS+=(--text-file "$TF")
    run_helper "${ARGS[@]}"
    ;;

  info)
    IN="$(field .input)"; [ -z "$IN" ] && err_json "input (a PDF path) is required"
    is_pdf "$IN" || err_json "not a PDF (or empty): ${IN}"
    run_helper info "$IN"
    ;;

  check)
    CHROME="$(find_chrome || true)"
    PY="$(python_bin)"
    jq -cn --arg chrome "$CHROME" --arg python "$PY" \
      --argjson weasy "$(weasy_available && echo true || echo false)" \
      --argjson pypdf "$(py_has pypdf && echo true || echo false)" \
      --argjson markdown "$(py_has markdown && echo true || echo false)" \
      --argjson pdftotext "$(command -v pdftotext >/dev/null 2>&1 && echo true || echo false)" \
      '{success:true, chrome:(if $chrome == "" then null else $chrome end), python:(if $python == "" then null else $python end),
        weasyprint:$weasy, pypdf:$pypdf, markdown:$markdown, pdftotext:$pdftotext,
        canRender:(($chrome != "") or $weasy), canRead:($pypdf or $pdftotext), canMerge:$pypdf}'
    ;;

  *) err_json "unknown action: ${ACTION} (use render, merge, read, info or check)" ;;
esac
