# Reply pacing: size the job, say the plan first (2026-09-24)

## The owner's request

On a long job, Slack showed only "⚙️ Ella is working on it…" and later "⏱ still working on this". There was no sign of what the agent understood or how it planned to do the work.

The owner wants the agent to judge the size of the job first:
- **Quick job:** do it and reply once, as today.
- **Longer job:** first say something like "got it", "here's my plan" or "this will take a while", then work.

That way expectations are set, and the owner can come back later.

## Design

- **Instruction.** Every reply instruction an agent receives gets `CHAT_REPLY_PACING_HINT` appended. This covers Slack team channels, shared rooms, agent DMs and chat-v2, via `defaultFormatPrompt` in `chat-v2.dispatcher.service.ts`. The orchestrator's routing turn is excluded, because it answers nothing. The rule:
  - Quick: a minute or two, one step. Do it and reply once.
  - Longer: several steps, running commands, driving a browser, a lot of reading, or more than about 3 minutes. First send one or two lines with `--interim`: what you understood, the plan, roughly how long, and any question for the owner. Then work, then send the final reply.
  - No progress updates in between, unless blocked or the plan changed.
- **Flag.** `reply-channel --interim` and `reply-chat --interim` add `interim: true` to the request.
  - `POST /api/chat/channels/:id/messages` passes it through `ChatV2Service.sendMessage`.
  - `POST /api/chat/agent-response` passes it through the chat-v2 DM record.
  - Either way it is stored as `metadata.interim` (key `SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY`). This only applies to agent senders.
- **Slack mirror.**
  - `SlackTeamChannelService.mirrorOutbound` and `SlackAgentDmService.mirrorOutbound` resolve the placeholder into the note as usual.
  - For an interim note they then `begin` a new "⚙️ … is working on it…" placeholder under the same key.
  - The final answer replaces that new placeholder.
  - Result in Slack: note → working → answer.
- **Tickets.** `TicketReviewService.onChatMessage` ignores interim notes, so a plan is never taken for the answer that moves a ticket to 待验收.

## Not covered

The orchestrator's legacy Slack bridge (`reply-slack`) is a separate path and was left unchanged.
