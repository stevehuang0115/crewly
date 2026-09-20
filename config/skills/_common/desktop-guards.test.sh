#!/usr/bin/env bash
# =============================================================================
# Tests for the desktop safety rails.
#
# These matter more than most skill tests: every rail here stands between an
# agent and the owner's real keyboard. Before 2026-09-20 none of them existed
# — a denied TCC prompt produced a black screenshot the agent read as "the
# click did nothing", ⌘Q quit the user's app, `type` went into password boxes,
# and two agents fought over one mouse.
#
# Run: bash config/skills/_common/desktop-guards.test.sh
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/../agent/computer-use/execute.sh"
export CREWLY_HOME="$(mktemp -d)"
export CREWLY_SESSION_NAME="test-agent"
PASS=0; FAIL=0; SKIP=0

# A locked screen refuses everything transient, so the rails that sit behind
# that check cannot be exercised. Skipping is honest; asserting would either
# fail on a locked Mac or pass for the wrong reason.
SCREEN_LOCKED=$(osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGSessionCopyCurrentDictionary", ["id", []]); var d = $.CGSessionCopyCurrentDictionary(); d && ObjC.unwrap(d.objectForKey("CGSSessionScreenIsLocked")) ? "yes" : "no"' 2>/dev/null)

# skip_if_locked <description>
skip_if_locked() {
  [ "$SCREEN_LOCKED" != "yes" ] && return 1
  SKIP=$((SKIP+1)); echo "  ⊘ $1 (screen is locked)"
  return 0
}

# assert_reason <description> <json-input> <expected reason>
assert_reason() {
  local desc="$1" input="$2" want="$3" got
  got=$(bash "$SKILL" "$input" 2>&1 | jq -r '.reason // empty' 2>/dev/null)
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); echo "  ✗ $desc"; echo "      want reason=$want  got=${got:-<none>}"; fi
}

# assert_allowed <description> <json-input> — guard must not refuse it.
# Runs dry so the suite never actually clicks, types or opens an app on the
# machine it runs on (the first version of this file opened TextEdit).
assert_allowed() {
  local desc="$1" input="$2" got
  got=$(CREWLY_DESKTOP_DRY_RUN=1 bash "$SKILL" "$input" 2>&1 | jq -r '.reason // "none"' 2>/dev/null)
  case "$got" in
    none|permission_required) PASS=$((PASS+1)); echo "  ✓ $desc" ;;
    *) FAIL=$((FAIL+1)); echo "  ✗ $desc"; echo "      unexpectedly refused: $got" ;;
  esac
}

echo "destructive key combos"
for combo in "command+q" "cmd+w" "Command + Shift + Delete" "COMMAND+BACKSPACE" "command+option+escape"; do
  assert_reason "refuses $combo" "{\"action\":\"key\",\"key\":\"$combo\"}" "destructive_blocked"
done
skip_if_locked "allows command+c" || assert_allowed "allows command+c" '{"action":"key","key":"command+c"}'
skip_if_locked "allows command+shift+s" || assert_allowed "allows command+shift+s" '{"action":"key","key":"command+shift+s"}'

echo "credential apps"
for app in "Keychain Access" "1Password" "System Settings" "bitwarden"; do
  assert_reason "refuses focus on $app" "{\"action\":\"focus\",\"app\":\"$app\"}" "app_not_allowed"
done
skip_if_locked "allows focus on TextEdit" || assert_allowed "allows focus on TextEdit" '{"action":"focus","app":"TextEdit"}'

echo "stop switch"
touch "$CREWLY_HOME/desktop.stop"
assert_reason "halts a click"  '{"action":"click","x":5,"y":5}'  "stopped_by_user"
assert_reason "halts a type"   '{"action":"type","text":"x"}'    "stopped_by_user"
rm -f "$CREWLY_HOME/desktop.stop"

echo "desktop lock"
printf '{"holder":"other-agent","expiresAt":%s}' "$(( $(date +%s) + 300 ))" > "$CREWLY_HOME/desktop.lock"
skip_if_locked "refuses while another agent holds it" || assert_reason "refuses while another agent holds it" '{"action":"click","x":5,"y":5}' "desktop_busy"
printf '{"holder":"dead-agent","expiresAt":%s}' "$(( $(date +%s) - 60 ))" > "$CREWLY_HOME/desktop.lock"
skip_if_locked "ignores an expired lock" || assert_allowed "ignores an expired lock" '{"action":"list-apps"}'
rm -f "$CREWLY_HOME/desktop.lock"

echo "dry run"
if skip_if_locked "reports what would run without doing it"; then :
elif CREWLY_DESKTOP_DRY_RUN=1 bash "$SKILL" '{"action":"click","x":5,"y":5}' 2>&1 | jq -e '.dryRun == true and .wouldRun == true' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✓ reports what would run without doing it"
else
  FAIL=$((FAIL+1)); echo "  ✗ dry run did not report cleanly"
fi
# A refusal must still win over a dry run, or the rails could be inspected away.
assert_reason "a refusal still wins in dry run" '{"action":"key","key":"command+q"}' "destructive_blocked"

echo "perception (Phase 2)"
# `displays` reads no window and touches nothing, so it must work even when
# everything else is refused — including on a locked screen.
if bash "$SKILL" '{"action":"displays"}' 2>&1 | jq -e '.success and (.displays | length > 0)' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✓ displays works with no permission or lock needed"
else
  FAIL=$((FAIL+1)); echo "  ✗ displays did not report any screen"
fi

# Looking must not take the desktop lock: an agent waiting its turn still
# needs to see, and two readers cannot corrupt each other.
printf '{"holder":"other-agent","expiresAt":%s}' "$(( $(date +%s) + 300 ))" > "$CREWLY_HOME/desktop.lock"
for act in snapshot ocr resolve; do
  got=$(bash "$SKILL" "{\"action\":\"$act\",\"ref\":\"@e1\"}" 2>&1 | jq -r '.reason // "none"' 2>/dev/null)
  # Whatever else it answers, it must not have stopped at the other agent's lock.
  if [ "$got" != "desktop_busy" ]; then PASS=$((PASS+1)); echo "  ✓ $act does not wait on the desktop lock"
  else FAIL=$((FAIL+1)); echo "  ✗ $act was blocked by another agent's lock"; fi
done
rm -f "$CREWLY_HOME/desktop.lock"

# Changing things must take it.
printf '{"holder":"other-agent","expiresAt":%s}' "$(( $(date +%s) + 300 ))" > "$CREWLY_HOME/desktop.lock"
skip_if_locked "click-ref waits on the lock" || assert_reason "click-ref waits on the lock" '{"action":"click-ref","ref":"@e1"}' "desktop_busy"
skip_if_locked "fill-ref waits on the lock"  || assert_reason "fill-ref waits on the lock"  '{"action":"fill-ref","ref":"@e1","text":"x"}' "desktop_busy"
rm -f "$CREWLY_HOME/desktop.lock"

# A locked screen makes accessibility answer with placeholder data rather
# than failing, so reading it would look plausible and be wrong.
if [ "$(bash "$SKILL" '{"action":"check-permissions"}' 2>&1 | jq -r '.ready')" = "true" ]; then
  locked=$(osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGSessionCopyCurrentDictionary", ["id", []]); var d = $.CGSessionCopyCurrentDictionary(); d && ObjC.unwrap(d.objectForKey("CGSSessionScreenIsLocked")) ? "yes" : "no"' 2>/dev/null)
  got=$(bash "$SKILL" '{"action":"snapshot"}' 2>&1 | jq -r '.reason // "none"' 2>/dev/null)
  if [ "$locked" = "yes" ]; then
    if [ "$got" = "screen_locked" ]; then PASS=$((PASS+1)); echo "  ✓ refuses to read a locked screen"
    else FAIL=$((FAIL+1)); echo "  ✗ read a locked screen anyway (got: $got)"; fi
  else
    if [ "$got" = "none" ]; then PASS=$((PASS+1)); echo "  ✓ snapshot runs on an unlocked screen"
    else FAIL=$((FAIL+1)); echo "  ✗ snapshot failed on an unlocked screen: $got"; fi
  fi
fi

# wait-for must reject a call that says nothing to wait for, rather than
# blocking for the whole timeout.
if skip_if_locked "wait-for demands a condition"; then :
elif bash "$SKILL" '{"action":"wait-for"}' 2>&1 | grep -q "one of"; then
  PASS=$((PASS+1)); echo "  ✓ wait-for demands a condition"
else
  FAIL=$((FAIL+1)); echo "  ✗ wait-for accepted an empty condition"
fi

echo "permissions report"
if bash "$SKILL" '{"action":"check-permissions"}' 2>&1 | jq -e 'has("screenRecording") and has("accessibility") and has("askingProcess")' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✓ check-permissions reports both grants and who to grant them to"
else
  FAIL=$((FAIL+1)); echo "  ✗ check-permissions did not report the expected fields"
fi

echo "audit trail"
if [ -s "$CREWLY_HOME/desktop-actions.jsonl" ] \
  && jq -e 'has("at") and has("session") and has("action")' < <(head -1 "$CREWLY_HOME/desktop-actions.jsonl") >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✓ every action is logged with time, session and action"
else
  FAIL=$((FAIL+1)); echo "  ✗ action log missing or malformed"
fi

echo "bash 3.2 compatibility"
# macOS ships bash 3.2, which has no negative array indices. Using one made
# every modifier combo fail with "bad array subscript".
if bash -c 'IFS="+" read -ra p <<< "command+shift+s"; echo "${p[$(( ${#p[@]} - 1 ))]}"' 2>/dev/null | grep -q '^s$'; then
  PASS=$((PASS+1)); echo "  ✓ key parsing uses a 3.2-safe last-element index"
else
  FAIL=$((FAIL+1)); echo "  ✗ key parsing is not bash 3.2 safe"
fi

rm -rf "$CREWLY_HOME"
echo
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$SKIP" -gt 0 ] && echo "    (unlock the screen and re-run to cover the skipped rails)"
[ "$FAIL" -eq 0 ]
