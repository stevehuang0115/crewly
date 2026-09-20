#!/usr/bin/env bash
# =============================================================================
# desktop-guards.sh — safety rails shared by every skill that drives the
# owner's real mouse, keyboard and screen.
#
# Sourced rather than copied because there are already two divergent
# computer-use implementations in this repo (config/skills/agent/computer-use
# and .../marketplace/computer-use) with different action sets. Duplicating
# the rails into both is how they drift apart, and a guard that exists in only
# one copy is worse than none — it makes the skill look safe.
#
# Callers must have sourced _common/lib.sh first (for error_exit) and must set
# ACTION and INPUT before calling cu_apply_guards.
#
# Usage:
#   source "${SCRIPT_DIR}/../../_common/desktop-guards.sh"
#   cu_apply_guards
# =============================================================================


CREWLY_HOME_DIR="${CREWLY_HOME:-$HOME/.crewly}"
DESKTOP_LOCK="${CREWLY_HOME_DIR}/desktop.lock"
DESKTOP_LOG="${CREWLY_HOME_DIR}/desktop-actions.jsonl"
DESKTOP_STOP="${CREWLY_HOME_DIR}/desktop.stop"
LOCK_TTL_SECONDS="${CREWLY_DESKTOP_LOCK_TTL:-120}"
HOLDER="${CREWLY_SESSION_NAME:-unknown-agent}"

mkdir -p "$CREWLY_HOME_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# cu_fail reason message [extra_json]
#
# A refusal the agent can act on. Every guard answers in this one shape so a
# model does not have to parse prose to tell "you lack permission" from "that
# element was not found".
# ---------------------------------------------------------------------------
cu_fail() {
  local reason="$1" message="$2" extra="${3:-{\}}"
  jq -n --arg a "$ACTION" --arg r "$reason" --arg m "$message" --argjson x "$extra" \
    '{success:false, action:$a, reason:$r, message:$m} + $x'
  exit 1
}

# ---------------------------------------------------------------------------
# Permission preflight
#
# macOS grants TCC permissions to the *process that asks*, which for a skill is
# whatever launched the agent — Terminal, iTerm, or the crewly backend's node.
# So the answer names the process, otherwise the owner cannot tell what to tick.
# ---------------------------------------------------------------------------
asking_process() {
  # The nearest ancestor the user would recognise in the TCC pane.
  ps -o comm= -p "${PPID:-$$}" 2>/dev/null | sed 's:.*/::' || echo "your terminal"
}

has_screen_recording() {
  # CGPreflightScreenCaptureAccess is a plain C function: importing CoreGraphics
  # is not enough, JXA only sees it once it is bound explicitly.
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics");
    ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
    $.CGPreflightScreenCaptureAccess() ? "yes" : "no"
  ' 2>/dev/null
}

has_accessibility() {
  osascript -l JavaScript -e 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted() ? "yes" : "no"' 2>/dev/null
}

require_screen_recording() {
  [ "$(has_screen_recording)" = "yes" ] && return 0
  cu_fail "permission_required" \
    "Screen Recording is not granted to $(asking_process), so every screenshot comes back blank. Grant it, then quit and reopen that app — macOS only applies the change on restart." \
    "$(jq -n --arg p "$(asking_process)" '{permission:"screen-recording", grantTo:$p, howTo:"System Settings → Privacy & Security → Screen & System Audio Recording"}')"
}

require_accessibility() {
  [ "$(has_accessibility)" = "yes" ] && return 0
  cu_fail "permission_required" \
    "Accessibility is not granted to $(asking_process), so clicks and keystrokes are silently discarded. Grant it, then quit and reopen that app." \
    "$(jq -n --arg p "$(asking_process)" '{permission:"accessibility", grantTo:$p, howTo:"System Settings → Privacy & Security → Accessibility"}')"
}

# ---------------------------------------------------------------------------
# Stop switch
#
# A file, so anything can set it: the owner, a hotkey, the backend. Checked
# before every action rather than only at the start, because the point is to
# stop an agent that is already mid-task.
# ---------------------------------------------------------------------------
require_not_stopped() {
  [ -f "$DESKTOP_STOP" ] || return 0
  cu_fail "stopped_by_user" \
    "Desktop control is stopped. The owner halted it; it stays off until $DESKTOP_STOP is removed." \
    "$(jq -n --arg f "$DESKTOP_STOP" '{stopFile:$f}')"
}

# ---------------------------------------------------------------------------
# Mutual exclusion
#
# One machine has one mouse and one keyboard focus, so two agents acting at
# once corrupt each other. The lock carries its holder and an expiry, so a
# crashed agent cannot wedge the desktop forever.
# ---------------------------------------------------------------------------
acquire_desktop_lock() {
  local now holder_existing expires
  now=$(date +%s)
  if [ -f "$DESKTOP_LOCK" ]; then
    holder_existing=$(jq -r '.holder // "unknown"' "$DESKTOP_LOCK" 2>/dev/null || echo unknown)
    expires=$(jq -r '.expiresAt // 0' "$DESKTOP_LOCK" 2>/dev/null || echo 0)
    if [ "$holder_existing" != "$HOLDER" ] && [ "$expires" -gt "$now" ] 2>/dev/null; then
      cu_fail "desktop_busy" \
        "$holder_existing is using the desktop until $(date -r "$expires" '+%H:%M:%S'). Wait, or ask that agent to finish." \
        "$(jq -n --arg h "$holder_existing" --argjson e "$expires" '{heldBy:$h, expiresAt:$e}')"
    fi
  fi
  jq -n --arg h "$HOLDER" --argjson e "$((now + LOCK_TTL_SECONDS))" --arg a "$ACTION" \
    '{holder:$h, expiresAt:$e, lastAction:$a}' > "$DESKTOP_LOCK" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Audit
#
# Appended before the action runs, so an action that hangs or crashes the shell
# still leaves a trace. Screenshots of each step come later (Phase 5).
# ---------------------------------------------------------------------------
log_action() {
  jq -nc --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg s "$HOLDER" --arg a "$ACTION" --argjson i "$INPUT" \
    '{at:$t, session:$s, action:$a, input:$i}' >> "$DESKTOP_LOG" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Destructive key combos
#
# Blocked outright rather than sent for approval: these are almost never what
# an automation legitimately wants, and a blocked action the agent can route
# around beats a prompt the owner learns to click through. An operator who
# really means it sets CREWLY_DESKTOP_ALLOW_DESTRUCTIVE=1 for that one run.
# ---------------------------------------------------------------------------
DESTRUCTIVE_KEYS='^(command|cmd)\+(q|w)$|^(command|cmd)\+(delete|backspace)$|^(command|cmd)\+shift\+(delete|backspace)$|^(command|cmd)\+(option|alt)\+escape$'

guard_destructive_key() {
  local key_name="$1" normalized
  normalized=$(printf '%s' "$key_name" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  printf '%s' "$normalized" | grep -qE "$DESTRUCTIVE_KEYS" || return 0
  [ "${CREWLY_DESKTOP_ALLOW_DESTRUCTIVE:-}" = "1" ] && return 0
  cu_fail "destructive_blocked" \
    "\"$key_name\" quits an app or deletes data, which desktop control refuses by default. Achieve the goal another way, or ask the owner to re-run with CREWLY_DESKTOP_ALLOW_DESTRUCTIVE=1." \
    "$(jq -n --arg k "$key_name" '{key:$k, override:"CREWLY_DESKTOP_ALLOW_DESTRUCTIVE=1"}')"
}

# ---------------------------------------------------------------------------
# Apps that are never automated
#
# Typing into a password manager or the Keychain is indistinguishable from
# exfiltrating credentials, so focus is refused rather than audited.
# ---------------------------------------------------------------------------
DENIED_APPS='^(system settings|system preferences|keychain access|1password|1password 7|1password 8|bitwarden|lastpass|dashlane|passwords)$'

guard_denied_app() {
  local app_name="$1" normalized
  normalized=$(printf '%s' "$app_name" | tr '[:upper:]' '[:lower:]')
  printf '%s' "$normalized" | grep -qE "$DENIED_APPS" || return 0
  cu_fail "app_not_allowed" \
    "Desktop control does not drive $app_name — it holds the owner's credentials. Ask the owner to do this part." \
    "$(jq -n --arg a "$app_name" '{app:$a}')"
}

# ---------------------------------------------------------------------------
# Secure text fields
#
# `type` goes to whatever has focus, so without this a password box is just
# another text box. Fails open when the focused element cannot be read: AX
# gaps are common and refusing every unreadable field would break normal use.
# ---------------------------------------------------------------------------
focused_role() {
  osascript -l JavaScript -e '
    ObjC.import("ApplicationServices");
    function roleOf() {
      var sys = $.AXUIElementCreateSystemWide();
      var appRef = Ref();
      if ($.AXUIElementCopyAttributeValue(sys, $.CFSTR("AXFocusedApplication"), appRef) !== 0) return "";
      var elemRef = Ref();
      if ($.AXUIElementCopyAttributeValue(appRef[0], $.CFSTR("AXFocusedUIElement"), elemRef) !== 0) return "";
      var roleRef = Ref();
      if ($.AXUIElementCopyAttributeValue(elemRef[0], $.CFSTR("AXRole"), roleRef) !== 0) return "";
      return ObjC.unwrap(roleRef[0]) || "";
    }
    roleOf();
  ' 2>/dev/null || echo ""
}

guard_secure_input() {
  local role
  role=$(focused_role)
  [ "$role" = "AXSecureTextField" ] || return 0
  cu_fail "secure_field" \
    "The focused field is a password box. Desktop control never types into one — ask the owner to enter it." \
    '{"focusedRole":"AXSecureTextField"}'
}

# ---------------------------------------------------------------------------
# check-permissions — report both TCC grants without performing any action.
# ---------------------------------------------------------------------------
do_check_permissions() {
  local screen ax proc
  screen=$(has_screen_recording); ax=$(has_accessibility); proc=$(asking_process)
  jq -n --arg p "$proc" \
    --argjson s "$([ "$screen" = yes ] && echo true || echo false)" \
    --argjson a "$([ "$ax" = yes ] && echo true || echo false)" \
    '{success:true, action:"check-permissions", askingProcess:$p,
      screenRecording:$s, accessibility:$a,
      ready:($s and $a),
      howTo:"System Settings → Privacy & Security → (Screen & System Audio Recording | Accessibility). Grant to the process named above, then quit and reopen it."}'
}

# ---------------------------------------------------------------------------
# cu_apply_guards
#
# Run every rail that applies to $ACTION. Call once, before dispatch.
#
# Action names differ between the two computer-use forks (`focus` vs
# `focus-app`, and only one has `key`), so the lists below accept both; an
# action a fork does not have simply never matches.
# ---------------------------------------------------------------------------
cu_apply_guards() {
  [ "$ACTION" = "check-permissions" ] && return 0
  [ "$ACTION" = "check-accessibility" ] && return 0

  require_not_stopped
  log_action

  case "$ACTION" in
    screenshot|find|click-text) require_screen_recording ;;
  esac
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|list-apps|click-text|read-ui|get-text)
      require_accessibility ;;
  esac
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|click-text)
      acquire_desktop_lock ;;
  esac
  case "$ACTION" in
    key)   guard_destructive_key "$(printf '%s' "$INPUT" | jq -r '.key // empty')" ;;
    type)  guard_secure_input ;;
    focus|focus-app|open-url) guard_denied_app "$(printf '%s' "$INPUT" | jq -r '.app // empty')" ;;
  esac

  # Dry run: every rail above has passed, so the action *would* be allowed —
  # report that and stop before touching the mouse. Exists because the rails
  # can only be tested honestly by also testing what they let through, and a
  # test suite must not open apps or send keystrokes on the owner's machine.
  # Agents can use it the same way, to check an action before committing to it.
  if [ "${CREWLY_DESKTOP_DRY_RUN:-}" = "1" ]; then
    jq -n --arg a "$ACTION" '{success:true, action:$a, dryRun:true, wouldRun:true}'
    exit 0
  fi
}
