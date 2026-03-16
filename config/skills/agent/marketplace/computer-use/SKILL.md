---
name: Desktop Automation (Computer Use)
description: "Control the macOS desktop: take screenshots, move/click the mouse, type text, and read app content via Accessibility API. Uses native macOS APIs (screencapture, CoreGraphics, System Events, Accessibility) with zero external dependencies."
version: 2.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - generalist
  - designer
  - qa
triggers:
  - screenshot
  - click
  - mouse
  - type text
  - desktop automation
  - computer use
  - read app
  - scroll
  - accessibility
  - ui elements
tags:
  - automation
  - desktop
  - screenshot
  - mouse
  - keyboard
  - macos
  - accessibility
  - ui-reading
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Desktop Automation (Computer Use)

Control the macOS desktop by taking screenshots, moving/clicking the mouse, typing text, and **reading app content via Accessibility API** (no screenshots needed).

## Actions

### Screenshot
Capture the screen (or a region) to an image file.

```bash
bash execute.sh '{"action":"screenshot"}'
bash execute.sh '{"action":"screenshot","output":"/tmp/my-screenshot.png"}'
```

### Move Mouse
Move the mouse cursor to a specific coordinate.

```bash
bash execute.sh '{"action":"move","x":500,"y":300}'
```

### Click
Click at a specific coordinate. Supports left click, right click, and double click.

```bash
bash execute.sh '{"action":"click","x":500,"y":300}'
bash execute.sh '{"action":"click","x":500,"y":300,"button":"right"}'
bash execute.sh '{"action":"click","x":500,"y":300,"button":"double"}'
```

### Type Text
Type a string of text using simulated keystrokes.

```bash
bash execute.sh '{"action":"type","text":"Hello, world!"}'
```

### List Apps
List all running GUI applications with their names and bundle IDs.

```bash
bash execute.sh '{"action":"list-apps"}'
```

### Focus App
Bring a specific app to the foreground.

```bash
bash execute.sh '{"action":"focus-app","appName":"discover"}'
```

### Read UI (Accessibility API)
Read the UI element tree from a specific app. Returns structured data including element roles, titles, values, and positions — **without taking a screenshot**.

```bash
bash execute.sh '{"action":"read-ui","appName":"discover"}'
bash execute.sh '{"action":"read-ui","appName":"discover","maxDepth":4}'
```

**Output includes:** element roles (button, text, image, etc.), titles, values (text content), descriptions, positions, sizes, and child elements.

### Get Text (Accessibility API)
Extract all visible text content from an app's UI. Faster than `read-ui` when you only need text, not the full element structure.

```bash
bash execute.sh '{"action":"get-text","appName":"discover"}'
```

**Output:** Array of `{role, text}` objects with deduplicated text content.

### Scroll
Scroll within the focused app or a specific app.

```bash
bash execute.sh '{"action":"scroll","direction":"down"}'
bash execute.sh '{"action":"scroll","direction":"up","amount":5}'
bash execute.sh '{"action":"scroll","direction":"down","amount":3,"appName":"discover"}'
```

## Parameters

| Parameter  | Required       | Default              | Description                                      |
|------------|----------------|----------------------|--------------------------------------------------|
| `action`   | Yes            | -                    | One of: `screenshot`, `move`, `click`, `type`, `list-apps`, `focus-app`, `read-ui`, `get-text`, `scroll`, `check-accessibility` |
| `x`        | For move/click | -                    | X coordinate (pixels from left)                  |
| `y`        | For move/click | -                    | Y coordinate (pixels from top)                   |
| `button`   | No             | `left`               | Click button: `left`, `right`, or `double`       |
| `text`     | For type       | -                    | Text string to type                              |
| `output`   | No             | `/tmp/screenshot.png`| Screenshot output file path                      |
| `appName`  | For read-ui/get-text/focus-app | - | macOS process name of the target app     |
| `maxDepth` | No             | `3`                  | Max depth for UI tree traversal (read-ui)        |
| `direction`| For scroll     | `down`               | Scroll direction: `up`, `down`, `left`, `right`  |
| `amount`   | No             | `3`                  | Number of scroll units                           |

### Check Accessibility
Check whether the current process has Accessibility permission. Run this first before using `read-ui` or `get-text`.

```bash
bash execute.sh '{"action":"check-accessibility"}'
```

**Output:** `{"trusted": true/false, "message": "..."}` with instructions if permission is missing.

## Requirements

- macOS (uses native `screencapture`, CoreGraphics, and Accessibility API)
- **Accessibility permissions** must be granted to the terminal app for `read-ui` and `get-text` actions:
  1. Open **System Settings > Privacy & Security > Accessibility**
  2. Enable the terminal app running this script (e.g., Terminal, iTerm2, VS Code)
  3. **Restart the terminal** after granting permission
  4. Run `check-accessibility` to verify
- Actions that do NOT need Accessibility: `screenshot`, `move`, `click`, `type`, `list-apps`, `focus-app`, `scroll`

## Typical Workflows

### Visual Workflow (screenshot-based)
1. Take a screenshot to see the current screen state
2. Identify the coordinates of the target element
3. Move the mouse and/or click on the target
4. Optionally type text into a focused field
5. Take another screenshot to verify the result

### Content Reading Workflow (Accessibility API — no screenshots)
1. Use `list-apps` to find the target app's process name
2. Use `focus-app` to bring the app to the foreground
3. Use `get-text` to read all visible text content
4. Use `scroll` to navigate, then `get-text` again for new content
5. Use `read-ui` when you need element positions for clicking

### Hybrid Workflow (recommended)
1. Use `get-text` to read content (fast, no screenshot)
2. Use `read-ui` to get element positions when you need to interact
3. Only use `screenshot` when visual context is needed (images, layout)
4. This reduces screenshot usage by 80%+ while maintaining full control

## Notes on iPad Apps (e.g., 小红书/discover)

iPad apps running on macOS via Apple Silicon may have **limited Accessibility API support**. Some elements may not expose their text content through the accessibility tree. In such cases:
- Try `read-ui` with higher `maxDepth` (4-5) to find deeper elements
- Fall back to `screenshot` + visual analysis for elements not exposed via Accessibility
- The hybrid workflow is recommended for iPad apps
