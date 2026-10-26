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

- **Elements**: `dashboard`, `crew-now`.

### Tickets hub (`/tickets`, tabs `board` · `runs`)

- **Elements**: `tickets-panel-${tab}`, `tickets-page`, `tickets-board`.

### Run detail (`/tickets/runs/:id`)

- **Elements**: `workitem-detail-loading|error|not-found`, `workitem-detail`.

### Usage (`/usage`)

- **Expected**: one headline.
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
check "no route: error says so" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'route or --feature')" "1"

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

ERR=$(bash "$EXEC" --route relative --dry-run 2>&1 >/dev/null); RC=$?
check "route must start with /" "$(printf '%s' "$ERR" | jq -r .error | grep -c 'must start with /')" "1"

ERR=$(bash "$EXEC" --route /x --bogus 2>&1 >/dev/null); RC=$?
check "unknown arg: exit 2" "$RC" "2"

echo "reproduce-ui: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
