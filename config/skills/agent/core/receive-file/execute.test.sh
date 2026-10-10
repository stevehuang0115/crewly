#!/bin/bash
# Tests for receive-file — run with: bash execute.test.sh
# A Python stub plays both the Crewly backend and the object storage.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi; }

PORT=18862
STUB_LOG="$(mktemp)"; export STUB_LOG STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
OK = 'hf_AbCdEfGhIjKlMnOpQrStUv'; SHORT = 'hf_ShortShortShortShortSh'; PEND = 'hf_PendPendPendPendPendPe'
DATA = b'x' * 2000000
def note(**kw):
    with open(LOG, 'a') as f: f.write(json.dumps(kw) + '\n')
class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        if self.path.startswith('/store/'):
            data = DATA[:1000] if 'short' in self.path else DATA
            note(op='download', range=self.headers.get('Range'))
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
        hid = self.path.rsplit('/', 1)[-1]
        if hid == PEND:
            return self.send(200, {'success': True, 'data': {'handoffId': hid, 'status': 'pending', 'sizeBytes': 5, 'fileName': 'a'}})
        if hid in (OK, SHORT):
            return self.send(200, {'success': True, 'data': {'handoffId': hid, 'status': 'ready', 'sizeBytes': len(DATA), 'fileName': '../../evil name.mp4', 'note': 'today',
                'download': {'url': f'http://127.0.0.1:{PORT}/store/' + ('short' if hid == SHORT else 'ok'), 'expiresAt': 'x'}}})
        self.send(404, {'success': False, 'error': 'not_found', 'message': 'This handoff is gone.'})
    def do_POST(self):
        note(op='ack' if self.path.endswith('/ack') else 'other', path=self.path, session=self.headers.get('X-Agent-Session')); self.send(200, {'success': True, 'data': {'deleted': True}})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done
mkdir -p "$WORK/home/.crewly" "$WORK/proj"
ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-mia HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly" CREWLY_PROJECT_PATH="$WORK/proj")
run() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OK=hf_AbCdEfGhIjKlMnOpQrStUv
OUT=$(run --id $OK)
DEST="$WORK/proj/received/evil name.mp4"
check "result" "$(printf '%s' "$OUT" | jq -c '{success, fileName, sizeBytes, acked, note}')" '{"success":true,"fileName":"evil name.mp4","sizeBytes":2000000,"acked":true,"note":"today"}'
check "saved in the default folder under a safe name" "$(wc -c < "$DEST" | tr -d ' ')" "2000000"
check "ack sent as this agent" "$(grep '"op": "ack"' "$STUB_LOG" | jq -c '{path, session}')" '{"path":"/api/apps/handoffs/hf_AbCdEfGhIjKlMnOpQrStUv/ack","session":"dev-mia"}'
check "no .part left" "$(ls -a "$WORK/proj/received" | grep -c part)" "0"

OUT=$(run --id $OK --dir "$WORK/proj/inbox")
check "second copy goes to --dir" "$(printf '%s' "$OUT" | jq -r .path)" "$WORK/proj/inbox/evil name.mp4"
run --id $OK >/dev/null
check "never overwrites" "$(ls "$WORK/proj/received" | sort | tr '\n' '|')" "evil name-1.mp4|evil name.mp4|"

: > "$STUB_LOG"
OUT=$(run --id $OK --no-ack --dir "$WORK/proj/noack")
check "--no-ack keeps the server copy" "$(printf '%s' "$OUT" | jq -c '{acked, warning: (.warning != null)}')" '{"acked":false,"warning":true}'
check "no ack request" "$(grep -c '"op": "ack"' "$STUB_LOG")" "0"

: > "$STUB_LOG"
OUT=$(run --id hf_ShortShortShortShortSh --dir "$WORK/proj/short"; true)
check "size mismatch fails, removes the partial and does not ack" "$(printf '%s' "$OUT" | jq -r .reason)|$(ls -A "$WORK/proj/short" | wc -l | tr -d ' ')|$(grep -c '"op": "ack"' "$STUB_LOG")" "size_mismatch|0|0"

OUT=$(run --id hf_PendPendPendPendPendPe; true)
check "pending handoff is not ready" "$(printf '%s' "$OUT" | jq -r .reason)" "not_ready"
OUT=$(run --id hf_GoneGoneGoneGoneGoneGo; true)
check "unknown handoff passes Cloud's reason" "$(printf '%s' "$OUT" | jq -r .reason)" "not_found"
check "bad id refused" "$(run_err --id nope | grep -c 'handoff id')" "1"
check "dir inside Crewly home refused" "$(run_err --id $OK --dir "$WORK/home/.crewly/x" | grep -c 'Crewly home')" "1"

echo "receive-file: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
