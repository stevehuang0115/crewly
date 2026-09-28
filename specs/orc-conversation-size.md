# Orchestrator conversation size

On 2026-09-23 Air's orchestrator (claude-code, Opus with a 1M window) re-read 612k tokens every turn, and only about 0.1% of each turn was new. The history had grown about 64k a day since 09-20 without ever being compacted:

- Claude Code only compacts near the 1M window.
- Crewly's own threshold compaction is off (the owner's choice: it fired at bad moments).
- The conversation was resumed across every restart.

The assembled system prompt is about 10.9k tokens, 1.8% of each turn. So the lever is the conversation itself, not the prompt text.

## Fresh conversation at a restart

`AgentRegistrationService.closeOversizedOrcConversation` runs when the orc is launched and would resume its stored Claude Code conversation:

- It measures the last real turn of the transcript (input + cache read + cache write; `lastTurnContextTokens`).
- If that is at or above `ORC_CONVERSATION_CONSTANTS.FRESH_CONTEXT_TOKENS` (300k; env `CREWLY_ORC_FRESH_CONTEXT_TOKENS`), the orc starts a fresh conversation instead of resuming.
- `buildHandoverSummary` writes `~/.crewly/handover/crewly-orc-<ts>.md`. It holds the plain words at the end of the old conversation: at most 40 messages, 800 characters each, 16k characters in total, with no tool traffic or system reminders, and no model call. It also records the path of the old transcript.
- The kickoff message tells the orc to read the handover file once after registering.
- Its real state (tasks, teams, OKRs, wiki) lives in Crewly and is read back by the startup steps anyway.
- This never happens mid-conversation. It applies only to the orchestrator on Claude Code.

## Less read into the conversation (what is read stays and is re-read every turn)

- Startup no longer `cat`s the ~50KB skills catalog; the orc `grep`s one skill when needed.
- Slack messages carry `[SLACK:<channel>:<threadTs>]`. The orc no longer reads the whole (unbounded) thread file to find them, and uses `tail`/`head` when it does need it.
- `get-tasks` returns stats plus open items only: compact fields, newest first, 50 at most, with filters `status` / `all` / `target` / `limit`. It streams the pool through a pipe with the skill output cap bypassed. The old version returned the entire 3.5MB pool; past about 1MB, and whenever the cap turned the response into a truncation envelope, it silently returned `[]`.
- Agent statuses forwarded to the orc are clipped to 600 characters, with a pointer to the conversation holding the full report.
- The lifecycle fragment's placeholders are now resolved. The orc used to see a literal `{{ORCHESTRATOR_SKILLS_PATH}}`.

Not changed: the orc's working directory, which is still the first project. The skill hints use relative paths, and moving the orc needs a separate check.

## Members: fresh conversation per task, and the idle-boundary cap

`FreshTaskConversationService` (backend/src/services/agent/fresh-task-conversation.service.ts) keeps Claude Code team members' conversations bounded. It never applies to the orchestrator, and it never clears during a turn.

**How a task reaches a member, and where the clear happens.** A task gets exactly one delivery, and the clear runs once, before that delivery:

- The dispatcher's `workitem:queued` push. `TaskPoolService.publishWorkItemQueued` puts `workItemId` and `target` on the event. `EventBusService.publish` passes both through its `event_published` signal. Before 2026-09-28 the signal carried only eventId, eventType and sessionName, so the listener never fired. `WorkItemDispatchSubscriber.dispatchTo` runs `prepareForTask`, then writes the brief. The queued push skips `crewly-orc`; the reconciler still handles the orc's items.
- The team-leader direct hand-over (`delegate-task`). The skill creates the WorkItem with `metadata.directDelivery: true`. It then posts `/terminal/:s/deliver` with the full brief, `workItemId`, and the id in the text. The controller (`prepareWorkItemHandOver`) takes the dispatcher's dedup key `(workItemId, target)` and runs `prepareForTask`. If that cleared the conversation, it puts the handover note first. For a direct-delivery item, the queued push waits `DIRECT_DELIVERY_CONSTANTS.GRACE_MS` (90 s). After that it delivers only if the hand-over never landed. A failed hand-over gives the key back. `/write` behaves the same way when it carries a `workItemId`. A deliver or write without one is never cleared.

**Idle-boundary context cap.** One task can run for 1000+ turns. Every 60 s a sweep checks each registered member. It caps a member only when all of these hold:

- its last turn (`lastTurnContextTokens`) is over `CREWLY_MEMBER_CONTEXT_CAP_TOKENS` (default 300k; `0` disables the cap);
- it is idle (not `in_progress`, and the PTY has been quiet for 30 s or more);
- nothing is being delivered to it, was delivered to it in the last 30 s, or is queued for it;
- it has not been capped in the last 20 minutes;
- it has an active WorkItem.

To cap a member, the sweep writes the handover file, stores a copy through memory so it reaches the wiki, and sends `/clear`. It then writes one `[CREWLY-CONTEXT-CAP]` line that names the WorkItem id and the handover path. The new conversation id is found by that WorkItem id plus the rule that it started after the clear, the same way as after a new-task clear. `AgentRegistrationService.sendMessageToAgent` marks each delivery as in progress while it runs and waits for any running clear to finish, so a clear cannot wipe a message on its way in.
