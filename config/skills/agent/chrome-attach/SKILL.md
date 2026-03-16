---
name: Chrome Live Attach
description: "One-click attach to user's running Chrome browser via CDP. Auto-discovers Chrome processes, connects via DevTools Protocol, preserves real logins."
version: 1.0.0
category: browser
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - researcher
triggers:
  - chrome attach
  - live attach
  - attach browser
  - connect chrome
  - mount chrome
  - use my browser
tags:
  - browser
  - chrome
  - cdp
  - live-attach
  - devtools
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Chrome Live Attach

One-click attach to the user's running Chrome browser via Chrome DevTools Protocol (CDP). Auto-discovers Chrome processes, connects without extensions, and preserves real logins.

## Modes

### `discover` (default)
Scans for Chrome instances with CDP enabled. Returns a list of attachable instances.

```json
{"mode": "discover"}
```

### `attach`
Connects to a specific CDP port. Returns connection info including WebSocket URL and open page count.

```json
{"mode": "attach", "port": 9222}
```

### `launch`
Launches Chrome with CDP enabled. If Chrome is already running without CDP, launches an alternative instance.

```json
{"mode": "launch", "port": 9222}
```

## Output Format

```json
{
  "success": true,
  "mode": "discover|attach|launch",
  "found": true,
  "instances": [
    {
      "port": 9222,
      "wsUrl": "ws://127.0.0.1:9222/devtools/browser/...",
      "httpEndpoint": "http://127.0.0.1:9222",
      "version": "Chrome/131.0.6778.86",
      "isPrimary": true
    }
  ]
}
```

## Privacy & Security

- Never kills the user's Chrome process
- Attach mode uses the user's existing profile (preserving logins)
- Launch mode defaults to user's profile; falls back to isolated profile if Chrome is already running
- All CDP operations are logged for audit trail
- Use `browse-stealth` skill instead for anti-detection scenarios (launches isolated profile)
