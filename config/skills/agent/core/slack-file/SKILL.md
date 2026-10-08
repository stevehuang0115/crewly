---
name: Slack File
description: Get a Slack file by link or id and save it locally — also a file posted in a channel your own bot is not in, or by an agent on another machine. Prints the saved path and, for text files, the first lines.
version: 1.0.0
category: communication
skillType: claude-skill
triggers:
  - can't open the slack file
  - read this slack attachment
  - download the file from slack
  - 打不开 slack 文件
  - 读一下这个附件
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

# Slack File

When you see a Slack file you cannot open — a link a colleague pasted, a
file posted in another channel, `[Slack: ... could not be read]` — fetch it
yourself. **Never ask a colleague to paste the text.**

```bash
bash execute.sh get https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md
bash execute.sh get F0ABC12345
bash execute.sh get https://acme.slack.com/archives/C0MKTG1234/p1696771234567890   # a message with a file
bash execute.sh get F0ABC12345 --out /path/to/project/longform-en.md
```

It tries this machine's Slack bots first (yours, the uploader's, the
channel's agents, the workspace bot), then Crewly Cloud, which holds every
bot of your account on every machine.

Output: `{ "path", "name", "mimetype", "size", "via", "preview"? }`.
`path` is where the file is saved (`~/.crewly/tmp/slack-files/` unless
`--out` is given); `preview` holds the first lines of a text file. Read
the full file at `path`.

| Error `code` | Meaning / what to do |
|---|---|
| `not_visible` | No bot of your account is in the file's channel. Ask the owner to invite you (or the Crewly app) there. |
| `foreign_workspace` | The link is from a Slack workspace your account has not connected. |
| `file_deleted` | The file was deleted. |
| `too_large` | Over 25 MB. |
| `no_file_in_message` | The message link has no file attached. |
