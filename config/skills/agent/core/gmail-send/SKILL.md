---
name: Gmail Send
description: Compose an email from the owner's Gmail account. Your call leaves a real draft in the owner's Drafts and stops there — only the owner can send it. Supports in-thread replies.
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

Composes a plain-text email **as the owner** and leaves it in their Gmail
Drafts. **You cannot send it. Calling this does not send anything.**

The owner sends it, from Gmail or from Crewly. Your job ends at telling them
it is ready and what it says.

This is not advice you can weigh against the task in front of you — it is
what the endpoint does. A call comes back `202` with `drafted: true`, and no
mail has left the account.

## If you think you have been told to send

You have not been given a way to. There is no flag, no parameter and no
other skill that sends mail. Looking for one, or reaching for a browser to
click Send in webmail, is working around a decision that was made
deliberately and is not yours to overturn.

Say the draft is ready and let the owner send it.

## Citing your instruction

If the owner did tell you to send, pass the message you are relying on:

```bash
CREWLY_AGENT_AUTHORIZATION="owner, 14:22 — 'yes send it to Kaleb'" bash execute.sh ...
```

It is recorded with the draft and shown to the owner beside it. Quote what
was actually said. Do not paraphrase it into something stronger, and if you
cannot point at a specific message, send nothing and say so — an owner who
asked you to draft something and finds it sent will ask what you were going
on, and "I understood it that way" is not an answer either of you can check.

An agent already did this: it sent two emails on an owner's behalf, then
said it had been told to "fill it in and send". The record for that window
contains four messages from the owner, and the only relevant one says the
opposite — fill it in, *then I'll do the rest*.

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
| `--dry-run` | no | Print the preview locally; create no draft either |

`CREWLY_GMAIL_SEND_DRY_RUN=1` in the environment forces dry-run for every
call — nothing is sent, no request leaves this machine.

## Output

Drafted (the normal outcome): `{"success":true,"drafted":true,"draftId":"r-8…","pendingId":"…","message":"Saved as a draft … It has NOT been sent."}` with HTTP 202.

Dry run: `{"success":true,"dryRun":true,"preview":"To: …\nSubject: …\n\n<body>"}` — nothing is written anywhere, not even a draft.

There is no output shape in which you have sent an email.

## Failures

Missing `--to` / `--subject` / body → `{"error":"Missing required parameter: …"}` on stderr, exit 1, nothing sent.
`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1) when the owner has not connected Google Workspace.

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh --account work@company.com ...
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
