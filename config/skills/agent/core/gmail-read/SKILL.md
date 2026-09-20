---
name: Gmail Read
description: Read one message from the owner's Gmail by id — headers, decoded body (plain text, HTML stripped as fallback) and a list of attachments (names only, nothing downloaded). Read-only.
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
  - read email
  - open email
  - show email
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

# Gmail Read

Fetches one message by the `id` a `gmail-search` hit returned.

```bash
bash execute.sh --id 18f0a1b2c3d4e5f6
bash execute.sh '{"id":"18f0a1b2c3d4e5f6"}'
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--id` / `-i` (`id`) | yes | Gmail message id |

## Output

```json
{"id":"18f…","threadId":"18f…","from":"Ann <ann@example.com>","to":"owner@example.com","cc":"","subject":"Q3 numbers","date":"…","messageId":"<abc@mail.example.com>","body":"Hi —\n…","bodyType":"text","attachments":[{"filename":"deck.pdf","mimeType":"application/pdf","size":12345,"attachmentId":"ANGjd…"}]}
```

`bodyType` is `text` (text/plain part), `html` (stripped from text/html)
or `none`. Attachments are listed, never downloaded. To reply in-thread,
pass `threadId` and `messageId` to `gmail-send`.

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace; `reason` `google_error`
with a 404 message when the id is unknown.

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh --account work@company.com ...
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
