#!/bin/bash
# Generate PDF from Markdown with CJK font support
# Uses pandoc (md→html) + weasyprint (html→pdf)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"input\":\"/tmp/report.md\",\"output\":\"/tmp/report.pdf\",\"title\":\"My Report\"}'"

MD_PATH=$(printf '%s' "$INPUT" | jq -r '.input // empty')
PDF_PATH=$(printf '%s' "$INPUT" | jq -r '.output // empty')
TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')

require_param "input" "$MD_PATH"

# Default output: same path with .pdf extension
if [ -z "$PDF_PATH" ]; then
  PDF_PATH="${MD_PATH%.md}.pdf"
fi

# Intermediate HTML path
HTML_PATH="${PDF_PATH%.pdf}.html"

# Default title from filename
if [ -z "$TITLE" ]; then
  TITLE=$(basename "$MD_PATH" .md | tr '-' ' ' | tr '_' ' ')
fi

# Ensure the CJK CSS header exists
CJK_HEADER="/tmp/cjk-header.html"
if [ ! -f "$CJK_HEADER" ]; then
  cat > "$CJK_HEADER" << 'CSSEOF'
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif;
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem;
  line-height: 1.8;
  color: #1a1a1a;
  font-size: 14px;
}
h1, h2, h3, h4 {
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif;
  margin-top: 1.5em;
  color: #111;
}
h1 { font-size: 1.8em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
h2 { font-size: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; }
h3 { font-size: 1.15em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 13px; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
blockquote { border-left: 4px solid #4a90d9; margin: 1em 0; padding: 0.5em 1em; background: #f0f6ff; color: #333; }
code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
strong { color: #111; }
</style>
CSSEOF
fi

# Check dependencies
if ! command -v pandoc &>/dev/null; then
  error_exit "pandoc is not installed. Run: brew install pandoc"
fi
if ! command -v weasyprint &>/dev/null; then
  error_exit "weasyprint is not installed. Run: brew install weasyprint"
fi

# Step 1: Markdown → HTML (with CJK CSS header)
pandoc "$MD_PATH" -o "$HTML_PATH" \
  --standalone \
  --metadata title="$TITLE" \
  --include-in-header="$CJK_HEADER" 2>/dev/null

# Step 2: HTML → PDF (weasyprint handles CJK fonts correctly)
weasyprint "$HTML_PATH" "$PDF_PATH" 2>/dev/null

# Get file size
PDF_SIZE=$(wc -c < "$PDF_PATH" | tr -d ' ')

# Clean up intermediate HTML
rm -f "$HTML_PATH"

# Output result
echo "{\"success\":true,\"pdf\":\"${PDF_PATH}\",\"size\":${PDF_SIZE}}"
