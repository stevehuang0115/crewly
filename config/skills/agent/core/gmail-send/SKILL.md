---
name: Gmail Send
description: Send an email from the owner's Gmail account (via the Google Workspace grant held by Crewly Cloud). Sends on the owner's behalf — needs the owner's go-ahead unless the task brief grants it. Supports in-thread replies and a dry-run preview.
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
triggers:
  - send email
  - reply to email
  - email someone
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

# Gmail Send

Sends a plain-text email **as the owner**. Because the message carries the
owner's name, only send when the owner has said so in this conversation or
the task brief explicitly grants sending; otherwise draft with `--dry-run`
and show the preview.

```bash
bash execute.sh --to ann@example.com --subject "Re: Q3 numbers" --text "Looks good, thanks!"
bash execute.sh --to ann@example.com --subject "Re: Q3 numbers" --text-file /tmp/reply.txt \
  --thread-id 18f0a1b2c3d4e5f6 --in-reply-to "<abc@mail.example.com>"
bash execute.sh '{"to":"ann@example.com","subject":"Hi","text":"…"}'
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--to` (`to`) | yes | Recipient(s), comma-separated |
| `--subject` (`subject`) | yes | Subject (UTF-8 fine) |
| `--text` / `--text-file` (`text`) | yes | Plain-text body, inline or from a file |
| `--cc` (`cc`) | no | Cc recipient(s) |
| `--thread-id` (`threadId`) | no | Gmail thread to reply in (from `gmail-search`) |
| `--in-reply-to` (`inReplyTo`) | no | `messageId` of the message being answered (from `gmail-read`) |
| `--dry-run` | no | Print the message preview; send nothing |

`CREWLY_GMAIL_SEND_DRY_RUN=1` in the environment forces dry-run for every
call — nothing is sent, no request leaves this machine.

## Output

Sent: `{"success":true,"id":"18f…","threadId":"18f…"}`

Dry run: `{"success":true,"dryRun":true,"preview":"To: …\nSubject: …\n\n<body>"}`

## Failures

Missing `--to` / `--subject` / body → `{"error":"Missing required parameter: …"}` on stderr, exit 1, nothing sent.
`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1) when the owner has not connected Google Workspace.

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh --account work@company.com ...
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
