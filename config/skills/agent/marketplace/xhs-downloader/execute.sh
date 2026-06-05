#!/usr/bin/env bash
# xhs-downloader skill — download images/videos from 小红书 (XHS) share links
# Usage: bash execute.sh '{"url":"https://..."}'
#        echo '{"url":"..."}' | bash execute.sh
# Input JSON:
#   url       (required) XHS share URL (full URL or xhslink.com short link)
#   outputDir (optional) Download directory
#             (default: ~/projects/personal-assistant/reports/rednote/downloads/)
# Output JSON:
#   success   bool
#   files     array of absolute file paths downloaded
#   type      "image" | "video" | "unknown"
#   metadata  array of {title, author, type, desc}
#   error     string (only present on failure)

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="${SKILL_DIR}/../xhs-downloader-venv/bin/python"
DOWNLOAD_SCRIPT="${SKILL_DIR}/download.py"
DEFAULT_OUTPUT_DIR="${HOME}/projects/personal-assistant/reports/rednote/downloads"

# ── Read input ────────────────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
    INPUT="$1"
else
    INPUT="$(cat)"
fi

# ── Parse JSON fields via Python stdin pipe ───────────────────────────────────
PARSED=$(printf '%s' "$INPUT" | python3 -c "
import sys, json

try:
    d = json.load(sys.stdin)
except Exception:
    print('')
    sys.exit(0)

url = d.get('url', '')
output_dir = d.get('outputDir', '')
print(url)
print(output_dir)
")

URL=$(printf '%s' "$PARSED" | head -n1)
OUTPUT_DIR=$(printf '%s' "$PARSED" | tail -n1)

if [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = "$URL" ]; then
    OUTPUT_DIR="$DEFAULT_OUTPUT_DIR"
fi

# ── Validate ──────────────────────────────────────────────────────────────────
if [ -z "$URL" ]; then
    printf '{"success":false,"error":"Missing required field: url"}\n'
    exit 0
fi

# ── Ensure venv exists ────────────────────────────────────────────────────────
if [ ! -f "$VENV_PYTHON" ]; then
    printf '{"success":false,"error":"XHS-Downloader venv not found. Please reinstall the skill."}\n'
    exit 1
fi

# ── Ensure output directory exists ────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

# ── Run downloader (XHS logs go to stderr, JSON result to stdout) ─────────────
cd "$SKILL_DIR"
RESULT=$("$VENV_PYTHON" "$DOWNLOAD_SCRIPT" "$URL" "$OUTPUT_DIR" 2>/dev/null) || true

if [ -z "$RESULT" ]; then
    printf '{"success":false,"error":"Downloader produced no output. The URL may be invalid or network unreachable."}\n'
    exit 0
fi

printf '%s\n' "$RESULT"
