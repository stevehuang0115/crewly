# Private channels: owner edits a group chat (#1400 phase 2)

Status: shipped in OSS. Portal UI pending (the relay RPCs are in place).

## What the owner asked for

"Each team is a public channel. The owner can also create private channels and
invite chosen agents into them (an ad-hoc team)."

## What already existed

- A **group chat** is a chat-v2 `type='huddle'` channel with an explicit roster
  (`chat_channel_members`). `/team-chat` → "New group chat" creates one; the
  dispatcher fans the owner's messages out to every member (an @'d member must
  reply, the others may).
- A **Crewly channel** (`crewly-channel.service.ts`) wraps a huddle in a registry
  (`~/.crewly/crewly-channels.json`) and, when Slack is connected, mirrors it to one
  Slack channel. It has rename / add / remove through `/api/channels` and the
  "Channel settings" dialog.

So private channels existed, but a plain group chat could not be renamed or have
its roster changed after creation, and the Cloud portal could create a huddle but
not edit one.

## What this adds

| Surface | Change |
|---|---|
| chat-v2 service | `setHuddleRoster(channelId, memberSessions, principal)` — owner-only, huddles only, same roster rules as `createHuddle` (dedupe, 1..50). `renameChannel` (existing) now refuses a Crewly channel, as does `setHuddleRoster`: those go through `/api/channels` so Slack follows. |
| REST | `PATCH /api/chat/channels/:id` `{ name }`; `PUT /api/chat/channels/:id/members` `{ memberSessions }` (complete roster). |
| Relay RPC | `renameChannel`, `setHuddleMembers` (closed set in `cloud-sync.types.ts`), for the portal and phone. |
| `@crewly/chat-ui` | `Channel.members` (roster of a huddle, from the DTO), optional `renameChannel` / `setHuddleMembers` on `ChatApiClient`, implemented by the HTTP and mock clients. |
| `/team-chat` | A group chat gets the same "Channel settings" menu item as a Crewly channel; the dialog is backed by the chat client (add = roster + agent, remove = roster − agent) and the channel list refreshes after each change. |

Not changed: delivery rules, the Slack bridge, Crewly channels.

## Tests

`chat-v2.service.test.ts` (roster replace, refusals: empty / DM / other owner / Crewly
channel, rename), `chat-v2.controller.test.ts` (PATCH + PUT, 400 / 404),
`chat-v2.relay-adapter.service.test.ts` (both RPCs), `cloud-sync.types.test.ts`
(closed set), `dto.test.ts` (members mapping), `LiveTeamChatPage.test.tsx` (group
chat settings go through the chat client, not the Crewly-channel API).
