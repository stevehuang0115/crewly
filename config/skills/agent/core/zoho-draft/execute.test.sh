#!/bin/bash
# Tests for zoho-draft — run with: bash execute.test.sh
# A python stub stands in for the backend; asserts the request the skill
# sends: right path, no "mode" key ever, fields mapped.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi; }
PORT=18807; STUB_LOG="$(mktemp)"; export STUB_LOG STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG=os.environ['STUB_LOG']; PORT=int(os.environ['STUB_PORT'])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length','0')); body=self.rfile.read(n).decode() if n else ''
        open(LOG,'w').write(json.dumps({'path':self.path,'body':json.loads(body or '{}')}))
        self.send_response(202); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'success':True,'drafted':True,'sent':False,'accountId':'1','detail':'ok'}).encode())
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',PORT),H).serve_forever()
PY
STUB_PID=$!; trap 'kill $STUB_PID 2>/dev/null' EXIT
sleep 1
export CREWLY_API_URL="http://127.0.0.1:$PORT" CREWLY_SESSION_NAME=t
OUT=$(bash "$EXEC" --from info@x.y --to a@b.c --subject S --text hi 2>/dev/null)
check "output drafted" "$(echo "$OUT" | jq -r '.drafted')" "true"
check "output sent" "$(echo "$OUT" | jq -r '.sent')" "false"
check "path" "$(jq -r .path "$STUB_LOG")" "/api/connectors/zoho/draft"
check "mapped" "$(jq -c '.body' "$STUB_LOG")" '{"fromAddress":"info@x.y","toAddress":"a@b.c","mailFormat":"plaintext","subject":"S","content":"hi"}'
bash "$EXEC" '{"from":"info@x.y","to":"a@b.c","mode":"send"}' >/dev/null 2>&1
check "json input never carries mode" "$(jq -r '.body | has("mode")' "$STUB_LOG")" "false"
bash "$EXEC" --to a@b.c >/dev/null 2>&1; check "missing --from fails" "$?" "1"
echo "pass=$PASS fail=$FAIL"; [ "$FAIL" = 0 ]
