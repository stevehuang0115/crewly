#!/usr/bin/env bash
# Crewly credential guard — a pre-tool hook that refuses an agent's tool call
# when it reads Crewly's own credentials.
#
# Spec: specs/2026-10-04-agent-credential-isolation.md (layer 2).
#
# Usage (wired by the backend through a generated wrapper; hook JSON on stdin):
#   bash guard.sh <format> [<paths-file>]
#     format:     claude | codex | gemini | antigravity
#     paths-file: written by the backend; defaults to $CREWLY_CREDENTIAL_GUARD_PATHS
#
# Paths-file lines (tab-separated):
#   home  -     <CREWLY_HOME>
#   abs   <id>  an absolute credential path (a file, or a directory = its subtree)
#
# What it judges — only REAL PATHS, resolved the way the call would resolve them:
#   - shell commands (Bash, run_shell_command, agy run_command) are tokenised
#     like a shell: quotes, escapes, `$(…)` and backticks (recursed into),
#     ~ / $HOME / ${HOME} / $CREWLY_HOME expansion (not inside single quotes;
#     ~ not inside double quotes). A word is a candidate path only when it
#     starts with `/`, or contains `/` and is resolved against the call's cwd,
#     and only when the whole word (or the value after `=`) is that path. A
#     bare word (`cloud`, `credentials`, `api-token`) never matches, and a
#     quoted sentence that mentions a path (a commit message) is one word
#     that is not a path.
#   - file tools: only argument fields whose NAME says path/file/dir
#     (file_path, path, AbsolutePath, …), resolved against the cwd. Content
#     fields (write_file / write_to_file bodies) are never read.
#   - `security find-generic-password|find-internet-password|export|-i`
#     in a command that names `crewly`, and any `security dump-keychain`.
#
# Deny contract:
#   claude, codex, gemini  exit 2, reason on stderr (fed back to the model)
#   antigravity            stdout {"decision":"deny","reason":"..."}, exit 0;
#                          an allowed call prints NOTHING (agy reads `{}` and
#                          a non-zero exit as deny)
#
# Fails open: no CREWLY_SESSION_NAME (the owner's own runtime), no node, no
# paths file, unparsable input -> allowed (agy) / non-blocking error (others).
#
# Coverage limits: paths built at runtime ($(echo …), base64, globs, other
# variables), a script the agent writes and then runs, an interpreter reading
# a computed path. It is a speed bump, not a boundary: same OS user.

set -u

FORMAT="${1:-claude}"
PATHS_FILE="${2:-${CREWLY_CREDENTIAL_GUARD_PATHS:-}}"
PREFIX="credential-guard:"
REASON_TAIL="Crewly credentials are not available to agents. Use the connector skills instead (docs-read, docs-comment, drive-read, sheets-read, gmail-search, ...) — they act for you without handing out a token. If a skill cannot do what you need, tell the owner instead of working around it."

INPUT="$(cat)"

# Owner's own runtime (no agent session): never judged.
SESSION="${CREWLY_SESSION_NAME:-}"
[ -z "$SESSION" ] && exit 0

if [ -z "$PATHS_FILE" ] || [ ! -f "$PATHS_FILE" ]; then
	echo "$PREFIX NO PATHS CHECKED — paths file missing (${PATHS_FILE:-<none>})" >&2
	[ "$FORMAT" = "antigravity" ] && exit 0
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "$PREFIX node not found — nothing checked" >&2
	[ "$FORMAT" = "antigravity" ] && exit 0
	exit 1
fi

# The matcher prints the rule id of the first guarded path the call reads, or nothing.
read -r -d '' MATCHER <<'JS'
const fs = require('fs');
const path = require('path');
const [pathsFile] = process.argv.slice(1);
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let o;
  try { o = JSON.parse(input); } catch { return; }
  let home = '';
  const guarded = [];
  for (const line of fs.readFileSync(pathsFile, 'utf8').split('\n')) {
    const [kind, id, value] = line.split('\t');
    if (kind === 'home') home = value;
    else if (kind === 'abs' && id && value) guarded.push({ id, p: path.resolve(value) });
  }
  const HOME = process.env.HOME || '';
  const CH = home || process.env.CREWLY_HOME || '';

  const tool = String(o.tool_name || (o.toolCall && o.toolCall.name) || '');
  const args = (o.tool_input || (o.toolCall && o.toolCall.args) || {});
  const cwd = String(o.cwd || (args && args.Cwd) || (Array.isArray(o.workspacePaths) && o.workspacePaths[0]) || process.cwd());

  const hit = (abs) => {
    const p = path.resolve(abs);
    for (const g of guarded) if (p === g.p || p.startsWith(g.p + '/')) return g.id;
    return null;
  };
  const expandVars = (s) => s
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, HOME)
    .replace(/\$\{CREWLY_HOME\}|\$CREWLY_HOME(?![A-Za-z0-9_])/g, CH);
  // bareOk: a path FIELD (file tools) — a bare name is a path, and ~ is
  // expanded here. Shell words arrive already expanded by the tokeniser
  // (a quoted ~ stays literal, as in a shell).
  const asPath = (s, bareOk) => {
    if (!s) return null;
    if (bareOk && s.startsWith('~/')) s = HOME + s.slice(1);
    if (s.startsWith('/')) return s;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // URL
    if (s.includes('/') || bareOk) return path.resolve(cwd, s);
    return null;
  };

  // ---- shell tokeniser ----
  const OPS = new Set([';', '&', '|', '<', '>', '(', ')', '\n']);
  function tokenize(cmd) {
    const out = []; // { w: string|null (null = operator), q: bool quoted }
    const subs = [];
    let w = '', started = false, quotedAll = true, i = 0;
    const push = () => { if (started) out.push({ w, q: quotedAll }); w = ''; started = false; quotedAll = true; };
    const readSub = (openIdx) => { // $( ... ) with nesting
      let depth = 1, j = openIdx;
      while (j < cmd.length && depth > 0) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; j++; }
      subs.push(cmd.slice(openIdx, j - 1));
      return j;
    };
    while (i < cmd.length) {
      const c = cmd[i];
      if (c === '\\' && i + 1 < cmd.length) { w += cmd[i + 1]; started = true; quotedAll = false; i += 2; continue; }
      if (c === "'") { const j = cmd.indexOf("'", i + 1); const end = j < 0 ? cmd.length : j; w += cmd.slice(i + 1, end); started = true; i = end + 1; continue; }
      if (c === '"') {
        let j = i + 1, seg = '';
        while (j < cmd.length && cmd[j] !== '"') {
          if (cmd[j] === '\\' && j + 1 < cmd.length) { seg += cmd[j + 1]; j += 2; continue; }
          if (cmd[j] === '$' && cmd[j + 1] === '(') { j = readSub(j + 2); seg += '\u0000'; continue; }
          if (cmd[j] === '`') { const k = cmd.indexOf('`', j + 1); const e = k < 0 ? cmd.length : k; subs.push(cmd.slice(j + 1, e)); seg += '\u0000'; j = e + 1; continue; }
          seg += cmd[j]; j++;
        }
        w += expandVars(seg); started = true; i = j + 1; continue;
      }
      if (c === '$' && cmd[i + 1] === '(') { i = readSub(i + 2); w += '\u0000'; started = true; quotedAll = false; continue; }
      if (c === '`') { const k = cmd.indexOf('`', i + 1); const e = k < 0 ? cmd.length : k; subs.push(cmd.slice(i + 1, e)); w += '\u0000'; started = true; quotedAll = false; i = e + 1; continue; }
      if (/\s/.test(c) && c !== '\n') { push(); i++; continue; }
      if (OPS.has(c)) { push(); out.push({ w: null }); i++; continue; }
      // unquoted text: ~ at the start of a word, and variables
      // ~ at the start of a word, or right after `=` / `:` (bash expands --opt=~/x too)
      if (c === '~' && (!started || /[=:]$/.test(w)) && (cmd[i + 1] === '/' || i + 1 === cmd.length)) { w += HOME; started = true; quotedAll = false; i++; continue; }
      if (c === '$') {
        const m = /^\$\{(HOME|CREWLY_HOME)\}|^\$(HOME|CREWLY_HOME)(?![A-Za-z0-9_])/.exec(cmd.slice(i));
        if (m) { w += (m[1] || m[2]) === 'HOME' ? HOME : CH; started = true; quotedAll = false; i += m[0].length; continue; }
      }
      w += c; started = true; quotedAll = false; i++;
    }
    push();
    return { tokens: out, subs };
  }

  const SKIP = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'xargs', 'exec', 'builtin']);
  function checkCommand(cmd, depth) {
    if (depth > 4) return null;
    const { tokens, subs } = tokenize(cmd);
    for (const s of subs) { const r = checkCommand(s, depth + 1); if (r) return r; }
    // simple commands
    let simple = [];
    const cmds = [];
    for (const t of tokens) { if (t.w === null) { if (simple.length) cmds.push(simple); simple = []; } else simple.push(t.w); }
    if (simple.length) cmds.push(simple);
    const lowerAll = cmd.toLowerCase();
    for (const words of cmds) {
      let k = 0;
      while (k < words.length && (SKIP.has(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))) k++;
      const verb = (words[k] || '').split('/').pop();
      const rest = words.slice(k + 1).map((x) => x.toLowerCase());
      if (verb === 'security') {
        if (rest.includes('dump-keychain')) return 'keychain';
        if (rest.some((x) => ['find-generic-password', 'find-internet-password', 'export', '-i'].includes(x)) && lowerAll.includes('crewly')) return 'keychain';
      }
      for (const word of words) {
        if (word.includes('\u0000')) continue; // contains a substitution: judged through the substitution
        const cands = [word];
        const eq = word.indexOf('=');
        if (eq > 0) cands.push(word.slice(eq + 1));
        for (const c of cands) {
          if (/\s/.test(c)) continue; // a sentence, not a path
          const p = asPath(c, false);
          if (p) { const id = hit(p); if (id) return id; }
        }
      }
    }
    return null;
  }

  function checkPathFields(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (!/path|file|dir/i.test(k)) continue; // never content fields
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) {
        if (typeof x !== 'string') continue;
        const p = asPath(expandVars(x), true);
        if (p) { const id = hit(p); if (id) return id; }
      }
    }
    return null;
  }

  const shellCmd = typeof args.command === 'string' ? args.command : typeof args.CommandLine === 'string' ? args.CommandLine : null;
  const isShell = /^(bash|run_shell_command|run_command|shell|exec_command)$/i.test(tool) || (shellCmd !== null && !/write|replace|edit/i.test(tool));
  let id = null;
  if (isShell && shellCmd !== null) id = checkCommand(shellCmd, 0);
  if (!id && !/write|replace|edit|create/i.test(tool)) id = checkPathFields(args);
  if (id) process.stdout.write(id);
});
JS

MATCH_ID="$(printf '%s' "$INPUT" | node -e "$MATCHER" "$PATHS_FILE" 2>/dev/null)"
MATCH_ID="$(printf '%s' "$MATCH_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"

[ -z "$MATCH_ID" ] && exit 0

REASON="Blocked: this reads Crewly's own credentials (${MATCH_ID}). ${REASON_TAIL}"

# ---- tell the backend (warning in its log; the owner hears once a day) ------
API_URL="${CREWLY_API_URL:-http://localhost:${WEB_PORT:-8787}}"
if command -v curl >/dev/null 2>&1; then
	CURL_ARGS=(-s -o /dev/null --max-time 2 -X POST "$API_URL/api/agent-hooks"
		-H "Content-Type: application/json"
		-H "User-Agent: crewly-credential-guard/1"
		-H "X-Agent-Session: $SESSION")
	if [ -n "${CREWLY_AGENT_BADGE:-}" ]; then
		CURL_ARGS+=(-H "X-Agent-Badge: $CREWLY_AGENT_BADGE")
	fi
	curl "${CURL_ARGS[@]}" --data "{\"event\":\"CredentialAccessBlocked\",\"rule\":\"$MATCH_ID\",\"runtime\":\"$(printf '%s' "$FORMAT" | tr -cd 'a-z')\"}" >/dev/null 2>&1 || true
fi

if [ "$FORMAT" = "antigravity" ]; then
	ESCAPED="$(printf '%s' "$REASON" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
	printf '{"decision":"deny","reason":"%s"}\n' "$ESCAPED"
	exit 0
fi

echo "$REASON" >&2
exit 2
