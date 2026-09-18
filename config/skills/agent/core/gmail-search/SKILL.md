---
name: Gmail Search
description: Search the owner's Gmail (via the Google Workspace grant held by Crewly Cloud) and list matching messages with sender, subject, date and snippet. Read-only.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - search gmail
  - search email
  - find email
  - check inbox
tags:
  - google
  - gmail
  - email
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Gmail Search

Runs a Gmail search on the owner's mailbox and prints the hits. Uses the
Google Workspace connection the owner made under Settings → Integrations;
the mail content goes straight from Google to this instance.

```bash
bash execute.sh --query "is:unread from:ann@example.com newer_than:2d" --max 10
bash execute.sh '{"query":"subject:invoice has:attachment","max":5}'
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--query` / `-q` (`query`) | yes | Gmail search syntax (`from:`, `subject:`, `is:unread`, `newer_than:7d`, `has:attachment`, …) |
| `--max` / `-n` (`max`) | no | Result cap, default 20, max 100 |

## Output

```json
{"query":"is:unread","count":2,"messages":[{"id":"18f…","threadId":"18f…","from":"Ann <ann@example.com>","to":"owner@example.com","subject":"Q3 numbers","date":"Thu, 18 Sep 2026 10:00:00 +0000","snippet":"Here are the…"}]}
```

Use the `id` with `gmail-read` to get the body; `threadId` + `gmail-read`'s
`messageId` with `gmail-send` to reply in-thread.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` — the
owner has not connected Google Workspace yet; hand them the hint URL (or
point them to Settings → Integrations → Google Workspace). Exit code 1.
