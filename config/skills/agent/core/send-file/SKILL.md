---
name: Send File
description: Hand a LARGE file (video, archive, dataset, up to 2 GB) to another agent of the same Crewly account, on this or another machine, through a temporary Crewly Cloud relay. Prefer this over Drive or Slack for anything bigger than a few MB. The receiver deletes it with receive-file; unclaimed files are deleted after 24 hours.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - send file
  - send a large file
  - hand off a file
  - pass the video to
  - transfer file to agent
  - share a big file
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

# Send File

Passes one big file to another agent of **your own Crewly account**
(same machine or another one) without Slack or Drive. Needs the machine to be
signed in to Crewly Cloud. The file is streamed from disk (never loaded into
memory), kept on a temporary server, and deleted as soon as the receiver
acknowledges it, or after 24 hours.

```bash
bash execute.sh --path ./out/daily-2026-10-09.mp4 --note "today's cut, 300 MB" --to Mia
```

Prints:

```json
{"success":true,"handoffId":"hf_…","fileName":"daily-2026-10-09.mp4","sizeBytes":314572800,"expiresAt":"…",
 "instruction":"Receive it with the receive-file skill: bash <skills>/core/receive-file/execute.sh --id hf_… [--dir <folder>]"}
```

**Send the `instruction` line to the receiving agent** (use your normal
agent-to-agent message), and tell it the handoff id. Do not post the id anywhere
public.

Options:

- `--path` (required): a regular file inside your project directory (not a
  symlink, not inside Crewly's home). Max 2 GB; the account may hold 5 GB of
  waiting handoffs at once, so wait for receivers to finish before sending more.
- `--name`: the name the receiver sees (default: the file's name).
- `--note`: one line for the receiver. `--to`: who it is for (informational).
- `--content-type`: default from the extension.

Not for secrets or credentials. Not for files under ~5 MB that can go in a
message. Cancel a handoff you no longer want received with
`bash execute.sh --cancel hf_…`.
