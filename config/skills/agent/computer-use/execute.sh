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
#   bash execute.sh '{"action":"find","mode":"button"}'
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

  # Crop FIRST, then grid — so grid labels show absolute screen coordinates
  local origin_x=0 origin_y=0
  if [ -n "$crop_json" ]; then
    local cx cy cw ch
    cx=$(echo "$INPUT" | jq -r '.crop.x')
    cy=$(echo "$INPUT" | jq -r '.crop.y')
    cw=$(echo "$INPUT" | jq -r '.crop.w')
    ch=$(echo "$INPUT" | jq -r '.crop.h')
    origin_x="$cx"
    origin_y="$cy"
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

  # Grid overlay — labels show ABSOLUTE screen coordinates
  # Grid step adapts to image size: dense for small crops, sparse for full screen
  if [ "$grid" = "true" ]; then
    python3 - "$output" "$origin_x" "$origin_y" <<'PYEOF'
import sys
from PIL import Image, ImageDraw, ImageFont

path = sys.argv[1]
ox, oy = int(sys.argv[2]), int(sys.argv[3])
img = Image.open(path)
draw = ImageDraw.Draw(img)
w, h = img.size

# Adaptive grid step: aim for ~8-12 cells across the image
step = max(25, min(100, w // 10))
# Round to nearest 25
step = (step // 25) * 25

try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", max(10, min(14, w // 80)))
except Exception:
    font = ImageFont.load_default()

# Vertical lines with absolute X labels
for x in range(0, w, step):
    draw.line([(x, 0), (x, h)], fill="red", width=1)
    label = str(ox + x)  # absolute screen coordinate
    draw.text((x + 2, 2), label, fill="red", font=font)

# Horizontal lines with absolute Y labels
for y in range(0, h, step):
    draw.line([(0, y), (w, y)], fill="red", width=1)
    label = str(oy + y)
    draw.text((2, y + 2), label, fill="red", font=font)

img.save(path)
PYEOF
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
# Action: find
# Locates UI elements by pixel-level color/contrast analysis.
# Takes a full-resolution screenshot, analyzes it with Python/Pillow,
# and returns screen-point coordinates of found elements.
# Modes: button (bright rectangles), avatar (colored circles), color (target RGB).
# ---------------------------------------------------------------------------
do_find() {
  local mode target region
  mode=$(printf '%s' "$INPUT" | jq -r '.mode // "button"')
  target=$(printf '%s' "$INPUT" | jq -r '.target // empty')
  region=$(printf '%s' "$INPUT" | jq -c '.region // null')

  # Take screenshot at FULL resolution for pixel-accurate scanning
  local scan_file="/tmp/cu-find-scan.png"
  screencapture -x "$scan_file" 2>/dev/null

  local scale_int
  scale_int=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); Math.round($.NSScreen.mainScreen.backingScaleFactor);' 2>/dev/null || echo "2")

  CU_SCALE="$scale_int" CU_MODE="$mode" CU_TARGET="$target" CU_REGION="$region" python3 << 'PYEOF'
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

img = Image.open('/tmp/cu-find-scan.png')
W, H = img.size
S = int(os.environ.get('CU_SCALE', '2'))
mode = os.environ.get('CU_MODE', 'button')
target = os.environ.get('CU_TARGET', '')
region_json = os.environ.get('CU_REGION', 'null')

# Optional region constraint: {"x":100,"y":200,"w":400,"h":300} in screen coords
region = json.loads(region_json) if region_json != 'null' else None
if region:
    rx, ry, rw, rh = region['x']*S, region['y']*S, region['w']*S, region['h']*S
else:
    rx, ry, rw, rh = 0, 0, W, H

def px(x, y):
    """Get pixel RGB, clamped to image bounds."""
    x, y = max(0, min(x, W-1)), max(0, min(y, H-1))
    return img.getpixel((x, y))[:3]

def to_screen(x, y):
    """Convert pixel coords to screen coords."""
    return x // S, y // S

def cluster_points(points, gap=20):
    """Cluster nearby points by Y proximity."""
    if not points:
        return []
    points.sort(key=lambda p: p[1])
    clusters = [[points[0]]]
    for i in range(1, len(points)):
        if points[i][1] - points[i-1][1] < gap:
            clusters[-1].append(points[i])
        else:
            clusters.append([points[i]])
    return [c for c in clusters if len(c) >= 3]

# ── MODE: text ──────────────────────────────────────────────────
# Uses macOS Vision framework OCR for fast, accurate text detection.
# Finds target text on screen and returns its screen coordinates.
if mode == 'text' and target:
    import subprocess
    # Call Swift Vision OCR (fast, accurate, built into macOS)
    swift_code = r'''
    import Vision
    import AppKit
    import Foundation

    let url = URL(fileURLWithPath: "/tmp/cu-find-scan.png")
    guard let image = NSImage(contentsOf: url),
          let tiffData = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData),
          let cgImage = bitmap.cgImage else {
        print("[]")
        exit(0)
    }
    let imgW = Double(cgImage.width)
    let imgH = Double(cgImage.height)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    var results: [[String: Any]] = []
    for obs in request.results ?? [] {
        if let candidate = obs.topCandidates(1).first {
            let box = obs.boundingBox
            // Convert from Vision coords (bottom-left, 0-1) to pixel coords (top-left)
            let px = box.origin.x * imgW + box.size.width * imgW / 2
            let py = (1.0 - box.origin.y - box.size.height) * imgH + box.size.height * imgH / 2
            results.append([
                "text": candidate.string,
                "px": Int(px),
                "py": Int(py),
                "confidence": candidate.confidence
            ])
        }
    }
    let jsonData = try! JSONSerialization.data(withJSONObject: results)
    print(String(data: jsonData, encoding: .utf8) ?? "[]")
    '''

    proc = subprocess.run(['swift', '-e', swift_code], capture_output=True, text=True, timeout=15)
    ocr_results = json.loads(proc.stdout.strip()) if proc.stdout.strip() else []

    # Search for target text (case-insensitive substring match)
    target_lower = target.lower()
    matches = []
    for r in ocr_results:
        if target_lower in r['text'].lower():
            sx, sy = r['px'] // S, r['py'] // S
            matches.append({'x': sx, 'y': sy, 'text': r['text'], 'confidence': round(r['confidence'], 3)})

    if matches:
        best = matches[0]
        print(json.dumps({'found': True, 'x': best['x'], 'y': best['y'], 'text': best['text'], 'confidence': best['confidence'], 'allMatches': matches[:5]}))
    else:
        # Return all detected text for debugging
        all_texts = [r['text'] for r in ocr_results[:15]]
        print(json.dumps({'found': False, 'target': target, 'textsOnScreen': all_texts}))

# ── MODE: button ────────────────────────────────────────────────
# Find button-like rectangles (white on dark OR bordered on light)
elif mode == 'button':
    buttons = []
    # Scan for horizontal runs of uniform bright OR bordered pixels
    for y in range(ry, ry+rh, 3):
        in_run = False
        run_start = 0
        for x in range(rx, rx+rw, 2):
            r, g, b = px(x, y)
            bright = r > 200 and g > 200 and b > 200
            # Check if this bright pixel has dark neighbors above/below (= button)
            if bright:
                above = px(x, max(0, y-40))
                below = px(x, min(H-1, y+40))
                is_button_pixel = (sum(above)/3 < 120) or (sum(below)/3 < 120)
            else:
                is_button_pixel = False

            if is_button_pixel and not in_run:
                run_start = x
                in_run = True
            elif not is_button_pixel and in_run:
                run_len = x - run_start
                if run_len > 80:
                    cx, cy = to_screen((run_start + x) // 2, y)
                    buttons.append({'x': cx, 'y': cy, 'width': run_len // S})
                in_run = False

    # Cluster
    clusters = []
    buttons.sort(key=lambda b: (b['y'], b['x']))
    if buttons:
        current = [buttons[0]]
        for i in range(1, len(buttons)):
            if abs(buttons[i]['y'] - current[-1]['y']) < 8:
                current.append(buttons[i])
            else:
                if len(current) >= 2:
                    cx = sum(b['x'] for b in current) // len(current)
                    cy = sum(b['y'] for b in current) // len(current)
                    w = max(b['width'] for b in current)
                    clusters.append({'x': cx, 'y': cy, 'width': w, 'height': len(current) * 3})
                current = [buttons[i]]
        if len(current) >= 2:
            cx = sum(b['x'] for b in current) // len(current)
            cy = sum(b['y'] for b in current) // len(current)
            w = max(b['width'] for b in current)
            clusters.append({'x': cx, 'y': cy, 'width': w, 'height': len(current) * 3})

    print(json.dumps({'found': len(clusters), 'elements': clusters[:20]}))

# ── MODE: avatar ────────────────────────────────────────────────
elif mode == 'avatar':
    colored = []
    for y in range(ry + rh//4, ry + 3*rh//4, 2):
        for x in range(rx + rw//4, rx + 3*rw//4, 3):
            r, g, b = px(x, y)
            sat = max(r,g,b) - min(r,g,b)
            if sat > 40 and max(r,g,b) > 80 and min(r,g,b) < 200:
                colored.append((x, y))

    clusters = cluster_points(colored, gap=15)
    avatars = []
    for c in clusters:
        if len(c) >= 5:
            cx, cy = to_screen(
                sum(p[0] for p in c) // len(c),
                sum(p[1] for p in c) // len(c)
            )
            avatars.append({'x': cx + 50, 'y': cy})

    print(json.dumps({'found': len(avatars), 'elements': avatars[:10]}))

# ── MODE: color ─────────────────────────────────────────────────
elif mode == 'color' and target:
    parts = target.split(',')
    tr, tg, tb = int(parts[0]), int(parts[1]), int(parts[2])
    tol = 60
    hits = []
    for y in range(ry, ry+rh, 3):
        for x in range(rx, rx+rw, 3):
            r, g, b = px(x, y)
            if abs(r-tr) < tol and abs(g-tg) < tol and abs(b-tb) < tol:
                hits.append((x, y))
    if hits:
        cx, cy = to_screen(
            sum(p[0] for p in hits) // len(hits),
            sum(p[1] for p in hits) // len(hits)
        )
        print(json.dumps({'found': len(hits), 'center': {'x': cx, 'y': cy}}))
    else:
        print(json.dumps({'found': 0}))

# ── MODE: contrast ──────────────────────────────────────────────
# Find high-contrast edges (useful for finding UI element boundaries)
elif mode == 'contrast':
    edges = []
    for y in range(ry+2, ry+rh-2, 3):
        for x in range(rx+2, rx+rw-2, 3):
            c = px(x, y)
            r_pixel = px(x+4, y)
            d_pixel = px(x, y+4)
            h_diff = abs(sum(c)/3 - sum(r_pixel)/3)
            v_diff = abs(sum(c)/3 - sum(d_pixel)/3)
            if h_diff > 80 or v_diff > 80:
                edges.append((x, y))
    clusters = cluster_points(edges, gap=10)
    elements = []
    for c in clusters:
        if len(c) >= 10:
            cx, cy = to_screen(
                sum(p[0] for p in c) // len(c),
                sum(p[1] for p in c) // len(c)
            )
            elements.append({'x': cx, 'y': cy, 'density': len(c)})
    print(json.dumps({'found': len(elements), 'elements': elements[:20]}))

elif mode == 'near':
    # Find an icon/element near a known text anchor.
    # target = the text to anchor on (found via OCR)
    # Uses pixel scanning around the anchor to find nearby non-text elements.
    # Params via env: CU_NEAR_DIR (right|left|above|below), CU_NEAR_DIST (max distance)
    near_dir = os.environ.get('CU_NEAR_DIR', 'right')
    near_dist = int(os.environ.get('CU_NEAR_DIST', '150'))

    if not target:
        print(json.dumps({'error': 'near mode requires target text'}))
    else:
        # First find anchor text via OCR
        import subprocess
        proc = subprocess.run(['swift', '/tmp/cu-ocr.swift', '/tmp/cu-find-scan.png'],
                            capture_output=True, text=True, timeout=15)
        ocr = json.loads(proc.stdout.strip()) if proc.stdout.strip() else []
        anchor = None
        for r in ocr:
            if target.lower() in r['text'].lower():
                anchor = (r['px'], r['py'])
                break

        if not anchor:
            # Try inverted image for dark themes
            from PIL import ImageOps
            ImageOps.invert(img.convert('RGB')).save('/tmp/cu-find-inverted.png')
            proc2 = subprocess.run(['swift', '/tmp/cu-ocr.swift', '/tmp/cu-find-inverted.png'],
                                capture_output=True, text=True, timeout=15)
            ocr2 = json.loads(proc2.stdout.strip()) if proc2.stdout.strip() else []
            for r in ocr2:
                if target.lower() in r['text'].lower():
                    anchor = (r['px'], r['py'])
                    break

        if not anchor:
            print(json.dumps({'found': False, 'error': f'Anchor text "{target}" not found'}))
        else:
            ax, ay = anchor
            dist_px = near_dist * S
            # Define scan region based on direction
            if near_dir == 'right':
                scan_x1, scan_y1 = ax + 20, ay - 30
                scan_x2, scan_y2 = ax + dist_px, ay + 30
            elif near_dir == 'left':
                scan_x1, scan_y1 = ax - dist_px, ay - 30
                scan_x2, scan_y2 = ax - 20, ay + 30
            elif near_dir == 'above':
                scan_x1, scan_y1 = ax - 30, ay - dist_px
                scan_x2, scan_y2 = ax + 30, ay - 20
            else:  # below
                scan_x1, scan_y1 = ax - 30, ay + 20
                scan_x2, scan_y2 = ax + 30, ay + dist_px

            # Clamp to image bounds
            scan_x1, scan_y1 = max(0, scan_x1), max(0, scan_y1)
            scan_x2, scan_y2 = min(W-1, scan_x2), min(H-1, scan_y2)

            # Scan for non-background pixels (icons, buttons)
            icon_pixels = []
            for y in range(scan_y1, scan_y2, 2):
                for x in range(scan_x1, scan_x2, 2):
                    r, g, b = px(x, y)
                    brightness = (r + g + b) / 3
                    # Icon: medium brightness, not pure white/black
                    if 60 < brightness < 180:
                        icon_pixels.append((x, y))

            if icon_pixels:
                ix = sum(p[0] for p in icon_pixels) // len(icon_pixels)
                iy = sum(p[1] for p in icon_pixels) // len(icon_pixels)
                sx, sy = to_screen(ix, iy)
                asx, asy = to_screen(ax, ay)
                print(json.dumps({
                    'found': True,
                    'x': sx, 'y': sy,
                    'anchor': {'x': asx, 'y': asy, 'text': target},
                    'direction': near_dir
                }))
            else:
                asx, asy = to_screen(ax, ay)
                print(json.dumps({
                    'found': False,
                    'anchor': {'x': asx, 'y': asy},
                    'error': f'No icon found {near_dir} of "{target}"'
                }))

else:
    print(json.dumps({'error': f'Unknown mode: {mode}. Use: text, button, avatar, color, contrast, near'}))
PYEOF

  rm -f "$scan_file"
}

# =============================================================================
# click-text — Find text via OCR and click on it (one-step convenience action)
# =============================================================================
do_click_text() {
  local target
  target=$(printf '%s' "$INPUT" | jq -r '.target // .text // empty')
  require_param "target" "$target"

  # Use find to locate the text
  local find_result
  find_result=$(CU_SCALE="$( osascript -l JavaScript -e 'ObjC.import("AppKit"); Math.round($.NSScreen.mainScreen.backingScaleFactor);' 2>/dev/null || echo 2)" \
    CU_MODE="text" CU_TARGET="$target" CU_REGION="null" \
    bash "${BASH_SOURCE[0]}" "{\"action\":\"find\",\"mode\":\"text\",\"target\":\"$target\"}" 2>&1)

  local found x y
  found=$(echo "$find_result" | jq -r '.found // false')
  x=$(echo "$find_result" | jq -r '.x // empty')
  y=$(echo "$find_result" | jq -r '.y // empty')

  if [ "$found" = "true" ] && [ -n "$x" ] && [ -n "$y" ]; then
    # Click at the found position
    do_click_at "$x" "$y"
    echo "{\"success\":true,\"action\":\"click-text\",\"target\":\"$target\",\"x\":$x,\"y\":$y,\"text\":$(echo "$find_result" | jq '.text')}"
  else
    echo "{\"success\":false,\"action\":\"click-text\",\"target\":\"$target\",\"error\":\"Text not found\",\"debug\":$find_result}"
  fi
}

# Helper: click at coordinates (reuses click logic)
do_click_at() {
  local cx="$1" cy="$2"
  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var point = \$.CGPointMake($cx, $cy);
    var move = \$.CGEventCreateMouseEvent(null, \$.kCGEventMouseMoved, point, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, move);
    delay(0.1);
    var down = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, point, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, down);
    delay(0.05);
    var up = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, point, 0);
    \$.CGEventPost(\$.kCGSessionEventTap, up);
  " >/dev/null 2>&1
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
  find)        do_find ;;
  click-text)  do_click_text ;;
  *)           error_exit "Unknown action: $ACTION. Valid: screenshot, click, move, type, key, scroll, drag, focus, open-url, list-apps, find, click-text" ;;
esac
