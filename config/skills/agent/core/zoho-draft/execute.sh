#!/bin/bash
# =============================================================================
# zoho-draft — save a Zoho Mail DRAFT. Never sends: the backend forces
# mode=draft (POST /api/connectors/zoho/draft); this script cannot pass a mode.
# Usage: see SKILL.md
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

FROM=""; TO=""; CC=""; BCC=""; SUBJECT=""; TEXT=""; TEXT_FILE=""; HTML=""; IRT=""; REFS=""; ACCT=""
INPUT_JSON=""
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then INPUT_JSON="$1"; shift || true; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)        [ $# -ge 2 ] || error_exit "--from requires a value"; FROM="$2"; shift 2 ;;
    --to)          [ $# -ge 2 ] || error_exit "--to requires a value"; TO="$2"; shift 2 ;;
    --cc)          [ $# -ge 2 ] || error_exit "--cc requires a value"; CC="$2"; shift 2 ;;
    --bcc)         [ $# -ge 2 ] || error_exit "--bcc requires a value"; BCC="$2"; shift 2 ;;
    --subject)     [ $# -ge 2 ] || error_exit "--subject requires a value"; SUBJECT="$2"; shift 2 ;;
    --text|--body) [ $# -ge 2 ] || error_exit "--text requires a value"; TEXT="$2"; shift 2 ;;
    --text-file)   [ $# -ge 2 ] || error_exit "--text-file requires a value"; TEXT_FILE="$2"; shift 2 ;;
    --html)        HTML=1; shift ;;
    --in-reply-to) [ $# -ge 2 ] || error_exit "--in-reply-to requires a value"; IRT="$2"; shift 2 ;;
    --references)  [ $# -ge 2 ] || error_exit "--references requires a value"; REFS="$2"; shift 2 ;;
    --account-id)  [ $# -ge 2 ] || error_exit "--account-id requires a value"; ACCT="$2"; shift 2 ;;
    --help|-h)     sed -n 2,6p "$0"; exit 0 ;;
    *) error_exit "Unknown option: $1" ;;
  esac
done
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  j() { printf '%s' "$INPUT" | jq -r ".$1 // empty"; }
  [ -z "$FROM" ] && FROM=$(j from); [ -z "$TO" ] && TO=$(j to); [ -z "$CC" ] && CC=$(j cc); [ -z "$BCC" ] && BCC=$(j bcc)
  [ -z "$SUBJECT" ] && SUBJECT=$(j subject); [ -z "$TEXT" ] && TEXT=$(printf '%s' "$INPUT" | jq -r '.text // .body // empty')
  [ -z "$IRT" ] && IRT=$(j inReplyTo); [ -z "$REFS" ] && REFS=$(j references); [ -z "$ACCT" ] && ACCT=$(j accountId)
  [ -z "$HTML" ] && HTML=$(printf '%s' "$INPUT" | jq -r 'if .html == true then "1" else "" end')
fi
if [ -n "$TEXT_FILE" ]; then
  [ -f "$TEXT_FILE" ] || error_exit "text file not found: $TEXT_FILE"
  TEXT=$(cat "$TEXT_FILE")
fi
require_param "from (--from)" "$FROM"
require_param "to (--to)" "$TO"

# Note: no "mode" key is ever built here; the backend sets it.
BODY=$(jq -cn --arg from "$FROM" --arg to "$TO" --arg cc "$CC" --arg bcc "$BCC" --arg subject "$SUBJECT" --arg content "$TEXT" \
  --arg irt "$IRT" --arg refs "$REFS" --arg acct "$ACCT" --arg html "$HTML" \
  '{fromAddress: $from, toAddress: $to, mailFormat: (if $html == "1" then "html" else "plaintext" end)}
   + (if $cc != "" then {ccAddress: $cc} else {} end)
   + (if $bcc != "" then {bccAddress: $bcc} else {} end)
   + (if $subject != "" then {subject: $subject} else {} end)
   + (if $content != "" then {content: $content} else {} end)
   + (if $irt != "" then {inReplyTo: $irt} else {} end)
   + (if $refs != "" then {refHeader: $refs} else {} end)
   + (if $acct != "" then {accountId: $acct} else {} end)')

RESPONSE=$(api_call POST "/connectors/zoho/draft" "$BODY" 2>&1) || {
  printf '%s' "$RESPONSE" | jq -c '{success: false, reason: (.details.error // .details.message // .error // "unknown")}' 2>/dev/null \
    || jq -n --arg r "$RESPONSE" '{success: false, reason: $r}'
  exit 1
}
printf '%s' "$RESPONSE" | jq -c '{success: (.success // false), drafted: (.drafted // false), sent: false, accountId: .accountId, detail: .detail}'
