---
name: Email Responder
description: Generate professional email response drafts based on incoming email context, tone, and intent.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - support
  - generalist
  - sales
  - product-manager
triggers:
  - reply email
  - email response
  - draft email
  - respond to email
tags:
  - email
  - communication
  - response
  - draft
  - customer-support
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Email Responder

Generate professional email response drafts based on incoming email context, tone, and intent. Auto-detects the intent of the incoming email and produces a structured draft ready for review.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `from` | Yes | Sender name or email |
| `subject` | Yes | Email subject line |
| `body` | Yes | Email body content |
| `tone` | No | Response tone: `professional`, `friendly`, `formal`, `apologetic` (default: professional) |
| `intent` | No | Detected intent: `question`, `complaint`, `request`, `feedback`, `auto` (default: auto) |
| `senderName` | No | Your name for the signature |

## Example

```bash
bash config/skills/agent/email-responder/execute.sh '{"from":"jane@example.com","subject":"Login issues after update","body":"Hi, I cannot log in since the latest update. I keep getting an error 403.","tone":"apologetic","senderName":"Support Team"}'
```

## Output

JSON with the generated draft, detected intent, suggested tone, reply subject line, and recommended follow-up actions.
