---
name: reply-remote
description: "DEPRECATED (2026-09-18) — Reply to a cross-machine message from another Crewly device. Agents on other machines are reached through a shared Slack team channel now; this legacy Cloud-queue channel is kept only so old [REMOTE:...] messages can still be answered."
category: communication
---
> **Deprecated (2026-09-18).** Cross-machine collaboration moved to Slack: put the teams of both machines in one Slack channel and @ colleagues by name (`list-colleagues` lists them). Do not start new conversations with this skill.


# reply-remote

Reply to a message received from another Crewly machine via Cloud.

## When to use

Use this skill when you receive a `[REMOTE:deviceId:deviceName]` tagged message
and need to send a response back to the originating device. This is the
cross-machine equivalent of `reply-slack`.

## Usage

```bash
# Reply to a specific device
bash execute.sh --device <deviceId> --message "Task completed successfully"

# With device name (for logging)
bash execute.sh --device <deviceId> --device-name "iriss-air.lan" --message "Tests passed"
```

## Extracting device info

When you receive a message like:
```
[REMOTE from iriss-air.lan] (delegate-task) Run tests [REMOTE:2577fec0-...:iriss-air.lan]
```

Extract the deviceId from the `[REMOTE:deviceId:deviceName]` tag at the end.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--device` | Yes | Target device ID (from the REMOTE tag) |
| `--device-name` | No | Device name (for logging) |
| `--message` | Yes | Reply message text (or pipe via stdin) |
| `--type` | No | Message type (default: `send-message`) |
