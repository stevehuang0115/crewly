# Slack rooms: who hears a message nobody @'d

Owner's rule, 2026-09-22. Replaces the 1.18.4 rule for un-addressed channel messages ("team leader alone").

## Rule

A message in a Slack room (team channel or private/ad-hoc channel) that @'s nobody, and is not a follow-up in a thread an agent is already in:

1. **Every agent that is awake gets it, on whichever machine it runs.** Each reads it and decides for itself. Each one it reaches puts 👀 on the message with its own bot, so the eyes count shows who saw it. An agent that decides to answer runs `reply-channel --working` first, which shows "X is working on it".
2. **Agents that are asleep are not woken.** An awake agent that thinks a sleeping colleague should answer @'s them in its reply. The existing @ path wakes them, across machines too. Being @'d twice is harmless.
3. **If nobody in the room is awake anywhere**, exactly one machine wakes the room's router:
   - in a team channel, the team leader (the member with `team-leader`/`tech-lead` role, else the first member);
   - in a private room, which has no leader: the orchestrator of the primary instance if it has an agent in the room, otherwise of the instance with the most agents there.
   The router decides who should answer. A team leader @'s that agent in the channel. An orchestrator uses `reply-channel --handoff <name>`, because its bot is usually not in the private room.
4. **Awake but busy counts as awake.** The message is queued for that agent like any other.

Rules that are unchanged: an @'d agent must answer. A bare follow-up in a thread goes to the agent that spoke last (required); other agents in that thread get it as optional.

## Presence

- **Each instance reports** in its registry heartbeat (`PUT /api/cloud/slack/instances/:id`):
  - `awakeAgents`: sessions running now;
  - `rooms`: ad-hoc channel → local members;
  - `teams[].leader`.
  The heartbeat is sent on every team save, which includes status writes, and when an ad-hoc room gains a member (`requestHeartbeat`).
- **Cloud (`roomPresence`)** builds each channel's roster across instances and attaches it to every channel message as `envelope.room = { members[{agentSession, displayName, instanceId, deviceName, awake}], fallback? }`.
  - An instance that doesn't report `awakeAgents` (OSS < 1.20.88), or has gone quiet, counts as asleep and is never chosen as the fallback.
  - `fallback` is set only when no member is awake.
- **Each instance** (`SlackTeamChannelService.roomStateFor`) judges its own agents by what is actually running, not by Cloud's copy.
  - If Cloud believes one of this machine's agents is awake but it has just stopped, every other machine thinks this one has the message. So this machine wakes the router itself.
  - Without `room`, it falls back to the team-leader rule.
- **The prompt** carries `此刻谁醒着: Name（醒着/在睡，本机/device）`.

## Hand-off

`POST /api/slack/handoff {channelId, threadId?, messageId?, name}` (skill: `reply-channel --handoff`):

- **Target on this machine:** the same Slack message is re-routed with `handoffTo`. It isn't recorded a second time, and it's delivered as if the agent had been @'d (👀 and a "waking up" placeholder from its own bot).
- **Target on another machine:** `POST /api/cloud/slack/handoff`. Cloud pushes an envelope with `handoffTo` and `mentionedAgentSessions:[agent]` to that agent's instance, which skips its repeat-copy filters for it.

## Also fixed here

A channel copy that arrives through an agent's own app now sets `SlackIncomingMessage.receivedVia`. 1.20.87 read `agentSession` instead, which is only set for DMs, so "a copy through my app = I'm in the room" never fired outside tests.
