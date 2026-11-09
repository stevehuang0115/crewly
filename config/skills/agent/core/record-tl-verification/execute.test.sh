#!/bin/bash
# Tests for record-tl-verification. Offline: `gh` is a stub, team configs and records are temp files.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✓ $1"
  else FAIL=$((FAIL + 1)); echo "  ✗ $1"; echo "    expected: $2"; echo "    actual:   $3"; fi
}

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SHA=0123456789abcdef0123456789abcdef01234567
cat > "$T/gh" <<EOF
#!/bin/bash
echo "\${PR_SHA:-$SHA}"
EOF
chmod +x "$T/gh"
mkdir -p "$T/teams/t1" "$T/home/local-gates/o__r"
printf '{"members":[{"sessionName":"tl1","role":"team-leader"},{"sessionName":"tl2","role":"team-leader"},{"sessionName":"dev1","role":"developer"}]}' > "$T/teams/t1/config.json"
printf '{"o/r":{"gate":["true"],"contentPaths":["c/**"],"codePrs":true},"o/nocode":{"gate":["true"],"contentPaths":["c/**"]}}' > "$T/gates.json"
REC="$T/home/local-gates/o__r/pr-9-$SHA.json"
MARK="$T/home/local-gates/o__r/pr-9-$SHA.tl.json"
rec() { printf '{"sha":"%s","exitCode":%s,"recordedBy":"dev1"}' "${2:-$SHA}" "${1:-0}" > "$REC"; }
export CREWLY_GUARD_GH="$T/gh" CREWLY_GUARD_LOCAL_GATES="$T/gates.json" CREWLY_HOME="$T/home" CREWLY_TEAMS_DIR="$T/teams"
run() { local who="$1"; shift; CREWLY_SESSION_NAME="$who" bash "$SCRIPT_DIR/execute.sh" "$@" >"$T/out" 2>"$T/err"; echo $?; }
has() { [ -f "$MARK" ] && echo yes || echo no; }

echo "record-tl-verification"
rec 0
check "a team leader other than the gate runner verifies" 0 "$(run tl1 --repo o/r --pr 9 --summary 'read the diff')"
check "marker written" yes "$(has)"
check "marker sha is the head" "$SHA" "$(jq -r .sha "$MARK")"
check "marker names the verifier" tl1 "$(jq -r .verifier "$MARK")"
check "marker names the gate runner" dev1 "$(jq -r .gateRecordedBy "$MARK")"
check "marker keeps the summary" "read the diff" "$(jq -r .summary "$MARK")"

rm -f "$MARK"
check "a developer is refused" 1 "$(run dev1 --repo o/r --pr 9 --summary x)"
check "an unknown session is refused" 1 "$(run nobody --repo o/r --pr 9 --summary x)"
check "no marker after refusals" no "$(has)"
rec 0; printf '{"sha":"%s","exitCode":0,"recordedBy":"tl1"}' "$SHA" > "$REC"
check "the session that ran the gate is refused" 1 "$(run tl1 --repo o/r --pr 9 --summary x)"
check "another leader may still verify that gate" 0 "$(run tl2 --repo o/r --pr 9 --summary x)"
rm -f "$MARK"
rec 1
check "a failed gate record is refused" 1 "$(run tl1 --repo o/r --pr 9 --summary x)"
rm -f "$REC"
check "no gate record is refused" 1 "$(run tl1 --repo o/r --pr 9 --summary x)"
rec 0
check "a repo without codePrs is refused" 1 "$(run tl1 --repo o/nocode --pr 9 --summary x)"
check "a missing summary is refused" 2 "$(run tl1 --repo o/r --pr 9)"
check "a PR whose head moved has no record to verify" 1 "$(PR_SHA=feedfacefeedface run tl1 --repo o/r --pr 9 --summary x)"
check "no marker for the moved head" 0 "$(find "$T/home" -name '*feedface*' | wc -l | tr -d ' ')"

echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
