---
name: Send Key
description: "Send a keyboard key or key sequence to an agent's terminal session."
version: 1.0.0
category: system
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - send key
  - press key
  - key press
  - send enter
tags:
  - system
  - terminal
  - key
  - input
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Send Key

Sends a keyboard key or key sequence to an agent's terminal session. Useful for navigating interactive prompts, accepting plan mode, dismissing dialogs, or sending control sequences.

## Usage

### Single key
```bash
bash config/skills/orchestrator/send-key/execute.sh '{"sessionName":"agent-joe","key":"Enter"}'
```

### Key sequence
```bash
bash config/skills/orchestrator/send-key/execute.sh '{"sessionName":"agent-joe","keys":["Down","Down","Enter"]}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` | Yes | The target agent's PTY session name |
| `key` | One of `key`/`keys` | A single key to send |
| `keys` | One of `key`/`keys` | An array of keys to send in sequence (300ms delay between each) |

## Supported Keys

| Key | Description |
|-----|-------------|
| `Enter` / `Return` | Submit / confirm |
| `Escape` | Cancel / dismiss |
| `Tab` | Tab key |
| `Backspace` | Delete character before cursor |
| `Delete` | Delete character after cursor |
| `Up` / `Down` / `Left` / `Right` | Arrow keys |
| `Home` / `End` | Jump to start/end of line |
| `PageUp` / `PageDown` | Scroll page |
| `C-c` | Ctrl+C (interrupt) |
| `C-d` | Ctrl+D (EOF) |
| `C-z` | Ctrl+Z (suspend) |
| `C-l` | Ctrl+L (clear screen) |

## Output

JSON confirmation of delivery for each key sent.
