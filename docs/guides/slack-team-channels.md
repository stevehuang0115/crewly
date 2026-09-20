# Slack team channels

Give every Crewly team its own Slack channel. Everyone on the team sees what
you post there, `@name` makes a specific agent answer, and each agent's reply
appears in the thread under its own name and icon. The orchestrator is not in
the loop — it keeps handling DMs and any channel that is not linked to a team.

```
you  ──▶  #alpha-team  ──▶  every agent on Alpha Team
                 ▲                 │
                 └── Sam / Leo / Mia reply in-thread, as themselves
```

## Setup

1. Add these bot scopes to your Slack app (OAuth & Permissions) and reinstall
   the app: `channels:manage`, `channels:join`, `channels:read`,
   `groups:read`, `chat:write.customize`. The bundled manifest
   (`config/slack-app-manifest.json`, also served by `GET /api/slack/install`)
   already includes them.

   `groups:read` is easy to miss and fails the whole feature: Crewly looks a
   channel up by name with `conversations.list` over public *and* private
   channels, so without it the first step of creating a team channel answers
   `missing_scope` — the error a second install hit on 2026-09-19, whose app
   had been built from an earlier version of this list. An app installed
   before that date needs the scope added and the app reinstalled; the
   missing-scope error now names the scope Slack asked for.
2. In Crewly → Settings → Slack, the **Team Channels** card appears once Slack
   is connected.

## How channels come and go

| Event in Crewly | What happens in Slack |
|---|---|
| A **new** team is created (and *Auto-create* is on) | `#<team-name>` is created, the bot posts a welcome listing the members |
| Team members change | The channel's roster follows the team |
| Team archived or deleted | The channel is archived |
| Existing team (created before this feature) | Nothing automatic — click **Create channel** or **Link** an existing channel in Settings |

Auto-create only reacts to *newly created* teams on purpose: Crewly saves team
files on every status change, and treating each save as "new team" would fill
your workspace with channels.

The channel name is the team name, lower-cased and hyphenated (`Growth Team`
→ `#growth-team`). Set a prefix (for example `crew-`) in Settings if you want
Crewly's channels grouped together.

## Talking to a team

- Post in the channel: every agent on the team receives it and may reply.
- `@sam 看一下这个` — Sam **must** reply; the others still see the message.
- A typo (`@lee`) gets a thread reply suggesting the closest names; the message
  still reaches the whole team.
- Replies stay in the Slack thread. Behind the scenes the thread maps to a
  chat-v2 thread, so the same conversation is visible in Crewly's chat UI.

## Storage

Mappings live in `~/.crewly/slack-team-channels.json`:

```json
{
  "version": 1,
  "autoCreate": true,
  "channelPrefix": "",
  "mappings": [
    { "teamId": "…", "slackChannelId": "C…", "slackChannelName": "alpha-team",
      "chatChannelId": "…", "createdAt": "…", "autoCreated": true }
  ]
}
```

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/slack/team-channels` | Settings + every team with its mapping |
| `PUT` | `/api/slack/team-channels/settings` | `{ autoCreate?, channelPrefix? }` |
| `POST` | `/api/slack/team-channels` | `{ teamId, slackChannelId? }` — create, or link an existing channel |
| `DELETE` | `/api/slack/team-channels/:teamId?archive=true` | Unlink (and optionally archive the Slack channel) |

## Agents starting a conversation

Reactive replies stay in the thread they came from. For anything an agent
raises itself there is the `slack-post` skill:

```bash
bash config/skills/agent/core/slack-post/execute.sh --target "#general" --text "Deploy finished."
bash config/skills/agent/core/slack-post/execute.sh --target "@steve" --text "This needs you."
```

Targets are `#channel`, `@person`, or a Slack id (`C…` channel, `D…` open DM,
`U…` person). Ids are upper-case and channel names lower-case, which is how
they are distinguished. With an agent identity installed the message comes
from that agent's bot, and a DM is a real conversation with it; otherwise the
shared Crewly bot sends it under the agent's name.

Agents already *read* every message in a channel the bot is in, not only the
ones that mention them: the whole team receives each message, and the mention
only decides who must answer.

## Limits

- One Slack app means one bot user. Agents are distinguished by per-message
  name and icon (`chat:write.customize`), which is why Slack's native `@`
  autocomplete does not list them. Real per-agent bot users are the next
  phase (per-agent Slack apps provisioned through Crewly Cloud).
- Private channels cannot be joined by the bot on its own; invite it first,
  then link the channel.
