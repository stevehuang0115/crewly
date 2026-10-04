# Shared rooms: follow Cloud's delivery facts, and audit what never arrived

Cloud side: crewly-services `fix/room-routing-verified-owner`
(`auth/specs/2026-10-04-room-routing-verified-owner.md`). Builds on
`2026-10-03-shared-room-owner.md` (#1019).

## Incident

On 2026-10-03 at 16:06Z, the owner wrote a top-level, un-@'d message in
#content-team (`C0C46TTBNNP`, ts `1791043567.147439`). Ella and Atlas, the
room's agents, both run on the Mac. The Mac never received the message: it
is not in the Mac's chat.db. Cloud (auth 1.10.2) picked the Air as the
room's owner. The Air reported the room from a never-pruned ad-hoc roster,
and its instance id sorts lowest. Cloud pushed the message to the Air only.

Today's checks look at the local chat.db, so a message that never arrived
on this machine can't show up in them.

## 1. Follow Cloud's delivery facts

Cloud now sends `room.delivery = { owner, targets, rule, reason }`, and
`members[].verified`. A member on a machine that is not proven to be in the
room comes with `awake: false`.

`roomOwnerInstance(room)` is the owner every machine defers to. Exactly one
machine is the owner, and it is always one that has the message.

- `delivery.owner` is set: that machine. Cloud names a responder for every
  un-@'d top-level human message, including when it is `uncertain` who is
  in the room. It pushes the responder first, and names a new one
  (`owner-unreachable`) if that push fails, before telling the others.
- No named owner: the #1019 rule, applied only to the machines in
  `delivery.targets`. That is home when an agent there is awake, else the
  lowest instance id with an awake team leader, else the lowest with an
  awake member.
- No `delivery` (older Cloud): unchanged.

"Uncertain" never means "everyone answers"; that would be the two-Ellas
case again (review of crewly-services#32).

`roomWatcherInstance` picks the last-resort watcher only from
`delivery.targets` when it is present, so the watcher is always a machine
that holds the message.

When a machine has no room mapping and defers to another machine
(`sharedRoomOwnedElsewhere`), it now logs the owner and Cloud's targets. A
machine with no local member never swallows a message silently. It defers
only to an owner that Cloud says received the message. Otherwise the
message falls through to its orchestrator, which acts.

## 2. Delivery audit

`GET /api/slack/delivery-audit?hours=24` (max 168). It is owner-only
(`rejectNonOwner`): an agent gets 403, and anyone else without an owner
credential gets 401.

For each Slack channel this machine maps (team channels and ad-hoc rooms):

1. Read it with the bot token of one of its own members:
   - `conversations.history` back to `now - hours`;
   - `conversations.replies` for threads active in that window, up to 20
     per channel.
2. Keep the owner's messages: the workspace installer
   (`getOwnerUserId`). If the owner is unknown, keep every human message.
3. For each message:
   - **here**: is it in this machine's chat.db? (`metadata.slackChannelId`
     plus `slackTs`, any chat channel)
   - **Cloud**: what does the routing log say?
     (`GET /api/cloud/slack/routing-decisions?channel&since`)

Verdicts:

| verdict | meaning |
|---|---|
| `reached-here` | in this machine's chat.db |
| `reached-other-instance` | not here; Cloud pushed it to another machine (named) |
| `pushed-here-not-recorded` | Cloud pushed it here, but chat.db has no row |
| `never-reached` | Cloud has a record, and no machine got a push |
| `no-cloud-record` | not here, and Cloud has no record (older Cloud, past 14 days, or Cloud unreachable) |

`summary.missing` counts the last three. A channel the bot can't read is
listed with its error, and is never silently skipped.

## Tests

- `slack-team-channel.service.test.ts`: a non-owner defers only when
  Cloud's targets include the owner; `uncertain` and `owner-unreachable`
  mean no deferral; `delivery.owner` wins over a disagreeing presence; the
  watcher pool is limited to targets.
- `slack-delivery-audit.service.test.ts`: every verdict, an unreadable
  channel, thread replies, and Cloud unavailable. No real Slack or Cloud
  calls are made (fetch is injected).

## 3. Ad-hoc room rosters are checked against Slack (2026-10-04 15:05Z)

On 2026-10-04 Cloud routed an owner message to the Air (crewly-services#34).
The Air's ad-hoc roster for #content-team still listed
`personal-assistant-team-ella`, who was awake, but her bot was never in the
channel. Ad-hoc rosters only ever grew.

`SlackTeamChannelService.pruneAdhocMembers()` runs 2 minutes after start,
then every 6 hours:

1. For each ad-hoc room, read `conversations.members` with its members'
   own bot tokens, one by one, until one read succeeds.
2. Drop each member whose bot user is not in that list.
3. A bot whose own read returns `not_in_channel` or `channel_not_found` is
   also dropped.
4. Keep a member with no bot of its own (it can't be checked). Keep
   everyone when Slack can't be read for any other reason (rate limit,
   network).
5. If anything was dropped: save, then send a heartbeat now so Cloud's
   `rooms` follows. A dropped agent is re-added when a copy next arrives
   through its own app.

## 4. Cloud names a responder or a fallback: every other machine defers (review of crewly-services#34)

- `delivery.owner` set → that machine. Cloud now names one for every
  un-@'d top-level message where anyone is awake, including when every
  proven agent is asleep and only claimed agents are awake (`uncertain`).
- `delivery.rule = nobody-awake` → the owner is `room.fallback.instanceId`.
  That machine wakes its lead. Every other machine defers: no dispatch to
  agents that are awake only by its own count, and no orchestrator
  fall-through (`sharedRoomOwnedElsewhere`).
- Pruning ad-hoc members (§3) re-reads the agents' bot ids and tokens from
  Cloud (`refreshIdentities`) before dropping anyone. It drops only members
  absent in both reads, so a reinstalled app (new bot user id) does not flap.
