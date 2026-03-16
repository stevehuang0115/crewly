---
name: Reply Google Chat
description: Send a message to a Google Chat space or thread via the backend API.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - reply gchat
  - reply google chat
  - send gchat
  - google chat message
tags:
  - communication
  - google-chat
  - notification
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Reply Google Chat

**IMPORTANT: This skill is for PROACTIVE notifications only.** When responding to an incoming `[GCHAT:...]` message, do NOT use this skill — just output a `[NOTIFY]` block and the system will automatically route your reply to the correct Google Chat thread. Using this skill for incoming GCHAT replies causes duplicate messages.

Use this skill ONLY when you need to send a message to Google Chat without an incoming GCHAT trigger (e.g. task completion notifications, proactive status updates).

Send a message to a Google Chat space (with optional thread) via the Crewly backend API. This bypasses terminal output parsing and delivers the message directly to Google Chat, avoiding PTY line-wrapping and ANSI artifacts.

## Usage

```bash
# Flag-based invocation
bash config/skills/orchestrator/reply-gchat/execute.sh --space "spaces/AAAA" --text "Task completed!" --thread "spaces/AAAA/threads/BBB"

# Multi-line text from stdin
cat message.txt | bash config/skills/orchestrator/reply-gchat/execute.sh --space "spaces/AAAA" --thread "spaces/AAAA/threads/BBB"

# JSON argument (legacy)
bash config/skills/orchestrator/reply-gchat/execute.sh '{"space":"spaces/AAAA","text":"Hello","threadName":"spaces/AAAA/threads/BBB"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `space` / `--space` | Yes | Google Chat space name (e.g. `spaces/AAAA...`) |
| `text` / `--text` / stdin | Yes | Message text |
| `threadName` / `--thread` | No | Thread name for threaded replies (e.g. `spaces/AAAA/threads/BBB`) |
| `conversationId` / `--conversation` | No | Conversation ID from the `[GCHAT:...]` prefix so the queue can resolve instantly |
| `--text-file` | No | Read message text from the specified file path |
| `--json` / `-j` | No | Raw JSON payload |

## Special Characters

If your message contains special characters like parentheses `()`, single quotes `'`, backslashes `\`, or dollar signs `$`, use `--text-file` or stdin to avoid bash escaping issues:

```bash
# Write message to a temp file first
bash config/skills/orchestrator/reply-gchat/execute.sh \
  --space "spaces/AAAA" \
  --thread "spaces/AAAA/threads/BBB" \
  --text-file /tmp/reply.txt
```

```bash
# Or pipe via stdin
echo "message with special chars (like these)" | bash config/skills/orchestrator/reply-gchat/execute.sh \
  --space "spaces/AAAA" \
  --thread "spaces/AAAA/threads/BBB"
```

## Output

JSON confirmation on success. After a successful API call the script automatically emits a `[NOTIFY]` block so the backend logs the reply and unblocks any pending Google Chat messages.
