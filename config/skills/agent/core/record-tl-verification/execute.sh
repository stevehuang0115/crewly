#!/bin/bash
# record-tl-verification — a team leader's verification marker for a CODE PR in a repo whose CI
# cannot run. destructive-git-guard needs it, next to a green record-local-gate record, before it
# lets `gh pr merge` through (local-gates.json "codePrs": true). The caller must be a team leader
# (role "team-leader" in a team config under ~/.crewly/teams) and must not be the session that ran
# the gate. A marker is for one head SHA: a new commit needs a new verification.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GH="${CREWLY_GUARD_GH:-gh}"
GATES="${CREWLY_GUARD_LOCAL_GATES:-${SCRIPT_DIR}/../../../../hooks/destructive-git-guard/local-gates.json}"
RECORDS_ROOT="${CREWLY_HOME:-$HOME/.crewly}/local-gates"
TEAMS_DIR="${CREWLY_TEAMS_DIR:-$HOME/.crewly/teams}"

usage() {
  cat <<'EOF_USAGE'
Usage: bash execute.sh --repo owner/name --pr N --summary "one line: what you verified"
Team leaders only. Needs a passing record-local-gate record at the PR's current head, made by
another session. Writes $CREWLY_HOME/local-gates/<owner>__<repo>/pr-<N>-<sha>.tl.json.
EOF_USAGE
}

fail() { printf '{"error":%s}\n' "$(jq -Rn --arg e "$1" '$e')" >&2; exit "${2:-1}"; }

REPO=""; PR=""; SUMMARY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --pr) PR="${2:-}"; shift 2 ;;
    --summary) SUMMARY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" 2 ;;
  esac
done
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--repo owner/name is required" 2
[[ "$PR" =~ ^[0-9]+$ ]] || fail "--pr <number> is required" 2
[ -n "$SUMMARY" ] || fail "--summary \"what you verified\" is required (one line)" 2
command -v jq >/dev/null || fail "jq is required"

jq -e --arg r "$REPO" '.[$r].codePrs == true' "$GATES" >/dev/null 2>&1 \
  || fail "$REPO is not enabled for code PRs (no \"codePrs\": true in $GATES); a TL marker would be ignored"

SESSION="${CREWLY_SESSION_NAME:-}"
[ -n "$SESSION" ] || fail "CREWLY_SESSION_NAME is not set; the verifier cannot be identified"
ROLE=""; CONFIGS=0
for c in "$TEAMS_DIR"/*/config.json; do
  [ -f "$c" ] || continue
  CONFIGS=$((CONFIGS + 1))
  r="$(jq -r --arg s "$SESSION" '[.members[]? | select(.sessionName == $s) | .role] | first // empty' "$c" 2>/dev/null)"
  [ -n "$r" ] && { ROLE="$r"; break; }
done
[ "$CONFIGS" -gt 0 ] || fail "no team configs found under $TEAMS_DIR (0 checked); cannot confirm $SESSION is a team leader"
[ "$ROLE" = "team-leader" ] || fail "only a team leader may record a TL verification ($SESSION has role '${ROLE:-unknown}')"

SHA="$("$GH" pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid 2>&1)" || fail "could not read PR #$PR with gh: $SHA"
[[ "$SHA" =~ ^[0-9a-f]{7,64}$ ]] || fail "gh returned no head commit for PR #$PR"

DIR="$RECORDS_ROOT/${REPO/\//__}"
REC="$DIR/pr-$PR-$SHA.json"
[ -f "$REC" ] || fail "no local-gate record at ${SHA:0:10}; run record-local-gate --repo $REPO --pr $PR first"
[ "$(jq -r '.sha' "$REC")" = "$SHA" ] && [ "$(jq -r '.exitCode' "$REC")" = "0" ] || fail "the local-gate record at ${SHA:0:10} is not a passing run for this head"
RECORDER="$(jq -r '.recordedBy // empty' "$REC")"
[ "$RECORDER" != "$SESSION" ] || fail "$SESSION ran the gate for this PR; another team leader must verify it"

OUT="$DIR/pr-$PR-$SHA.tl.json"
jq -n --arg sha "$SHA" --arg verifier "$SESSION" --arg role "$ROLE" --arg recorder "$RECORDER" --arg summary "$SUMMARY" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{sha:$sha, verifier:$verifier, role:$role, gateRecordedBy:$recorder, summary:$summary, recordedAt:$at}' > "$OUT.tmp" \
  && mv "$OUT.tmp" "$OUT" || fail "could not write $OUT"

echo "record-tl-verification: $SESSION (team-leader) verified $REPO PR #$PR at $SHA; gate run by ${RECORDER:-unknown}; marker: $OUT"
