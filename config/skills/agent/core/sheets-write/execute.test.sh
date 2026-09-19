#!/bin/bash
# Tests for sheets-write — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request the skill sends and
# the JSON it prints. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18816
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def _reply(self, method, data=None):
        open(LOG, 'w').write(json.dumps({'method': method, 'path': self.path, 'body': data}))
        if 'no-grant' in self.path or (data or {}).get('title') == 'no-grant':
            self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'not_connected', 'message': 'no grant', 'hint': 'https://cloud/start?token=j'}).encode()); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'data': {'id': 'n1', 'title': data.get('title', 'T'), 'sheets': [{'title': 'Raw'}], 'webViewLink': 'https://l', 'mode': data.get('mode'), 'spreadsheetId': 's1', 'updatedRange': 'Raw!A3:B3', 'updatedRows': len(data.get('rows', []))}}).encode())
    def do_GET(self): self._reply('GET')
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        self._reply('POST', json.loads(body or '{}'))
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -f "$STUB_LOG"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

run() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>/dev/null; }
run_err() { CREWLY_API_URL="http://127.0.0.1:${PORT}" bash "$EXEC" "$@" 2>&1 >/dev/null; }

OUT=$(run --title "Leads" --sheet Raw --rows '[["name","email"],["Ann","a@x"]]')
check "create: output" "$OUT" '{"success":true,"action":"create","id":"n1","title":"Leads","sheets":["Raw"],"webViewLink":"https://l"}'
check "create: body" "$(jq -c .body "$STUB_LOG")" '{"title":"Leads","sheetTitle":"Raw","rows":[["name","email"],["Ann","a@x"]]}'
TMP="$(mktemp).csv"; printf 'name,email\n"Bob, Jr",b@x\n' > "$TMP"
OUT=$(run --id "https://docs.google.com/spreadsheets/d/s1/edit" --csv-file "$TMP")
check "append: output" "$OUT" '{"success":true,"action":"append","spreadsheetId":"s1","updatedRange":"Raw!A3:B3","updatedRows":2}'
check "append: body" "$(jq -c .body "$STUB_LOG")" '{"rows":[["name","email"],["Bob, Jr","b@x"]],"mode":"append"}'
rm -f "$TMP"
run --id s1 --rows '[["v"]]' --range "Raw!B2" --mode update >/dev/null
check "update: path+body" "$(jq -r '.path + " " + (.body|tojson)' "$STUB_LOG")" '/api/google/sheets/s1/values {"rows":[["v"]],"mode":"update","range":"Raw!B2"}'
OUT=$(run_err --id s1 --rows '["not","nested"]' || true)
check "bad rows rejected" "$(printf '%s' "$OUT" | grep -c 'array of arrays')" "1"

echo "sheets-write: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
