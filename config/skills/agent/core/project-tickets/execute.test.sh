#!/bin/bash
# Tests for project-tickets — run with: bash execute.test.sh
# A python HTTP stub plays the backend; asserts the calls and the output.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18841
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
T = {'id': 'APP-1', 'title': 'Export CSV', 'status': 'ready', 'priority': 'P1', 'assignee': None,
     'labels': ['ui'], 'workItemId': None, 'fileName': 'APP-1-export-csv.md', 'extra': {'x': 1},
     'log': ['a · owner · created', 'b · dev · note']}
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def record(self, body=None):
        open(LOG, 'w').write(json.dumps({'method': self.command, 'path': self.path, 'body': body, 'agent': self.headers.get('X-Agent-Session')}))
    def do_GET(self):
        self.record()
        if self.path.startswith('/api/project-tickets/'):
            if self.path.count('/') >= 4 and not self.path.split('?')[0].endswith('%2Fapp'):
                return self.reply(200, {'success': True, 'data': T})
            return self.reply(200, {'success': True, 'data': {'project': {'id': 'p1'}, 'tickets': [T], 'invalid': []}})
        if self.path.startswith('/api/project-ticket-autopilot/'):
            return self.reply(200, {'success': True, 'data': {'settings': {'enabled': False}}})
        if self.path.startswith('/api/project-tickets'):
            return self.reply(200, {'success': True, 'data': [{'project': {'id': 'p1'}, 'tickets': [T]}]})
        return self.reply(404, {'success': False, 'error': 'nope'})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = json.loads(self.rfile.read(n).decode() or '{}')
        self.record(body)
        if self.path.endswith('/link'):
            return self.reply(200, {'success': True, 'data': {'workItem': {'id': body.get('workItemId')}, 'ticket': dict(T, status='in_progress', assignee='dev-bo', workItemId=body.get('workItemId'))}})
        if self.path.endswith('/claim'):
            return self.reply(200, {'success': True, 'data': {'claimed': True, 'workItem': {'id': 'wi-9'}, 'ticket': dict(T, status='in_progress', assignee='dev-ann', workItemId='wi-9')}})
        if self.path.endswith('/ask-owner'):
            if body.get('clear'):
                return self.reply(200, {'success': True, 'data': {'ticket': T, 'withdrawn': 1}})
            return self.reply(200, {'success': True, 'data': {'decision': {'id': 'D-1', 'asker': 'dev-ann', 'status': 'open', 'deadline': 'x', 'card': {'slackChannelId': 'C1'}}, 'ticket': dict(T, labels=['ui', 'needs-owner'])}})
        if 'forbidden' in self.path:
            return self.reply(403, {'success': False, 'error': 'Not allowed'})
        return self.reply(200, {'success': True, 'data': T})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }
last() { jq -r "$1" "$STUB_LOG"; }

# --- list: one project (path is URL-encoded), and across my teams' projects ---
OUT=$(run list --project /work/app --status ready)
check "list: path" "$(last .path)" "/api/project-tickets/%2Fwork%2Fapp?status=ready"
check "list: rows" "$(printf '%s' "$OUT" | jq -c '[.tickets[] | [.id, .status]]')" '[["APP-1","ready"]]'
check "list: agent header" "$(last .agent)" "dev-ann"
OUT=$(run list)
check "list mine: path" "$(last .path)" "/api/project-tickets"
check "list mine: grouped" "$(printf '%s' "$OUT" | jq -c '[.projects[] | .project.id]')" '["p1"]'

# --- show drops the extra frontmatter noise ---
OUT=$(run show --project p1 --id APP-1)
check "show: path" "$(last .path)" "/api/project-tickets/p1/APP-1"
check "show: no extra" "$(printf '%s' "$OUT" | jq -c '.ticket | has("extra")')" "false"

# --- create with repeated acceptance and labels ---
run create --project p1 --title "Export CSV" --description "why" --acceptance "header row" --acceptance "opens in Excel" --priority P1 --labels "ui, export" --source request:TKT-012 >/dev/null
check "create: path" "$(last .path)" "/api/project-tickets/p1"
check "create: body" "$(last '.body | tostring')" '{"title":"Export CSV","description":"why","acceptance":["header row","opens in Excel"],"priority":"P1","labels":["ui","export"],"source":"request:TKT-012"}'

# --- create from JSON input ---
run '{"action":"create","project":"p1","title":"From JSON","status":"ready","ownerReview":true}' >/dev/null
check "create json: body" "$(last '.body | tostring')" '{"title":"From JSON","status":"ready","ownerReview":true}'

# --- update only sends what was given ---
run update --project p1 --id APP-1 --priority P0 --status ready --note groomed >/dev/null
check "update: path" "$(last .path)" "/api/project-tickets/p1/APP-1/update"
check "update: body" "$(last '.body | tostring')" '{"priority":"P0","status":"ready","note":"groomed"}'
check "update: nothing" "$(run_err update --project p1 --id APP-1 | grep -c 'Nothing to update')" "1"

# --- claim returns the WorkItem id and what to do next ---
OUT=$(run claim --project p1 --id APP-1)
check "claim: path" "$(last .path)" "/api/project-tickets/p1/APP-1/claim"
check "claim: output" "$(printf '%s' "$OUT" | jq -c '[.claimed, .workItemId, .ticket.status]')" '[true,"wi-9","in_progress"]'

# --- release = transition to ready ---
run release --project p1 --id APP-1 --note "blocked on design" >/dev/null
check "release: path" "$(last .path)" "/api/project-tickets/p1/APP-1/transition"
check "release: body" "$(last '.body | tostring')" '{"status":"ready","note":"blocked on design"}'

# --- assign (orchestrator / lead) ---
run assign --project p1 --id APP-1 --to dev-bo >/dev/null
check "assign: path" "$(last .path)" "/api/project-tickets/p1/APP-1/assign"
check "assign: body" "$(last '.body | tostring')" '{"assignee":"dev-bo","start":true}'
run '{"action":"assign","project":"p1","id":"APP-1","to":"Steve","start":false}' >/dev/null
check "assign json no-start" "$(last '.body | tostring')" '{"assignee":"Steve","start":false}'
check "assign: missing to" "$(run_err assign --project p1 --id APP-1 | grep -c 'to')" "1"

# --- log ---
OUT=$(run log --project p1 --id APP-1 --note "halfway")
check "log: body" "$(last '.body | tostring')" '{"note":"halfway"}'
check "log: last line" "$(printf '%s' "$OUT" | jq -r .lastLog)" "b · dev · note"

# --- link (orchestrator / lead): tie a live WorkItem to a ticket ---
OUT=$(run link --project p1 --id APP-1 --work-item wi-42)
check "link: path" "$(last .path)" "/api/project-tickets/p1/APP-1/link"
check "link: body" "$(last '.body | tostring')" '{"workItemId":"wi-42"}'
check "link: output" "$(printf '%s' "$OUT" | jq -c '[.workItemId, .ticket.status, .ticket.workItemId]')" '["wi-42","in_progress","wi-42"]'
run '{"action":"link","project":"p1","id":"APP-1","workItemId":"wi-43"}' >/dev/null
check "link json" "$(last '.body | tostring')" '{"workItemId":"wi-43"}'
check "link: missing work item" "$(run_err link --project p1 --id APP-1 | grep -c 'work-item')" "1"

# --- ask-owner: a structured decision (question + 2–3 options + default) ---
OUT=$(run ask-owner --project p1 --id APP-1 --question "Send the draft to the partners?" --option "Send Monday — after review" --option "Hold" --default Hold --sensitive email)
check "ask-owner: path" "$(last .path)" "/api/project-tickets/p1/APP-1/ask-owner"
check "ask-owner: body" "$(last '.body | tostring')" '{"question":"Send the draft to the partners?","options":["Send Monday — after review","Hold"],"default":"Hold","sensitive":"email"}'
check "ask-owner: output" "$(printf '%s' "$OUT" | jq -c '.decision')" '{"id":"D-1","asker":"dev-ann","status":"open","deadline":"x","posted":true,"postError":null}'
run '{"action":"ask-owner","project":"p1","id":"APP-1","question":"Q is long enough?","options":["A","B"],"default":"wait","deadline":"2026-10-02T12:00"}' >/dev/null
check "ask-owner json: body" "$(last '.body | tostring')" '{"question":"Q is long enough?","options":["A","B"],"default":"wait","deadline":"2026-10-02T12:00"}'
OUT=$(run ask-owner --project p1 --id APP-1 --clear --note "owner said yes")
check "ask-owner: clear" "$(last '.body | tostring')" '{"clear":true,"note":"owner said yes"}'
check "ask-owner: clear output" "$(printf '%s' "$OUT" | jq -c '.withdrawn')" '1'
check "ask-owner: missing question" "$(run_err ask-owner --project p1 --id APP-1 | grep -c 'question')" "1"

# --- autopilot (owner / orchestrator): show or change the switch ---
OUT=$(run autopilot --project p1)
check "autopilot show: GET" "$(last '[.method, .path] | tostring')" '["GET","/api/project-ticket-autopilot/p1"]'
check "autopilot show: output" "$(printf '%s' "$OUT" | jq -c '.autopilot.settings')" '{"enabled":false}'
run autopilot --project p1 --on --daily-budget 12.5 --max-in-flight 2 >/dev/null
check "autopilot on: POST" "$(last '[.method, .path] | tostring')" '["POST","/api/project-ticket-autopilot/p1"]'
check "autopilot on: body" "$(last '.body | tostring')" '{"enabled":true,"dailyBudgetUsd":12.5,"maxInFlightPerMember":2}'
run autopilot --project p1 --off --driver default >/dev/null
check "autopilot off: body" "$(last '.body | tostring')" '{"enabled":false,"driver":null}'
run '{"action":"autopilot","project":"p1","enabled":true,"driver":"ce-owen"}' >/dev/null
check "autopilot json: body" "$(last '.body | tostring')" '{"enabled":true,"driver":"ce-owen"}'

# --- errors ---
check "missing action" "$(run_err | grep -c 'Missing action')" "1"
check "unknown action" "$(run_err explode | grep -c 'Unknown action')" "1"
check "missing project" "$(run_err show --id APP-1 | grep -c 'project')" "1"
check "server 403 surfaces" "$(run_err claim --project forbidden --id APP-1 >/dev/null; CREWLY_SESSION_NAME=dev-ann CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" log --project forbidden --id APP-1 --note x 2>&1 >/dev/null | grep -c '403')" "1"

echo "project-tickets: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
