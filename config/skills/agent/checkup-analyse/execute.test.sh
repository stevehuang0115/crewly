#!/bin/bash
# Tests for checkup-analyse — run with: bash execute.test.sh
# Offline: runs ingest-exports on its fixtures first, then analyses the result. Needs node and jq.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
INGEST="$HERE/../ingest-exports/execute.sh"
FX="$HERE/../ingest-exports/fixtures"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
bash "$INGEST" --in "$FX" --out "$T/ingest" >/dev/null || { echo "ingest-exports failed; cannot test"; exit 1; }
bash "$INGEST" --in "$FX" --out "$T/ingest-hashed" --hash-names >/dev/null

# 1. Default as-of = last activity; period = activity span, not contact creation dates
OUT="$(bash "$EXEC" --in "$T/ingest" --out "$T/an")"; RC=$?
check "exit 0" "$RC" "0"
check "success" "$(printf '%s' "$OUT" | jq -r '.success')" "true"
check "as-of = last activity" "$(printf '%s' "$OUT" | jq -r '.asOf')" "2026-09-20"
check "period from first sign-up, not mailing-list opt-in" "$(printf '%s' "$OUT" | jq -r '.period.from')" "2026-08-28"
check "period days" "$(printf '%s' "$OUT" | jq -r '.period.days')" "23"
check "people linked across files" "$(printf '%s' "$OUT" | jq -r '.people')" "8"
check "systems exclude the unmapped file" "$(printf '%s' "$OUT" | jq -c '.systems')" '["jackrabbit","jotform","mailchimp","quickbooks","square"]'
check "breaks.json written" "$([ -f "$T/an/breaks.json" ] && echo yes || echo no)" "yes"
check "report.md written" "$([ -f "$T/an/report.md" ] && echo yes || echo no)" "yes"
cnt() { jq -r --arg t "$1" '.breaks[] | select(.type==$t) | .count' "$T/an/breaks.json"; }
item() { jq -r --arg t "$1" ".breaks[] | select(.type==\$t) | $2" "$T/an/breaks.json"; }

# 2. Each break finds exactly the planted case
check "inquiry with no follow-through = Tom only (Alex and Priya signed up)" "$(cnt inquiry_no_follow_through)" "1"
check "  who" "$(item inquiry_no_follow_through '.items[0].person')" "Tom Baker"
check "signed up unpaid = Sam Rivera (Sofia's family paid on 09-02)" "$(cnt signed_up_unpaid)" "1"
check "  who" "$(item signed_up_unpaid '.items[0].person')" "Sam Rivera"
check "  fee" "$(item signed_up_unpaid '.items[0].fee')" "180"
check "  outstanding" "$(item signed_up_unpaid '.estimate.outstanding')" "180"
check "paid but on no roster = Daniel (walk-in with no name is skipped)" "$(cnt paid_not_listed)" "1"
check "  who" "$(item paid_not_listed '.items[0].person')" "Daniel Chen"
check "dropped = Anika" "$(cnt dropped)" "1"
check "  dropped date from end date" "$(item dropped '.items[0].droppedAt')" "2026-09-22"
check "lapsed = none at default as-of" "$(cnt lapsed)" "0"
check "overdue invoices = none at default as-of (due 09-30 and 10-15)" "$(cnt overdue_invoices)" "0"
check "  open not yet due" "$(item overdue_invoices '.estimate.openNotYetDue')" "2"
check "double entry = 4 people in 2+ systems" "$(cnt double_entry)" "4"
check "  adult label, not the child's name" "$(item double_entry '.items[0].person')" "Maria Lopez"
check "  family in three systems" "$(item double_entry '.items[0].systems | join(",")')" "jackrabbit,mailchimp,square"
check "  child vs parent name is not a conflict" "$(item double_entry '.items[0].conflicts | length')" "0"
check "  phone missing in mailchimp noted" "$(item double_entry '.items[3].conflicts[0]')" "phone missing in mailchimp"
check "  extra entries (2+1+2+1)" "$(item double_entry '.estimate.extraEntries')" "6"
check "not on mailing list = 3 customers" "$(cnt not_on_mailing_list)" "3"
check "  Maria is on it" "$(item not_on_mailing_list '[.items[].person] | index("Maria Lopez")')" "null"
check "anonymous walk-in counted" "$(jq -r '.stats.anonymousRows.payment' "$T/an/breaks.json")" "1"
check "unmapped rows ignored, not dropped silently" "$(jq -r '.stats.ignoredOtherRows' "$T/an/breaks.json")" "3"
check "refunds counted" "$(jq -c '.stats.refunds' "$T/an/breaks.json")" '{"count":1,"amount":49}'

# 3. Estimates carry a formula and are marked estimates; avg customer value comes from the data
check "avg customer value from data" "$(jq -r '.assumptions.avgCustomerValue' "$T/an/breaks.json")" "113"
check "avg source named" "$(jq -r '.stats.avgCustomerValueFrom' "$T/an/breaks.json" | cut -c1-7)" "mean of"
check "every estimate marked" "$(jq -r '[.breaks[].estimate.isEstimate] | all' "$T/an/breaks.json")" "true"
check "every estimate has a formula" "$(jq -r '[.breaks[].estimate.formula | length > 20] | all' "$T/an/breaks.json")" "true"
check "unpaid $/month = outstanding over 1 month" "$(item signed_up_unpaid '.estimate.dollarsPerMonth')" "180"
check "top 3 ranked by $/month" "$(jq -c '.top3' "$T/an/breaks.json")" '["signed_up_unpaid","dropped","inquiry_no_follow_through"]'
check "totals add up" "$(jq -r '.totals.dollarsPerMonth' "$T/an/breaks.json")" "$(jq -r '[.breaks[].estimate.dollarsPerMonth] | add' "$T/an/breaks.json")"
check "every break says what an agent could do" "$(jq -r '[.breaks[].whatAnAgentCouldDo | length > 20] | all' "$T/an/breaks.json")" "true"

# 4. report.md is the owner-facing text
check "report title" "$(head -1 "$T/an/report.md")" "# Check-up: where the apps disagree"
check "report has top 3" "$(grep -c '^### [123]\. ' "$T/an/report.md")" "3"
check "report says estimate" "$(grep -c -i 'estimate' "$T/an/report.md" | awk '{print ($1>0)?"yes":"no"}')" "yes"
check "report lists assumptions" "$(grep -c '^- hourlyValue: 30' "$T/an/report.md")" "1"
check "report lists files" "$(grep -c '^- square-transactions.csv: square payment, 4 rows' "$T/an/report.md")" "1"

# 5. --as-of moves overdue and lapsed; --assume changes the inputs
LATE="$(bash "$EXEC" --in "$T/ingest" --as-of 2026-10-26 --out "$T/late")"
check "as-of honoured" "$(printf '%s' "$LATE" | jq -r '.asOf')" "2026-10-26"
check "two invoices overdue on 10-26" "$(printf '%s' "$LATE" | jq -r '.breaks[] | select(.type=="overdue_invoices") | .count')" "2"
check "  outstanding" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .estimate.outstanding' "$T/late/breaks.json")" "3391"
check "  days overdue" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .items[0].daysOverdue' "$T/late/breaks.json")" "26"
check "  overdue is now top" "$(printf '%s' "$LATE" | jq -r '.top3[0]')" "overdue_invoices"
check "still nobody lapsed at 90 days" "$(printf '%s' "$LATE" | jq -r '.breaks[] | select(.type=="lapsed") | .count')" "0"
LAPSED="$(bash "$EXEC" --in "$T/ingest" --as-of 2026-10-26 --assume lapsedDays=30 --assume hourlyValue=60)"
check "lapsedDays=30 → 4 customers lapsed" "$(printf '%s' "$LAPSED" | jq -r '.breaks[] | select(.type=="lapsed") | .count')" "4"
FAR="$(bash "$EXEC" --in "$T/ingest" --as-of 2027-01-15 --out "$T/far")"
check "a year on, every customer is lapsed" "$(printf '%s' "$FAR" | jq -r '.breaks[] | select(.type=="lapsed") | .count')" "4"
check "lapsed item has days since" "$(jq -r '.breaks[] | select(.type=="lapsed") | .items[0].daysSince > 100' "$T/far/breaks.json")" "true"
check "hourlyValue assumption applied" "$(bash "$EXEC" --in "$T/ingest" --assume hourlyValue=60 --out "$T/hv" >/dev/null; jq -r '.assumptions.hourlyValue' "$T/hv/breaks.json")" "60"

# 6. Hashed input: same counts, no names anywhere
HOUT="$(bash "$EXEC" --in "$T/ingest-hashed" --out "$T/anh")"
check "hashed: same break counts" "$(printf '%s' "$HOUT" | jq -c '[.breaks[].count]')" "$(printf '%s' "$OUT" | jq -c '[.breaks[].count]')"
check "hashed: no plain names in breaks.json" "$(grep -c -E "Lopez|Rivera|Baker|Chen|Natarajan|example\.test|555 010" "$T/anh/breaks.json")" "0"
check "hashed: no plain names in report.md" "$(grep -c -E "Lopez|Rivera|Baker|Chen|Natarajan" "$T/anh/report.md")" "0"
check "hashed: person label is a hash" "$(jq -r '.breaks[] | select(.type=="signed_up_unpaid") | .items[0].person' "$T/anh/breaks.json" | cut -c1-2)" "h:"

# 7. Partial data: notes say which checks could not run
mkdir -p "$T/partial"; cp "$T/ingest/square-transactions.json" "$T/ingest/square-customers.json" "$T/partial/"
POUT="$(bash "$EXEC" --in "$T/partial")"
check "partial: exits 0" "$?" "0"
check "partial: roster check skipped with a note" "$(printf '%s' "$POUT" | jq -r '.notes | map(select(test("paid but not listed"))) | length')" "1"
check "partial: mailing-list check skipped with a note" "$(printf '%s' "$POUT" | jq -r '.notes | map(select(test("mailing list"))) | length')" "1"
check "partial: paid_not_listed stays 0" "$(printf '%s' "$POUT" | jq -r '.breaks[] | select(.type=="paid_not_listed") | .count')" "0"
check "single file input works" "$(bash "$EXEC" --in "$T/ingest/quickbooks-invoices.json" --as-of 2026-10-26 | jq -r '.breaks[] | select(.type=="overdue_invoices") | .count')" "2"

# 8. JSON input
JOUT="$(bash "$EXEC" "{\"in\":\"$T/ingest\",\"out\":\"$T/json\",\"asOf\":\"2026-10-26\",\"assume\":{\"lapsedDays\":30}}")"
check "json input: as-of" "$(printf '%s' "$JOUT" | jq -r '.asOf')" "2026-10-26"
check "json input: assumption" "$(jq -r '.assumptions.lapsedDays' "$T/json/breaks.json")" "30"
check "json input: out written" "$([ -f "$T/json/report.md" ] && echo yes || echo no)" "yes"

# 9. Errors
bash "$EXEC" --in "$T/nope" >/dev/null 2>&1; check "missing input exits 2" "$?" "2"
mkdir -p "$T/empty"; bash "$EXEC" --in "$T/empty" >/dev/null 2>&1; check "empty folder exits 2" "$?" "2"
bash "$EXEC" >/dev/null 2>&1; check "no args exits 1" "$?" "1"
bash "$EXEC" --in "$T/ingest" --as-of 10/26/2026 >/dev/null 2>&1; check "bad as-of exits 1" "$?" "1"
bash "$EXEC" --in "$T/ingest" --assume nope=3 >/dev/null 2>&1; check "unknown assumption exits 1" "$?" "1"
bash "$EXEC" --in "$T/ingest" --assume hourlyValue=lots >/dev/null 2>&1; check "non-number assumption exits 1" "$?" "1"
printf 'not json' > "$T/ingest/broken.json"
BOUT="$(bash "$EXEC" --in "$T/ingest")"; RC=$?
check "unreadable file → exit 2 but the rest is analysed" "$RC" "2"
check "  problem named" "$(printf '%s' "$BOUT" | jq -r '.problems[0]' | cut -c1-11)" "broken.json"
check "  breaks still computed" "$(printf '%s' "$BOUT" | jq -r '.people')" "8"

echo "checkup-analyse: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
