---
name: Reply Chat
description: Send a message to the Crewly Chat UI. Use this to post responses, updates, or notifications directly to a chat conversation.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - reply chat
  - send chat
  - chat message
  - chat response
tags:
  - communication
  - chat
  - notification
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Reply Chat Skill

Send a message to the Crewly Chat UI. This is the preferred way for orchestrators and agents to post messages to the Chat UI — it uses the backend API directly instead of relying on terminal output `[NOTIFY]` marker interception.

## Usage

### Flag-based invocation

```bash
bash config/skills/orchestrator/reply-chat/execute.sh \
  --conversation "conv-abc123" \
  --text "Task completed successfully"
```

### With sender name

```bash
bash config/skills/orchestrator/reply-chat/execute.sh \
  --conversation "conv-abc123" \
  --sender "Orchestrator" \
  --text "Deploy complete"
```

### Multi-line text from stdin

```bash
cat <<'EOF' | bash config/skills/orchestrator/reply-chat/execute.sh --conversation "conv-abc123"
## Status Update

All tasks completed:
- Feature implemented
- Tests passing
- Ready for review
EOF
```

### JSON argument (legacy)

```bash
bash config/skills/orchestrator/reply-chat/execute.sh '{"conversationId":"conv-abc123","content":"Hello","senderName":"Orchestrator"}'
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--conversation` | `-C` | Chat conversation ID (optional — defaults to current) |
| `--text` | `-t` | Message text |
| `--text-file` | | Read message text from file |
| `--sender` | `-s` | Sender name (default: "Orchestrator") |
| `--sender-type` | | Sender type: orchestrator, agent, system (default: orchestrator) |
| `--json` | `-j` | Raw JSON payload |
| `--help` | `-h` | Show help |
