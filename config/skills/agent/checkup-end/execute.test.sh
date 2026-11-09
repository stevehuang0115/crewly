#!/bin/bash
# Tests for checkup-end — run with: bash execute.test.sh
# Offline: builds a check-up folder with ingest-exports + checkup-analyse + checkup-report first. Needs node and jq.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
INGEST="$HERE/../ingest-exports/execute.sh"
ANALYSE="$HERE/../checkup-analyse/execute.sh"
REPORT="$HERE/../checkup-report/execute.sh"
FX="$HERE/../ingest-exports/fixtures"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# A check-up laid out the way the team template works: project P with ingest/, analysis/, checkup-data/, checkup-app/, intake.json
build_checkup() {
  local P="$1"; local hash="${2:-}"
  mkdir -p "$P"
  if [ -n "$hash" ]; then bash "$INGEST" --in "$FX" --out "$P/ingest" --hash-names >/dev/null; else bash "$INGEST" --in "$FX" --out "$P/ingest" >/dev/null; fi
  bash "$ANALYSE" --in "$P/ingest" --as-of 2026-10-26 --out "$P/analysis" >/dev/null
  cat > "$P/intake.json" <<'EOF'
{"apps":["Square","Jotform","Jackrabbit"],"slowestTask":"copying sign-ups","fears":[],"appsPerCustomer":"3","firstNumber":"Money owed to me","savedAt":"2026-10-26T10:00:00.000Z"}
EOF
  bash "$REPORT" --log-step intake --start --out "$P/checkup-data" >/dev/null
  bash "$REPORT" --log-step intake --end --out "$P/checkup-data" >/dev/null
  bash "$REPORT" --breaks "$P/analysis/breaks.json" --business "Oak Pottery" --intake "$P/intake.json" --out "$P/checkup-data" >/dev/null
  bash "$REPORT" --daily "Replied to 3 inquiries." --date 2026-10-27 --out "$P/checkup-data" >/dev/null
  bash "$REPORT" --app-dir "$P/checkup-app" >/dev/null
}

# 1. Dry run: lists everything, deletes nothing, receipt marked dryRun
build_checkup "$T/p1"
BEFORE=$(find "$T/p1" -type f | wc -l | tr -d ' ')
OUT="$(bash "$EXEC" --dir "$T/p1" --business "Oak Pottery" --app 28au74d9cj --dry-run)"; RC=$?
check "dry run exits 0" "$RC" "0"
check "dry run success" "$(printf '%s' "$OUT" | jq -r '.success')" "true"
check "dry run flagged" "$(printf '%s' "$OUT" | jq -r '.dryRun')" "true"
check "dry run counts the files" "$(printf '%s' "$OUT" | jq -r '.deleted >= 12')" "true"
AFTER=$(find "$T/p1" -type f -not -name 'checkup-end-receipt.*' | wc -l | tr -d ' ')
check "dry run deleted nothing" "$AFTER" "$BEFORE"
check "dry run still has breaks.json" "$([ -f "$T/p1/analysis/breaks.json" ] && echo yes || echo no)" "yes"
R="$T/p1/checkup-end-receipt.json"
check "receipt json written" "$([ -f "$R" ] && echo yes || echo no)" "yes"
check "receipt md written" "$([ -f "$T/p1/checkup-end-receipt.md" ] && echo yes || echo no)" "yes"
check "receipt dryRun" "$(jq -r '.dryRun' "$R")" "true"
check "receipt business" "$(jq -r '.business' "$R")" "Oak Pottery"
check "receipt next = unpublish with the app id" "$(printf '%s' "$OUT" | jq -r '.next[0]')" "publish-app --app 28au74d9cj --delete"
check "receipt lists the apps to revoke" "$(jq -c '.todo[1].apps' "$R")" '["Square","Jotform","Jackrabbit"]'
check "receipt says names were not hashed" "$(jq -r '.namesHashed' "$R")" "false"
check "md mentions dry run" "$(grep -c 'dry run' "$T/p1/checkup-end-receipt.md")" "1"

# 2. Real run: known files gone, empty folders removed, leftovers kept and listed
build_checkup "$T/p2" hash
echo "owner note" > "$T/p2/analysis/notes.txt"          # not written by a check-up skill → leftover
mkdir -p "$T/p2/ingest/raw"                              # a sub-folder → leftover
ln -s "$T/p2/intake.json" "$T/p2/checkup-data/link.json" # a symlink → never followed
OUT="$(bash "$EXEC" --dir "$T/p2" --business "Oak Pottery")"; RC=$?
check "end exits 0" "$RC" "0"
check "end success" "$(printf '%s' "$OUT" | jq -r '.success')" "true"
check "end not a dry run" "$(printf '%s' "$OUT" | jq -r '.dryRun')" "false"
check "breaks.json gone" "$([ -e "$T/p2/analysis/breaks.json" ] && echo still || echo gone)" "gone"
check "ingested rows gone" "$(ls "$T/p2/ingest" 2>/dev/null | grep -c '\.json$')" "0"
check "report-doc gone" "$([ -e "$T/p2/checkup-data/report-doc.json" ] && echo still || echo gone)" "gone"
check "daily gone" "$([ -e "$T/p2/checkup-data/daily-2026-10-27.json" ] && echo still || echo gone)" "gone"
check "timelog gone" "$([ -e "$T/p2/checkup-data/timelog.json" ] && echo still || echo gone)" "gone"
check "intake gone" "$([ -e "$T/p2/intake.json" ] && echo still || echo gone)" "gone"
check "app page copy gone" "$([ -e "$T/p2/checkup-app/index.html" ] && echo still || echo gone)" "gone"
check "empty checkup-app folder removed" "$([ -d "$T/p2/checkup-app" ] && echo still || echo gone)" "gone"
check "leftover note kept" "$([ -f "$T/p2/analysis/notes.txt" ] && echo yes || echo no)" "yes"
check "leftover folder kept" "$([ -d "$T/p2/ingest/raw" ] && echo yes || echo no)" "yes"
check "symlink kept (not followed)" "$([ -L "$T/p2/checkup-data/link.json" ] && echo yes || echo no)" "yes"
check "non-empty folders kept" "$([ -d "$T/p2/analysis" ] && [ -d "$T/p2/ingest" ] && echo yes || echo no)" "yes"
R="$T/p2/checkup-end-receipt.json"
check "receipt leftovers = 3" "$(jq -r '.leftovers | length' "$R")" "3"
check "receipt leftover note reason" "$(jq -r '.leftovers[] | select(.path=="analysis/notes.txt") | .note' "$R")" "not written by a check-up skill"
check "receipt symlink reason" "$(jq -r '.leftovers[] | select(.path=="checkup-data/link.json") | .note' "$R")" "symbolic link, not followed"
check "receipt names hashed" "$(jq -r '.namesHashed' "$R")" "true"
check "receipt people files counted" "$(printf '%s' "$OUT" | jq -r '.peopleFiles >= 8')" "true"
check "receipt bytes > 0" "$(jq -r '.bytes > 0' "$R")" "true"
check "receipt removed folders lists checkup-app" "$(jq -r '.removedFolders | index("checkup-app") != null' "$R")" "true"
check "receipt next without --app shows placeholder" "$(printf '%s' "$OUT" | jq -r '.next[0]')" "publish-app --app <appId> --delete"
check "md lists deleted kinds" "$(grep -c 'held people data' "$T/p2/checkup-end-receipt.md" | awk '{print ($1>=5)?"yes":"no"}')" "yes"
check "md hashed note" "$(grep -c 'were hashed' "$T/p2/checkup-end-receipt.md")" "1"

# 3. Raw exports folder: only *.csv in it, not recursive
build_checkup "$T/p3"
mkdir -p "$T/exports/sub"
cp "$FX"/*.csv "$T/exports/"
echo "x" > "$T/exports/readme.txt"
cp "$FX/square-transactions.csv" "$T/exports/sub/"
N_CSV=$(ls "$T/exports"/*.csv | wc -l | tr -d ' ')
OUT="$(bash "$EXEC" --dir "$T/p3" --exports "$T/exports")"; RC=$?
check "exports exits 0" "$RC" "0"
check "csv exports gone" "$(ls "$T/exports" | grep -c '\.csv$')" "0"
check "readme kept" "$([ -f "$T/exports/readme.txt" ] && echo yes || echo no)" "yes"
check "sub-folder csv kept" "$([ -f "$T/exports/sub/square-transactions.csv" ] && echo yes || echo no)" "yes"
check "receipt counts the csvs" "$(jq -r --argjson n "$N_CSV" '[.deleted[] | select(.kind | startswith("raw export"))] | length == $n' "$T/p3/checkup-end-receipt.json")" "true"

# 4. Refuses a folder that is not a check-up, deletes nothing
mkdir -p "$T/notme/analysis"; echo "keep" > "$T/notme/analysis/report.md"; echo "keep" > "$T/notme/other.txt"
OUT="$(bash "$EXEC" --dir "$T/notme")"; RC=$?
check "not a check-up exits 2" "$RC" "2"
check "not a check-up error" "$(printf '%s' "$OUT" | jq -r '.error' | grep -c 'does not look like a check-up')" "1"
check "not a check-up kept report.md" "$([ -f "$T/notme/analysis/report.md" ] && echo yes || echo no)" "yes"
check "not a check-up wrote no receipt" "$([ -e "$T/notme/checkup-end-receipt.json" ] && echo yes || echo no)" "no"

# 5. Missing folder, usage, JSON input, explicit slot flags and --receipt
OUT="$(bash "$EXEC" --dir "$T/nope")"; RC=$?
check "missing dir exits 2" "$RC" "2"
OUT="$(bash "$EXEC")"; RC=$?
check "no args exits 1" "$RC" "1"
OUT="$(bash "$EXEC" --dir "$T/p3" --bogus)"; RC=$?
check "unknown flag exits 1" "$RC" "1"
build_checkup "$T/p5"
mv "$T/p5/checkup-data" "$T/p5/elsewhere"
OUT="$(bash "$EXEC" "{\"dir\":\"$T/p5\",\"data\":\"$T/p5/elsewhere\",\"business\":\"Oak Pottery\",\"app\":\"abc123\",\"receipt\":\"$T/p5-receipt\",\"dryRun\":true}")"; RC=$?
check "json exits 0" "$RC" "0"
check "json dry run" "$(printf '%s' "$OUT" | jq -r '.dryRun')" "true"
check "json app in next" "$(printf '%s' "$OUT" | jq -r '.next[0]')" "publish-app --app abc123 --delete"
check "json --data slot found the moved folder" "$(jq -r '[.deleted[] | select(.path=="elsewhere/report-doc.json")] | length' "$T/p5-receipt/checkup-end-receipt.json")" "1"
check "json receipt in --receipt dir" "$([ -f "$T/p5-receipt/checkup-end-receipt.md" ] && echo yes || echo no)" "yes"
check "json receipt not in project" "$([ -e "$T/p5/checkup-end-receipt.json" ] && echo yes || echo no)" "no"

# 6. Ending twice: the second run finds nothing and says so
build_checkup "$T/p6"
bash "$EXEC" --dir "$T/p6" >/dev/null
OUT="$(bash "$EXEC" --dir "$T/p6")"; RC=$?
check "second end refuses (nothing left to mark a check-up)" "$RC" "2"

echo "checkup-end: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
