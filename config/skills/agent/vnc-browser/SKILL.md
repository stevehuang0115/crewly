---
name: VNC Remote Browser Access
description: Launch a virtual display with VNC + noVNC + cloudflared for remote browser viewing and control. Enables human-in-the-loop login/verification when Playwright needs manual interaction.
version: 1.0.0
category: browser
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - qa-engineer
  - fullstack-dev
  - backend-developer
  - frontend-developer
  - generalist
triggers:
  - vnc
  - remote browser
  - browser login
  - manual login
  - human verification
  - captcha
  - 2fa
  - playwright headful
tags:
  - vnc
  - browser
  - remote-access
  - playwright
  - noVNC
  - cloudflared
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# VNC Remote Browser Access

Bridge macOS Screen Sharing to a public HTTPS URL via noVNC + cloudflared. This lets humans remotely view and control the Mac desktop (and any browser on it) from anywhere — essential when Playwright hits a login page, CAPTCHA, or 2FA prompt.

The stack: **macOS Screen Sharing** (built-in VNC, port 5900) → **websockify + noVNC** (web client, port 6080) → **cloudflared** (public HTTPS tunnel).

## Prerequisites

**macOS Screen Sharing must be enabled manually** before using this skill:

1. Open **System Settings** → **General** → **Sharing**
2. Turn on **Screen Sharing**
3. (Optional) Set a VNC password under Screen Sharing options

This only needs to be done once. Screen Sharing runs as a system service and persists across reboots.

## When to Use

- Playwright hits a login page that requires human credentials
- A website shows a CAPTCHA or anti-bot challenge
- Two-factor authentication (2FA/MFA) requires a code from the user
- You need the user to visually verify something in the browser
- Any browser automation step that needs human-in-the-loop interaction

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action`  | Yes      | One of: `start`, `stop`, `status`, `get-url` |

### Actions

- **start** — Check Screen Sharing is on, install deps if needed, launch websockify + noVNC + cloudflared. Returns the public URL.
- **stop** — Shut down websockify + cloudflared. Does NOT touch Screen Sharing.
- **status** — Check Screen Sharing (port 5900), websockify, and cloudflared status.
- **get-url** — Retrieve the cloudflared public URL.

## Examples

### Start and get the public URL

```bash
bash config/skills/agent/vnc-browser/execute.sh '{"action":"start"}'
```

Output:
```json
{
  "success": true,
  "status": "started",
  "publicUrl": "https://abc-xyz.trycloudflare.com/vnc.html?autoconnect=true",
  "localUrl": "http://localhost:6080/vnc.html?autoconnect=true",
  "hint": "Share the publicUrl with the user..."
}
```

### Send the URL to the user via Slack

```bash
URL=$(bash config/skills/agent/vnc-browser/execute.sh '{"action":"get-url"}' | jq -r '.publicUrl')
# Then send via reply-slack or report-status
```

### Check status

```bash
bash config/skills/agent/vnc-browser/execute.sh '{"action":"status"}'
```

### Stop when done

```bash
bash config/skills/agent/vnc-browser/execute.sh '{"action":"stop"}'
```

## Workflow

1. **Ensure Screen Sharing is on** (one-time setup)
2. **Start VNC bridge** → get the public URL
3. **Launch Playwright** in headful mode (the browser appears on the Mac desktop)
4. **Navigate** to the page requiring human interaction
5. **Send the public URL** to the user via Slack
6. **Wait** for the user to complete the manual step (login, CAPTCHA, etc.)
7. **Continue automation** once the browser is past the manual step
8. **Stop VNC bridge** when no longer needed

## Technical Details

- **VNC source**: macOS Screen Sharing on port 5900 (system-managed)
- **Web client**: noVNC on port 6080 via websockify
- **Public tunnel**: cloudflared Quick Tunnel (random `*.trycloudflare.com` subdomain)
- **Security**: Screen Sharing requires macOS user credentials; cloudflared provides HTTPS
- **Dependencies**: websockify (pip), noVNC (GitHub release), cloudflared (Homebrew) — auto-installed on first run
- **PID files**: `~/.crewly/vnc/` for websockify and cloudflared lifecycle
- **Note**: This skill does NOT start or stop macOS Screen Sharing — that is user-managed

## Requirements

- macOS with Screen Sharing enabled
- Homebrew installed
- Python 3 with pip (for websockify)
- Internet access (for cloudflared tunnel and dependency installation)
