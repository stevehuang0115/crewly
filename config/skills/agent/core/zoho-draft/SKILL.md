---
name: Zoho Draft
description: Save a draft in a Zoho Mail mailbox (e.g. info@crewlyai.com). Draft only — agents cannot send Zoho mail. Also lists the read tools.
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - operations
  - ops
  - sales
  - support
  - generalist
  - content-strategist
triggers:
  - zoho draft
  - draft email in zoho
  - reply to info@
tags:
  - zoho
  - email
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 45000
---

# Zoho Draft

Saves an email as a **draft** in a Zoho Mail mailbox. **It never sends.**
The backend forces draft mode itself; you cannot pass a mode, schedule a send,
or attach files. `ZohoMail_sendEmail` / `ZohoMail_sendReplyEmail` are removed
from the Zoho connector for agents and calls to them are refused. A human
opens the draft in Zoho and sends it (or deletes it).

Say the draft is ready, who it is to and what it says; do not look for another way to send.

## Usage

```bash
bash execute.sh --from info@crewlyai.com --to ann@example.com --subject "Re: Pricing" --text "Hi Ann, …"
bash execute.sh --from info@crewlyai.com --to ann@example.com --subject "Re: Pricing" --text-file /tmp/reply.txt \
  --in-reply-to "<message-id@mail>" --references "<m1@mail> <m2@mail>"
bash execute.sh '{"from":"info@crewlyai.com","to":"ann@example.com","subject":"Hi","text":"…"}'
```

| Option | Required | Meaning |
|---|---|---|
| `--from` | yes | Mailbox to save the draft in (must be a Zoho account of the connector) |
| `--to` | yes | Recipient(s) |
| `--cc`, `--bcc` | no | Cc / Bcc |
| `--subject` | no | Subject |
| `--text` / `--text-file` | no | Body (plain text unless `--html`) |
| `--html` | no | Treat the body as HTML |
| `--in-reply-to`, `--references` | no | Message-ID(s) of the thread you are answering (from `ZohoMail_getMessageHeader`) |
| `--account-id` | no | Numeric Zoho accountId; looked up from `--from` when omitted |

Output: `{"success":true,"drafted":true,"sent":false,...}`. On failure
`{"success":false,"reason":"…"}` (exit 1) — e.g. Zoho needs the owner to sign in (tell the owner), or the address is not a Zoho account.

## Reading mail

Reading goes through the Zoho MCP tools in your session (the connector), not this skill:
`ZohoMail_getMailAccounts` (find the account), `ZohoMail_listEmails`,
`ZohoMail_getMessageContent`, `ZohoMail_getMessageHeader` (Message-ID for replies),
`ZohoMail_getMessageDetails`. Send tools are not listed for agents.
