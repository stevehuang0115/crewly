# Slack rooms: who hears a message nobody @'d

Owner's rule, 2026-09-22. Replaces the 1.18.4 rule for un-addressed channel messages ("team leader alone").

## Rule

A message in a Slack room (team channel or private/ad-hoc channel) that @'s nobody, and is not a follow-up in a thread an agent is already in:

1. **Every agent that is awake gets it, on whichever machine it runs.** Each reads it and decides for itself. Each one it reaches puts 👀 on the message with its own bot, so the eyes count shows who saw it. An agent that decides to answer runs `reply-channel --working` first, which shows "X is working on it". The harness does not rely on that: for an owner's message, the first recipient seen going from idle to busy within `SLACK_TYPING_CONSTANTS.AUTO_WORKING_WINDOW_MS` of delivery gets the same placeholder posted for it (`SlackAutoWorkingService`). It is skipped when the thread already has a placeholder or an answer, and for an agent that was already busy when the message arrived. The usual rules take it down: the answer replaces it, and an agent that ends its turn without replying has it settled.
2. **Agents that are asleep are not woken.** An awake agent that thinks a sleeping colleague should answer @'s them in its reply. The existing @ path wakes them, across machines too. Being @'d twice is harmless.
3. **If nobody in the room is awake anywhere**, exactly one machine wakes the room's router:
   - in a team channel, the team leader (the member with `team-leader`/`tech-lead` role, else the first member);
   - in a private room, which has no leader: the orchestrator of the primary instance if it has an agent in the room, otherwise of the instance with the most agents there.
   The router decides who should answer. A team leader @'s that agent in the channel. An orchestrator uses `reply-channel --handoff <name>`, because its bot is usually not in the private room.
4. **Awake but busy counts as awake.** The message is queued for that agent like any other.

Rules that are unchanged: an @'d agent must answer. A bare follow-up in a thread goes to the agent that spoke last (required); other agents in that thread get it as optional. `@here` / `@channel` / `@everyone` count as no @ at all.

## A message that @'s people

Owner's rule, 2026-10-01. In #course-standardization-team the owner asked a colleague `@Info 这些课堂视频是现在每节课上传的那些吗?` in a thread Jordan had been answering. The person's `<@U…>` resolved to nothing (`mentions:[]`, `unknown:[]`), the message counted as un-@'d, and the last-speaker rule made Jordan answer it.

A person's message that @'s a Slack user is addressed to whoever it names:

- **Only people @'d** (no agent named, by `<@U…>` or by `@Name`): no agent hears it. It is recorded in the huddle (in its thread) as context only — no 👀, no placeholder, no ticket intake, no "working on it" watch, no unanswered-message watch, no "did you mean" hint. One INFO line: `Slack team message addressed to people, not agents — recorded, not dispatched`.
- **People and agents @'d:** only the @'d agents get it (required). Thread engagement does not add anyone.
- The thread last-speaker rule and the "nobody addressed" rule above never override an explicit @ of a person.

Who counts as a person (`SlackTeamChannelService.peopleMentions`): a `<@U…>` whose id is none of — a local agent's own bot (any team), the orchestrator's bot, the connected master bot (`getBotUserId`, seeded from the Cloud config), or a bot the Slack directory lists (our agents on other machines, other accounts' agents, other vendors' bots; the same cached list the roster line reads, so no extra Slack call). A typed `@Name` that matches no agent but is someone who has spoken in a mapped channel is also a person. Messages that Cloud says @ an agent (`mentionedAgentSessions`), hand-offs, and posts written by agents are not affected.

The huddle row carries the people's ids/names under `metadata.slackMentionedPeople` (`SLACK_TEAM_CHANNEL_CONSTANTS.PEOPLE_MENTIONS_METADATA_KEY`); the chat-v2 dispatcher's `computeHuddleTargets` reads it, so planning and delivery agree.

The rule holds whoever sent the message (the instance owner, another person in the workspace, a person or bot of another Crewly account) and whoever was @'d (the instance owner included), whether or not an agent spoke in the thread before, and whether the message arrived over the socket or from Cloud with room presence attached.

### Follow-ups of a person-to-person exchange

Owner's rule, 2026-10-02. In #personal-assistant-team (steamfun-ops, 1.20.191) a person @'d the owner in a top-level post; the owner answered in its thread with two messages 35 s apart: `<@U0AMU9APG9E> 没有 目前没有连接你的calendar和gmail` (recorded, not dispatched: correct) and `因为这里主要是用来做steamfun的 所以我只联通了Google drive` (no @ at all). The second counted as un-addressed; nobody in the room was awake, so the team leader Aria was woken (`optional`) and answered a message meant for the other person.

### Naming an agent without an @

Owner's rule, 2026-10-02. A message that **opens with** the display name of an agent in the room addresses that agent, exactly as an @ would. This applies everywhere, not only in person-to-person threads. Examples: `Aria，帮我…`, `Aria, can you…`, `aria: …`, `Aria帮我…`, or a typed `@Aria` that Slack left as plain text.

How the match works (`leadingNameMention` in `slack-mention-resolver.ts`):
- It ignores case and leading spaces, and tries longer names first.
- The name must end at a word boundary: punctuation, a space, the end of the message, or Chinese text after a Latin name. "Ariana …", "Aria's …" and "Calendar …" (with an agent called Cal) do not match.
- A name in the middle of a sentence never counts.
- "Agents in the room" means the room's local members plus the agents Cloud lists in `room.members` on other machines. A remote agent named this way is handled like a Cloud-reported @ of it: this machine records the message and leaves it to that machine.
- Known risk: an agent whose name is also an ordinary word that opens sentences (for example "Tidy up the docs") will be addressed.

A message with no explicit addressee of its own — no `<@U…>`, no `@Name` (known or unknown), no agent named at the start, no `@here`/`@channel`/`@everyone`, no agent Cloud lists in `mentionedAgentSessions`, not a hand-off, not written by an agent — inherits one:

- **Same-sender follow-up.** Its sender's previous message in the same conversation was addressed to people only and came at most `SLACK_TEAM_CHANNEL_CONSTANTS.PEOPLE_FOLLOWUP_WINDOW_MS` earlier (5 min; override with the env var `CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS`). In a thread the conversation is the thread. At the top level it is the channel's latest top-level message.
- **Person-to-person thread.** In a thread, walk back from the newest message. Agents' posts and human messages with no addressee are skipped. The first human message that has an addressee decides:
  - it @'d people only: the follow-up is context only;
  - it @'d an agent (here or on another machine), or `@here`/`@channel`: the normal rules apply.
  The exchange lasts `SLACK_TEAM_CHANNEL_CONSTANTS.PERSON_EXCHANGE_WINDOW_MS` from the last explicit human-to-human @ in the thread. The default is 30 min; override it with the env var `CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS`. Inherited follow-ups do not extend it. After that, the normal rules apply again, and the prompt still names the earlier exchange. To bring an agent in sooner, @ it or open the message with its name.

An inherited addressee is handled exactly like an explicit @ of a person. The row is recorded as context only, with `metadata.slackMentionedPeople` set to the inherited people and `metadata.slackAddresseeInherited` set to `same-sender-followup` or `person-exchange`. Nobody is woken: not the last speaker, not "every awake agent decides", and not the nobody-awake team-leader/orchestrator wake. One INFO line: `Slack team message continues a person-to-person exchange — recorded, not dispatched`. A row addressed to an agent on another machine carries `metadata.slackMentionedAgents`, so the walk knows that exchange included an agent.

### Prompt backstop

Routing decides who hears a message. The prompt also says who it was for, in case routing lets something through. The agent's turn gets an `Addressed to:` line when:

- the message @'d people as well as this agent: answer only the part meant for you;
- the message @'d people and not this agent (routing should never deliver this): "this message was addressed to <person>, not you — reply only if asked";
- the agent was not @'d, and the conversation's recent human messages were people addressing each other: the message may continue that exchange. This covers the thread before the last agent @, and a different person's top-level post within the window. Reply only if asked; the default is to stay silent.

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
