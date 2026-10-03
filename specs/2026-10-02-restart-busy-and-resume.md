# Restart busy detection and resume of interrupted work

Status: implemented (2026-10-02)
Extends: `specs/safe-restart.md`, `specs/2026-10-01-reply-open-items.md`, `specs/2026-09-26-agent-status-hooks.md`

## Incident (2026-10-02, Eve, TKT-194)

- 04:37:59Z: `evership-eve-398f05df` (Claude Code) told the owner in #evership that she would post the plan document there in about 20–30 minutes ("大约 20–30 分钟后把方案文档发到这里"). She sent it with `reply-channel --interim`.
- She then kept working. Her transcript shows a background `Explore` subagent (launched 04:38:21), web searches, and Claude Docs updates up to rev 7 at 04:43:56.
- 04:40:18: her turn ended (`stop_reason: end_turn`, "the data inventory is still running in the background"). The background subagent was still running.
- 04:41:11: the subagent finished, and Claude Code started a new turn on its own from the `<task-notification>`. Crewly did not deliver anything, so this turn was not tracked.
- 04:42:33: ActivityMonitor published `agent:idle` / `agent:idle_after_task`, because the screen had not changed for one 30 s poll while the model was writing a long tool input. `[SlackTyping]` took the placeholder down.
- 04:43:53: SIGTERM from an external restart-when-idle script. `[RestartDrain]` waited only for `ce-vera` and `think-tank-atlas`. Eve had no tracked turn, so she was not waited on, and she was killed mid-work.
- After the restart: `Skipping auto-restore for sessions with no work in hand`. Eve stayed down, and the owner never got the document, although it already existed in Claude Docs.
- No `[OpenItems] Commitment tracked` was logged for TKT-194, so there was no follow-up when the promise came due.

## Root causes

1. **Busy came from screen output and Crewly's own deliveries, not from the runtime's turn state.**
   - The in-flight tracker only knew about turns that a Crewly delivery started. A turn the runtime started itself (a background subagent or a background shell finishing) was invisible. This was a documented known limit in `safe-restart.md`.
   - The probe (status bar + 15 s of PTY quiet) and the ActivityMonitor (screen diff per 30 s poll) both read "silent" as "idle". A long tool call, or the model writing a long tool input, is silent.
   - Background work (a subagent or a `run_in_background` shell) runs after the main turn has ended. No signal reported it.
2. **The drain and readiness only listed tracked turns**, so the drain never probed Eve at all.
3. **Boot restored only sessions with active WorkItems or interrupted deliveries.** An owner commitment (its follow-up WorkItem is `blocked`) and an owed owner reply did not count as work in hand.
4. **Promises in interim notes were dropped.** `OpenItemsService.onAgentMessage` returned early for any message flagged `interim`. An interim note ("got it, here is my plan, I'll post X in 30 minutes") is exactly where agents make time-bound promises. The extractor itself parses Eve's message correctly (commitment, due at +30 min). The restart did not drop a pending extraction: the chat-v2 `chat_message` handler runs within milliseconds of the post.

## Design

### 1. Runtime turn state (`services/monitoring/agent-turn-state.ts`)

One in-memory record per session, fed by Claude Code hooks, with a transcript fallback. It answers `getVerdict(session)` with:

| Verdict | Meaning |
|---|---|
| `turn` | A turn is in progress (thinking, streaming, or a tool call running) |
| `background` | The main turn ended, but a subagent or background task is still running and will start a new turn when it finishes |
| `idle` | The runtime reported that the turn ended and nothing is pending |
| `unknown` | No signal for this session (other runtimes, hooks not installed) |

It also returns `longRunning` (a tool call or subagent is open) and `since`.

**Hook events.** The agent-status hook (`config/hooks/agent-status/report.sh`) is now also registered for `PreToolUse`, `SubagentStart` and `SubagentStop`. It sends two more identifiers, `toolUseId` and `agentId` (`[A-Za-z0-9_-]{1,128}`; nothing else from stdin leaves the machine).

| Event | Effect |
|---|---|
| `UserPromptSubmit` | turn active |
| `PreToolUse` | turn active, tool `toolUseId` open |
| `PostToolUse` | turn active, tool `toolUseId` closed |
| `SubagentStart` | subagent `agentId` running |
| `SubagentStop` | subagent `agentId` finished; the turn is active again, because the parent is notified and resumes |
| `Stop` | turn ended, open tools cleared (running subagents stay) |
| `Notification`, `PermissionRequest` | no change (the waiting-on-human signal handles these) |

**Staleness.** A lost `Stop` must not pin an agent as busy forever:
- An active turn with no hook event for `TURN_STATE.HOOK_SILENCE_MS` (10 min) and no open tool or subagent is no longer trusted, and the verdict becomes `unknown`, so the screen decides.
- An open tool call or a running subagent expires after `TURN_STATE.OPEN_WORK_MAX_MS` (60 min).

**Transcript fallback (Claude Code).** `claudeTranscriptTurnState(file)` reads the tail of the session's transcript (`~/.claude/projects/<cwd slug>/<claudeSessionId>.jsonl`, found through session persistence):
- The last main-chain entry is an assistant message with `stop_reason: tool_use`, a tool result, or a user prompt / `<task-notification>` → `turn`. This applies only when the file changed within `TURN_STATE.TRANSCRIPT_FRESH_MS` (10 min).
- A `tool_use` with `input.run_in_background: true` whose `<task-notification>` has not appeared yet → `background`. This applies only within `OPEN_WORK_MAX_MS` of the launch.
- An assistant `end_turn` or a `turn_duration` / `stop_hook_summary` system entry, with no pending background task → `idle`.

The fallback catches background shells (`Bash` with `run_in_background`), which fire no subagent hooks, and covers hooks that failed to post. Results are cached per (path, size, mtime).

**Combining.** `turn` beats `background`, which beats `idle`, which beats `unknown`. Hooks and the transcript are combined this way.

**Other runtimes.**
- In-process (crewly-agent): the tracker already ends the turn exactly when its promise settles.
- Codex: shows "esc to interrupt" for the whole turn, which the probe already reads.
- Gemini CLI: shows "esc to cancel" while working. The probe now reads it, but only for Gemini sessions, because Claude Code dialogs also say "Esc to cancel".
- Antigravity: no reliable turn signal is known. It keeps the PTY-activity fallback.

All of these keep the PTY-activity fallback when their verdict is `unknown`.

### 2. Who consumes it

- **Turn probe** (`turn-probe.ts`). The probe gets `getRuntimeVerdict`.
  - `turn` or `background` → `busy`.
  - When a delivery is newer than the last hook event, the session stays busy for up to `TURN_STATE.DELIVERY_START_MS` (2 min) while waiting for `UserPromptSubmit`. A session is mid-turn from delivery until the runtime's turn-end signal.
  - Otherwise the existing status bar and PTY-quiet checks apply.
- **In-flight tracker.** `getMidTurn()` also lists sessions that the runtime reports busy even though no delivery is tracked: self-started turns and background work. These turns have no messages and carry `origin: 'runtime'`. Every turn carries `longRunning`.
- **Restart drain.** If any agent it waits on is `longRunning`, the cap becomes `SAFE_RESTART.BACKGROUND_DRAIN_TIMEOUT_MS` (10 min, `CREWLY_RESTART_DRAIN_BACKGROUND_MS`). Otherwise the existing `DRAIN_TIMEOUT_MS` (2 min) applies. `CREWLY_RESTART_DRAIN_MS=0` still disables the wait. After the cap the drain proceeds, and the remaining agents are persisted as interrupted. The CLI's shutdown budget (SIGKILL deadline, systemd `TimeoutStopSec`) uses the larger cap.
- **`GET /api/system/restart-readiness`, auto-update quiet window, system-control busy list.** All three read `getMidTurn()`, so they see the new sessions without other changes.
- **ActivityMonitor.**
  - When the screen did not change but the runtime verdict is `turn`, the member stays `in_progress`. No `agent:idle` / `agent:idle_after_task` is published mid-turn.
  - A `background` verdict does not keep it `in_progress`, because the agent can take messages.
  - The existing 15-minute auto-reset still caps a stuck `in_progress`.
- **Placeholder settling and ticket submit on `agent:idle`.**
  - `settleTurnWithoutReply`, `settleOpenThreads` and the ticket review's `onAgentIdle` are skipped while the agent has background work. The work is not finished, and the turn that delivers it comes later.
  - The queued-message flush still runs.

### 3. Resume interrupted work

- **Shutdown.** `saveInterruptedTurns` now also persists turns with no delivered message (`origin: 'runtime'`) as one `kind: 'work'` entry per session. Its label is the ticket marker of the last message delivered to that session (the tracker remembers it after the turn settles). A turn made only of `[SYSTEM]` pings is still dropped, because its producers fire again.
- **Boot restore set.** `sessionsToRestore` adds:
  - the sessions in `interrupted-turns.json` (as before);
  - agents with an active owner commitment (open-items `commitment` in `open` / `overdue`) on a ticket that is not done or cancelled;
  - agents responsible for an owed owner reply in the owner-message watchdog store.
- **Resume note.** Each restored agent gets one English message per interruption, through the usual paths: re-enqueue with the original source for queue messages, `sendMessageToAgent` otherwise. The note reads:

  > Crewly restarted while you were working on TKT-194. Continue where you left off and deliver.

  For a message entry, the original message follows the note, so the reply keeps its routing. For a commitment, the promise is quoted ("You promised the owner: …").
- **One note per session.** A session with message entries gets no extra `work` note. A commitment holder that was also interrupted gets only the interrupted-turn note.
- **Context is kept.** Restored Claude Code and Codex agents resume their conversation (`--resume` / `codex resume`, see the agent-session-resume work), so the agent sees what it had already done. In Eve's case, that includes the Claude Docs document.

### 4. Promise tracking on every agent→owner path

- Every agent reply path ends in a chat-v2 `chat_message`:
  - `reply` (`/chat/reply`)
  - `reply-channel` (`/chat/channels/:id/messages`)
  - `reply-chat` / `send-chat-response` / `report-status` (`/chat/agent-response`)
  - `slack-post` in a thread, through the Slack → chat-v2 mirror

  `OpenItemsService.onAgentMessage` runs on that event.
- **Interim notes are now read for commitments only.** No questions are taken from them, and they never count as a delivery (`deliveredBy` already refused interim posts).
- A due phrase of 20–30 minutes gives a due time 30 minutes after the post (the upper bound). This is existing extractor behaviour, now covered by a test with Eve's message.
- When the promise comes due, the existing open-items sweep nudges the agent once, and later posts one owner note if the work is still undelivered.
- A top-level Slack post with no thread is not mirrored into chat-v2, and so cannot be tied to a ticket. This is unchanged.

## Tests

- `agent-turn-state.test.ts`:
  - hook sequences, including Eve's: Stop while a subagent runs → `background`; SubagentStop → `turn`; Stop → `idle`;
  - silence expiry;
  - transcript parsing.
- `turn-probe.test.ts`: silence during a long tool call is not idle; the runtime verdict overrides a quiet PTY.
- `in-flight-turn-tracker.service.test.ts`: a self-started runtime turn is listed by `getMidTurn`.
- `restart-drain.service.test.ts`: the drain waits for that agent; the long-running cap applies; after the cap the agent is returned as interrupted.
- `interrupted-turns.test.ts`:
  - work entries are saved;
  - an interrupted agent is restored and gets the resume note with its ticket;
  - commitment holders get one note.
- `restore-filter.test.ts`: commitment and owed-reply sessions are restored.
- `activity-monitor.service.test.ts`: no `agent:idle` while the runtime reports a turn.
- `open-items.service.test.ts`: Eve's interim `reply-channel` message creates a commitment due at +30 min.
- `agent-hooks.controller.test.ts`, `control-plane-guard.service.test.ts`, `report.test.ts`: the new events and identifiers.
