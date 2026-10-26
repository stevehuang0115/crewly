#!/bin/bash
# Tests for spawn-subagent — run with: bash execute.test.sh
# Python HTTP stub as the backend; asserts the request the skill sends and
# the JSON it prints. Separate HOME / CREWLY_HOME. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

PORT=18851
STUB_LOG="$(mktemp)"; export STUB_LOG; export STUB_PORT="$PORT"
python3 -u <<'PY' >/dev/null 2>&1 &
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os
LOG = os.environ['STUB_LOG']; PORT = int(os.environ['STUB_PORT'])
OUTCOME = {'success': True, 'stoppedReason': 'done', 'summary': 'retry delay at src/slack.ts:42 = 2000',
           'toolCalls': 2, 'toolNames': ['grep', 'read_file'], 'filesChanged': [],
           'usage': {'input': 100, 'output': 20, 'cachedInput': 0}, 'steps': 3,
           'sessionName': 'dev-ella/sub-1', 'durationMs': 1500, 'model': 'deepseek/deepseek-chat'}
class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self): self._send(200, {'success': True})
    def do_POST(self):
        n = int(self.headers.get('content-length', '0')); body = self.rfile.read(n).decode() if n else ''
        data = json.loads(body) if body else None
        with open(LOG, 'a') as f:
            f.write(json.dumps({'method': 'POST', 'path': self.path, 'body': data,
                                'session': self.headers.get('X-Agent-Session')}) + '\n')
        if self.path != '/api/subagents':
            return self._send(200, {'success': True})
        task = (data or {}).get('task', '')
        if task.startswith('NESTED'):
            return self._send(400, {'success': False, 'code': 'nested', 'error': 'A sub-agent cannot spawn sub-agents.'})
        if task.startswith('TIMEOUT'):
            out = dict(OUTCOME); out.update({'success': False, 'stoppedReason': 'timeout', 'toolCalls': 0, 'error': 'sub-agent exceeded 600000 ms'})
            return self._send(200, {'success': True, 'data': out})
        self._send(200, {'success': True, 'data': OUTCOME})
    def log_message(self, *a, **k): pass
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PY
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
WORK="$(mktemp -d)"; mkdir -p "$WORK/home/.crewly" "$WORK/repo"
trap 'kill "$STUB_PID" >/dev/null 2>&1; rm -rf "$STUB_LOG" "$WORK"' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null -m 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null && break; sleep 0.1; done

ENVS=(CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly" CREWLY_PROJECT_PATH="$WORK/repo")
# stdin closed: the skill reads JSON from a pipe when no task is given, and a
# test runner's stdin is a pipe that never ends.
run() { : > "$STUB_LOG"; env "${ENVS[@]}" bash "$EXEC" "$@" 2>/dev/null </dev/null; }
run_err() { : > "$STUB_LOG"; env "${ENVS[@]}" bash "$EXEC" "$@" 2>&1 >/dev/null </dev/null; }
# The skill library's start-of-skill heartbeat is not part of what we test.
reqs() { jq -c 'select(.path != "/api/heartbeat") | {path, session, body}' "$STUB_LOG" | paste -sd'|' -; }

# 1. Minimal call: task only; cwd defaults to CREWLY_PROJECT_PATH; readOnly false; no optionals.
OUT=$(run --task "Where is the retry delay set?")
check "minimal: request" "$(reqs)" "{\"path\":\"/api/subagents\",\"session\":\"dev-ella\",\"body\":{\"task\":\"Where is the retry delay set?\",\"cwd\":\"$WORK/repo\",\"readOnly\":false}}"
check "minimal: prints the outcome unwrapped" "$(printf '%s' "$OUT" | jq -c '{success, stoppedReason, toolCalls, sessionName}')" '{"success":true,"stoppedReason":"done","toolCalls":2,"sessionName":"dev-ella/sub-1"}'

# 2. Every flag.
OUT=$(run --task "Fix it" --cwd "$WORK/repo" --read-only --max-steps 12 --model deepseek/deepseek-chat)
check "all flags" "$(jq -c 'select(.path == "/api/subagents") | .body' "$STUB_LOG")" "{\"task\":\"Fix it\",\"cwd\":\"$WORK/repo\",\"readOnly\":true,\"maxSteps\":12,\"model\":\"deepseek/deepseek-chat\"}"

# 3. Legacy JSON form.
OUT=$(run "{\"task\":\"From JSON\",\"cwd\":\"$WORK/repo\",\"readOnly\":true,\"maxSteps\":5}")
check "json form" "$(jq -c 'select(.path == "/api/subagents") | .body' "$STUB_LOG")" "{\"task\":\"From JSON\",\"cwd\":\"$WORK/repo\",\"readOnly\":true,\"maxSteps\":5}"

# 4. Task from a file keeps quotes and newlines.
printf 'Line one with "quotes"\nLine two\n' > "$WORK/task.md"
run --task-file "$WORK/task.md" >/dev/null
check "task file" "$(jq -r 'select(.path == "/api/subagents") | .body.task' "$STUB_LOG")" "$(printf 'Line one with "quotes"\nLine two\n')"

# 5. cwd falls back to PWD when CREWLY_PROJECT_PATH is unset.
: > "$STUB_LOG"
(cd "$WORK/repo" && env CREWLY_API_URL="http://127.0.0.1:${PORT}" CREWLY_SESSION_NAME=dev-ella HOME="$WORK/home" CREWLY_HOME="$WORK/home/.crewly" bash "$EXEC" --task "pwd default" >/dev/null 2>&1 </dev/null)
check "cwd defaults to PWD" "$(jq -r 'select(.path == "/api/subagents") | .body.cwd' "$STUB_LOG")" "$WORK/repo"

# 6. Refusals before any request.
OUT=$(run_err --cwd "$WORK/repo" || true)
check "task required" "$(printf '%s' "$OUT" | grep -c 'Missing required parameter: task')" "1"
check "task required: nothing sent" "$(reqs)" ""
OUT=$(run_err --task x --cwd relative/dir || true)
check "cwd must be absolute" "$(printf '%s' "$OUT" | grep -c 'must be an absolute path')" "1"
OUT=$(run_err --task x --cwd "$WORK/missing" || true)
check "cwd must exist" "$(printf '%s' "$OUT" | grep -c 'not a directory')" "1"
OUT=$(run_err --task x --max-steps many || true)
check "max-steps numeric" "$(printf '%s' "$OUT" | grep -c 'whole number')" "1"
OUT=$(run_err --task x --bogus || true)
check "unknown flag" "$(printf '%s' "$OUT" | grep -c 'Unknown argument: --bogus')" "1"

# 7. A backend refusal is an error with its code; exit non-zero.
OUT=$(run_err --task "NESTED please" || true)
check "backend refusal surfaces the code" "$(printf '%s' "$OUT" | jq -r 'select(.error == true) | .details.code' 2>/dev/null | head -1)" "nested"
set +e; run --task "NESTED please" >/dev/null 2>&1; RC=$?; set -e
check "backend refusal exits 1" "$RC" "1"

# 8. A child that timed out is still a 200 outcome with success:false.
OUT=$(run --task "TIMEOUT me")
check "timeout outcome passes through" "$(printf '%s' "$OUT" | jq -c '{success, stoppedReason, error}')" '{"success":false,"stoppedReason":"timeout","error":"sub-agent exceeded 600000 ms"}'

# 9. --help prints usage and sends nothing.
OUT=$(run --help)
check "help" "$(printf '%s' "$OUT" | grep -c -- '--read-only')" "2"
check "help sends nothing" "$(reqs)" ""

echo "spawn-subagent: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
