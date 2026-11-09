#!/bin/bash
# Tests for record-local-gate. Offline: `gh` is a stub, the "remote" is a local repo with
# refs/pull/7/head, and the gate commands are `true` / `false`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✓ $1"
  else FAIL=$((FAIL + 1)); echo "  ✗ $1"; echo "    expected: $2"; echo "    actual:   $3"; fi
}

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
REMOTE="$T/remote"
git init -q -b main "$REMOTE"
git -C "$REMOTE" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
git -C "$REMOTE" -c user.name=t -c user.email=t@t commit -q --allow-empty -m pr
SHA="$(git -C "$REMOTE" rev-parse HEAD)"
git -C "$REMOTE" update-ref refs/pull/7/head "$SHA"

# gh stub: pr view -> head sha + base; api commits/main --jq .sha -> base sha
cat > "$T/gh" <<EOF
#!/bin/bash
if [ "\$1" = pr ] && [ "\$2" = view ]; then echo '{"headRefOid":"'"\${PR_SHA:-$SHA}"'","baseRefName":"main"}'; exit 0; fi
if [ "\$1" = api ]; then echo basesha0001; exit 0; fi
exit 3
EOF
chmod +x "$T/gh"

gates() { printf '{"o/r":{"gate":%s,"contentPaths":["content/**/*.md"]}}' "$1" > "$T/gates.json"; }
export CREWLY_GUARD_GH="$T/gh" CREWLY_GUARD_LOCAL_GATES="$T/gates.json" CREWLY_HOME="$T/home" \
  CREWLY_LOCAL_GATE_CLONE_URL="$REMOTE" CREWLY_SESSION_NAME=tester TMPDIR="$T"
REC="$T/home/local-gates/o__r/pr-7-$SHA.json"
run() { bash "$SCRIPT_DIR/execute.sh" "$@" >"$T/out" 2>"$T/err"; echo $?; }

echo "record-local-gate"
gates '["true","echo second"]'
check "passing gate exits 0" 0 "$(run --repo o/r --pr 7)"
check "record exists for the head sha" yes "$([ -f "$REC" ] && echo yes || echo no)"
check "record sha is the PR head" "$SHA" "$(jq -r .sha "$REC")"
check "record exitCode 0" 0 "$(jq .exitCode "$REC")"
check "record keeps the base sha at run time" basesha0001 "$(jq -r .baseSha "$REC")"
check "record names who recorded it" tester "$(jq -r .recordedBy "$REC")"
check "record lists the commands run" "true && echo second" "$(jq -r .command "$REC")"
check "output says what ran and the exit code" 1 "$(grep -c 'exit code 0; record:' "$T/out")"

rm -f "$REC"
gates '["true","false","echo never"]'
check "failing gate exits non-zero" 1 "$(run --repo o/r --pr 7)"
check "failing gate still writes a record" yes "$([ -f "$REC" ] && echo yes || echo no)"
check "failing record has exitCode != 0" 1 "$(jq .exitCode "$REC")"
check "gate stops at the first failure" 0 "$(grep -c '^never' "$T/out")"

rm -f "$REC"
gates '["true"]'
check "--exit-code is refused" 2 "$(run --repo o/r --pr 7 --exit-code 0)"
check "no record after a refused flag" no "$([ -f "$REC" ] && echo yes || echo no)"
check "a repo with no entry is refused" 1 "$(run --repo x/y --pr 7)"
check "a missing --pr is refused" 2 "$(run --repo o/r)"

check "a PR that moved since gh looked is refused" 1 "$(PR_SHA=deadbeefdeadbeef run --repo o/r --pr 7)"
check "no record for the moved head" 0 "$(find "$T/home" -name 'pr-7-deadbeef*' 2>/dev/null | wc -l | tr -d ' ')"

echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
