#!/bin/bash
# Tests for ingest-exports — run with: bash execute.test.sh
# Offline: fixture CSVs only. Needs node (and jq for the JSON-input case).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
FX="$HERE/fixtures"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# 1. Every fixture is recognised as the right tool and kind
OUT="$(bash "$EXEC" --in "$FX" --out "$T/all")"; RC=$?
check "folder ingest exits 0" "$RC" "0"
check "7 files loaded" "$(printf '%s' "$OUT" | jq -r '.totals.files')" "7"
for spec in "square-transactions.csv square payment 4" "square-customers.csv square contact 3" "quickbooks-invoices.csv quickbooks invoice 3" \
            "mailchimp-audience.csv mailchimp contact 2" "jotform-submissions.csv jotform booking 3" "jackrabbit-enrollments.csv jackrabbit booking 3" \
            "unknown-report.csv unknown other 3"; do
  set -- $spec
  check "$1 source" "$(printf '%s' "$OUT" | jq -r --arg f "$1" '.files[] | select(.file==$f) | .source')" "$2"
  check "$1 kind" "$(printf '%s' "$OUT" | jq -r --arg f "$1" '.files[] | select(.file==$f) | .kind')" "$3"
  check "$1 rows" "$(printf '%s' "$OUT" | jq -r --arg f "$1" '.files[] | select(.file==$f) | .rows')" "$4"
  check "$1 output file exists" "$([ -f "$T/all/${1%.csv}.json" ] && echo yes || echo no)" "yes"
done
check "summary.json written" "$([ -f "$T/all/summary.json" ] && echo yes || echo no)" "yes"
check "totals.rows" "$(printf '%s' "$OUT" | jq -r '.totals.rows')" "21"

# 2. Date ranges and value normalisation
check "square date range" "$(printf '%s' "$OUT" | jq -c '.files[] | select(.file=="square-transactions.csv") | .dateRange')" '{"from":"2026-09-02","to":"2026-09-20"}'
check "quickbooks US dates → ISO" "$(jq -r '.records[0].at' "$T/all/quickbooks-invoices.json")" "2026-09-01"
check "quickbooks amount with thousands" "$(jq -r '.records[0].amount' "$T/all/quickbooks-invoices.json")" "1250"
check "quickbooks paid status from open balance" "$(jq -r '.records[1].status' "$T/all/quickbooks-invoices.json")" "paid"
check "quickbooks due date" "$(jq -r '.records[2].dueAt' "$T/all/quickbooks-invoices.json")" "2026-10-15"
check "square time joined to date" "$(jq -r '.records[0].at' "$T/all/square-transactions.json")" "2026-09-02T10:14:03"
check "square total collected" "$(jq -r '.records[1].amount' "$T/all/square-transactions.json")" "117.45"
check "square refunded status" "$(jq -r '.records[2].status' "$T/all/square-transactions.json")" "refunded"
check "square customer name joined" "$(jq -r '.records[0].name' "$T/all/square-customers.json")" "Maria Lopez"
check "mailchimp tags split" "$(jq -c '.records[0].tags' "$T/all/mailchimp-audience.json")" '["parent","pottery"]'
check "jotform parent name" "$(jq -r '.records[0].name' "$T/all/jotform-submissions.json")" "Alex Rivera"
check "jotform class as item" "$(jq -r '.records[0].item' "$T/all/jotform-submissions.json")" "Kids Pottery"
check "jackrabbit dropped status" "$(jq -r '.records[2].status' "$T/all/jackrabbit-enrollments.json")" "dropped"
check "jackrabbit enrolled status" "$(jq -r '.records[0].status' "$T/all/jackrabbit-enrollments.json")" "enrolled"
check "jackrabbit end date" "$(jq -r '.records[2].endAt' "$T/all/jackrabbit-enrollments.json")" "2026-09-22"

# 3. Unknown CSV: original columns kept, note says could not map, quoted field intact
check "unknown note" "$(printf '%s' "$OUT" | jq -r '.files[] | select(.file=="unknown-report.csv") | .notes[0]' | cut -c1-13)" "could not map"
check "unknown keeps original columns" "$(jq -c '.records[0].original' "$T/all/unknown-report.json")" '{"Widget":"Spinner","Colour":"Blue","Units":"12","Notes":"Back-ordered, \"rush\""}'
check "unknown has no mapped name" "$(jq -r '.records[0] | has("name")' "$T/all/unknown-report.json")" "false"
check "unknown unmapped columns = all" "$(printf '%s' "$OUT" | jq -c '.files[] | select(.file=="unknown-report.csv") | .unmappedColumns')" '["Widget","Colour","Units","Notes"]'

# 4. --hash-names: no plain name/email/phone anywhere in the output
HOUT="$(bash "$EXEC" --in "$FX/jotform-submissions.csv" --in "$FX/jackrabbit-enrollments.csv" --out "$T/hashed" --hash-names)"
check "hashed flag in summary" "$(printf '%s' "$HOUT" | jq -r '.namesHashed')" "true"
check "no plain names in hashed jotform" "$(grep -c -E "Rivera|Natarajan|Baker|example\.test|555 010" "$T/hashed/jotform-submissions.json")" "0"
check "no plain names in hashed jackrabbit" "$(grep -c -E "Lopez|Rivera|Natarajan|example\.test" "$T/hashed/jackrabbit-enrollments.json")" "0"
check "hashed name has h: prefix" "$(jq -r '.records[0].name' "$T/hashed/jotform-submissions.json" | cut -c1-2)" "h:"
check "same person hashes the same across files" "$(jq -r '.records[0].email' "$T/hashed/jotform-submissions.json")" "$(jq -r '.records[1].email' "$T/hashed/jackrabbit-enrollments.json")"
check "child age kept (not personal)" "$(jq -r '.records[0].original["Child'"'"'s Age"]' "$T/hashed/jotform-submissions.json")" "7"
check "child name hashed" "$(jq -r '.records[0].original["Child'"'"'s Name"]' "$T/hashed/jotform-submissions.json" | cut -c1-2)" "h:"
check "rows unchanged by hashing" "$(printf '%s' "$HOUT" | jq -r '.totals.rows')" "6"

# 5. --detect-only writes nothing; JSON input form; missing file → exit 2
DOUT="$(bash "$EXEC" --in "$FX/square-customers.csv" --detect-only)"
check "detect-only source" "$(printf '%s' "$DOUT" | jq -r '.files[0].source')" "square"
check "detect-only has no out" "$(printf '%s' "$DOUT" | jq -r '.out')" "null"
JOUT="$(bash "$EXEC" "{\"in\":[\"$FX/mailchimp-audience.csv\"],\"out\":\"$T/json\",\"hashNames\":true}")"
check "json input works" "$(printf '%s' "$JOUT" | jq -r '.files[0].kind + " " + (.namesHashed|tostring)')" "contact true"
MOUT="$(bash "$EXEC" --in "$T/nope.csv" --in "$FX/unknown-report.csv" --out "$T/miss")"; RC=$?
check "missing file exits 2" "$RC" "2"
check "missing file reported, other loaded" "$(printf '%s' "$MOUT" | jq -r '(.files[0].error) + "/" + (.totals.files|tostring)')" "not found/1"
UOUT="$(bash "$EXEC" --out "$T/u" 2>/dev/null)"; RC=$?
check "no --in is a usage error" "$RC" "1"

# 6. --source forces a known mapping only when the headers fit
SOUT="$(bash "$EXEC" --in "$FX/unknown-report.csv" --out "$T/forced" --source square)"
check "--source cannot force square onto unrelated headers" "$(printf '%s' "$SOUT" | jq -r '.files[0].source')" "unknown"

echo "ingest-exports: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
