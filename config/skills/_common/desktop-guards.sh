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
# Platform
#
# Everything here is macOS: screencapture, AppleScript, CoreGraphics event
# taps, the Accessibility API. On Linux or Windows the commands are simply
# absent, and the failure an agent saw was `osascript: command not found` —
# which reads as a broken install rather than an unsupported platform, so it
# retried. Saying so plainly is the whole fix until the Linux backend of
# Phase 6 exists.
# ---------------------------------------------------------------------------
require_macos() {
  [ "$(uname -s)" = "Darwin" ] && return 0
  cu_fail "unsupported_platform" \
    "Desktop control is macOS-only for now. On $(uname -s) there is no screen to drive from here — use the browser tools for web work, or a skill for anything with an API." \
    "$(jq -n --arg p "$(uname -s)" '{platform:$p, supported:["Darwin"]}')"
}

# ---------------------------------------------------------------------------
# Locked screen
#
# Accessibility does not fail while the screen is locked — it answers with
# rubbish. Every window of every app comes back with role AXApplication and no
# real content, and System Events cannot even name the frontmost process. An
# agent reading that sees a plausible-looking tree and acts on it, clicking
# coordinates that belong to nothing (2026-09-20, found while testing the
# perception layer against a locked Mac).
#
# There is also nothing useful to do on a locked screen, so this is a refusal
# rather than a warning.
# ---------------------------------------------------------------------------
screen_is_locked() {
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics");
    ObjC.bindFunction("CGSessionCopyCurrentDictionary", ["id", []]);
    var d = $.CGSessionCopyCurrentDictionary();
    d && ObjC.unwrap(d.objectForKey("CGSSessionScreenIsLocked")) ? "yes" : "no"
  ' 2>/dev/null
}

require_unlocked() {
  [ "$(screen_is_locked)" = "yes" ] || return 0
  cu_fail "screen_locked" \
    "The screen is locked. Accessibility answers with placeholder data while it is, so anything read now would be wrong and anything clicked would land on nothing. Wait for the owner to unlock, or ask them to." \
    '{"recoverable":true}'
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
DESKTOP_SHOTS="${CREWLY_HOME_DIR}/desktop-actions"

# Small enough that a day of them costs a few megabytes, large enough to see
# which window was in front and whether a dialog was open.
THUMB_WIDTH="${CREWLY_DESKTOP_THUMB_WIDTH:-480}"

# capture_thumb <label> → path, or empty when it could not be taken
#
# Failure is silent and empty: an action must never fail because its evidence
# could not be recorded.
capture_thumb() {
  [ "${CREWLY_DESKTOP_AUDIT_SHOTS:-1}" = "1" ] || return 0
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|click-text|click-ref|fill-ref) ;;
    # Handing over to a person: the picture of what the agent is stuck on is
    # the most useful thing the owner gets, especially on a phone.
    request-human) ;;
    *) return 0 ;;
  esac
  local day dir file
  day=$(date -u +%Y-%m-%d)
  dir="${DESKTOP_SHOTS}/${day}"
  mkdir -p "$dir" 2>/dev/null || return 0
  file="${dir}/$(date -u +%H%M%S)-$$-$1.jpg"
  screencapture -x -t jpg "$file" 2>/dev/null || return 0
  sips --resampleWidth "$THUMB_WIDTH" "$file" --out "$file" >/dev/null 2>&1 || true
  printf '%s' "$file"
}

log_action() {
  local before
  before=$(capture_thumb before)
  jq -nc --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg s "$HOLDER" --arg a "$ACTION" \
    --argjson i "$INPUT" --arg b "$before" \
    '{at:$t, session:$s, action:$a, input:$i} + (if $b == "" then {} else {before:$b} end)' \
    >> "$DESKTOP_LOG" 2>/dev/null || true
  # The "after" shot is taken on the way out, once the action has landed, so
  # the pair shows cause and effect rather than two pictures of the same
  # moment. Only for actions that got past every rail — a refusal changed
  # nothing and a second identical picture is just noise.
  CU_LOG_BEFORE="$before"
}

# cu_log_after — called once the action has run.
cu_log_after() {
  [ -n "${CU_LOG_BEFORE:-}" ] || return 0
  local after
  # Give the UI a moment to actually change; without it the pair is useless.
  sleep 0.35
  after=$(capture_thumb after)
  [ -n "$after" ] || return 0
  jq -nc --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg s "$HOLDER" --arg a "$ACTION" \
    --arg b "$CU_LOG_BEFORE" --arg f "$after" \
    '{at:$t, session:$s, action:$a, phase:"after", before:$b, after:$f}' \
    >> "$DESKTOP_LOG" 2>/dev/null || true
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
# The perception helper
#
# A small Swift binary (AX tree, Vision OCR, display list). Compiled on first
# use and cached, because shipping a binary in a skill directory means
# shipping an unsigned one a user cannot verify, and because the source is
# the thing worth reviewing. Rebuilt whenever the source is newer.
#
# Swift rather than JXA: the scripting bridge costs a round trip per
# attribute, so reading one window took seconds — too slow to do before every
# action. Raw AXUIElement does it in tens of milliseconds.
# ---------------------------------------------------------------------------
PERCEIVE_SRC="${CREWLY_SKILLS_COMMON:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/desktop-perceive.swift"
PERCEIVE_BIN="${CREWLY_HOME_DIR}/bin/desktop-perceive"

cu_perceive() {
  if [ ! -x "$PERCEIVE_BIN" ] || [ "$PERCEIVE_SRC" -nt "$PERCEIVE_BIN" ]; then
    if ! command -v swiftc >/dev/null 2>&1; then
      cu_fail "toolchain_missing" \
        "Element-level perception needs swiftc, which comes with the Xcode Command Line Tools. Install them with: xcode-select --install" \
        '{"install":"xcode-select --install"}'
    fi
    mkdir -p "$(dirname "$PERCEIVE_BIN")"
    if ! swiftc -O -o "$PERCEIVE_BIN" "$PERCEIVE_SRC" 2>"${CREWLY_HOME_DIR}/desktop-perceive-build.log"; then
      cu_fail "build_failed" \
        "Could not build the perception helper. See ${CREWLY_HOME_DIR}/desktop-perceive-build.log." \
        "$(jq -n --arg l "${CREWLY_HOME_DIR}/desktop-perceive-build.log" '{log:$l}')"
    fi
  fi
  "$PERCEIVE_BIN" "$@"
}

# ---------------------------------------------------------------------------
# Presence: the banner, the hotkey, and the eye on the owner's own input
#
# The browser line has shown a takeover banner since April; the desktop showed
# nothing, and a pointer that starts moving by itself is the difference
# between automation and a haunting. The resident process owns no policy — it
# writes the same desktop.stop / desktop.pause files these rails already read,
# so it can die without leaving anything un-enforced.
#
# Started on demand and refreshed before each action; it exits by itself once
# the refreshes stop, so a crashed agent cannot leave a banner claiming to be
# working.
# ---------------------------------------------------------------------------
PRESENCE_SRC="${CREWLY_SKILLS_COMMON:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/desktop-presence.swift"
PRESENCE_BIN="${CREWLY_HOME_DIR}/bin/desktop-presence"
DESKTOP_PAUSE="${CREWLY_HOME_DIR}/desktop.pause"

cu_presence() {
  # Never fatal: an agent that cannot show a banner should still be stoppable
  # by the rails, and failing the action would be worse than a missing banner.
  [ "${CREWLY_DESKTOP_NO_BANNER:-}" = "1" ] && return 0
  if [ ! -x "$PRESENCE_BIN" ] || [ "$PRESENCE_SRC" -nt "$PRESENCE_BIN" ]; then
    command -v swiftc >/dev/null 2>&1 || return 0
    mkdir -p "$(dirname "$PRESENCE_BIN")"
    swiftc -O -o "$PRESENCE_BIN" "$PRESENCE_SRC" 2>"${CREWLY_HOME_DIR}/desktop-presence-build.log" || return 0
  fi
  "$PRESENCE_BIN" "$@" >/dev/null 2>&1 || true
}

# Show (or refresh) the banner for this action.
cu_presence_refresh() {
  local goal="${CREWLY_AGENT_GOAL:-$ACTION}"
  cu_presence begin --agent "$HOLDER" --goal "$goal"
  # The window only exists while a foreground process is running; start one
  # if none is.
  pgrep -f "desktop-presence begin .*--foreground" >/dev/null 2>&1 || {
    nohup "$PRESENCE_BIN" begin --agent "$HOLDER" --goal "$goal" --foreground >/dev/null 2>&1 &
  }
}

# ---------------------------------------------------------------------------
# Paused
#
# Distinct from stopped: the owner reached for the mouse, or pressed Pause.
# The task is not abandoned — it waits, and the same banner resumes it. A
# refusal rather than a block, because a blocked shell holds the desktop lock
# and would stop the owner's own agents too.
# ---------------------------------------------------------------------------
require_not_paused() {
  [ -f "$DESKTOP_PAUSE" ] || return 0
  cu_fail "paused" \
    "Desktop control is paused — the owner is using the machine. Wait, and try again when they hand it back; the task is not cancelled." \
    '{"recoverable":true}'
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
  # Platform first: on the wrong OS not even "check what permissions I have"
  # has an answer, and `osascript: command not found` reads as a broken
  # install rather than an unsupported platform.
  require_macos
  [ "$ACTION" = "check-permissions" ] && return 0
  [ "$ACTION" = "check-accessibility" ] && return 0
  # Listing screens reads no window and touches nothing.
  [ "$ACTION" = "displays" ] && return 0
  # Asking for a person is how an agent gets *out* of being stuck, so it must
  # work while paused — refusing it would leave the agent with nothing to do
  # but retry the thing it already cannot do.
  [ "$ACTION" = "request-human" ] && { require_macos; log_action; return 0; }

  require_not_stopped
  log_action

  # Permanent policy first, before anything transient. Both "you may not press
  # ⌘Q" and "the screen is locked" can be true at once, and answering with the
  # transient one invites the agent to wait and retry something that will never
  # be allowed. These are pure string checks, so they also work on a locked
  # screen where reading the UI would not.
  case "$ACTION" in
    key)   guard_destructive_key "$(printf '%s' "$INPUT" | jq -r '.key // empty')" ;;
    focus|focus-app|open-url) guard_denied_app "$(printf '%s' "$INPUT" | jq -r '.app // empty')" ;;
  esac

  # Then the transient conditions, cheapest first.
  require_not_paused
  require_unlocked

  case "$ACTION" in
    screenshot|find|click-text|ocr) require_screen_recording ;;
  esac
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|list-apps|click-text|read-ui|get-text|\
    snapshot|click-ref|fill-ref|resolve|wait-for)
      require_accessibility ;;
  esac

  # Reads the focused element, so it has to come after the lock and permission
  # checks — on a locked screen the answer would be meaningless.
  # fill-ref's own secure-field refusal lives in the perception helper, which
  # reads the target element's role directly instead of guessing from focus.
  case "$ACTION" in
    type) guard_secure_input ;;
  esac

  # Only actions that change something take the lock. Looking (snapshot, ocr,
  # resolve, wait-for) must stay free: an agent waiting its turn still needs
  # to see, and two agents reading at once cannot corrupt anything.
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|click-text|click-ref|fill-ref)
      acquire_desktop_lock ;;
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

  # The banner goes up last, and only for actions that will actually move
  # something. Reading the screen is not taking the machine over, and a dry
  # run moves nothing at all — raising it for either would cry wolf, and a
  # banner the owner learns to ignore is worse than none.
  case "$ACTION" in
    click|move|type|key|scroll|drag|focus|focus-app|open-url|click-text|click-ref|fill-ref)
      cu_presence_refresh ;;
  esac
}
