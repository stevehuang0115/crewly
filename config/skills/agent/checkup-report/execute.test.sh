#!/bin/bash
# Tests for checkup-report — run with: bash execute.test.sh
# Offline: runs ingest-exports + checkup-analyse on the ingest fixtures first. Needs node and jq.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
INGEST="$HERE/../ingest-exports/execute.sh"
ANALYSE="$HERE/../checkup-analyse/execute.sh"
FX="$HERE/../ingest-exports/fixtures"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
bash "$INGEST" --in "$FX" --out "$T/ingest" >/dev/null || { echo "ingest-exports failed"; exit 1; }
bash "$INGEST" --in "$FX" --out "$T/ingest-hashed" --hash-names >/dev/null
bash "$ANALYSE" --in "$T/ingest" --as-of 2026-10-26 --out "$T/an" >/dev/null || { echo "checkup-analyse failed"; exit 1; }
bash "$ANALYSE" --in "$T/ingest-hashed" --as-of 2026-10-26 --out "$T/anh" >/dev/null

# 1. The App page follows the Crewly Apps rules (sandbox: no network, no storage, old Safari)
PAGE="$HERE/app/index.html"
check "page exists" "$([ -f "$PAGE" ] && echo yes || echo no)" "yes"
check "viewport meta" "$(grep -c 'name="viewport"' "$PAGE")" "1"
check "no external script" "$(grep -c -E '<script[^>]+src=' "$PAGE")" "0"
check "no fetch/XHR" "$(grep -c -E '\bfetch\(|XMLHttpRequest|WebSocket' "$PAGE")" "0"
check "no localStorage/cookies" "$(grep -c -E 'localStorage|sessionStorage|document\.cookie' "$PAGE")" "0"
check "no alert/confirm/prompt" "$(grep -c -E '\b(alert|confirm|prompt)\(' "$PAGE")" "0"
check "no innerHTML with data" "$(grep -c 'innerHTML' "$PAGE")" "0"
check "no optional chaining / nullish (iOS 12)" "$(grep -c -E '\?\.[a-zA-Z(]|\?\?' "$PAGE")" "0"
check "no arrow functions / class fields (iOS 12)" "$(grep -c -E '=>' "$PAGE")" "0"
check "replaceChildren polyfilled" "$(grep -c 'Element.prototype.replaceChildren = ' "$PAGE")" "1"
check "reads report/current" "$(grep -c "crewly.db.get('report', 'current')" "$PAGE")" "1"
check "writes intake/answers" "$(grep -c "crewly.db.set('intake', 'answers'" "$PAGE")" "1"
check "lists daily" "$(grep -c "crewly.db.list('daily'" "$PAGE")" "1"
check "subscribes to report changes" "$(grep -c "crewly.db.subscribe('report'" "$PAGE")" "1"
check "data-crewly-id on the key elements" "$(grep -o 'data-crewly-id="[^"]*"' "$PAGE" | sort -u | wc -l | tr -d ' ' | awk '{print ($1>=15)?"enough":"few"}')" "enough"
check "page JS parses (node)" "$(node -e '
const fs=require("fs");const html=fs.readFileSync(process.argv[1],"utf8");
const m=html.match(/<script>([\s\S]*?)<\/script>/);try{new Function(m[1]);console.log("ok")}catch(e){console.log("syntax: "+e.message)}' "$PAGE")" "ok"

# 2. --app-dir copies the page into the project for publish-app
OUT="$(bash "$EXEC" --app-dir "$T/checkup-app")"; RC=$?
check "app-dir exits 0" "$RC" "0"
check "index.html copied" "$([ -f "$T/checkup-app/index.html" ] && echo yes || echo no)" "yes"
check "copied list" "$(printf '%s' "$OUT" | jq -c '.copied')" '["index.html"]'
check "next says publish-app" "$(printf '%s' "$OUT" | jq -r '.next' | cut -c1-11)" "publish-app"
check "copy is identical" "$(cmp -s "$PAGE" "$T/checkup-app/index.html" && echo same || echo differs)" "same"

# 3. --breaks builds the report document
cat > "$T/intake.json" <<'EOF'
{"apps":["Square","Jotform","Jackrabbit","Mailchimp","QuickBooks"],"slowestTask":"copying sign-ups into the roster","fears":["Unpaid invoices"],"appsPerCustomer":"3","firstNumber":"Money owed to me","savedAt":"2026-10-26T10:00:00.000Z"}
EOF
ROUT="$(bash "$EXEC" --breaks "$T/an/breaks.json" --business "Oak Pottery" --intake "$T/intake.json" --out "$T/data")"; RC=$?
check "breaks exits 0" "$RC" "0"
check "report-doc written" "$([ -f "$T/data/report-doc.json" ] && echo yes || echo no)" "yes"
D="$T/data/report-doc.json"
check "business" "$(jq -r '.business' "$D")" "Oak Pottery"
check "as-of carried" "$(jq -r '.asOf' "$D")" "2026-10-26"
check "top3 carried" "$(jq -c '.top3' "$D")" "$(jq -c '.top3' "$T/an/breaks.json")"
check "totals carried" "$(jq -c '.totals' "$D")" "$(jq -c '.totals' "$T/an/breaks.json")"
check "8 breaks" "$(jq -r '.breaks | length' "$D")" "8"
check "no raw items in the doc" "$(jq -r '[.breaks[] | has("items")] | any' "$D")" "false"
check "estimate keeps the formula" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .estimate.formula | length > 20' "$D")" "true"
check "examples for overdue invoices" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .examples | length' "$D")" "2"
check "  example text" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .examples[0]' "$D")" "Harbor Dental: invoice 1042 \$1250, 26 days overdue"
check "example for unpaid sign-up" "$(jq -r '.breaks[] | select(.type=="signed_up_unpaid") | .examples[0]' "$D")" "Sam Rivera: Kids Pottery Sat 10am on 2026-09-10, \$180 unpaid"
check "example for double entry" "$(jq -r '.breaks[] | select(.type=="double_entry") | .examples[0]' "$D")" "Maria Lopez is in jackrabbit, mailchimp, square"
check "examples capped at 3 by default" "$(jq -r '.breaks[] | select(.type=="double_entry") | .examples | length' "$D")" "3"
check "first number: money owed" "$(jq -r '.firstNumber.key' "$D")" "money_owed"
check "  value = overdue + unpaid sign-ups" "$(jq -r '.firstNumber.value' "$D")" "\$3,571"
check "  asked text kept" "$(jq -r '.firstNumber.asked' "$D")" "Money owed to me"
check "summary line has top3" "$(printf '%s' "$ROUT" | jq -r '.top3[0]')" "overdue_invoices"
check "summary line next = app-data set" "$(printf '%s' "$ROUT" | jq -r '.next' | grep -c '^app-data --app <appId> --set report current --data-file ')" "1"
check "files carried" "$(jq -r '.files | length' "$D")" "7"
check "assumptions carried" "$(jq -r '.assumptions.hourlyValue' "$D")" "30"
check "doc small" "$(wc -c < "$D" | awk '{print ($1<20000)?"small":"big"}')" "small"

# 4. Examples cap, other first-number choices, intake in app-data output shape, free-text first number
bash "$EXEC" --breaks "$T/an/breaks.json" --examples 1 --out "$T/data1" >/dev/null
check "--examples 1" "$(jq -r '.breaks[] | select(.type=="double_entry") | .examples | length' "$T/data1/report-doc.json")" "1"
bash "$EXEC" --breaks "$T/an/breaks.json" --examples 4 --out "$T/data4x" >/dev/null
check "--examples 4 reaches the conflict example" "$(jq -r '.breaks[] | select(.type=="double_entry") | .examples[3]' "$T/data4x/report-doc.json")" "Tom Baker is in jotform, mailchimp (phone missing in mailchimp)"
bash "$EXEC" --breaks "$T/an/breaks.json" --examples 0 --out "$T/data0" >/dev/null
check "--examples 0 → none" "$(jq -r '[.breaks[].examples | length] | add' "$T/data0/report-doc.json")" "0"
printf '{"success":true,"id":"answers","data":{"apps":["Square"],"firstNumber":"Inquiries I missed"},"rev":1}' > "$T/intake-appdata.json"
bash "$EXEC" --breaks "$T/an/breaks.json" --intake "$T/intake-appdata.json" --out "$T/data2" >/dev/null
check "intake from app-data output shape" "$(jq -r '.firstNumber.key' "$T/data2/report-doc.json")" "missed_inquiries"
check "  value" "$(jq -r '.firstNumber.value' "$T/data2/report-doc.json")" "1"
printf '{"firstNumber":"how many hours we lose typing things twice"}' > "$T/intake-free.json"
bash "$EXEC" --breaks "$T/an/breaks.json" --intake "$T/intake-free.json" --out "$T/data3" >/dev/null
check "free-text first number mapped" "$(jq -r '.firstNumber.key' "$T/data3/report-doc.json")" "double_entry_hours"
printf '{"firstNumber":"Customers who lapsed"}' > "$T/intake-lapsed.json"
bash "$EXEC" --breaks "$T/an/breaks.json" --intake "$T/intake-lapsed.json" --out "$T/data4" >/dev/null
check "lapsed first number" "$(jq -r '.firstNumber.key' "$T/data4/report-doc.json")" "lapsed"
printf '{"firstNumber":"the weather"}' > "$T/intake-odd.json"
bash "$EXEC" --breaks "$T/an/breaks.json" --intake "$T/intake-odd.json" --out "$T/data5" >/dev/null
check "unmappable first number → no firstNumber" "$(jq -r 'has("firstNumber")' "$T/data5/report-doc.json")" "false"
check "  but a note" "$(jq -r '.notes | map(select(test("the weather"))) | length' "$T/data5/report-doc.json")" "1"
bash "$EXEC" --breaks "$T/an/breaks.json" --out "$T/data6" >/dev/null
check "no intake → no firstNumber, no note" "$(jq -r 'has("firstNumber"), (.notes|length)' "$T/data6/report-doc.json" | tr '\n' ' ')" "false 0 "

# 5. Hashed data: no names, examples say "names hashed"
bash "$EXEC" --breaks "$T/anh/breaks.json" --out "$T/datah" >/dev/null
check "hashed: no plain names in the doc" "$(grep -c -E "Lopez|Rivera|Baker|Chen|Natarajan|example\.test" "$T/datah/report-doc.json")" "0"
check "hashed: no hashes leak either" "$(grep -c '"h:' "$T/datah/report-doc.json")" "0"
check "hashed: example says names hashed" "$(jq -r '.breaks[] | select(.type=="signed_up_unpaid") | .examples[0]' "$T/datah/report-doc.json")" "1 person (names hashed)"
check "hashed: invoice customers hashed too → count only" "$(jq -r '.breaks[] | select(.type=="overdue_invoices") | .examples[0]' "$T/datah/report-doc.json")" "2 people (names hashed)"

# 6. --daily
DOUT="$(bash "$EXEC" --daily "Replied to 3 open inquiries; 1 booked." --date 2026-10-27 --out "$T/data")"
check "daily exits 0" "$?" "0"
check "daily file" "$([ -f "$T/data/daily-2026-10-27.json" ] && echo yes || echo no)" "yes"
check "daily doc" "$(jq -c '{date,summary}' "$T/data/daily-2026-10-27.json")" '{"date":"2026-10-27","summary":"Replied to 3 open inquiries; 1 booked."}'
check "daily next = app-data set daily <date>" "$(printf '%s' "$DOUT" | jq -r '.next' | grep -c '^app-data --app <appId> --set daily 2026-10-27 --data-file ')" "1"
check "daily default date = today" "$(bash "$EXEC" --daily "x" --out "$T/data" | jq -r '.dailyDoc' | grep -c "daily-$(date -u +%F).json")" "1"

# 7. JSON input and combined calls
JOUT="$(bash "$EXEC" "{\"appDir\":\"$T/japp\",\"breaks\":\"$T/an/breaks.json\",\"business\":\"Oak\",\"out\":\"$T/jdata\"}")"
check "json input: app copied" "$([ -f "$T/japp/index.html" ] && echo yes || echo no)" "yes"
check "json input: report written" "$(jq -r '.business' "$T/jdata/report-doc.json")" "Oak"
check "json input: summary has both" "$(printf '%s' "$JOUT" | jq -r '(.copied|length), (.top3|length)' | tr '\n' ' ')" "1 3 "

# 8. Errors
bash "$EXEC" >/dev/null 2>&1; check "no args exits 1" "$?" "1"
bash "$EXEC" --breaks "$T/an/breaks.json" >/dev/null 2>&1; check "breaks without --out exits 1" "$?" "1"
bash "$EXEC" --breaks "$T/nope.json" --out "$T/x" >/dev/null 2>&1; check "missing breaks exits 2" "$?" "2"
printf '{"foo":1}' > "$T/notbreaks.json"
bash "$EXEC" --breaks "$T/notbreaks.json" --out "$T/x" >/dev/null 2>&1; check "wrong file exits 2" "$?" "2"
bash "$EXEC" --breaks "$T/an/breaks.json" --intake "$T/nope.json" --out "$T/x" >/dev/null 2>&1; check "missing intake exits 2" "$?" "2"
bash "$EXEC" --daily "x" --date 27/10/2026 --out "$T/x" >/dev/null 2>&1; check "bad date exits 1" "$?" "1"
bash "$EXEC" --daily "   " --out "$T/x" >/dev/null 2>&1; check "empty daily exits 1" "$?" "1"
bash "$EXEC" --breaks "$T/an/breaks.json" --examples lots --out "$T/x" >/dev/null 2>&1; check "bad examples exits 1" "$?" "1"
bash "$EXEC" --bogus >/dev/null 2>&1; check "unknown flag exits 1" "$?" "1"

echo "checkup-report: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
