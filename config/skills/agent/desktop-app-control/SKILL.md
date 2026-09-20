---
name: Desktop App Control (agent-browser)
description: "Control desktop Electron apps and Chrome-based browsers via agent-browser (Vercel Labs). Uses CDP (Chrome DevTools Protocol) with accessibility snapshots and ref-based interaction \u2014 82-96% token savings vs raw Playwright. Supports VS Code, Slack, Discord, Notion, Figma, Spotify, Chrome, and any Electron app."
version: 1.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - developer
  - generalist
  - designer
  - qa
triggers:
  - desktop app
  - electron
  - browser control
  - agent-browser
  - slack control
  - vscode control
  - notion control
  - discord control
  - chrome control
  - cdp
  - accessibility snapshot
  - desktop automation
tags:
  - automation
  - desktop
  - electron
  - cdp
  - agent-browser
  - browser
  - playwright
  - accessibility
  - snapshot
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Desktop App Control (agent-browser)

Control Electron desktop apps and Chrome browsers using [agent-browser](https://github.com/vercel-labs/agent-browser) by Vercel Labs. Uses accessibility snapshots with ref-based interaction for 82-96% token savings.

## Quick Start

```bash
# Scan for controllable apps
bash execute.sh scan

# Launch an app with CDP enabled
bash execute.sh launch --app 'Slack' --port 9222

# Connect to a running app
bash execute.sh connect --port 9222

# Take accessibility snapshot (shows refs like @e1, @e2)
bash execute.sh snapshot

# Interactive elements only (recommended for AI)
bash execute.sh snapshot --interactive

# Click an element by ref
bash execute.sh click --ref @e5

# Type text into a field
bash execute.sh fill --ref @e3 --text 'Hello World'

# Press a key
bash execute.sh press --key Enter

# Take screenshot
bash execute.sh screenshot --output /tmp/app.png

# Get text content of element
bash execute.sh get-text --ref @e1

# Scroll
bash execute.sh scroll --direction down

# List tabs/windows
bash execute.sh tabs

# Switch to a tab
bash execute.sh tab --index 2

# Disconnect
bash execute.sh close

# Check agent-browser status and version
bash execute.sh status
```

## Architecture

```
agent-browser (Vercel Labs)
├── Rust CLI          — Fast command parsing
├── Node.js Daemon    — Playwright browser lifecycle
└── CDP Connection    — Chrome DevTools Protocol
```

**Snapshot + Refs Workflow:**
1. `snapshot` returns accessibility tree with `[ref=e1]` markers
2. Use `@e1` to interact: `click @e1`, `fill @e3 "text"`, `get text @e1`
3. Re-snapshot after actions to get updated refs

## Controllable Apps

**Electron Apps** (launch with `--remote-debugging-port`):
- VS Code, Slack, Discord, Notion, Figma, Spotify, Postman, MongoDB Compass, Termius, etc.

**Chrome-based Browsers:**
- Google Chrome, Brave, Microsoft Edge, Chromium, Arc

**Any Electron App** — if it's built on Electron, it can be controlled.

## Multi-App Control

Use sessions to control multiple apps simultaneously:

```bash
bash execute.sh launch --app 'Slack' --port 9222 --session slack
bash execute.sh launch --app 'Visual Studio Code' --port 9223 --session vscode

bash execute.sh snapshot --session slack --interactive
bash execute.sh snapshot --session vscode --interactive
```

## Safety Rules

1. NEVER close or kill apps without explicit user permission
2. NEVER interact with password fields or sensitive data
3. Always snapshot BEFORE and AFTER any action for verification
4. All actions logged to `~/.crewly/logs/desktop-app-control.log`
5. Only connect to locally running apps (127.0.0.1)

## Requirements

- `agent-browser` (npm install -g agent-browser && agent-browser install)
- macOS / Linux / Windows
- Target apps must be relaunched with `--remote-debugging-port` flag

## Which control surface to use

Crewly has three ways to act on a screen. Pick the **lowest** one that can do
the job — each step down costs more tokens, breaks more easily, and disturbs
the user more.

| Need | Use | Why |
|---|---|---|
| Anything a Crewly skill or connector already does (mail, Drive, Slack, calendar, git, files) | that skill | No screen at all. Fastest and cannot misclick. |
| Content of a web page, or acting as the signed-in user in Chrome | `remote-browser` | Real Chrome, real session, per-agent bound tab, and the user sees a takeover banner. |
| An Electron app (VS Code, Slack, Notion, Figma) | `desktop-app-control` | Accessibility snapshot with element refs — no coordinates. Needs the app started with a debug port. |
| Native macOS apps, system dialogs, anything the above cannot reach | `computer-use` | Last resort: screen coordinates and pixels. Slowest and most fragile. |

`computer-use` refuses destructive key combos, typing into password fields and
driving credential apps, holds a machine-wide lock while it works, and logs
every action to `~/.crewly/desktop-actions.jsonl`. Run
`{"action":"check-permissions"}` first — without Screen Recording and
Accessibility every action fails, and the refusal tells you what to grant.
