---
name: Attach File
description: Put a real file into the Slack channel you are replying in — PDF, image, spreadsheet, anything. Lands in the same thread as your reply, under your own name. Use this instead of uploading to Drive and pasting a link.
version: 1.0.0
category: communication
skillType: claude-skill
triggers:
  - send me the pdf
  - attach the file
  - send the file in slack
  - 发给我
  - 直接发到 slack
tags:
  - slack
  - file
  - attachment
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Attach File

`reply-channel` sends text. This sends a file, into the same Slack thread,
from the same bot as your words.

```bash
bash execute.sh --channel <chatChannelId> --path /tmp/report.pdf
bash execute.sh --channel <chatChannelId> --path /tmp/report.pdf \
  --comment "方案 v2，第 3 节改了" --thread <messageId>
```

`--channel` is the chat channel id you were given in your prompt — the same
one you pass to `reply-channel`. You do not need a Slack channel id; the
backend resolves the Slack channel, the thread and your bot identity from it.

## Parameters

| Name | Required | Meaning |
|---|---|---|
| `--channel` | yes | Chat channel id from your prompt (`[CHAT:<id>]`) |
| `--path` | yes | Absolute path of the file to send |
| `--name` | no | Filename to show; defaults to the file's own name |
| `--title` | no | Title shown above the file in Slack |
| `--comment` | no | A line of text posted with the file |
| `--thread` | no | Reply inside this thread (same id `reply-channel` takes) |

## When to use it

Whenever the person asks for a file. "发给我", "send me the PDF", "attach it".

**Do not upload to Drive and paste a link instead.** A link is not what was
asked for: it makes the reader leave Slack, it breaks for anyone without
access to that Drive, and on a phone it is several taps to something they
wanted in front of them. Send the file; add a Drive link as well only if
they will want to edit it.

Text still goes through `reply-channel` — send the words, attach the file.

## Output

`{"success":true,"data":{"slackChannelId":"C…","threadTs":"1758…","fileId":"F…","asAgentBot":true}}`

`asAgentBot:false` means your own Slack bot is not installed yet, so the file
arrived from the workspace app instead of from you. It still lands; mention
it to the owner if they ask why the name differs.

## Failures

`{"success":false,"error":"not_a_slack_channel"}` — that chat channel is not
mirrored to Slack. Nothing to attach to; reply with text.

`{"success":false,"error":"No such file: …"}` — check the path. Write the file
out first, then attach it.

`{"success":false,"error":"slack_not_connected"}` — Slack is down for this
instance. Say so; do not fall back to a link without saying why.
