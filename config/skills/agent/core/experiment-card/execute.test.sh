#!/bin/bash
# Tests for experiment-card — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18853
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
E = {'id': 'EXP-1', 'traceId': 'exp:EXP-1', 'status': 'planned', 'title': 'T', 'hypothesis': 'H',
     'metric': {'source': 'gsc', 'measure': 'clicks', 'config': '/c.json', 'page': 'https://x/'}, 'windowDays': 14,
     'baseline': {'total': 100, 'days': [1, 2]}, 'timeline': [{'at': 'a', 'event': 'created'}], 'createdBy': 'ella'}
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def record(self, body=None):
        open(LOG, 'w').write(json.dumps({'method': self.command, 'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
    def do_GET(self):
        self.record()
        if self.path.startswith('/api/experiments/'):
            return self.reply(200, {'success': True, 'data': E})
        return self.reply(200, {'success': True, 'data': [E, dict(E, id='EXP-2', status='done', verdict='worked')]})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        self.record(body)
        if self.path.endswith('/measure'):
            return self.reply(409, {'success': False, 'error': 'EXP-1 is not due until 2026-10-28'})
        return self.reply(200, {'success': True, 'data': E})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=ella CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=ella CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
last() { jq -r "$1" "$STUB_LOG"; }

# --- create on a project ticket: metric, expectation, window ---
OUT=$(run create --hypothesis "FAQ schema → clicks 100 to 140" --source gsc --measure clicks --config /c.json \
  --page https://x/ --from 100 --to 140 --window-days 21 --project ce --ticket T-12)
check "create: path" "$(last .path)" "/api/experiments"
check "create: body" "$(last '.body | tostring')" '{"hypothesis":"FAQ schema → clicks 100 to 140","metric":{"source":"gsc","measure":"clicks","config":"/c.json","page":"https://x/"},"expected":{"from":"100","to":"140"},"windowDays":"21","ticket":{"kind":"project","project":"ce","id":"T-12"}}'
check "create: agent header" "$(last .agent)" "ella"
check "create: card" "$(printf '%s' "$OUT" | jq -c '.experiment | [.id, .baseline, .metric.page]')" '["EXP-1",100,"https://x/"]'

# --- create on a harness ticket with GA4 form events ---
run create --hypothesis "Shorter form" --source ga4 --measure events --event generate_lead --channel all --config /c.json --tkt TKT-40 >/dev/null
check "create ga4: body" "$(last '.body | tostring')" '{"hypothesis":"Shorter form","metric":{"source":"ga4","measure":"events","config":"/c.json","event":"generate_lead","channel":"all"},"ticket":{"kind":"harness","id":"TKT-40"}}'

# --- create from JSON passes the body through ---
run '{"action":"create","hypothesis":"J","metric":{"source":"gsc","measure":"ctr","config":"/c.json"}}' >/dev/null
check "create json: body" "$(last '.body | tostring')" '{"hypothesis":"J","metric":{"source":"gsc","measure":"ctr","config":"/c.json"}}'

# --- create on an already-done ticket with an explicit ship time ---
run create --hypothesis "Late card" --source gsc --measure clicks --config /c.json --project ce --ticket T-9 --shipped-at 2026-10-01T10:00:00Z >/dev/null
check "create shipped-at: body" "$(last '.body.shippedAt')" "2026-10-01T10:00:00Z"
run '{"action":"create","hypothesis":"J","metric":{"source":"gsc","measure":"ctr","config":"/c.json"},"shippedAt":"2026-10-01T10:00:00Z"}' >/dev/null
check "create json shipped-at: body" "$(last '.body.shippedAt')" "2026-10-01T10:00:00Z"

# --- missing params / a ticket without its project ---
check "create: missing" "$(run_err create --hypothesis h --source gsc --measure clicks | grep -c 'config')" "1"
check "create: ticket w/o project" "$(run_err create --hypothesis h --source gsc --measure clicks --config /c --ticket T-1 | grep -c 'needs --project')" "1"

# --- ship / show / list / cancel ---
run ship --id EXP-1 --shipped-at 2026-10-01T10:00:00Z >/dev/null
check "ship: path" "$(last .path)" "/api/experiments/EXP-1/ship"
check "ship: body" "$(last '.body | tostring')" '{"shippedAt":"2026-10-01T10:00:00Z"}'
OUT=$(run show --id EXP-1)
check "show: timeline" "$(printf '%s' "$OUT" | jq -c '.experiment.timeline | map(.event)')" '["created"]'
OUT=$(run list --status done --ticket TKT-40)
check "list: path" "$(last .path)" "/api/experiments?status=done&ticket=TKT-40"
check "list: rows" "$(printf '%s' "$OUT" | jq -c '[.experiments[] | [.id, .verdict]]')" '[["EXP-1",null],["EXP-2","worked"]]'
run cancel --id EXP-1 --reason dup >/dev/null
check "cancel: body" "$(last '.body | tostring')" '{"reason":"dup"}'

# --- measure refused before it is due: the error reaches the agent ---
check "measure: not due" "$(run_err measure --id EXP-1 | grep -c 'not due')" "1"

# --- unknown action / option ---
check "unknown action" "$(run_err frobnicate | grep -c 'Unknown action')" "1"
check "unknown option" "$(run_err list --nope | grep -c 'Unknown option')" "1"

echo "experiment-card: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
