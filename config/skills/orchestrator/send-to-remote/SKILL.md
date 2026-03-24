---
name: send-to-remote
description: Send a message to another Crewly machine via Cloud API
category: communication
---

# send-to-remote

Send a cross-machine message to a remote Crewly instance via Cloud API.

## When to use

Use this skill when you need to communicate with a Crewly orchestrator running on a different machine. Both machines must be connected to the same CrewlyAI Cloud account.

## Prerequisites

1. Both machines must be connected to CrewlyAI Cloud (`/api/cloud/status` shows connected)
2. Both machines must be running Crewly v1.5.2+ (auto-registers queue on startup)

## Usage

```bash
# Send a message to a specific machine
bash execute.sh --target <device-id> --type send-message --message "Hello from this machine"

# Delegate a task to a remote machine
bash execute.sh '{"targetMachine":"<device-id>","type":"delegate-task","message":"Run the full test suite"}'

# Ping a specific machine
bash execute.sh --target <device-id> --type ping
```

## Finding Device IDs

Use `GET /api/cloud/devices` to list all connected devices with their IDs.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `targetMachine` | Yes | Target device ID (from `/api/cloud/devices`) |
| `type` | Yes | Message type: `delegate-task`, `send-message`, `status-request`, `ping` |
| `message` | No | Human-readable message text |
| `payload` | No | JSON object with additional structured data |
