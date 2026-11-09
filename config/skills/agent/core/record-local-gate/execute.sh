#!/bin/bash
# record-local-gate — run a repo's gate on a PR's exact head commit in a FRESH clone and
# record the result for destructive-git-guard (gh pr merge of a content-only PR whose CI
# cannot run). There is no way to pass an exit code in: the record is only ever the real
# result of the commands in local-gates.json. See config/hooks/destructive-git-guard/guard.mjs.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GH="${CREWLY_GUARD_GH:-gh}"
GATES="${CREWLY_GUARD_LOCAL_GATES:-${SCRIPT_DIR}/../../../../hooks/destructive-git-guard/local-gates.json}"
RECORDS_ROOT="${CREWLY_HOME:-$HOME/.crewly}/local-gates"
LOG_TAIL_LINES=40

usage() {
  cat <<'EOF_USAGE'
Usage: bash execute.sh --repo owner/name --pr N
Runs the repo's gate (config/hooks/destructive-git-guard/local-gates.json) on the PR head in a
fresh temporary clone and writes $CREWLY_HOME/local-gates/<owner>__<repo>/pr-<N>-<sha>.json.
Exits non-zero when the gate fails (the record is still written, with the failing exit code).
EOF_USAGE
}

fail() { printf '{"error":%s}\n' "$(jq -Rn --arg e "$1" '$e')" >&2; exit "${2:-1}"; }

REPO=""; PR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --pr) PR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1 (this skill takes only --repo and --pr; a record cannot be hand-made)" 2 ;;
  esac
done
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--repo owner/name is required" 2
[[ "$PR" =~ ^[0-9]+$ ]] || fail "--pr <number> is required" 2
command -v jq >/dev/null || fail "jq is required"

ENTRY="$(jq -c --arg r "$REPO" '.[$r] // empty' "$GATES" 2>/dev/null)"
[ -n "$ENTRY" ] || fail "no local-gates entry for $REPO in $GATES; this repo has no local-gate path (its CI is the only way)"
N_CMDS="$(printf '%s' "$ENTRY" | jq '.gate | length')"
[ "${N_CMDS:-0}" -gt 0 ] || fail "the local-gates entry for $REPO has no gate commands"

VIEW="$("$GH" pr view "$PR" -R "$REPO" --json headRefOid,baseRefName 2>&1)" || fail "could not read PR #$PR with gh: $VIEW"
SHA="$(printf '%s' "$VIEW" | jq -r .headRefOid)"
BASE_REF="$(printf '%s' "$VIEW" | jq -r .baseRefName)"
[[ "$SHA" =~ ^[0-9a-f]{7,64}$ ]] || fail "gh returned no head commit for PR #$PR"
BASE_SHA="$("$GH" api "repos/$REPO/commits/$BASE_REF" --jq .sha 2>&1)" || fail "could not read the head of $BASE_REF: $BASE_SHA"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/local-gate.XXXXXX")" || fail "could not make a temp dir"
trap 'rm -rf "$WORK"' EXIT
CLONE="$WORK/clone"; LOG="$WORK/gate.log"; : > "$LOG"
URL="${CREWLY_LOCAL_GATE_CLONE_URL:-https://github.com/$REPO.git}"

git init -q "$CLONE" || fail "git init failed"
(
  cd "$CLONE" || exit 1
  git remote add origin "$URL"
  git -c credential.helper= -c "credential.helper=!$GH auth git-credential" fetch -q --depth 1 origin "pull/$PR/head" \
    && [ "$(git rev-parse FETCH_HEAD)" = "$SHA" ] \
    && git checkout -q --detach FETCH_HEAD
) >"$WORK/fetch.log" 2>&1 || fail "could not check out PR #$PR at $SHA in a fresh clone (the PR may have moved): $(tail -3 "$WORK/fetch.log" | tr '\n' ' ')"

echo "record-local-gate: $REPO PR #$PR at $SHA (base $BASE_REF $BASE_SHA), $N_CMDS gate command(s), fresh clone $CLONE"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXIT_CODE=0; RAN=""
while IFS= read -r CMD; do
  [ -n "$CMD" ] || continue
  RAN="${RAN:+$RAN && }$CMD"
  echo "record-local-gate: running: $CMD"
  # A scrubbed environment: no tokens or session secrets reach the repo's scripts.
  (cd "$CLONE" && env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" CI=true bash -c "set -o pipefail; $CMD") 2>&1 | tee -a "$LOG"
  RC="${PIPESTATUS[0]}"
  if [ "$RC" -ne 0 ]; then EXIT_CODE="$RC"; echo "record-local-gate: FAILED (exit $RC): $CMD"; break; fi
done < <(printf '%s' "$ENTRY" | jq -r '.gate[]')
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

DIR="$RECORDS_ROOT/${REPO/\//__}"
mkdir -p "$DIR" || fail "could not create $DIR"
OUT="$DIR/pr-$PR-$SHA.json"
tail -n "$LOG_TAIL_LINES" "$LOG" | jq -Rs --arg sha "$SHA" --arg baseRef "$BASE_REF" --arg baseSha "$BASE_SHA" --arg command "$RAN" \
  --argjson exitCode "$EXIT_CODE" --arg startedAt "$STARTED" --arg finishedAt "$FINISHED" --arg by "${CREWLY_SESSION_NAME:-unknown}" \
  '{sha:$sha, baseRef:$baseRef, baseSha:$baseSha, command:$command, exitCode:$exitCode, startedAt:$startedAt, finishedAt:$finishedAt, logTail:(split("\n")|map(select(length>0))), recordedBy:$by}' \
  > "$OUT.tmp" && mv "$OUT.tmp" "$OUT" || fail "could not write the record $OUT"

echo "record-local-gate: ran $RAN"
echo "record-local-gate: exit code $EXIT_CODE; record: $OUT"
exit "$EXIT_CODE"
