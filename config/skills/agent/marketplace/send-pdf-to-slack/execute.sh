#!/bin/bash
# Convert a markdown file to PDF using weasyprint and upload it to a Slack channel
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --channel C0123 --file /path/to/doc.md --title "Report"

Options:
  --channel | -c   Slack channel ID (required)
  --file    | -f   Path to the markdown file to convert (required)
  --title   | -T   Title for the uploaded PDF (optional)
  --text    | -t   Initial comment to include with the upload (optional)
  --thread  | -r   Slack thread timestamp the PDF answers (without it the harness picks the thread, or the upload is refused)
  --allow-new-thread  Post at the channel's top level on purpose (a new thread)
  --help    | -h   Show this help
EOF_USAGE
}

CHANNEL_ID=""
MD_FILE=""
TITLE=""
TEXT=""
THREAD_TS=""
ALLOW_NEW_THREAD="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel|-c)
      CHANNEL_ID="$2"
      shift 2
      ;;
    --file|-f)
      MD_FILE="$2"
      shift 2
      ;;
    --title|-T)
      TITLE="$2"
      shift 2
      ;;
    --text|-t)
      TEXT="$2"
      shift 2
      ;;
    --thread|-r)
      THREAD_TS="$2"
      shift 2
      ;;
    --allow-new-thread)
      ALLOW_NEW_THREAD="true"
      shift
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      unknown_arg_exit "$1"
      ;;
  esac
done

require_param "channel" "$CHANNEL_ID"
require_param "file" "$MD_FILE"

# Validate markdown file exists
if [ ! -f "$MD_FILE" ]; then
  error_exit "Markdown file not found: $MD_FILE"
fi

# Check required dependencies
if ! command -v python3 &>/dev/null; then
  error_exit "python3 is not installed. Install it with: brew install python3 (macOS) or sudo apt-get install python3 (Linux)."
fi
if ! command -v jq &>/dev/null; then
  error_exit "jq is not installed. Install it with: brew install jq (macOS) or sudo apt-get install jq (Linux)."
fi

# Set up a persistent venv with weasyprint + markdown if not already present
CREWLY_HOME="${HOME}/.crewly"
VENV_DIR="${CREWLY_HOME}/venv/pdf-tools"
PYTHON="${VENV_DIR}/bin/python3"

if [ ! -f "$PYTHON" ]; then
  echo '{"status":"installing","message":"Setting up PDF tools (first-time only)..."}' >&2
  python3 -m venv "$VENV_DIR"
  "${VENV_DIR}/bin/pip" install --quiet weasyprint markdown 2>&1 >&2
fi

# Verify weasyprint is importable
if ! "$PYTHON" -c "import weasyprint, markdown" 2>/dev/null; then
  echo '{"status":"installing","message":"Reinstalling PDF tools..."}' >&2
  "${VENV_DIR}/bin/pip" install --quiet --force-reinstall weasyprint markdown 2>&1 >&2
fi

# Prepare temp directory and output path
TMP_DIR="${CREWLY_HOME}/tmp/slack-pdfs"
mkdir -p "$TMP_DIR"

# Generate a unique output filename based on input name + timestamp
BASE_NAME="$(basename "$MD_FILE" .md)"
TIMESTAMP="$(date +%s)"
PDF_FILE="${TMP_DIR}/${BASE_NAME}-${TIMESTAMP}.pdf"

# Ensure temp PDF is cleaned up on exit (success or failure)
cleanup() { rm -f "$PDF_FILE" "/tmp/weasyprint-err-$$.log"; }
trap cleanup EXIT

# Convert markdown to PDF using weasyprint
if ! "$PYTHON" -c "
import sys, markdown, weasyprint

md_file = sys.argv[1]
pdf_file = sys.argv[2]

with open(md_file, 'r', encoding='utf-8') as f:
    md_content = f.read()

html = markdown.markdown(md_content, extensions=['tables', 'fenced_code', 'codehilite', 'toc', 'meta'])

styled_html = '''<!DOCTYPE html>
<html><head><meta charset=\"utf-8\">
<style>
  body { font-family: -apple-system, \"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif;
         max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.8;
         font-size: 14px; color: #333; }
  h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; }
  h2 { font-size: 20px; border-bottom: 1px solid #ddd; padding-bottom: 6px; margin-top: 28px; }
  h3 { font-size: 16px; margin-top: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background-color: #f5f5f5; font-weight: 600; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
  blockquote { border-left: 4px solid #ddd; margin: 16px 0; padding: 8px 16px; color: #666; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
</style></head><body>''' + html + '</body></html>'

weasyprint.HTML(string=styled_html).write_pdf(pdf_file)
" "$MD_FILE" "$PDF_FILE" 2>/tmp/weasyprint-err-$$.log; then
  WP_ERR="$(cat /tmp/weasyprint-err-$$.log 2>/dev/null || echo 'unknown error')"
  error_exit "weasyprint conversion failed: ${WP_ERR}"
fi

# Verify PDF was created
if [ ! -f "$PDF_FILE" ]; then
  error_exit "PDF file was not created at: $PDF_FILE"
fi

# Build upload request body
UPLOAD_TITLE="${TITLE:-${BASE_NAME}.pdf}"
BODY=$(jq -n \
  --arg channelId "$CHANNEL_ID" \
  --arg filePath "$PDF_FILE" \
  --arg filename "${BASE_NAME}.pdf" \
  --arg title "$UPLOAD_TITLE" \
  --arg initialComment "${TEXT:-}" \
  --arg threadTs "${THREAD_TS:-}" \
  --argjson allowNewThread "$ALLOW_NEW_THREAD" \
  '{channelId: $channelId, filePath: $filePath, filename: $filename, title: $title} +
   (if $initialComment != "" then {initialComment: $initialComment} else {} end) +
   (if $threadTs != "" then {threadTs: $threadTs} else {} end) +
   (if $allowNewThread then {allowNewThread: true} else {} end)')

# Upload to Slack
RESULT=$(api_call POST "/slack/upload-file" "$BODY")

# Output the result
echo "$RESULT"

# Emit a [NOTIFY] block so the chat service captures this action
{
  echo "[NOTIFY]"
  echo "type: slack_pdf_upload"
  echo "title: PDF Uploaded to Slack"
  echo "channelId: $CHANNEL_ID"
  if [ -n "$THREAD_TS" ]; then
    echo "threadTs: $THREAD_TS"
  fi
  echo "---"
  printf 'Converted %s to PDF and uploaded to Slack channel %s\n' "$MD_FILE" "$CHANNEL_ID"
  if [ -n "$TEXT" ]; then
    printf 'Comment: %s\n' "$TEXT"
  fi
  echo "[/NOTIFY]"
} >&2
