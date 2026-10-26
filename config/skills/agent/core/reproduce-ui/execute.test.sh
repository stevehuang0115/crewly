#!/bin/bash
# Tests for reproduce-ui — run with: bash execute.test.sh
# Offline: a fixture feature map, --dry-run only (no browser is started).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/execute.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
MAP="$T/FEATURE_MAP.md"
cat > "$MAP" <<'EOF_MAP'
# Feature map

## Routes

| Route | Page | Reached from | One job |
| --- | --- | --- | --- |
| `/` | `src/pages/Dashboard.tsx` | sidebar Dashboard | What needs me |
| `/tickets` | `src/pages/hubs/TicketsHub.tsx` | sidebar Tickets | Board · Requests · Runs tabs |
| `/tickets/runs/:id` | `src/pages/WorkItemDetail.tsx` | Tickets › Runs row | One run (work item) |
| `/usage` | `src/pages/Usage.tsx` | sidebar Usage | Tokens by team |

## Old URLs

| Old URL | Goes to |
| --- | --- |
| `/workitems` | `/tickets?tab=runs` |

## Features

### Dashboard (`/`)

- **Expected**: "Waiting on you" first, then "Crew now" with the health bar.
- **Elements**: `dashboard`, `crew-now`.

### Tickets hub (`/tickets`, tabs `board` · `runs`)

- **Expected**: Board = kanban columns; Runs = one row per work item.
- **Elements**: `tickets-panel-${tab}`, `tickets-page`, `tickets-board`.

### Run detail (`/tickets/runs/:id`)

- **Expected**: the work item's header, metrics and timeline.
- **Elements**: `workitem-detail-loading|error|not-found`, `workitem-detail`.

### Usage (`/usage`)

- **Expected**: one headline with tokens by team.
EOF_MAP
export CREWLY_API_URL="http://127.0.0.1:18799"
export CREWLY_HOME="$T/home"

# ---- help ----
OUT=$(bash "$EXEC" --help 2>&1); RC=$?
check "help exits 0" "$RC" "0"
check "help names --feature" "$(printf '%s' "$OUT" | grep -c -- '--feature')" "$(printf '%s' "$OUT" | grep -c -- '--feature')"
[ "$(printf '%s' "$OUT" | grep -c -- '--feature')" -ge 1 ] || { FAIL=$((FAIL+1)); echo "FAIL: help lacks --feature"; }

# ---- no route / feature ----
ERR=$(bash "$EXEC" --dry-run 2>&1 >/dev/null); RC=$?
check "no route: exit 1" "$RC" "1"
check "no route: error says so" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'route, --feature or --report')" "1"

# ---- route + map: wait selector from the Elements line; ${} and a|b skipped ----
OUT=$(bash "$EXEC" --route "/tickets?tab=runs" --map "$MAP" --dry-run)
check "route: dryRun" "$(printf '%s' "$OUT" | jq -r .dryRun)" "true"
check "route: url" "$(printf '%s' "$OUT" | jq -r .url)" "http://127.0.0.1:18799/tickets?tab=runs"
check "route: wait = the tab's panel" "$(printf '%s' "$OUT" | jq -r .waitFor)" '[data-testid="tickets-panel-runs"]'
check "route without tab: first static id" "$(bash "$EXEC" --route /tickets --map "$MAP" --dry-run | jq -r .waitFor)" '[data-testid="tickets-page"]'
check "route: waitSource map" "$(printf '%s' "$OUT" | jq -r .waitSource)" "map"
check "route: feature job from the row" "$(printf '%s' "$OUT" | jq -r .feature.job)" "Board · Requests · Runs tabs"
check "route: evidence root under CREWLY_HOME" "$(printf '%s' "$OUT" | jq -r .outRoot)" "$T/home/evidence"

OUT=$(bash "$EXEC" --route "/tickets/runs/abc" --map "$MAP" --dry-run)
check "run detail literal id: alternatives skipped" "$(printf '%s' "$OUT" | jq -r .waitFor)" '[data-testid="workitem-detail"]'

# ---- feature word → route; :id from --param ----
OUT=$(bash "$EXEC" --feature "One run" --param id=wi-9 --map "$MAP" --dry-run)
check "feature: route resolved" "$(printf '%s' "$OUT" | jq -r .route)" "/tickets/runs/:id"
check "feature: param filled" "$(printf '%s' "$OUT" | jq -r .path)" "/tickets/runs/wi-9"

ERR=$(bash "$EXEC" --feature "One run" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "feature without param: exit 1" "$RC" "1"
check "feature without param: names it" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'param id')" "1"

OUT=$(bash "$EXEC" --feature "/usage" --map "$MAP" --dry-run)
check "exact route as feature" "$(printf '%s' "$OUT" | jq -r .path)" "/usage"
check "no Elements line → body" "$(printf '%s' "$OUT" | jq -r .waitFor)" "body"
check "waitSource default" "$(printf '%s' "$OUT" | jq -r .waitSource)" "default"

ERR=$(bash "$EXEC" --feature "tickets" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "ambiguous feature: exit 1" "$RC" "1"
check "ambiguous feature: lists candidates" "$(printf '%s' "$ERR" | jq -r .error | grep -c '/tickets/runs/:id')" "1"

ERR=$(bash "$EXEC" --feature "nothing-like-this" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "unknown feature: exit 1" "$RC" "1"
check "unknown feature: says no row" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'no feature-map row')" "1"

ERR=$(bash "$EXEC" --feature "Usage" --map "$T/missing.md" --dry-run 2>&1 >/dev/null); RC=$?
check "feature without map: exit 1" "$RC" "1"
check "feature without map: explains" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'needs the feature map')" "1"

# ---- explicit wait, base url, timeout, full page, JSON input ----
OUT=$(bash "$EXEC" --route /x --wait '#main' --base-url http://localhost:9999/ --timeout 500 --full-page --dry-run)
check "explicit wait" "$(printf '%s' "$OUT" | jq -r .waitFor)" "#main"
check "waitSource arg" "$(printf '%s' "$OUT" | jq -r .waitSource)" "arg"
check "base url trailing slash trimmed" "$(printf '%s' "$OUT" | jq -r .url)" "http://localhost:9999/x"
check "timeout" "$(printf '%s' "$OUT" | jq -r .timeoutMs)" "500"
check "full page" "$(printf '%s' "$OUT" | jq -r .fullPage)" "true"

OUT=$(bash "$EXEC" '{"route":"/usage","map":"'"$MAP"'","dryRun":true,"params":{"id":"1"},"fullPage":true}')
check "json input: route" "$(printf '%s' "$OUT" | jq -r .path)" "/usage"
check "json input: fullPage" "$(printf '%s' "$OUT" | jq -r .fullPage)" "true"

# ---- --report: a bug report matched to a feature (slice 3) ----
OUT=$(bash "$EXEC" --report "the runs tab under tickets is blank" --map "$MAP" --dry-run)
check "report: tab word picks the hub with ?tab=" "$(printf '%s' "$OUT" | jq -r .route)" "/tickets?tab=runs"
check "report: wait = that tab's panel" "$(printf '%s' "$OUT" | jq -r .waitFor)" '[data-testid="tickets-panel-runs"]'
check "report: match title" "$(printf '%s' "$OUT" | jq -r .match.title)" "Tickets hub"
check "report: matched words (plural dropped)" "$(printf '%s' "$OUT" | jq -c .match.matched)" '["run","ticket"]'
check "report: runner-up listed" "$(printf '%s' "$OUT" | jq -r '.match.candidates[0].route')" "/tickets/runs/:id"
check "report: text kept in the plan" "$(printf '%s' "$OUT" | jq -r .report)" "the runs tab under tickets is blank"

OUT=$(bash "$EXEC" --report "Tokens by team headline missing on the usage page" --map "$MAP" --dry-run)
check "report: Expected words pick Usage" "$(printf '%s' "$OUT" | jq -r .route)" "/usage"

OUT=$(bash "$EXEC" --report "Waiting on you never loads, Crew now spins" --map "$MAP" --dry-run)
check "report: Dashboard by its Expected words" "$(printf '%s' "$OUT" | jq -r .route)" "/"

ERR=$(bash "$EXEC" --report "nothing happens at all" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "report with no match: exit 3" "$RC" "3"
check "report with no match: says so" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'matches no feature')" "1"

ERR=$(bash "$EXEC" --report "tickets" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "one-word report: exit 3" "$RC" "3"
check "one-word report: asks for more words" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'too weakly')" "1"
check "one-word report: best candidate first" "$(printf '%s' "$ERR" | jq -r '.candidates[0].route')" "/tickets"

ERR=$(bash "$EXEC" --report "the work item is wrong" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "even report: exit 3" "$RC" "3"
check "even report: says equally" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'about equally')" "1"
check "even report: lists candidates" "$(printf '%s' "$ERR" | jq -r '.candidates | length' )" "2"

printf 'runs tab under\ntickets is blank\n' > "$T/report.txt"
OUT=$(bash "$EXEC" --report-file "$T/report.txt" --map "$MAP" --dry-run)
check "report-file: same match" "$(printf '%s' "$OUT" | jq -r .route)" "/tickets?tab=runs"
ERR=$(bash "$EXEC" --report-file "$T/nope.txt" --map "$MAP" --dry-run 2>&1 >/dev/null); RC=$?
check "report-file missing: exit 1" "$RC" "1"

OUT=$(bash "$EXEC" '{"report":"runs tab under tickets","map":"'"$MAP"'","dryRun":true}')
check "json input: report" "$(printf '%s' "$OUT" | jq -r .route)" "/tickets?tab=runs"

OUT=$(bash "$EXEC" --route /usage --report "runs tab under tickets" --map "$MAP" --dry-run)
check "route beats report" "$(printf '%s' "$OUT" | jq -r .route)" "/usage"
check "route beats report: no match block" "$(printf '%s' "$OUT" | jq -r .match)" "null"

ERR=$(bash "$EXEC" --report "runs tab" --map "$T/missing.md" --dry-run 2>&1 >/dev/null); RC=$?
check "report without map: exit 1" "$RC" "1"
check "report without map: explains" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'needs the feature map')" "1"

# ---- ticketLine / report sections (pure functions, no browser) ----
OUT=$(cd "$HERE" && node --input-type=module -e '
import { ticketLine, renderReport } from "./reproduce.mjs";
const reqs = [{ url: "http://x/api/a", method: "GET", status: 404 }, { url: "http://x/api/b", method: "POST", status: 500 }];
const s = { route: "/tickets?tab=runs", url: "http://x/tickets?tab=runs", finalUrl: "", title: "T", waitFor: "[data-testid=\"p\"]", waitSource: "map",
  found: false, error: "Timeout 60000ms", timings: { navigationMs: 1, elementMs: null, totalMs: 2 }, consoleErrors: 1, failedRequests: 2, dir: "/e/1",
  screenshot: null, feature: null, report: "runs tab blank\nsecond line", match: { title: "Tickets hub", score: 6, matched: ["run", "ticket"] } };
s.ticketLine = ticketLine(s, reqs);
console.log(s.ticketLine);
console.log(renderReport(s, [{ type: "error", text: "boom" }], reqs));
')
check "ticketLine: not found + 5xx first" "$(printf '%s' "$OUT" | sed -n 1p)" 'Reproduced `/tickets?tab=runs`: key element `[data-testid="p"]` NOT found (Timeout 60000ms); 1 console error; 2 failed requests (first: POST http://x/api/b → 500); evidence: /e/1'
check "report.md: match line" "$(printf '%s' "$OUT" | grep -c 'Matched from the report: Tickets hub (score 6, words: run, ticket)')" "1"
check "report.md: ticket section" "$(printf '%s' "$OUT" | grep -c '^## For the ticket')" "1"
check "report.md: report quoted" "$(printf '%s' "$OUT" | grep -c '^> second line')" "1"
OUT=$(cd "$HERE" && node --input-type=module -e '
import { ticketLine } from "./reproduce.mjs";
console.log(ticketLine({ route: "/", found: true, consoleErrors: 0, failedRequests: 0, dir: "/e/2" }, []));
')
check "ticketLine: rendered, nothing failed" "$OUT" 'Reproduced `/`: rendered; 0 console errors; 0 failed requests; evidence: /e/2'

ERR=$(bash "$EXEC" --route relative --dry-run 2>&1 >/dev/null); RC=$?
check "route must start with /" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'must start with /')" "1"

ERR=$(bash "$EXEC" --route /x --bogus 2>&1 >/dev/null); RC=$?
check "unknown arg: exit 2" "$RC" "2"

echo "reproduce-ui: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
