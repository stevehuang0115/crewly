#!/bin/bash
#
# gmail multi-action skill (v1.0.0) — list / read / search / send.
#
# Credentials are injected by the Crewly skill executor based on the
# credentialBindings.gmail resolution; this script does NOT handle OAuth or
# token refresh.
#
# Usage:
#   bash execute.sh '{"action":"list","q":"is:unread in:inbox","maxResults":10}'
#   bash execute.sh '{"action":"read","id":"18fa..."}'
#   bash execute.sh '{"action":"search","q":"from:a@b.com","maxResults":5}'
#   bash execute.sh '{"action":"send","to":"a@b.com","subject":"Hi","body":"..."}'
#
# Env (injected by the executor):
#   CREWLY_CRED_GMAIL_ACCESS_TOKEN  — OAuth access token (required)
#   CREWLY_CRED_GMAIL_EMAIL         — account email (used as From: for send)
#
# Exit codes:
#   0 — success
#   1 — input/usage error (missing token, bad action, missing required param)
#   2 — Gmail API error (4xx/5xx)
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_common/lib.sh
source "${SCRIPT_DIR}/../../_common/lib.sh"

VALID_ACTIONS="list, read, search, send"

# --- Helpers ----------------------------------------------------------------

# emit_success: print success JSON on stdout (consumed by skill executor / agent).
emit_success() {
  printf '%s\n' "$1"
}

# emit_error CODE STDERR_MSG STDOUT_JSON_MSG
# Always prints stderr message, prints structured JSON on stdout, exits CODE.
emit_error() {
  local code="$1" stderr_msg="$2" stdout_msg="$3"
  echo "$stderr_msg" >&2
  jq -nc --arg e "$stdout_msg" '{success:false, error:$e}'
  exit "$code"
}

# gmail_get PATH_AND_QUERY  -> echoes JSON body, sets _LAST_HTTP
gmail_get() {
  local path="$1"
  local response http body
  response=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${CREWLY_CRED_GMAIL_ACCESS_TOKEN}" \
    "https://gmail.googleapis.com/gmail/v1/users/me${path}")
  http="${response##*$'\n'}"
  body="${response%$'\n'*}"
  _LAST_HTTP="$http"
  printf '%s' "$body"
}

# gmail_post PATH JSON_BODY  -> echoes JSON body, sets _LAST_HTTP
gmail_post() {
  local path="$1" body="$2"
  local response http resp_body
  response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer ${CREWLY_CRED_GMAIL_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "https://gmail.googleapis.com/gmail/v1/users/me${path}")
  http="${response##*$'\n'}"
  resp_body="${response%$'\n'*}"
  _LAST_HTTP="$http"
  printf '%s' "$resp_body"
}

# api_error_message BODY -> best-effort plain string of the Gmail error
api_error_message() {
  local body="$1"
  printf '%s' "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    err = d.get('error', {})
    print(err.get('message') or json.dumps(d))
except Exception:
    print('(unparseable response)')
" 2>/dev/null || echo "(unparseable response)"
}

# --- Token + input validation ----------------------------------------------

if [ -z "${CREWLY_CRED_GMAIL_ACCESS_TOKEN:-}" ]; then
  emit_error 1 \
    "Error: CREWLY_CRED_GMAIL_ACCESS_TOKEN is not set. Bind a google-oauth credential to the 'gmail' slot when calling this skill." \
    "CREWLY_CRED_GMAIL_ACCESS_TOKEN is not set"
fi

INPUT=$(read_json_input "${1:-}")
if [ -z "$INPUT" ]; then
  emit_error 1 \
    "Usage: execute.sh '{\"action\":\"<one of: ${VALID_ACTIONS}>\", ...}'" \
    "No input provided. Expected JSON with 'action' field. Valid actions: ${VALID_ACTIONS}"
fi

if ! printf '%s' "$INPUT" | jq -e . >/dev/null 2>&1; then
  emit_error 1 \
    "Error: input is not valid JSON." \
    "Input is not valid JSON. Expected: {\"action\":\"<one of: ${VALID_ACTIONS}>\", ...}"
fi

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
if [ -z "$ACTION" ]; then
  emit_error 1 \
    "Error: missing required field 'action'. Valid actions: ${VALID_ACTIONS}" \
    "Missing required field 'action'. Valid actions: ${VALID_ACTIONS}"
fi

ACCOUNT="${CREWLY_CRED_GMAIL_EMAIL:-me}"

# --- Action dispatch -------------------------------------------------------

case "$ACTION" in
  list|search)
    Q=$(printf '%s' "$INPUT" | jq -r '.q // "is:unread in:inbox"')
    MAX=$(printf '%s' "$INPUT" | jq -r '.maxResults // 10')
    if ! [[ "$MAX" =~ ^[0-9]+$ ]]; then MAX=10; fi
    if [ "$MAX" -lt 1 ]; then MAX=1; fi
    if [ "$MAX" -gt 50 ]; then MAX=50; fi

    Q_ENC=$(printf '%s' "$Q" | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()))")

    LIST_BODY=$(gmail_get "/messages?q=${Q_ENC}&maxResults=${MAX}")
    if [ "${_LAST_HTTP:-}" != "200" ]; then
      MSG=$(api_error_message "$LIST_BODY")
      emit_error 2 \
        "Error: Gmail API returned status ${_LAST_HTTP:-?} when listing messages: ${MSG}" \
        "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${MSG}"
    fi

    IDS=$(printf '%s' "$LIST_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for m in d.get('messages', []):
    print(m['id'] + '\t' + m.get('threadId',''))
" 2>/dev/null || echo "")

    MESSAGES_JSON='[]'
    if [ -n "$IDS" ]; then
      ENTRIES=()
      while IFS=$'\t' read -r id tid; do
        [ -z "$id" ] && continue
        MSG=$(gmail_get "/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date")
        if [ "${_LAST_HTTP:-}" != "200" ]; then
          continue
        fi
        ENTRY=$(printf '%s' "$MSG" | python3 -c "
import json, sys
m = json.load(sys.stdin)
headers = {h['name'].lower(): h['value'] for h in m.get('payload', {}).get('headers', [])}
snippet = (m.get('snippet') or '').strip()
if len(snippet) > 120:
    snippet = snippet[:117] + '...'
out = {
  'id': m.get('id',''),
  'threadId': m.get('threadId',''),
  'subject': headers.get('subject',''),
  'from': headers.get('from',''),
  'date': headers.get('date',''),
  'snippet': snippet,
}
print(json.dumps(out))
" 2>/dev/null || echo "")
        if [ -n "$ENTRY" ]; then
          ENTRIES+=("$ENTRY")
        fi
      done <<< "$IDS"

      if [ "${#ENTRIES[@]}" -gt 0 ]; then
        MESSAGES_JSON=$(printf '%s\n' "${ENTRIES[@]}" | jq -s '.')
      fi
    fi

    COUNT=$(printf '%s' "$MESSAGES_JSON" | jq 'length')
    OUT=$(jq -nc \
      --arg account "$ACCOUNT" \
      --arg query "$Q" \
      --argjson count "$COUNT" \
      --argjson messages "$MESSAGES_JSON" \
      '{success:true, account:$account, query:$query, count:$count, messages:$messages}')
    emit_success "$OUT"
    ;;

  read)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    if [ -z "$ID" ]; then
      emit_error 1 \
        "Error: 'read' action requires 'id' field (Gmail message id)." \
        "Missing required parameter: id"
    fi

    BODY=$(gmail_get "/messages/${ID}?format=full")
    if [ "${_LAST_HTTP:-}" != "200" ]; then
      MSG=$(api_error_message "$BODY")
      emit_error 2 \
        "Error: Gmail API returned status ${_LAST_HTTP:-?} when reading message ${ID}: ${MSG}" \
        "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${MSG}"
    fi

    OUT=$(printf '%s' "$BODY" | python3 -c "
import json, sys, base64, re

def b64url_decode(s):
    if not s:
        return ''
    s = s.replace('-', '+').replace('_', '/')
    pad = (-len(s)) % 4
    s += '=' * pad
    try:
        return base64.b64decode(s).decode('utf-8', errors='replace')
    except Exception:
        return ''

def walk_parts(part, plain_acc, html_acc):
    mime = part.get('mimeType','') or ''
    body = part.get('body', {}) or {}
    data = body.get('data')
    if data:
        if mime == 'text/plain':
            plain_acc.append(b64url_decode(data))
        elif mime == 'text/html':
            html_acc.append(b64url_decode(data))
    for sub in part.get('parts', []) or []:
        walk_parts(sub, plain_acc, html_acc)

m = json.load(sys.stdin)
payload = m.get('payload', {}) or {}
headers = {h['name'].lower(): h['value'] for h in payload.get('headers', [])}
plain_acc, html_acc = [], []
walk_parts(payload, plain_acc, html_acc)

plain = '\n'.join([p for p in plain_acc if p]).strip()
html = '\n'.join([p for p in html_acc if p]).strip()

result = {
  'success': True,
  'id': m.get('id',''),
  'threadId': m.get('threadId',''),
  'headers': {
    'from': headers.get('from',''),
    'to': headers.get('to',''),
    'cc': headers.get('cc',''),
    'subject': headers.get('subject',''),
    'date': headers.get('date',''),
  },
  'snippet': (m.get('snippet') or '').strip(),
}
if plain:
    result['body'] = plain
elif html:
    text = re.sub(r'<\s*br\s*/?\s*>', '\n', html, flags=re.IGNORECASE)
    text = re.sub(r'</\s*p\s*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    result['body'] = text
    result['bodyHtml'] = html
else:
    result['body'] = ''
print(json.dumps(result))
" 2>/dev/null || echo "")

    if [ -z "$OUT" ]; then
      emit_error 2 \
        "Error: failed to parse Gmail response for message ${ID}" \
        "Failed to parse Gmail response"
    fi
    emit_success "$OUT"
    ;;

  send)
    TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
    SUBJECT=$(printf '%s' "$INPUT" | jq -r '.subject // empty')
    BODY_TEXT=$(printf '%s' "$INPUT" | jq -r '.body // empty')

    MISSING=()
    [ -z "$TO" ] && MISSING+=("to")
    [ -z "$SUBJECT" ] && MISSING+=("subject")
    [ -z "$BODY_TEXT" ] && MISSING+=("body")
    if [ "${#MISSING[@]}" -gt 0 ]; then
      MISSING_STR=$(IFS=,; echo "${MISSING[*]}")
      emit_error 1 \
        "Error: 'send' action requires fields: ${MISSING_STR}" \
        "Missing required parameter(s): ${MISSING_STR}"
    fi

    RAW=$(printf '%s' "$INPUT" | python3 -c "
import json, sys, base64, os
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid

d = json.load(sys.stdin)
msg = MIMEText((d.get('body') or ''), 'plain', 'utf-8')
sender = os.environ.get('CREWLY_CRED_GMAIL_EMAIL', '')
if sender:
    msg['From'] = sender
msg['To'] = d.get('to') or ''
if d.get('cc'):
    msg['Cc'] = d['cc']
if d.get('bcc'):
    msg['Bcc'] = d['bcc']
msg['Subject'] = d.get('subject') or ''
msg['Date'] = formatdate(localtime=True)
msg['Message-ID'] = make_msgid()

raw = base64.urlsafe_b64encode(msg.as_bytes()).decode('ascii').rstrip('=')
print(raw)
" 2>/dev/null || echo "")

    if [ -z "$RAW" ]; then
      emit_error 1 \
        "Error: failed to encode MIME message for send." \
        "Failed to encode MIME message"
    fi

    SEND_BODY=$(jq -nc --arg raw "$RAW" '{raw:$raw}')
    SEND_RESP=$(gmail_post "/messages/send" "$SEND_BODY")
    if [ "${_LAST_HTTP:-}" != "200" ]; then
      MSG=$(api_error_message "$SEND_RESP")
      emit_error 2 \
        "Error: Gmail API returned status ${_LAST_HTTP:-?} when sending message: ${MSG}" \
        "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${MSG}"
    fi

    OUT=$(printf '%s' "$SEND_RESP" | jq -c '{success:true, id:.id, threadId:.threadId}')
    emit_success "$OUT"
    ;;

  *)
    emit_error 1 \
      "Error: Unknown action '${ACTION}'. Valid actions: ${VALID_ACTIONS}" \
      "Unknown action '${ACTION}'. Valid actions: ${VALID_ACTIONS}"
    ;;
esac
