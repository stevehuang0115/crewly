#!/bin/bash
#
# gmail multi-action skill (v1.1.0) — 9 actions.
#
# Email ops:           list, read, search, send
# Label management:    add-label, remove-label, list-labels
# Status management:   mark-as-read, mark-as-unread
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
#   bash execute.sh '{"action":"list-labels"}'
#   bash execute.sh '{"action":"add-label","id":"18fa...","labelId":"Label_5"}'
#   bash execute.sh '{"action":"remove-label","id":"18fa...","labelId":"Label_5"}'
#   bash execute.sh '{"action":"mark-as-read","id":"18fa..."}'
#   bash execute.sh '{"action":"mark-as-unread","id":"18fa..."}'
#
# Env (injected by the executor):
#   CREWLY_CRED_GMAIL_ACCESS_TOKEN  — OAuth access token (required)
#   CREWLY_CRED_GMAIL_EMAIL         — account email (used as From: for send)
#
# Required scope: https://www.googleapis.com/auth/gmail.modify (covers all 9 actions)
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

VALID_ACTIONS="list, read, search, send, add-label, remove-label, list-labels, mark-as-read, mark-as-unread"

# Base URL for the Gmail v1 "users/me" endpoint. Overridable via env so tests
# can point the skill at a local mock HTTP server (see execute.live.test.sh).
GMAIL_API_BASE="${GMAIL_API_BASE:-https://gmail.googleapis.com/gmail/v1/users/me}"

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

# gmail_call OUT_BODY_VAR METHOD PATH [JSON_BODY]
#
# Make a Gmail API request against ${GMAIL_API_BASE}${PATH}, write the response
# body into the variable named by OUT_BODY_VAR, and set the global _LAST_HTTP
# to the response's HTTP status code.
#
# IMPORTANT: this function MUST be invoked directly (e.g. `gmail_call RESP GET "/labels"`)
# and MUST NOT be wrapped in command substitution (e.g. `RESP=$(gmail_call ... )`).
# The function relies on parent-shell scope to write _LAST_HTTP and the named
# output variable; command substitution forks a subshell, which would silently
# discard those writes the moment the substitution returns. The previous
# implementation (helpers `gmail_get` / `gmail_post` invoked via `$()`) hit
# exactly this pitfall and silently mis-classified every successful 200 as a
# failure with HTTP "?" because _LAST_HTTP never propagated out of the subshell.
#
# Authorization header is built from CREWLY_CRED_GMAIL_ACCESS_TOKEN. The token
# is never echoed to stdout/stderr.
gmail_call() {
  local _out_var="$1" method="$2" path="$3" body="${4:-}"
  local raw

  if [ "$method" = "GET" ]; then
    raw=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer ${CREWLY_CRED_GMAIL_ACCESS_TOKEN}" \
      "${GMAIL_API_BASE}${path}")
  else
    raw=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Authorization: Bearer ${CREWLY_CRED_GMAIL_ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${GMAIL_API_BASE}${path}")
  fi

  # Both writes happen in the caller's shell scope because this function is
  # called directly, not via $().
  _LAST_HTTP="${raw##*$'\n'}"
  printf -v "$_out_var" '%s' "${raw%$'\n'*}"
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

# extract_label_ids_array -> stdout: JSON array of label IDs from INPUT
# Reads the parsed INPUT and returns a JSON array of label IDs from either
# `labelId` (string) or `labelIds` (array). Returns "[]" if neither field is set.
extract_label_ids_array() {
  printf '%s' "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ids = []
single = d.get('labelId')
multi = d.get('labelIds')
if isinstance(multi, list):
    ids.extend([str(x) for x in multi if x])
if isinstance(single, str) and single:
    ids.append(single)
# de-dup, preserve order
seen = set(); out = []
for x in ids:
    if x not in seen:
        seen.add(x); out.append(x)
print(json.dumps(out))
" 2>/dev/null || echo '[]'
}

# modify_message ID ADD_JSON_ARRAY REMOVE_JSON_ARRAY
# Calls /messages/{id}/modify with the given add/remove label arrays.
# Emits the success/failure JSON to stdout and exits accordingly.
modify_message() {
  local id="$1" add_arr="$2" remove_arr="$3"
  if [ -z "$id" ]; then
    emit_error 1 \
      "Error: 'id' (Gmail message id) is required for modify operations." \
      "Missing required parameter: id"
  fi

  local body
  body=$(jq -nc --argjson add "$add_arr" --argjson remove "$remove_arr" \
    '{addLabelIds:$add, removeLabelIds:$remove}')

  local resp
  gmail_call resp POST "/messages/${id}/modify" "$body"
  if [ "${_LAST_HTTP:-}" != "200" ]; then
    local msg
    msg=$(api_error_message "$resp")
    emit_error 2 \
      "Error: Gmail API returned status ${_LAST_HTTP:-?} when modifying message ${id}: ${msg}" \
      "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${msg}"
  fi

  local out
  out=$(printf '%s' "$resp" | jq -c '{success:true, id:.id, threadId:.threadId, labelIds:(.labelIds // [])}')
  emit_success "$out"
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

# Validate JSON parses
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

    gmail_call LIST_BODY GET "/messages?q=${Q_ENC}&maxResults=${MAX}"
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
        gmail_call MSG GET "/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date"
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

    gmail_call BODY GET "/messages/${ID}?format=full"
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
  'labelIds': m.get('labelIds', []),
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

    # Build RFC-2822 MIME + base64url-encode via python (safe handling of unicode/CRLF).
    # Reading INPUT from stdin avoids any shell-arg escaping issues with embedded
    # quotes / backticks / $ in the body.
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
    gmail_call SEND_RESP POST "/messages/send" "$SEND_BODY"
    if [ "${_LAST_HTTP:-}" != "200" ]; then
      MSG=$(api_error_message "$SEND_RESP")
      emit_error 2 \
        "Error: Gmail API returned status ${_LAST_HTTP:-?} when sending message: ${MSG}" \
        "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${MSG}"
    fi

    OUT=$(printf '%s' "$SEND_RESP" | jq -c '{success:true, id:.id, threadId:.threadId}')
    emit_success "$OUT"
    ;;

  list-labels)
    gmail_call RESP GET "/labels"
    if [ "${_LAST_HTTP:-}" != "200" ]; then
      MSG=$(api_error_message "$RESP")
      emit_error 2 \
        "Error: Gmail API returned status ${_LAST_HTTP:-?} when listing labels: ${MSG}" \
        "Gmail API error (HTTP ${_LAST_HTTP:-?}): ${MSG}"
    fi

    LABELS=$(printf '%s' "$RESP" | jq -c '[.labels[]? | {id, name, type}]')
    COUNT=$(printf '%s' "$LABELS" | jq 'length')
    OUT=$(jq -nc \
      --arg account "$ACCOUNT" \
      --argjson count "$COUNT" \
      --argjson labels "$LABELS" \
      '{success:true, account:$account, count:$count, labels:$labels}')
    emit_success "$OUT"
    ;;

  add-label)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    LABEL_IDS=$(extract_label_ids_array)
    if [ "$LABEL_IDS" = "[]" ]; then
      emit_error 1 \
        "Error: 'add-label' requires 'labelId' (string) or 'labelIds' (array)." \
        "Missing required parameter: labelId or labelIds"
    fi
    modify_message "$ID" "$LABEL_IDS" '[]'
    ;;

  remove-label)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    LABEL_IDS=$(extract_label_ids_array)
    if [ "$LABEL_IDS" = "[]" ]; then
      emit_error 1 \
        "Error: 'remove-label' requires 'labelId' (string) or 'labelIds' (array)." \
        "Missing required parameter: labelId or labelIds"
    fi
    modify_message "$ID" '[]' "$LABEL_IDS"
    ;;

  mark-as-read)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    modify_message "$ID" '[]' '["UNREAD"]'
    ;;

  mark-as-unread)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    modify_message "$ID" '["UNREAD"]' '[]'
    ;;

  *)
    emit_error 1 \
      "Error: Unknown action '${ACTION}'. Valid actions: ${VALID_ACTIONS}" \
      "Unknown action '${ACTION}'. Valid actions: ${VALID_ACTIONS}"
    ;;
esac
