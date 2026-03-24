---
name: reply-remote
description: Reply to a cross-machine message from another Crewly device
category: communication
---

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
