---
name: Gmail Attachment
description: Download one attachment of an email in the owner's Gmail (via the Google Workspace grant held by Crewly Cloud) to a local file and print its path; PDFs also print their extracted text when pdftotext is installed. Read-only, 25 MB cap.
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
  - email attachment
  - download attachment
  - gmail attachment
  - open attachment
tags:
  - google
  - gmail
  - email
  - attachment
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Gmail Attachment

Read email attachments with `gmail attachment …`; never open Gmail in the
browser for that. The Google connection already allows it (`gmail.readonly`),
needs no owner approval, and does not depend on Chrome.

```bash
# 1. List the attachments: gmail-read prints id, filename, mimeType and size for each
bash ../gmail-read/execute.sh --id 18f0a1b2c3d4e5f6

# 2. Download one, by attachmentId or by filename
bash execute.sh --message 18f0a1b2c3d4e5f6 --attachment deck.pdf
bash execute.sh --message 18f0a1b2c3d4e5f6 --attachment ANGjd… --out /path/to/file
```

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--message` / `-m` (`message`) | yes | Gmail message id (from gmail-search) |
| `--attachment` / `-a` (`attachment`) | yes | `attachmentId` or exact filename from gmail-read |
| `--out` / `-o` (`out`) | no | Where to save (default: `$CREWLY_HOME/attachments/<message>/<filename>`) |
| `--account` | no | Which connected Google account to act as |

## Output

```json
{"success":true,"path":"/Users/me/.crewly/attachments/18f0…/deck.pdf","filename":"deck.pdf","mimeType":"application/pdf","size":12345,"text":"…extracted PDF text…"}
```

`text` appears only for PDFs and only when `pdftotext` is installed; otherwise
read the file at `path` yourself. Attachments over 25 MB are refused
(`reason: too_large`).

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when Google is not connected; `reason: not_found` when no attachment on the
message matches; `reason: google_error` for Google failures.
