---
name: Reply Slack
description: Send a message to a Slack channel or thread via the backend API.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - reply slack
  - send slack
  - slack message
tags:
  - communication
  - slack
  - notification
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Reply Slack

Send a message to a Slack channel or thread via the Crewly backend API. This bypasses terminal output parsing and delivers the message directly to Slack, avoiding PTY line-wrapping and ANSI artifacts.

## Usage

```bash
# Legacy JSON argument (kept for backwards compatibility)
bash config/skills/orchestrator/reply-slack/execute.sh '{"channelId":"C0123","text":"Task completed successfully!"}'

# Recommended multi-line usage with stdin
cat <<'EOF' | bash config/skills/orchestrator/reply-slack/execute.sh --channel C0123 --conversation "$CHAT_CONVERSATION"
Deploy complete ✅

Tests are green and artifacts published.
EOF
```

With thread reply (any style):

```bash
bash config/skills/orchestrator/reply-slack/execute.sh '{"channelId":"C0123","text":"Update: tests passing","threadTs":"1707430000.001234"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channelId` / `--channel` | Yes | Slack channel ID to send the message to |
| `text` / `--text` / stdin | Yes* | Message text (supports Slack Markdown). You can pipe multi-line text via stdin with `--channel`. *Optional when `--image` or `--file` is provided |
| `threadTs` / `--thread` | Yes (default) | Thread timestamp for threaded replies. Required unless `--allow-new-thread` is set |
| `--image` / `-i` | No | Path to an image file to upload to Slack. When provided, calls `/api/slack/upload-image` instead of `/api/slack/send`. The `--text` becomes an optional comment on the image |
| `--file` / `-f` | No | Path to any file type (PDF/CSV/ZIP/etc.) to upload via `/api/slack/upload-file`. The `--text` becomes an optional comment |
| `--allow-new-thread` | No | Explicitly allow posting without a thread (safety override) |
| `conversationId` / `--conversation` | No | Conversation ID from the `[CHAT:...]` prefix so the queue can resolve instantly (falls back to the active conversation if omitted) |

## Image Upload

To send an image to Slack:

```bash
bash config/skills/orchestrator/reply-slack/execute.sh \
  --channel C0123 \
  --image /path/to/screenshot.png \
  --text "Here's the test result"
```

Supported image types: PNG, JPEG, GIF, WebP, SVG. Max file size: 20 MB.

## Generic File Upload

To send any file type (for example PDF/CSV):

```bash
bash config/skills/orchestrator/reply-slack/execute.sh \
  --channel C0123 \
  --thread 1707430000.001234 \
  --file /path/to/report.pdf \
  --text "Daily report attached"
```

## Output

JSON confirmation with the Slack message timestamp (text) or file ID (image) on success.

> **Heads up:** After a successful API call the script automatically emits a `[NOTIFY]` block so the backend logs the reply and unblocks any pending Slack messages. If you pass `--conversation`, that ID is embedded in the header. Otherwise TerminalGateway will associate the notify block with the active conversation.

## Special Characters

If your message contains special characters like parentheses `()`, single quotes `'`, backslashes `\`, or dollar signs `$`, use `--text-file` or stdin to avoid bash escaping issues:

```bash
# Write message to a temp file first
bash config/skills/orchestrator/reply-slack/execute.sh \
  --channel C0123 \
  --thread 1707430000.001234 \
  --text-file /tmp/reply.txt
```

```bash
# Or pipe via stdin
echo "message with special chars (like these)" | bash config/skills/orchestrator/reply-slack/execute.sh \
  --channel C0123 \
  --thread 1707430000.001234
```

## Safety Behavior

By default, this skill **requires** `threadTs` and will fail fast if it is missing.  
This prevents accidental top-level posts when the intent is to reply in an existing thread.

If you intentionally want a new top-level message, pass:

```bash
bash config/skills/orchestrator/reply-slack/execute.sh \
  --channel C0123 \
  --allow-new-thread \
  --text "Top-level announcement"
```
