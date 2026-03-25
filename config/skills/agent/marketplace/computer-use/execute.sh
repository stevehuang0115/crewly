#!/bin/bash
# =============================================================================
# Desktop Automation (Computer Use) Skill
# Controls macOS desktop: screenshots, mouse, keyboard, UI reading
# Uses native macOS APIs — no external dependencies required
# Includes Accessibility API for reading app content without screenshots
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"screenshot|move|click|type|list-apps|read-ui|get-text|scroll|focus-app|check-accessibility\", ...}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
require_param "action" "$ACTION"

# -----------------------------------------------------------------------------
# Accessibility permission check helper
# Returns 0 if trusted, 1 if not. Caches result for the session.
# -----------------------------------------------------------------------------
_AX_CHECKED=""
_AX_TRUSTED=""
check_ax_permission() {
  if [ -z "$_AX_CHECKED" ]; then
    # Use swift one-liner to call AXIsProcessTrusted()
    _AX_TRUSTED=$(swift -e 'import Cocoa; print(AXIsProcessTrusted())' 2>/dev/null || echo "false")
    _AX_CHECKED="1"
  fi
  [ "$_AX_TRUSTED" = "true" ]
}

require_ax_permission() {
  if ! check_ax_permission; then
    error_exit "Accessibility permission required but not granted. To fix: System Settings > Privacy & Security > Accessibility > enable Terminal (or whichever terminal app is running this script). Then restart the terminal. Actions needing this: read-ui, get-text."
  fi
}

# -----------------------------------------------------------------------------
# check-accessibility — report whether Accessibility permission is granted
# -----------------------------------------------------------------------------
do_check_accessibility() {
  if check_ax_permission; then
    echo "{\"success\":true,\"action\":\"check-accessibility\",\"trusted\":true,\"message\":\"Accessibility permission is granted. read-ui and get-text will work.\"}"
  else
    echo "{\"success\":true,\"action\":\"check-accessibility\",\"trusted\":false,\"message\":\"Accessibility permission NOT granted. read-ui and get-text will fail. Fix: System Settings > Privacy & Security > Accessibility > enable your terminal app.\"}"
  fi
}

# -----------------------------------------------------------------------------
# screenshot — capture the screen to a file
# -----------------------------------------------------------------------------
do_screenshot() {
  local output
  output=$(printf '%s' "$INPUT" | jq -r '.output // "/tmp/screenshot.png"')

  # Ensure output directory exists
  mkdir -p "$(dirname "$output")"

  screencapture -x "$output" 2>/dev/null

  if [ -f "$output" ]; then
    local size
    size=$(stat -f%z "$output" 2>/dev/null || stat -c%s "$output" 2>/dev/null || echo "unknown")
    echo "{\"success\":true,\"action\":\"screenshot\",\"file\":\"$output\",\"size\":$size}"
  else
    error_exit "Screenshot failed — file not created"
  fi
}

# -----------------------------------------------------------------------------
# move — move mouse cursor to (x, y)
# -----------------------------------------------------------------------------
do_move() {
  local x y
  x=$(printf '%s' "$INPUT" | jq -r '.x // empty')
  y=$(printf '%s' "$INPUT" | jq -r '.y // empty')
  require_param "x" "$x"
  require_param "y" "$y"

  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var point = $.CGPointMake($x, $y);
    var event = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
    $.CGEventPost($.kCGHIDEventTap, event);
    'moved';
  " >/dev/null 2>&1

  echo "{\"success\":true,\"action\":\"move\",\"x\":$x,\"y\":$y}"
}

# -----------------------------------------------------------------------------
# click — click at (x, y) with optional button type
# -----------------------------------------------------------------------------
do_click() {
  local x y button
  x=$(printf '%s' "$INPUT" | jq -r '.x // empty')
  y=$(printf '%s' "$INPUT" | jq -r '.y // empty')
  button=$(printf '%s' "$INPUT" | jq -r '.button // "left"')
  require_param "x" "$x"
  require_param "y" "$y"

  case "$button" in
    left)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var point = $.CGPointMake($x, $y);
        var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
        $.CGEventPost($.kCGHIDEventTap, move);
        var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, 0);
        $.CGEventPost($.kCGHIDEventTap, down);
        var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, 0);
        $.CGEventPost($.kCGHIDEventTap, up);
        'clicked';
      " >/dev/null 2>&1
      ;;
    right)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var point = $.CGPointMake($x, $y);
        var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
        $.CGEventPost($.kCGHIDEventTap, move);
        var down = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, point, $.kCGMouseButtonRight);
        $.CGEventPost($.kCGHIDEventTap, down);
        var up = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, point, $.kCGMouseButtonRight);
        $.CGEventPost($.kCGHIDEventTap, up);
        'clicked';
      " >/dev/null 2>&1
      ;;
    double)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var point = $.CGPointMake($x, $y);
        var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, 0);
        $.CGEventPost($.kCGHIDEventTap, move);
        var down1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, 0);
        $.CGEventSetIntegerValueField(down1, $.kCGMouseEventClickState, 1);
        $.CGEventPost($.kCGHIDEventTap, down1);
        var up1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, 0);
        $.CGEventSetIntegerValueField(up1, $.kCGMouseEventClickState, 1);
        $.CGEventPost($.kCGHIDEventTap, up1);
        delay(0.05);
        var down2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, 0);
        $.CGEventSetIntegerValueField(down2, $.kCGMouseEventClickState, 2);
        $.CGEventPost($.kCGHIDEventTap, down2);
        var up2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, 0);
        $.CGEventSetIntegerValueField(up2, $.kCGMouseEventClickState, 2);
        $.CGEventPost($.kCGHIDEventTap, up2);
        'double-clicked';
      " >/dev/null 2>&1
      ;;
    *)
      error_exit "Unknown button type: $button (use left, right, or double)"
      ;;
  esac

  echo "{\"success\":true,\"action\":\"click\",\"x\":$x,\"y\":$y,\"button\":\"$button\"}"
}

# -----------------------------------------------------------------------------
# type — simulate keyboard input
# -----------------------------------------------------------------------------
do_type() {
  local text
  text=$(printf '%s' "$INPUT" | jq -r '.text // empty')
  require_param "text" "$text"

  osascript -e "tell application \"System Events\" to keystroke \"$text\"" 2>/dev/null

  local char_count=${#text}
  echo "{\"success\":true,\"action\":\"type\",\"characters\":$char_count}"
}

# -----------------------------------------------------------------------------
# list-apps — list running GUI apps with bundle IDs
# -----------------------------------------------------------------------------
do_list_apps() {
  local result
  result=$(osascript -l JavaScript -e '
    var app = Application("System Events");
    var procs = app.processes.whose({backgroundOnly: false});
    var result = [];
    for (var i = 0; i < procs.length; i++) {
      try {
        var p = procs[i];
        result.push({name: p.name(), bundleId: p.bundleIdentifier() || "unknown"});
      } catch(e) {}
    }
    JSON.stringify(result);
  ' 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to list apps: $result"
  fi
  echo "{\"success\":true,\"action\":\"list-apps\",\"apps\":$result}"
}

# -----------------------------------------------------------------------------
# focus-app — bring an app to the foreground
# -----------------------------------------------------------------------------
do_focus_app() {
  local app_name
  app_name=$(printf '%s' "$INPUT" | jq -r '.appName // empty')
  require_param "appName" "$app_name"

  osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$app_name');
    proc.frontmost = true;
    'focused';
  " >/dev/null 2>&1

  echo "{\"success\":true,\"action\":\"focus-app\",\"appName\":\"$app_name\"}"
}

# -----------------------------------------------------------------------------
# read-ui — read UI element tree from a specific app via Accessibility API
# Returns structured data: element roles, titles, values, positions
# -----------------------------------------------------------------------------
do_read_ui() {
  local app_name max_depth
  app_name=$(printf '%s' "$INPUT" | jq -r '.appName // empty')
  max_depth=$(printf '%s' "$INPUT" | jq -r '.maxDepth // 8')
  require_param "appName" "$app_name"
  require_ax_permission

  local result
  result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$app_name');
    var maxDepth = $max_depth;
    var nodeCount = 0;
    var MAX_NODES = 500;

    function readElement(el, depth) {
      if (depth > maxDepth || nodeCount >= MAX_NODES) return null;
      nodeCount++;
      var info = {};
      try { info.role = el.role(); } catch(e) { info.role = 'unknown'; }
      try { info.title = el.title() || ''; } catch(e) { info.title = ''; }
      try { info.value = (el.value() !== null && el.value() !== undefined) ? String(el.value()).substring(0, 500) : ''; } catch(e) { info.value = ''; }
      try { info.description = el.description() || ''; } catch(e) { info.description = ''; }
      try { var p = el.position(); info.position = {x: p[0], y: p[1]}; } catch(e) {}
      try { var s = el.size(); info.size = {w: s[0], h: s[1]}; } catch(e) {}

      // Only include non-empty fields
      if (!info.title) delete info.title;
      if (!info.value) delete info.value;
      if (!info.description) delete info.description;

      if (depth < maxDepth && nodeCount < MAX_NODES) {
        try {
          var children = el.uiElements();
          if (children.length > 0) {
            info.children = [];
            for (var i = 0; i < Math.min(children.length, 50); i++) {
              var child = readElement(children[i], depth + 1);
              if (child) info.children.push(child);
            }
          }
        } catch(e) {}
      }
      return info;
    }

    var windows = proc.windows();
    var result = {windowCount: windows.length, windows: []};
    for (var w = 0; w < windows.length; w++) {
      var win = windows[w];
      var winInfo = readElement(win, 0);
      try { winInfo.windowTitle = win.title() || win.name() || 'Window ' + w; } catch(e) { winInfo.windowTitle = 'Window ' + w; }
      result.windows.push(winInfo);
    }
    JSON.stringify(result);
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to read UI (check Accessibility permission): $result"
  fi
  echo "{\"success\":true,\"action\":\"read-ui\",\"appName\":\"$app_name\",\"maxDepth\":$max_depth,\"ui\":$result}"
}

# -----------------------------------------------------------------------------
# get-text — extract all visible text content from an app's UI
# Faster than read-ui when you only need text, not structure
# -----------------------------------------------------------------------------
do_get_text() {
  local app_name max_depth
  app_name=$(printf '%s' "$INPUT" | jq -r '.appName // empty')
  max_depth=$(printf '%s' "$INPUT" | jq -r '.maxDepth // 25')
  require_param "appName" "$app_name"
  require_ax_permission

  local result
  result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$app_name');
    var texts = [];
    var maxDepth = $max_depth;

    // Generic descriptions to skip (not real content)
    var skipDescs = {'group':1,'button':1,'scroll area':1,'collection':1,'text':1,
      'standard window':1,'image':1,'tab bar':1,'close button':1,
      'full screen button':1,'minimize button':1};

    function extractText(el, depth) {
      if (depth > maxDepth) return;
      var role = 'unknown';
      try { role = el.role(); } catch(e) {}

      try {
        var val = el.value();
        if (val !== null && val !== undefined && String(val).trim().length > 0) {
          texts.push({role: role, text: String(val).substring(0, 1000)});
        }
      } catch(e) {}
      try {
        var title = el.title();
        if (title && title.trim().length > 0) {
          texts.push({role: role, text: title});
        }
      } catch(e) {}
      try {
        var desc = el.description();
        if (desc && desc.trim().length > 0 && !skipDescs[desc.toLowerCase()]) {
          texts.push({role: role, text: desc});
        }
      } catch(e) {}
      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 100); i++) {
          extractText(children[i], depth + 1);
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) {
      extractText(windows[w], 0);
    }

    // Deduplicate
    var seen = {};
    var unique = [];
    for (var i = 0; i < texts.length; i++) {
      var key = texts[i].text;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(texts[i]);
      }
    }
    JSON.stringify(unique);
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to get text (check Accessibility permission): $result"
  fi
  echo "{\"success\":true,\"action\":\"get-text\",\"appName\":\"$app_name\",\"maxDepth\":$max_depth,\"texts\":$result}"
}

# -----------------------------------------------------------------------------
# scroll — scroll within the focused app or a specific app
# direction: up, down, left, right
# amount: number of scroll units (default 3)
# -----------------------------------------------------------------------------
do_scroll() {
  local direction amount app_name
  direction=$(printf '%s' "$INPUT" | jq -r '.direction // "down"')
  amount=$(printf '%s' "$INPUT" | jq -r '.amount // 3')
  app_name=$(printf '%s' "$INPUT" | jq -r '.appName // empty')

  # Focus app first if specified
  if [ -n "$app_name" ]; then
    osascript -l JavaScript -e "
      var app = Application('System Events');
      var proc = app.processes.byName('$app_name');
      proc.frontmost = true;
    " >/dev/null 2>&1
    sleep 0.3
  fi

  local dx=0 dy=0
  case "$direction" in
    up)    dy=$amount ;;
    down)  dy=$(( -amount )) ;;
    left)  dx=$amount ;;
    right) dx=$(( -amount )) ;;
    *)     error_exit "Unknown direction: $direction (use up, down, left, right)" ;;
  esac

  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, $dy, $dx);
    $.CGEventPost($.kCGHIDEventTap, event);
    'scrolled';
  " >/dev/null 2>&1

  echo "{\"success\":true,\"action\":\"scroll\",\"direction\":\"$direction\",\"amount\":$amount}"
}

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------
case "$ACTION" in
  screenshot)           do_screenshot ;;
  move)                 do_move ;;
  click)                do_click ;;
  type)                 do_type ;;
  list-apps)            do_list_apps ;;
  focus-app)            do_focus_app ;;
  read-ui)              do_read_ui ;;
  get-text)             do_get_text ;;
  scroll)               do_scroll ;;
  check-accessibility)  do_check_accessibility ;;
  *)                    error_exit "Unknown action: $ACTION (use screenshot, move, click, type, list-apps, focus-app, read-ui, get-text, scroll, check-accessibility)" ;;
esac
