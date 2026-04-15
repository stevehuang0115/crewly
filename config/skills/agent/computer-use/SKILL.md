---
name: computer-use
displayName: Computer Use
description: "Self-contained macOS desktop control — screenshot, click, type, scroll, drag, focus, open-url, key combos, and app listing. All coordinates in screen points."
version: 2.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - developer
  - generalist
  - designer
  - qa
triggers:
  - computer use
  - desktop automation
  - screenshot
  - click
  - type text
  - scroll
  - drag
  - focus app
  - open url
  - key combo
  - list apps
tags:
  - automation
  - desktop
  - screenshot
  - macos
  - computer-use
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
inputs:
  - name: action
    type: string
    required: true
    description: "Action to perform: screenshot, click, move, type, key, scroll, drag, focus, open-url, list-apps"
  - name: x
    type: number
    required: false
    description: "X screen coordinate (for click, move, scroll)"
  - name: y
    type: number
    required: false
    description: "Y screen coordinate (for click, move, scroll)"
  - name: text
    type: string
    required: false
    description: "Text to type (for type action)"
  - name: key
    type: string
    required: false
    description: "Key combo like 'command+c', 'return', 'shift+tab' (for key action)"
  - name: button
    type: string
    required: false
    default: left
    description: "Mouse button: left, right, double (for click action)"
  - name: url
    type: string
    required: false
    description: "URL to open (for open-url action)"
  - name: app
    type: string
    required: false
    description: "Application name (for focus, open-url actions)"
  - name: grid
    type: boolean
    required: false
    default: false
    description: "Overlay red grid lines every 100 screen points (for screenshot)"
  - name: crop
    type: object
    required: false
    description: "Crop region {x, y, w, h} in screen coordinates (for screenshot)"
  - name: dx
    type: number
    required: false
    description: "Horizontal scroll amount (for scroll action)"
  - name: dy
    type: number
    required: false
    description: "Vertical scroll amount, negative = down (for scroll action)"
  - name: x1
    type: number
    required: false
    description: "Drag start X (for drag action)"
  - name: y1
    type: number
    required: false
    description: "Drag start Y (for drag action)"
  - name: x2
    type: number
    required: false
    description: "Drag end X (for drag action)"
  - name: y2
    type: number
    required: false
    description: "Drag end Y (for drag action)"
---

# Computer Use

Self-contained macOS desktop control skill. Provides 10 actions for full programmatic interaction with the desktop.

## Key Design Decisions

- **kCGSessionEventTap**: All CoreGraphics mouse events use `$.kCGSessionEventTap` (not `kCGHIDEventTap`) for reliable event posting in user sessions.
- **Screen coordinate downscaling**: Screenshots are automatically downscaled by the backing scale factor so that 1 pixel = 1 screen point. This means screenshot coordinates directly match click/move coordinates.
- **ABC input switching**: The type action automatically switches to English (ABC) keyboard layout before typing to avoid IME interference.
- **No lib/ dependencies**: Fully self-contained in a single execute.sh file (sources only the shared `_common/lib.sh`).

## Usage Examples

```bash
# Take a screenshot (returns path, width, height, scale)
bash execute.sh '{"action":"screenshot"}'

# Screenshot with grid overlay for coordinate finding
bash execute.sh '{"action":"screenshot","grid":true}'

# Screenshot with crop
bash execute.sh '{"action":"screenshot","crop":{"x":100,"y":100,"w":400,"h":300}}'

# Left click at coordinates
bash execute.sh '{"action":"click","x":500,"y":300}'

# Right click
bash execute.sh '{"action":"click","x":500,"y":300,"button":"right"}'

# Double click
bash execute.sh '{"action":"click","x":500,"y":300,"button":"double"}'

# Move mouse
bash execute.sh '{"action":"move","x":500,"y":300}'

# Type text (auto-switches to ABC input)
bash execute.sh '{"action":"type","text":"Hello, world!"}'

# Key combo
bash execute.sh '{"action":"key","key":"command+c"}'
bash execute.sh '{"action":"key","key":"return"}'

# Scroll down at position
bash execute.sh '{"action":"scroll","x":500,"y":400,"dy":-5}'

# Drag from point A to point B
bash execute.sh '{"action":"drag","x1":100,"y1":200,"x2":400,"y2":500}'

# Focus an app
bash execute.sh '{"action":"focus","app":"Safari"}'

# Open URL (bypasses keyboard entirely)
bash execute.sh '{"action":"open-url","url":"https://example.com","app":"Google Chrome"}'

# List running GUI apps
bash execute.sh '{"action":"list-apps"}'
```

## Requirements

- macOS (Apple Silicon or Intel)
- `jq` for JSON parsing
- `sips`, `screencapture`, `osascript` (macOS built-in)
- `python3` + `PIL`/`Pillow` (optional, for grid overlay and crop)
- Accessibility permission for click, type, key, scroll, drag, focus
- Screen Recording permission for screenshot
