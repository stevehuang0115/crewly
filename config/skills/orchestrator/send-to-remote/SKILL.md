# send-to-remote

Send a cross-machine message to a remote Crewly instance via Slack.

## When to use

Use this skill when you need to communicate with a Crewly orchestrator running on a different machine. Both machines must be connected to the same Slack workspace and have cross-machine messaging configured.

## Prerequisites

1. Both machines must have Slack connected
2. Cross-machine messaging must be configured on both machines (via `POST /api/cross-machine/configure`)
3. Both machines must be in the same Slack workspace

## Usage

```bash
# Delegate a task to a remote machine
bash execute.sh '{"targetMachine":"<device-id>","type":"delegate-task","message":"Run the full test suite on branch feature/xyz"}'

# Send a message to a remote orchestrator
bash execute.sh '{"targetMachine":"<device-id>","type":"send-message","message":"Build completed successfully"}'

# Request status from a remote machine
bash execute.sh '{"targetMachine":"<device-id>","type":"status-request"}'

# Ping all machines (broadcast)
bash execute.sh '{"targetMachine":"*","type":"ping"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `targetMachine` | Yes | Target device ID (UUID from `~/.crewly/device.json`) or `*` for broadcast |
| `type` | Yes | Message type: `delegate-task`, `send-message`, `status-request`, `ping` |
| `message` | No | Human-readable message text |
| `payload` | No | JSON object with additional structured data |

## Message Types

- **delegate-task**: Ask the remote orchestrator to execute a task
- **send-message**: Send an informational message
- **status-request**: Request status from the remote machine (triggers automatic response)
- **ping**: Check if a machine is online (triggers automatic pong response)

## Finding Device IDs

To find a remote machine's device ID:
1. On the remote machine: `cat ~/.crewly/device.json` → `deviceId` field
2. Or use `GET /api/cross-machine/status` on the local machine to see your own ID
