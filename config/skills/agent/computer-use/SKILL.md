---
name: Agent Browser — Universal Desktop Control
description: "Universal desktop application control for macOS. Integrates three control methods: AppleScript/JXA for native app automation, Accessibility API for universal UI reading/interaction, and Playwright CDP for Chrome web apps. Includes app discovery, safety logging, and screenshot auditing."
version: 1.0.0
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
  - browser
  - screenshot
  - click
  - type text
  - applescript
  - accessibility
  - ui tree
  - chrome
  - playwright
  - control app
tags:
  - automation
  - desktop
  - browser
  - screenshot
  - applescript
  - accessibility
  - playwright
  - macos
  - ui-reading
  - cdp
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Agent Browser — Universal Desktop Control

Control any macOS application through three integrated methods: AppleScript/JXA, Accessibility API, and Playwright CDP.

## Quick Reference

```bash
# List all controllable apps with available methods
bash execute.sh list-apps

# Get app info with UI element tree
bash execute.sh app-info --app 'Google Chrome'

# Read UI tree of an app (Accessibility API)
bash execute.sh ui-tree --app 'Finder' --depth 5

# Click a UI element by role:name
bash execute.sh click --app 'Finder' --element 'button:New Folder'

# Click at coordinates
bash execute.sh click --app 'Finder' --x 500 --y 300

# Type text in focused app
bash execute.sh type --text 'Hello World'

# Screenshot an app window
bash execute.sh screenshot --app 'Notion' --output /tmp/notion.png

# Screenshot full screen
bash execute.sh screenshot --output /tmp/screen.png

# Run custom AppleScript
bash execute.sh applescript --code 'tell application "Finder" to get name of every window'

# Run common AppleScript presets
bash execute.sh applescript --preset activate-app --app 'Safari'
bash execute.sh applescript --preset get-window-list --app 'Finder'
bash execute.sh applescript --preset click-menu-item --app 'Safari' --menu 'File' --item 'New Window'
bash execute.sh applescript --preset open-file --path '/Users/me/doc.txt'

# Extract all text from an app
bash execute.sh get-text --app 'Notes'

# Scroll in an app
bash execute.sh scroll --app 'Safari' --direction down --amount 5

# Focus (activate) an app
bash execute.sh focus --app 'Terminal'

# Check accessibility permission
bash execute.sh check-access

# Connect to Chrome via CDP
bash execute.sh chrome-connect --port 9222

# Chrome: list tabs
bash execute.sh chrome-tabs --port 9222

# Chrome: run JS in a tab
bash execute.sh chrome-eval --port 9222 --tab 0 --code 'document.title'
```

## Control Methods

### Layer 1: App Discovery
- `list-apps` — Lists all foreground apps with bundle IDs and available control methods
- `app-info` — Gets detailed info: windows, UI elements, controllability

### Layer 2: AppleScript/JXA (native macOS apps)
- `applescript` — Run custom AppleScript or use presets
- Presets: `activate-app`, `get-window-list`, `click-menu-item`, `open-file`, `get-clipboard`, `set-clipboard`
- Works with: Finder, Terminal, Safari, Mail, Calendar, Notes, Sublime Text, etc.

### Layer 3: Accessibility API (universal)
- `ui-tree` — Read any app's UI element tree (roles, titles, values, positions)
- `click` — Click elements by role:name or coordinates
- `type` — Type text in the focused field
- `get-text` — Extract all visible text from an app
- `scroll` — Scroll within an app
- `focus` — Bring an app to the foreground
- `screenshot` — Capture app window or full screen
- Requires: System Settings > Privacy & Security > Accessibility permission

### Layer 4: Playwright CDP (Chrome web apps)
- `chrome-connect` — Connect to Chrome via Chrome DevTools Protocol
- `chrome-tabs` — List open Chrome tabs
- `chrome-eval` — Run JavaScript in a Chrome tab
- Requires: Chrome launched with `--remote-debugging-port=9222`

## Safety Rules

1. NEVER close or kill apps without explicit user permission
2. NEVER interact with password fields or sensitive data
3. Always screenshot BEFORE and AFTER any action for audit trail
4. All actions logged to `~/.crewly/logs/computer-use.log`
5. iPad apps: READ ONLY via Accessibility — never killall, never force-quit

## Requirements

- macOS (Apple Silicon or Intel)
- `jq` for JSON parsing
- Accessibility permission for UI reading/interaction
- Chrome with `--remote-debugging-port` for CDP features
