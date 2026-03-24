---
name: list-devices
description: List all Crewly devices connected to Cloud
category: communication
---

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
