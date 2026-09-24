---
name: slack-post
description: Start a Slack conversation yourself — post to a channel or DM a person, under your own Slack identity. Use it to raise something proactively, not to answer a message you were already sent (that is reply-channel).
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - team-leader
  - tpm
  - developer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa
  - qa-engineer
  - designer
  - product-manager
  - architect
  - generalist
  - sales
  - support
  - marketing
triggers:
  - slack post
  - message slack
  - dm on slack
  - tell the team on slack
tags:
  - communication
  - slack
  - proactive
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 20000
---

# slack-post

Send a Slack message on your own initiative. If you have a Slack identity of
your own, the message comes from your bot user, so a DM is a real conversation
between that person and you. Otherwise it goes out through the shared Crewly
bot carrying your name and icon.

## When to use

- Something you found needs a human's attention now, and nobody asked you.
- You finished long-running work and the person who wanted it is not in the
  thread any more.
- You need one specific person, so a DM beats the team channel.

**Do not use it to answer a message you were handed.** A prompt that starts
with `[CHAT:<channelId>]` is answered with `reply-channel`, which keeps your
reply in the same Slack thread.

## Invocation

```bash
bash config/skills/agent/core/slack-post/execute.sh \
  --target "#general" \
  --text "Deploy finished, staging is on 1.4.2."
```

```bash
# DM a person by handle
bash config/skills/agent/core/slack-post/execute.sh --target "@steve" --text "..."

# Reply inside an existing Slack thread
bash config/skills/agent/core/slack-post/execute.sh --target C0123ABCD --thread 1712345678.000100 --text "..."

# Long text from a file, or piped
bash .../execute.sh --target "#general" --text-file /tmp/report.md
echo "..." | bash .../execute.sh --target "@steve"
```

## A private message that fails stays unsent

If a DM cannot be delivered, **do not post the same thing to a channel**.
Team channels are public: everyone in the workspace can read them. Content
you were about to send to one person — anything out of the owner's mail,
calendar, files, or notes — does not become postable just because the DM
failed.

Say that you could not reach them privately, and say it without the
content. "I could not DM you — the calendar reminder is set, tell me where
to send the details" is fine. Repeating the details in the channel is not.

`cannot_dm_bot` means you targeted an app, not a person — very likely
yourself. Look up the person's handle and try that.

## Target syntax

| Target | Goes to |
|---|---|
| `#general` or `general` | that channel |
| `C0123ABCD` | that channel by id |
| `D0123ABCD` | an already-open DM |
| `@steve` | a DM with that person |
| `U0123ABCD` | a DM with that user id |

Slack ids are upper-case and channel names are lower-case, which is how the
two are told apart. Write ids exactly as Slack shows them.

## Options

| Flag | Short | Description |
|---|---|---|
| `--target` | `-c` | Channel or person (required) |
| `--text` | `-m` | Message text (required unless piped or `--text-file`) |
| `--text-file` | | Read the text from a file |
| `--thread` | `-t` | Slack thread timestamp to reply inside |
| `--json` | `-j` | Raw JSON payload |

## Environment

- `CREWLY_SESSION_NAME` — your agent session, attached automatically. The post
  is sent under that agent's identity, so this must be set.
- `CREWLY_API_URL` — set by Crewly to the running instance (e.g. `http://localhost:8797` when started with `-p 8797`); falls back to `http://localhost:${WEB_PORT:-8787}`.

## Output

On success, JSON on stdout:

```json
{"success":true,"channelId":"C-GEN","messageTs":"1712345678.000200","kind":"channel","postedAs":"agent"}
```

`postedAs` is `agent` when your own Slack bot sent it, `crewly` when the shared
bot did.

## Failures worth knowing

| Message contains | What to do |
|---|---|
| `No Slack channel named` | check the name, or the bot cannot see it (private channel needs an invite) |
| `No Slack user matches` | the handle is wrong; ask for the exact Slack handle |
| `invite ... into the channel` | a private channel the bot is not in; ask a human to invite it |
| `reinstall the app` | the Slack app is missing a scope; tell the owner |
| `Slack is not connected` | Slack is not configured on this install; stop, do not retry |
