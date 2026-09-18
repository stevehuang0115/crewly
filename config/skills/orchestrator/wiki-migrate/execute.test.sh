#!/bin/bash
# Tests for ORC wiki-migrate execute.sh
#
# The backend's scan payload carries the full `proposedPages` array (hundreds
# of rows on a real project). The skill must return a COMPACT report by
# default and only hand back the raw payload with --full / {"full":true}.
#
# Like delegate-task/execute.test.sh, this harness runs a COPY of the real
# execute.sh (plus compact.jq) under a stubbed api_call so production logic
# is exercised verbatim.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

CALL_LOG=$(mktemp)
SKILL_PARENT=$(mktemp -d)
trap 'rm -rf "$SKILL_PARENT" "$CALL_LOG"' EXIT

# The skill resolves `${SCRIPT_DIR}/../../_common/lib.sh`, so mirror the
# config/skills/<role>/<skill> depth.
mkdir -p "$SKILL_PARENT/_common" "$SKILL_PARENT/orchestrator/wiki-migrate"

# Fixture: 25 proposed pages across 4 sourceTypes; 8 already migrated, 1
# skipped for another reason, 16 net-new, 2 routingUncertain.
FIXTURE=$(jq -nc '
  def page($i; $type; $skip; $unc):
    {sourceType: $type, sourceFile: "src/\($i).json", sourceId: "id-\($i)",
     contentHash: "h\($i)", targetVaultPath: "/vault",
     targetRelativePath: "llm-curated/\($type)/\($i).md", title: "t\($i)",
     routingUncertain: $unc}
    + (if $skip == "" then {} else {skipReason: $skip} end);
  {
    ok: true, vaultPath: "/vault", legacyDetected: true,
    bootstrapNeeded: {project: true, global: false, teams: []},
    summary: {decisions: 10, patterns: 8, gotchas: 4, relationships: 3,
              learnings: 0, looseMd: 0, memoryEntries: 0, alreadyMigrated: 8},
    proposedPages: (
      [range(0;10) | page(.; "decision"; (if . < 4 then "already migrated" else "" end); false)]
      + [range(10;18) | page(.; "pattern"; (if . < 14 then "already migrated" else "" end); (. == 15))]
      + [range(18;22) | page(.; "gotcha"; (if . == 18 then "malformed" else "" end); (. == 19))]
      + [range(22;25) | page(.; "relationship"; ""; false)]
    )
  }')
export FIXTURE

REAL_LIB="$(cd "$SCRIPT_DIR/../.." && pwd)/_common/lib.sh"
cat > "$SKILL_PARENT/_common/lib.sh" <<EOF
source "$REAL_LIB"
api_call() {
  local method="\$1" path="\$2" body="\${3:-}"
  echo "\${method} \${path} \${body}" >> "${CALL_LOG}"
  printf '%s' "\$FIXTURE"
}
EOF
cp "$SCRIPT_DIR/execute.sh" "$SCRIPT_DIR/compact.jq" "$SKILL_PARENT/orchestrator/wiki-migrate/"
chmod +x "$SKILL_PARENT/orchestrator/wiki-migrate/execute.sh"
SKILL="$SKILL_PARENT/orchestrator/wiki-migrate/execute.sh"

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"; echo "    expected: $expected"; echo "    actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}

echo "=== wiki-migrate compact output ==="

# ---- Test 1: default scan is compact and drops proposedPages ----
OUT=$(bash "$SKILL" --project-root /tmp/proj)
assert_eq "scan hits the scan endpoint" "1" "$(grep -c 'POST /wiki/migrate/scan' "$CALL_LOG")"
assert_eq "compact: proposedPages dropped" "false" "$(printf '%s' "$OUT" | jq 'has("proposedPages")')"
assert_eq "compact: totalProposed" "25" "$(printf '%s' "$OUT" | jq '.totalProposed')"
assert_eq "compact: alreadyMigrated" "8" "$(printf '%s' "$OUT" | jq '.alreadyMigrated')"
assert_eq "compact: skippedOther" "1" "$(printf '%s' "$OUT" | jq '.skippedOther')"
assert_eq "compact: netNew" "16" "$(printf '%s' "$OUT" | jq '.netNew')"
assert_eq "compact: routingUncertain" "2" "$(printf '%s' "$OUT" | jq '.routingUncertain')"
assert_eq "compact: byCategory decision" '{"proposed":10,"netNew":6}' "$(printf '%s' "$OUT" | jq -c '.byCategory.decision')"
assert_eq "compact: byCategory gotcha" '{"proposed":4,"netNew":3}' "$(printf '%s' "$OUT" | jq -c '.byCategory.gotcha')"
assert_eq "compact: sample holds first 10 net-new relPaths" "10" "$(printf '%s' "$OUT" | jq '.netNewSample | length')"
assert_eq "compact: sample starts at first net-new page" "llm-curated/decision/4.md" "$(printf '%s' "$OUT" | jq -r '.netNewSample[0]')"
assert_eq "compact: sample excludes skipped pages" "0" "$(printf '%s' "$OUT" | jq '[.netNewSample[] | select(. == "llm-curated/gotcha/18.md")] | length')"
assert_eq "compact: passthrough keys kept" "true|/vault|true" "$(printf '%s' "$OUT" | jq -r '"\(.ok)|\(.vaultPath)|\(.bootstrapNeeded.project)"')"
assert_eq "compact: original summary kept" "8" "$(printf '%s' "$OUT" | jq '.summary.alreadyMigrated')"
assert_eq "compact: hint mentions --full" "true" "$(printf '%s' "$OUT" | jq '.hint | test("--full")')"
COMPACT_BYTES=$(printf '%s' "$OUT" | wc -c | tr -d ' ')
RAW_BYTES=$(printf '%s' "$FIXTURE" | wc -c | tr -d ' ')
assert_eq "compact: smaller than raw" "yes" "$([ "$COMPACT_BYTES" -lt "$RAW_BYTES" ] && echo yes || echo no)"

# ---- Test 2: WIKI_MIGRATE_SAMPLE_SIZE tunes the sample ----
OUT=$(WIKI_MIGRATE_SAMPLE_SIZE=3 bash "$SKILL" --project-root /tmp/proj)
assert_eq "sample size env respected" "3" "$(printf '%s' "$OUT" | jq '.netNewSample | length')"

# ---- Test 3: --full returns the raw payload ----
OUT=$(bash "$SKILL" --project-root /tmp/proj --full)
assert_eq "--full: proposedPages present" "25" "$(printf '%s' "$OUT" | jq '.proposedPages | length')"
assert_eq "--full: no compact keys" "false" "$(printf '%s' "$OUT" | jq 'has("netNew")')"

# ---- Test 4: {"full":true} JSON input also returns the raw payload ----
OUT=$(bash "$SKILL" '{"projectRoot":"/tmp/proj","full":true}')
assert_eq "json full:true: proposedPages present" "25" "$(printf '%s' "$OUT" | jq '.proposedPages | length')"

# ---- Test 5: apply path is compacted too and keeps apply-only keys ----
FIXTURE=$(printf '%s' "$FIXTURE" | jq -c '. + {applied: 16, skipped: 9, bootstrapped: ["/vault"], manifestPath: "/vault/.migration-state.json"}')
export FIXTURE
: > "$CALL_LOG"
OUT=$(bash "$SKILL" --project-root /tmp/proj --apply)
assert_eq "apply hits the apply endpoint" "1" "$(grep -c 'POST /wiki/migrate/apply' "$CALL_LOG")"
assert_eq "apply body carries confirm:true" "1" "$(grep -c '"confirm": *true' "$CALL_LOG")"
assert_eq "apply: applied/skipped kept" "16|9|/vault/.migration-state.json" "$(printf '%s' "$OUT" | jq -r '"\(.applied)|\(.skipped)|\(.manifestPath)"')"
assert_eq "apply: proposedPages dropped" "false" "$(printf '%s' "$OUT" | jq 'has("proposedPages")')"

# ---- Test 6: payload without proposedPages does not break the filter ----
FIXTURE='{"ok":true,"legacyDetected":false,"bootstrapNeeded":{"project":false,"global":false,"teams":[]}}'
export FIXTURE
OUT=$(bash "$SKILL" --project-root /tmp/proj)
assert_eq "empty scan: netNew 0" "0" "$(printf '%s' "$OUT" | jq '.netNew')"
assert_eq "empty scan: byCategory {}" "{}" "$(printf '%s' "$OUT" | jq -c '.byCategory')"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
