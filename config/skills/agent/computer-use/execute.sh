#!/usr/bin/env bash
# =============================================================================
# Computer Use — Self-Contained macOS Desktop Control
#
# A single-file skill for programmatic desktop interaction on macOS.
# Uses CoreGraphics (kCGSessionEventTap), screencapture, and AppleScript.
#
# Usage:
#   bash execute.sh '{"action":"screenshot"}'
#   bash execute.sh '{"action":"click","x":500,"y":300}'
#   bash execute.sh '{"action":"type","text":"hello"}'
#
# All coordinates are in SCREEN POINTS (not backing pixels).
# Screenshots are automatically downscaled to match screen coordinates.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source common library for read_json_input, error_exit, require_param
source "${SCRIPT_DIR}/../_common/lib.sh"

# Temp directory for screenshots
TMPDIR_CU="${TMPDIR:-/tmp}/crewly-computer-use"
mkdir -p "$TMPDIR_CU"

# ---------------------------------------------------------------------------
# Read and parse JSON input
# ---------------------------------------------------------------------------
INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "No JSON input provided"

ACTION=$(echo "$INPUT" | jq -r '.action // empty')
[ -z "$ACTION" ] && error_exit "Missing required parameter: action"

# ---------------------------------------------------------------------------
# Helper: get screen dimensions and scale factor
# ---------------------------------------------------------------------------
get_screen_info() {
  osascript -l JavaScript -e '
    ObjC.import("AppKit");
    var screen = $.NSScreen.mainScreen;
    var frame = screen.frame;
    var w = frame.size.width;
    var h = frame.size.height;
    var scale = screen.backingScaleFactor;
    JSON.stringify({width: w, height: h, scale: scale});
  '
}

# ---------------------------------------------------------------------------
# Action: screenshot
# Captures screen, downscales to screen coordinates (1px = 1 screen point),
# optionally overlays a grid, optionally crops.
# ---------------------------------------------------------------------------
do_screenshot() {
  local output="${TMPDIR_CU}/screen_$(date +%s%N).png"
  local grid=$(echo "$INPUT" | jq -r '.grid // empty')
  local crop_json=$(echo "$INPUT" | jq -r '.crop // empty')

  # Capture full screen (silent)
  screencapture -x "$output"

  # Get backing scale factor
  local scale_int
  scale_int=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); Math.round($.NSScreen.mainScreen.backingScaleFactor);')

  # Get pixel dimensions of captured image
  local img_w
  img_w=$(sips -g pixelWidth "$output" | tail -1 | awk '{print $2}')

  # Downscale so 1 pixel = 1 screen point
  if [ "$scale_int" -gt 1 ]; then
    local target_w=$((img_w / scale_int))
    sips --resampleWidth "$target_w" "$output" --out "$output" >/dev/null 2>&1
  fi

  # Re-read dimensions after downscale
  img_w=$(sips -g pixelWidth "$output" | tail -1 | awk '{print $2}')
  local img_h
  img_h=$(sips -g pixelHeight "$output" | tail -1 | awk '{print $2}')

  # Grid overlay (red lines every 100 screen points with labels)
  if [ "$grid" = "true" ]; then
    python3 - "$output" <<'PYEOF'
import sys
from PIL import Image, ImageDraw, ImageFont

path = sys.argv[1]
img = Image.open(path)
draw = ImageDraw.Draw(img)
w, h = img.size
step = 100

try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
except Exception:
    font = ImageFont.load_default()

for x in range(0, w, step):
    draw.line([(x, 0), (x, h)], fill="red", width=1)
    draw.text((x + 2, 2), str(x), fill="red", font=font)

for y in range(0, h, step):
    draw.line([(0, y), (w, y)], fill="red", width=1)
    draw.text((2, y + 2), str(y), fill="red", font=font)

img.save(path)
PYEOF
  fi

  # Crop support: {x, y, w, h} in screen coordinates
  if [ -n "$crop_json" ]; then
    local cx cy cw ch
    cx=$(echo "$INPUT" | jq -r '.crop.x')
    cy=$(echo "$INPUT" | jq -r '.crop.y')
    cw=$(echo "$INPUT" | jq -r '.crop.w')
    ch=$(echo "$INPUT" | jq -r '.crop.h')
    local cropped="${TMPDIR_CU}/crop_$(date +%s%N).png"
    python3 - "$output" "$cx" "$cy" "$cw" "$ch" "$cropped" <<'PYEOF'
import sys
from PIL import Image

path, cx, cy, cw, ch, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
img = Image.open(path)
cropped = img.crop((cx, cy, cx + cw, cy + ch))
cropped.save(out)
PYEOF
    output="$cropped"
    img_w="$cw"
    img_h="$ch"
  fi

  # Return result as JSON
  jq -n \
    --arg path "$output" \
    --argjson width "$img_w" \
    --argjson height "$img_h" \
    --argjson scale "$scale_int" \
    '{action:"screenshot", path:$path, width:$width, height:$height, scale:$scale, note:"Coordinates are in screen points. 1 pixel = 1 screen point."}'
}

# ---------------------------------------------------------------------------
# Action: click (left, right, double)
# Uses CoreGraphics with kCGSessionEventTap for reliable clicking.
# ---------------------------------------------------------------------------
do_click() {
  local x y button
  x=$(echo "$INPUT" | jq -r '.x // empty')
  y=$(echo "$INPUT" | jq -r '.y // empty')
  button=$(echo "$INPUT" | jq -r '.button // "left"')
  require_param "x" "$x"
  require_param "y" "$y"

  case "$button" in
    left)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var p = \$.CGPointMake($x, $y);
        var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, mv);
        delay(0.1);
        var dn = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, dn);
        delay(0.05);
        var up = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, up);
      "
      ;;
    right)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var p = \$.CGPointMake($x, $y);
        var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, mv);
        delay(0.1);
        var dn = \$.CGEventCreateMouseEvent(null, \$.kCGEventRightMouseDown, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, dn);
        delay(0.05);
        var up = \$.CGEventCreateMouseEvent(null, \$.kCGEventRightMouseUp, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, up);
      "
      ;;
    double)
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var p = \$.CGPointMake($x, $y);
        var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p, 0);
        \$.CGEventPost(\$.kCGSessionEventTap, mv);
        delay(0.1);
        var dn = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, p, 0);
        \$.CGEventSetIntegerValueField(dn, \$.kCGMouseEventClickState, 2);
        \$.CGEventPost(\$.kCGSessionEventTap, dn);
        delay(0.05);
        var up = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, p, 0);
        \$.CGEventSetIntegerValueField(up, \$.kCGMouseEventClickState, 2);
        \$.CGEventPost(\$.kCGSessionEventTap, up);
      "
      ;;
    *)
      error_exit "Unknown button type: $button (use left, right, or double)"
      ;;
  esac

  jq -n --arg action "click" --arg button "$button" --argjson x "$x" --argjson y "$y" \
    '{action:$action, button:$button, x:$x, y:$y, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: move
# Moves mouse cursor to given screen coordinates.
# ---------------------------------------------------------------------------
do_move() {
  local x y
  x=$(echo "$INPUT" | jq -r '.x // empty')
  y=$(echo "$INPUT" | jq -r '.y // empty')
  require_param "x" "$x"
  require_param "y" "$y"

  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var p = \$.CGPointMake($x, $y);
    var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, mv);
  "

  jq -n --argjson x "$x" --argjson y "$y" '{action:"move", x:$x, y:$y, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: type
# Types text using System Events keystroke.
# Auto-switches to English (ABC) input source first.
# ---------------------------------------------------------------------------
do_type() {
  local text
  text=$(echo "$INPUT" | jq -r '.text // empty')
  require_param "text" "$text"

  # Switch to English (ABC) input source to avoid IME issues
  osascript -l JavaScript -e '
    ObjC.import("Carbon");
    var sources = $.TISCreateInputSourceList($(), false);
    var count = $.CFArrayGetCount(sources);
    for (var i = 0; i < count; i++) {
      var src = $.CFArrayGetValueAtIndex(sources, i);
      var srcId = $.CFStringGetCStringPtr($.TISGetInputSourceProperty(src, $.kTISPropertyInputSourceID), 0);
      if (srcId && (srcId.match(/ABC/) || srcId.match(/US/) || srcId.match(/com\.apple\.keylayout\.ABC/))) {
        $.TISSelectInputSource(src);
        break;
      }
    }
  ' 2>/dev/null || true

  # Type text via System Events
  osascript -e "tell application \"System Events\" to keystroke \"$text\""

  jq -n --arg text "$text" '{action:"type", text:$text, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: key
# Sends a key combination (e.g., "command+c", "return", "shift+tab").
# ---------------------------------------------------------------------------
do_key() {
  local combo
  combo=$(echo "$INPUT" | jq -r '.key // empty')
  require_param "key" "$combo"

  # Parse modifier+key combination
  local modifiers=""
  local key_name=""
  IFS='+' read -ra parts <<< "$combo"

  if [ ${#parts[@]} -eq 1 ]; then
    key_name="${parts[0]}"
  else
    key_name="${parts[-1]}"
    for ((i=0; i<${#parts[@]}-1; i++)); do
      case "${parts[$i]}" in
        command|cmd)   modifiers="${modifiers}command down, " ;;
        shift)         modifiers="${modifiers}shift down, " ;;
        option|alt)    modifiers="${modifiers}option down, " ;;
        control|ctrl)  modifiers="${modifiers}control down, " ;;
      esac
    done
    modifiers="${modifiers%, }"
  fi

  # Map common key names to AppleScript key codes
  local key_code=""
  case "$key_name" in
    return|enter)   key_code="36" ;;
    tab)            key_code="48" ;;
    escape|esc)     key_code="53" ;;
    space)          key_code="49" ;;
    delete|backspace) key_code="51" ;;
    up)             key_code="126" ;;
    down)           key_code="125" ;;
    left)           key_code="123" ;;
    right)          key_code="124" ;;
    f1)             key_code="122" ;;
    f2)             key_code="120" ;;
    f3)             key_code="99" ;;
    f4)             key_code="118" ;;
    f5)             key_code="96" ;;
  esac

  if [ -n "$key_code" ]; then
    if [ -n "$modifiers" ]; then
      osascript -e "tell application \"System Events\" to key code $key_code using {$modifiers}"
    else
      osascript -e "tell application \"System Events\" to key code $key_code"
    fi
  else
    if [ -n "$modifiers" ]; then
      osascript -e "tell application \"System Events\" to keystroke \"$key_name\" using {$modifiers}"
    else
      osascript -e "tell application \"System Events\" to keystroke \"$key_name\""
    fi
  fi

  jq -n --arg combo "$combo" '{action:"key", key:$combo, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: scroll
# Scrolls at the given position (or current mouse location).
# ---------------------------------------------------------------------------
do_scroll() {
  local x y dx dy
  x=$(echo "$INPUT" | jq -r '.x // empty')
  y=$(echo "$INPUT" | jq -r '.y // empty')
  dx=$(echo "$INPUT" | jq -r '.dx // "0"')
  dy=$(echo "$INPUT" | jq -r '.dy // "-3"')

  # Move mouse first if coordinates given
  if [ -n "$x" ] && [ -n "$y" ]; then
    osascript -l JavaScript -e "
      ObjC.import('CoreGraphics');
      var p = \$.CGPointMake($x, $y);
      var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p, 0);
      \$.CGEventPost(\$.kCGSessionEventTap, mv);
    "
    sleep 0.1
  fi

  # Scroll using CoreGraphics scroll event
  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var ev = \$.CGEventCreateScrollWheelEvent(null, \$.kCGScrollEventUnitLine, 2, $dy, $dx);
    \$.CGEventPost(\$.kCGSessionEventTap, ev);
  "

  jq -n --arg dx "$dx" --arg dy "$dy" '{action:"scroll", dx:$dx, dy:$dy, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: drag
# Drags from (x1,y1) to (x2,y2).
# ---------------------------------------------------------------------------
do_drag() {
  local x1 y1 x2 y2
  x1=$(echo "$INPUT" | jq -r '.x1 // empty')
  y1=$(echo "$INPUT" | jq -r '.y1 // empty')
  x2=$(echo "$INPUT" | jq -r '.x2 // empty')
  y2=$(echo "$INPUT" | jq -r '.y2 // empty')
  require_param "x1" "$x1"
  require_param "y1" "$y1"
  require_param "x2" "$x2"
  require_param "y2" "$y2"

  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var p1 = \$.CGPointMake($x1, $y1);
    var p2 = \$.CGPointMake($x2, $y2);
    var mv = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, p1, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, mv);
    delay(0.1);
    var dn = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, p1, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, dn);
    delay(0.1);
    var drag = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDragged, p2, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, drag);
    delay(0.1);
    var up = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, p2, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, up);
  "

  jq -n --argjson x1 "$x1" --argjson y1 "$y1" --argjson x2 "$x2" --argjson y2 "$y2" \
    '{action:"drag", from:{x:$x1,y:$y1}, to:{x:$x2,y:$y2}, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: focus
# Brings an application to the foreground.
# ---------------------------------------------------------------------------
do_focus() {
  local app
  app=$(echo "$INPUT" | jq -r '.app // empty')
  require_param "app" "$app"

  osascript -e "
    tell application \"$app\"
      activate
    end tell
  "
  sleep 0.3

  jq -n --arg app "$app" '{action:"focus", app:$app, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: open-url
# Opens a URL in a browser. Bypasses keyboard entirely.
# ---------------------------------------------------------------------------
do_open_url() {
  local url app_name
  url=$(echo "$INPUT" | jq -r '.url // empty')
  app_name=$(echo "$INPUT" | jq -r '.app // "Safari"')
  require_param "url" "$url"

  osascript -e "tell application \"$app_name\" to open location \"$url\""
  osascript -e "tell application \"$app_name\" to activate"
  sleep 0.5

  jq -n --arg url "$url" --arg app "$app_name" '{action:"open-url", url:$url, app:$app, status:"ok"}'
}

# ---------------------------------------------------------------------------
# Action: list-apps
# Lists all running GUI applications.
# ---------------------------------------------------------------------------
do_list_apps() {
  local apps
  apps=$(osascript -e '
    tell application "System Events"
      set appList to {}
      repeat with proc in (every process whose background only is false)
        set end of appList to name of proc
      end repeat
      set AppleScript'\''s text item delimiters to ","
      return appList as text
    end tell
  ')

  # Convert comma-separated list to JSON array
  echo "$apps" | tr ',' '\n' | jq -R -s '
    split("\n") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) |
    {action: "list-apps", apps: ., count: length}
  '
}

# ---------------------------------------------------------------------------
# Action dispatch
# ---------------------------------------------------------------------------
case "$ACTION" in
  screenshot)  do_screenshot ;;
  click)       do_click ;;
  move)        do_move ;;
  type)        do_type ;;
  key)         do_key ;;
  scroll)      do_scroll ;;
  drag)        do_drag ;;
  focus)       do_focus ;;
  open-url)    do_open_url ;;
  list-apps)   do_list_apps ;;
  *)           error_exit "Unknown action: $ACTION. Valid: screenshot, click, move, type, key, scroll, drag, focus, open-url, list-apps" ;;
esac
