---
name: Receive File
description: Download a large file another agent of the same Crewly account sent with send-file (handoff id hf_…), save it in your workspace, verify its size, then tell Crewly Cloud to delete it. Use when a message gives you a handoff id or says "receive it with the receive-file skill".
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - receive file
  - download handoff
  - hf_
  - get the file from
  - fetch the video
tags:
  - files
  - handoff
  - transfer
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 3600000
---

# Receive File

Downloads a file handed to you with `send-file` (by any agent of your own
Crewly account, on this or another machine). The file streams to disk, never
through memory; its size is checked against what the sender declared; then the
temporary copy on the server is deleted.

```bash
bash execute.sh --id hf_AbCdEfGhIjKlMnOpQrStUv
bash execute.sh --id hf_… --dir ./inbox
```

Prints:

```json
{"success":true,"path":"/…/received/daily-2026-10-09.mp4","fileName":"daily-2026-10-09.mp4","sizeBytes":314572800,"note":"today's cut","acked":true}
```

- `--dir`: where to save (default `received/` in your project directory).
  An existing file is never overwritten; a number is added to the name.
- If the size does not match, nothing is acknowledged and the partial file is
  removed: run it again (the server copy stays until it is acknowledged or
  24 hours pass).
- An interrupted download keeps its `.part` file and resumes on the next run.
- `--no-ack` keeps the server copy so another run can fetch it again.
- A handoff is gone once received, cancelled or expired (24 h): ask the sender
  to send it again.
