#!/bin/bash
#
# gmail-reader execute.sh
#
# Reads unread messages from a Google account's inbox. The credentials are
# injected by the Crewly skill executor based on the credentialBindings.gmail
# resolution — this script does NOT handle OAuth directly.
#
# Usage:
#   bash execute.sh [maxResults]
#
# Env (injected by the executor):
#   CREWLY_CRED_GMAIL_ACCESS_TOKEN  — OAuth access token (required)
#   CREWLY_CRED_GMAIL_EMAIL         — account email (optional, display only)
#

set -euo pipefail

if [ -z "${CREWLY_CRED_GMAIL_ACCESS_TOKEN:-}" ]; then
    echo "Error: CREWLY_CRED_GMAIL_ACCESS_TOKEN is not set." >&2
    echo "Bind a google-oauth credential to the 'gmail' slot when calling this skill." >&2
    exit 1
fi

# Clamp max results to 1..50
MAX="${1:-10}"
if ! [[ "$MAX" =~ ^[0-9]+$ ]]; then MAX=10; fi
if [ "$MAX" -lt 1 ]; then MAX=1; fi
if [ "$MAX" -gt 50 ]; then MAX=50; fi

ACCOUNT="${CREWLY_CRED_GMAIL_EMAIL:-account}"
BASE="https://gmail.googleapis.com/gmail/v1/users/me"
AUTH_HDR="Authorization: Bearer ${CREWLY_CRED_GMAIL_ACCESS_TOKEN}"

# Step 1: list unread message IDs
LIST_BODY=$(curl -s -w "\n%{http_code}" \
  -H "$AUTH_HDR" \
  "${BASE}/messages?q=is:unread+in:inbox&maxResults=${MAX}")
LIST_HTTP="${LIST_BODY##*$'\n'}"
LIST_JSON="${LIST_BODY%$'\n'*}"

if [ "$LIST_HTTP" != "200" ]; then
    echo "Error: Gmail API returned status ${LIST_HTTP} when listing messages." >&2
    echo "$LIST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  '+(d.get('error',{}).get('message') or str(d)), file=sys.stderr)" 2>/dev/null || true
    exit 2
fi

IDS=$(python3 -c "
import json, sys
d = json.loads('''${LIST_JSON//\'/\\\'}''')
for m in d.get('messages', []):
    print(m['id'])
" 2>/dev/null || echo "")

if [ -z "$IDS" ]; then
    echo "No unread messages in ${ACCOUNT}'s inbox."
    exit 0
fi

COUNT=$(echo "$IDS" | wc -l | tr -d ' ')
echo "Unread messages in ${ACCOUNT}'s inbox (${COUNT} of up to ${MAX}):"
echo "============================================================"
echo ""

# Step 2: fetch metadata for each
while IFS= read -r id; do
    [ -z "$id" ] && continue
    MSG=$(curl -s \
      -H "$AUTH_HDR" \
      "${BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date")
    python3 -c "
import json, sys
m = json.loads('''${MSG//\'/\\\'}''')
headers = {h['name']: h['value'] for h in m.get('payload', {}).get('headers', [])}
snippet = (m.get('snippet') or '').strip()
if len(snippet) > 120:
    snippet = snippet[:117] + '...'
print(f'  From:    {headers.get(\"From\", \"(unknown)\")}')
print(f'  Subject: {headers.get(\"Subject\", \"(no subject)\")}')
print(f'  Date:    {headers.get(\"Date\", \"(unknown)\")}')
print(f'  Snippet: {snippet}')
print(f'  ID:      {m.get(\"id\", \"\")}')
print()
" 2>/dev/null || echo "  (failed to parse message ${id})"
done <<< "$IDS"
