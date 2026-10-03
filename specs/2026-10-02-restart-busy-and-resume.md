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

**Hook events.** The agent-status hook (`config/hooks/agent-status/report.sh`) is now also registered for `PreToolUse`, `SubagentStart`, `SubagentStop` and `SessionStart`. It sends three more fields: `toolUseId` and `agentId` (`[A-Za-z0-9_-]{1,128}`), and the SessionStart `source` (startup / resume / clear / compact). Nothing else from stdin leaves the machine.

| Event | Effect |
|---|---|
| `UserPromptSubmit` | turn active |
| `PreToolUse` | turn active, tool `toolUseId` open |
| `PostToolUse` | turn active, tool `toolUseId` closed |
| `SubagentStart` | subagent `agentId` running |
| `SubagentStop` | subagent `agentId` finished; the turn is active again, because the parent is notified and resumes |
| `Stop` | turn ended, open tools cleared; the turn's subagents are *held* (see Combining) |
| `SessionStart` (startup / resume) | new runtime process: state reset, transcript launches before now ignored |
| `Notification`, `PermissionRequest` | no change (the waiting-on-human signal handles these) |

**Staleness.** A lost `Stop` must not pin an agent as busy forever:
- An active turn with no hook event for `TURN_STATE.HOOK_SILENCE_MS` (10 min) and no open tool or subagent is no longer trusted, and the verdict becomes `unknown`, so the screen decides.
- An open tool call or a running subagent expires after `TURN_STATE.OPEN_WORK_MAX_MS` (60 min).
- The record is forgotten when the runtime exits (RuntimeExitMonitor callback) and restarted when a runtime is launched (`noteRuntimeStart`), and the runtime busy source skips sessions whose child process is dead.

**Transcript fallback (Claude Code).** `claudeTranscriptTurnState(file)` reads the tail of the session's transcript (`~/.claude/projects/<cwd slug>/<claudeSessionId>.jsonl`, found through session persistence):
- The last main-chain entry is an assistant message with `stop_reason: tool_use`, a tool result, or a user prompt / `<task-notification>` → `turn`. This applies only when the file changed within `TURN_STATE.TRANSCRIPT_FRESH_MS` (10 min).
- A `tool_use` with `input.run_in_background: true` (or a tool result "Async agent launched" / "running in background with ID") whose completion notice has not appeared yet → `background`. Completion notices are read from all three places Claude Code writes them: a `user` message, a `queue-operation` entry's `content`, and a `queued_command` `attachment`'s `prompt`. Launches older than the current runtime's start are ignored (a restart killed them). Within `OPEN_WORK_MAX_MS` of the launch only.
- `turn_duration.pendingBackgroundAgentCount` (Claude Code's own count) also counts as pending.
- An assistant `end_turn` / `stop_sequence`, an API or usage-limit error (`isApiErrorMessage`), an interrupt (`[Request interrupted by user`), or a `turn_duration` / `stop_hook_summary` entry ends the turn (`turnEndedAt`).

Results are cached per (path, size, mtime, runtime start). On 200 recent local transcripts the reader ends 190 idle, 8 mid-turn, 2 background (one a genuinely orphaned launch).

**Combining** (the hooks lead):
- A transcript turn end newer than the last hook event ends a hook `turn`. Esc, API errors and usage limits fire no `Stop`.
- After `Stop`, held subagents count as `background` only while the transcript agrees (pending > 0). A transcript turn end with nothing pending drops them, and with no transcript `Stop` clears them.
- A transcript-only `background` (no hook saw a subagent: a background shell, or a stale launch) is reported as `idle`. On its own it never blocks the drain or settling.
- A transcript `turn` newer than the last hook event (a lost hook POST) is a `turn`. With no hooks at all, a fresh transcript `turn` is a `turn`.

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
- **Restart drain.** If any agent it waits on is `longRunning`, the cap becomes `SAFE_RESTART.BACKGROUND_DRAIN_TIMEOUT_MS` (10 min, `CREWLY_RESTART_DRAIN_BACKGROUND_MS`). Otherwise the existing `DRAIN_TIMEOUT_MS` (2 min) applies. `CREWLY_RESTART_DRAIN_MS=0` still disables the wait. After the cap the drain proceeds, and the remaining agents are persisted as interrupted.
- **Supervisor budget.** Under systemd (`INVOCATION_ID` set), the backend reads its unit's live `TimeoutStopUSec` (unit found via `/proc/self/cgroup`; `systemctl [--user] show -p TimeoutStopUSec --value`) at boot and caps both drain caps to it minus `SHUTDOWN_MARGIN_MS` (30 s). The drain then ends before the SIGKILL and `saveInterruptedTurns` still runs. A unit from before this change (steamfun-ops: 150 s) caps the drain at 120 s, as before, and logs a warning with the fix.
  - `generateSystemdUnit` writes `TimeoutStopSec` = longest drain + margin (630 s by default). `crewly service upgrade` now rewrites an out-of-date unit file (the service is stopped at that point) before its `daemon-reload`.
  - Impact: a `systemctl stop`, or a reboot, can now wait up to 10.5 min, but only while an agent has a tool call or subagent open. A second SIGTERM (`crewly service stop --now`) skips the wait.
- **`GET /api/system/restart-readiness`, auto-update quiet window, system-control busy list.** All three read `getMidTurn()`, so they see the new sessions without other changes.
- **ActivityMonitor.**
  - When the screen did not change but the runtime verdict is `turn`, the member stays `in_progress`. No `agent:idle` / `agent:idle_after_task` is published mid-turn.
  - A `background` verdict does not keep it `in_progress`, because the agent can take messages.
  - The existing 15-minute auto-reset still caps a stuck `in_progress`.
- **Placeholder settling and ticket submit on `agent:idle`.**
  - `settleTurnWithoutReply`, `settleOpenThreads` and the ticket review's `onAgentIdle` are skipped while the agent has background work. The work is not finished, and the turn that delivers it comes later.
  - A skipped settle is re-checked every minute (`DeferredIdleSettle`, `TURN_STATE.SETTLE_RECHECK_MS`):
    - it settles once the background work is gone;
    - it stops if a new turn started (that turn's own idle settles);
    - it settles anyway after `OPEN_WORK_MAX_MS`.
  - The queued-message flush still runs.

### 3. Resume interrupted work

- **Shutdown.** `saveInterruptedTurns` now also persists turns with no delivered message (`origin: 'runtime'`) as one `kind: 'work'` entry per session. Its label is the ticket marker of the last message delivered to that session (the tracker remembers it after the turn settles). A turn made only of `[SYSTEM]` pings is still dropped, because its producers fire again.
- **Boot restore set.** `sessionsToRestore` adds only agents that were really working at shutdown (the sessions in `interrupted-turns.json`), plus agents whose owner commitment (`open` / `ready`) is **past due, never nudged and never restart-reminded**, on a ticket that is not done or cancelled (`owedCommitments`).
  - Not-yet-due promises are left alone; the sweep acts when they come due.
  - Overdue / already-nudged promises belong to the sweep.
  - Owed owner replies are left to the owner-message watchdog, which wakes the agent itself.
- **Resume note.** Each restored agent gets one English message per interruption, through the usual paths: re-enqueue with the original source for queue messages, `sendMessageToAgent` otherwise. The note reads:

  > Crewly restarted while you were working on TKT-194. Continue where you left off and deliver.

  For a message entry, the original message follows the note, so the reply keeps its routing. For a commitment, the promise is quoted ("You promised the owner: …"). Before sending, `markRestartReminded` records `restartRemindedAt` **and** `nudgedAt` (status `overdue`) on the item, after re-reading it. The reminder is therefore the one nudge: it is sent at most once ever, the sweep never nudges it again (it moves on to the owner note), and if the sweep nudged first the reminder is not sent.
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
  - Only a promise with an explicit time (`dueSource: 'text'`) and a concrete deliverable (a doc / 方案 / 报告 / draft / link / file / PR …, after removing "report back / get back to you / let you know / 回复你 / 汇报" phrases) is kept. "On it, I'll report back", "稍后回复你" and similar make none.
  - It is marked `fromInterim`. The same agent's next substantive non-interim reply in the thread delivers it, with no `MIN_DELIVERY_GAP_MS` and no deliverable-word match.
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
- Review follow-ups (PR #1013):
  - `claude-transcript-turn.test.ts`: queue-operation / attachment notices, the runtime-start filter, and API-error turn ends.
  - `agent-turn-state.test.ts`: held subagents need the transcript's agreement; transcript-only background is idle; a newer transcript turn end overrides a hook turn; SessionStart resets.
  - `deferred-idle-settle.test.ts`.
  - `supervisor-stop-budget.test.ts`: systemd timespan / cgroup parsing and the drain cap.
  - `service.test.ts`: the unit is refreshed on upgrade.
  - `open-items.service.test.ts`: interim false commitments, interim delivery, `owedCommitments` / `markRestartReminded` (one reminder, no double nudge).
