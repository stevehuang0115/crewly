#!/bin/bash
# =============================================================================
# gmail-attachment — Download one attachment of a Gmail message (read-only)
#
# Backed by GET /api/google/gmail/messages/:id and
#           GET /api/google/gmail/messages/:id/attachments/:attachmentId.
#
# Usage:
#   bash execute.sh --message <id> --attachment <attachmentId|filename> [--out <path>]
#   bash execute.sh '{"message":"<id>","attachment":"deck.pdf"}'
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

print_usage() {
  cat <<'EOF_USAGE'
Usage:
  bash execute.sh --message <gmail message id> --attachment <attachmentId|filename> [--out <path>]
  bash execute.sh '{"message":"<id>","attachment":"<attachmentId|filename>","out":"<path>"}'

Options:
  --message    | -m   Gmail message id (required; from gmail-search)
  --attachment | -a   attachmentId or exact filename (required; listed by gmail-read)
  --out        | -o   Where to save the file (default: $CREWLY_HOME/attachments/<message>/<filename>)
  --account           Which connected Google account to act as (default: your primary)
  --help       | -h   Show this help
EOF_USAGE
}

INPUT_JSON=""; MESSAGE=""; ATT=""; OUT=""; ACCOUNT=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message|-m)    [ $# -ge 2 ] || error_exit "--message requires a value"; MESSAGE="$2"; shift 2 ;;
    --attachment|-a) [ $# -ge 2 ] || error_exit "--attachment requires a value"; ATT="$2"; shift 2 ;;
    --out|-o)        [ $# -ge 2 ] || error_exit "--out requires a value"; OUT="$2"; shift 2 ;;
    --account)       [ $# -ge 2 ] || error_exit "--account requires a value"; ACCOUNT="$2"; shift 2 ;;
    --help|-h) print_usage; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$MESSAGE" ] && MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // .id // .messageId // empty')
  [ -z "$ATT" ] && ATT=$(printf '%s' "$INPUT" | jq -r '.attachment // .attachmentId // .filename // empty')
  [ -z "$OUT" ] && OUT=$(printf '%s' "$INPUT" | jq -r '.out // empty')
  [ -z "$ACCOUNT" ] && ACCOUNT=$(printf '%s' "$INPUT" | jq -r '.account // empty')
fi
[ -n "$ACCOUNT" ] && export CREWLY_GOOGLE_ACCOUNT="$ACCOUNT"
require_param "message (--message)" "$MESSAGE"
require_param "attachment (--attachment)" "$ATT"

MAX_BYTES=$((25 * 1024 * 1024))

fail() { # fail <reason> <message>
  jq -nc --arg r "$1" --arg m "$2" '{success: false, reason: $r, message: $m}'
  exit 1
}
api_fail() { # api_fail <raw error output>
  printf '%s' "$1" | jq -c '{success: false, reason: (.details.error // .details // .error // "unknown"), hint: (.details.hint // ""), message: (.details.message // "")}' 2>/dev/null \
    || jq -nc --arg r "$1" '{success: false, reason: $r}'
  exit 1
}

# A large attachment is a large JSON body: never park it behind the output cap.
export CREWLY_SKILL_FULL_OUTPUT=1

MSG_ENC=$(jq -rn --arg v "$MESSAGE" '$v|@uri')
MSG=$(api_call GET "/google/gmail/messages/${MSG_ENC}" 2>&1) || api_fail "$MSG"

# Resolve --attachment (id first, then exact filename, then case-insensitive filename).
META=$(printf '%s' "$MSG" | jq -c --arg a "$ATT" '
  (.data.attachments // []) as $l
  | ([$l[] | select(.attachmentId == $a)][0]
     // [$l[] | select(.filename == $a)][0]
     // [$l[] | select((.filename | ascii_downcase) == ($a | ascii_downcase))][0]) // empty')
if [ -z "$META" ]; then
  NAMES=$(printf '%s' "$MSG" | jq -r '[.data.attachments[]?.filename] | join(", ")')
  fail "not_found" "No attachment \"${ATT}\" on this message. Attachments: ${NAMES:-none}"
fi
ATT_ID=$(printf '%s' "$META" | jq -r '.attachmentId')
FILENAME=$(printf '%s' "$META" | jq -r '.filename')
MIME=$(printf '%s' "$META" | jq -r '.mimeType')
LISTED=$(printf '%s' "$META" | jq -r '.size // 0')
if [ "$LISTED" -gt "$MAX_BYTES" ]; then
  fail "too_large" "Attachment is ${LISTED} bytes; the limit is ${MAX_BYTES} (25 MB)."
fi

# Never let a filename walk out of the target directory.
SAFE_NAME=$(printf '%s' "$FILENAME" | tr '/\\' '__' | sed 's/^\.*//')
[ -n "$SAFE_NAME" ] || SAFE_NAME="attachment"
if [ -z "$OUT" ]; then
  OUT="${CREWLY_HOME:-${HOME}/.crewly}/attachments/${MESSAGE}/${SAFE_NAME}"
fi
mkdir -p "$(dirname "$OUT")"

ATT_ENC=$(jq -rn --arg v "$ATT_ID" '$v|@uri')
RESP=$(api_call GET "/google/gmail/messages/${MSG_ENC}/attachments/${ATT_ENC}" 2>&1) || {
  if printf '%s' "$RESP" | jq -e '(.details.error // "") == "validation" and ((.details.message // "") | test("limit"))' >/dev/null 2>&1; then
    fail "too_large" "Attachment is over the 25 MB limit."
  fi
  api_fail "$RESP"
}
TMP="${OUT}.part.$$"
if ! printf '%s' "$RESP" | jq -er '.data.dataBase64' | base64 -d > "$TMP" 2>/dev/null; then
  rm -f "$TMP"; fail "decode_failed" "Could not decode the attachment data."
fi
mv "$TMP" "$OUT"
SIZE=$(wc -c < "$OUT" | tr -d ' ')

TEXT=""
IS_PDF=0
case "$(printf '%s' "$MIME" | tr 'A-Z' 'a-z')" in application/pdf) IS_PDF=1 ;; esac
case "$(printf '%s' "$SAFE_NAME" | tr 'A-Z' 'a-z')" in *.pdf) IS_PDF=1 ;; esac
if [ "$IS_PDF" = 1 ] && command -v pdftotext >/dev/null 2>&1; then
  TEXT=$(pdftotext -layout "$OUT" - 2>/dev/null || true)
fi

if [ -n "$TEXT" ]; then
  jq -nc --arg path "$OUT" --arg filename "$FILENAME" --arg mime "$MIME" --argjson size "$SIZE" --arg text "$TEXT" \
    '{success: true, path: $path, filename: $filename, mimeType: $mime, size: $size, text: $text}'
else
  jq -nc --arg path "$OUT" --arg filename "$FILENAME" --arg mime "$MIME" --argjson size "$SIZE" \
    '{success: true, path: $path, filename: $filename, mimeType: $mime, size: $size}'
fi
