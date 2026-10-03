#!/bin/bash
# Tests for signal-digest — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the requests the skill sends and
# the JSON it prints. Google is never called (no GSC / GA4 in the configs).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18841
TMP="$(mktemp -d)"
STUB_LOG="$TMP/requests.jsonl"; : > "$STUB_LOG"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        with open(LOG, 'a') as f:
            f.write(json.dumps({'method': method, 'path': self.path, 'body': data, 'account': self.headers.get('X-Google-Account')}) + '\n')
        path = self.path.split('?')[0]
        status, out = 200, {}
        if path == '/api/signal-digests/history':
            out = {'site': 'visa.careerengine.us', 'entries': [{'key': 'errors:broken:/gone', 'status': 'skip', 'at': '2026-10-01T00:00:00Z', 'digestId': 'SD-1'}]}
        elif path == '/api/experiments':
            out = [{'id': 'EXP-1', 'status': 'running', 'metric': {'query': 'opt extension'}, 'updatedAt': '2026-10-01T00:00:00Z'}]
        elif path == '/api/google/gmail/search':
            out = {'query': 'to:visa', 'count': 1, 'messages': [{'id': 'm1', 'from': 'a@b.c', 'subject': 'H1B fee?', 'date': 'd', 'snippet': 'how much'}]}
        elif path == '/api/signal-digests' and method == 'POST':
            if any(i.get('key') == 'tried' for i in (data or {}).get('items', [])):
                status = 409
                body = {'success': False, 'error': 'These actions were already decided: "tried"'}
                self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps(body).encode()); return
            out = {'id': 'SD-7', 'site': data['site'], 'items': data['items'], 'card': {'slackChannelId': 'C1', 'messageTs': '1.0'}}
            status = 201
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': out}).encode())
    def _body(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        return json.loads(body or '{}')
    def do_GET(self): self._reply('GET')
    def do_POST(self): self._reply('POST', self._body())
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

CFG="$TMP/ce.signal.json"
cat > "$CFG" <<'EOF'
{"siteUrl":"https://visa.careerengine.us","signalDigest":{"project":"CE site","inbox":{"query":"to:visa@careerengine.us newer_than:1d","account":"site@careerengine.us","max":5},"errors":{"checkSitemap":false}}}
EOF
BARE="$TMP/bare.json"
echo '{"siteUrl":"https://example.com","signalDigest":{"errors":{"checkSitemap":false}}}' > "$BARE"

run() { CREWLY_SESSION_NAME=tl-owen CREWLY_API_URL="http://127.0.0.1:${PORT}" HOME="$TMP" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=tl-owen CREWLY_API_URL="http://127.0.0.1:${PORT}" HOME="$TMP" bash "$EXEC" "$@" 2>&1 >/dev/null; }
# Skills fire a background POST /api/heartbeat on start: ignore it everywhere.
calls() { jq -c 'select(.path != "/api/heartbeat")' "$STUB_LOG"; }
last() { calls | tail -n 1 | jq -c "$1"; }
req() { calls | jq -c "select(.path | startswith(\"$1\")) | $2" | tail -n 1; }

# --- collect: history + inbox fetched, passed to the Python side
OUT=$(run collect --config "$CFG")
check "collect: exit 0 with the inbox as a source" "$(printf '%s' "$OUT" | jq -c '.sources')" '{"ga4":"not configured","gsc":"not configured","inbox":"ok","errors":"not configured"}'
check "collect: site and project from config" "$(printf '%s' "$OUT" | jq -c '[.site,.project]')" '["visa.careerengine.us","CE site"]'
check "collect: inbox messages" "$(printf '%s' "$OUT" | jq -c '.inbox.messages')" '[{"from":"a@b.c","subject":"H1B fee?","date":"d","snippet":"how much"}]'
check "collect: history asked for this site" "$(req /api/signal-digests/history '.path')" '"/api/signal-digests/history?site=visa.careerengine.us"'
check "collect: experiment cards asked for" "$(req /api/experiments '.path')" '"/api/experiments"'
check "collect: gmail query, max and account" "$(req /api/google/gmail/search '[.path,.account]')" '["/api/google/gmail/search?q=to%3Avisa%40careerengine.us%20newer_than%3A1d&max=5","site@careerengine.us"]'

: > "$STUB_LOG"
run collect --config "$BARE" >/dev/null; CODE=$?
check "collect: nothing examinable exits 1" "$CODE" "1"
check "collect: no inbox query, no gmail call" "$(req /api/google '.path')" ''

# --- propose
cat > "$TMP/actions.json" <<'EOF'
[{"key":"gsc:low-ctr:a","source":"gsc","signal":"s1","proposal":"p1","expectedEffect":"e1","effort":"S","metric":"m1","score":99,"experiment":{"source":"gsc","measure":"ctr","query":"a"}},
 {"key":"errors:broken:/x","source":"errors","signal":"s2","proposal":"p2","expectedEffect":"e2","effort":"S"},
 {"key":"ga4:drop","source":"ga4","signal":"s3","proposal":"p3","expectedEffect":"e3","effort":"M"}]
EOF
OUT=$(run propose --config "$CFG" --actions "$TMP/actions.json")
check "propose: output" "$OUT" '{"success":true,"digestId":"SD-7","site":"visa.careerengine.us","actions":3,"card":"posted"}'
check "propose: body (site, project, no score, experiment kept)" "$(last '.body | [.site, .project, (.items|length), .items[0]]')" '["visa.careerengine.us","CE site",3,{"key":"gsc:low-ctr:a","source":"gsc","signal":"s1","proposal":"p1","expectedEffect":"e1","effort":"S","metric":"m1","experiment":{"source":"gsc","measure":"ctr","query":"a"}}]'
check "propose: absolute config path" "$(last '.body.config')" "\"$CFG\""
check "propose: no metric key when absent" "$(last '.body.items[1] | has("metric")')" 'false'
run propose --config "$BARE" --actions '{"items":[{"key":"k1","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"},{"key":"k2","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"},{"key":"k3","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"}]}' >/dev/null
check "propose: inline {items}, no project, site from siteUrl" "$(last '.body | [.site, has("project"), (.items|length)]')" '["example.com",false,3]'
OUT=$(run propose --config "$CFG" --actions '[{"key":"tried","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"}]' || true)
check "propose: a 409 is passed on" "$(printf '%s' "$OUT" | jq -r '.success')" "false"
check "propose: bad actions" "$(run_err propose --config "$CFG" --actions '{"nope":1}' | jq -r .error | cut -c1-25)" "--actions must be a JSON "

# --- schedule: prints the create-cron object (it never creates the cron itself)
mkdir -p "$TMP/.crewly/teams/team-ce"
echo '{"members":[{"sessionName":"tl-owen"}]}' > "$TMP/.crewly/teams/team-ce/config.json"
: > "$STUB_LOG"
OUT=$(run schedule --config "$CFG" --cron "30 7 * * 1-5")
check "schedule: cron object" "$(printf '%s' "$OUT" | jq -c '.createCron | [.cronExpression,.timezone,.targetAgent,.targetTeamId]')" '["30 7 * * 1-5","America/New_York","tl-owen","team-ce"]'
check "schedule: task names the site and both steps" "$(printf '%s' "$OUT" | jq -r '.createCron.taskDescription | test("visa.careerengine.us") and test("collect --config /") and test("propose --config")')" "true"
check "schedule: no API call" "$(calls | wc -l | tr -d ' ')" "0"

# --- argument errors
check "config required" "$(run_err collect | jq -r .error)" "Missing required parameter: config (--config)"
check "unknown command" "$(run_err frobnicate --config "$CFG" | jq -r .error)" "Unknown command: frobnicate (collect | propose | schedule)"
OUT=$(run '{"command":"propose","config":"'"$CFG"'","actions":[{"key":"k1","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"},{"key":"k2","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"},{"key":"k3","source":"gsc","signal":"s","proposal":"p","expectedEffect":"e","effort":"S"}]}')
check "json input: actions as an array" "$(printf '%s' "$OUT" | jq -r .digestId)" "SD-7"

echo "signal-digest: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
