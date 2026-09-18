---
name: list-devices
description: "DEPRECATED (2026-09-18) — List all Crewly devices connected to Cloud. Agents on other machines are reached through a shared Slack team channel now; this legacy Cloud-queue channel is kept only so old [REMOTE:...] messages can still be answered."
category: communication
---
> **Deprecated (2026-09-18).** Cross-machine collaboration moved to Slack: put the teams of both machines in one Slack channel and @ colleagues by name (`list-colleagues` lists them). Do not start new conversations with this skill.


# list-devices

List all devices connected to this CrewlyAI Cloud account.

## When to use

Use this skill to discover which machines are online and get their device IDs for cross-machine messaging via `send-to-remote`.

## Usage

```bash
bash execute.sh
```

## Output

Returns a JSON object with all connected devices including:
- `deviceId` — UUID to use with `send-to-remote`
- `deviceName` — Human-readable hostname
- `status` — `online` or `offline`
- `isLocal` — Whether this is the current machine
