# Safe Restart: drain in-flight agent turns, resume the ones cut off

Status: implemented (2026-09-24)

## Problem

A restart (SIGTERM from `crewly service restart|upgrade`, systemd, `kill -TERM`
of the CLI pid, or `POST /api/system/restart`) killed every agent PTY at once.
A message already written into an agent's PTY is no longer on the persistent
message queue, so if the agent was mid-turn the turn was lost and nothing
picked it back up.

Incident: the owner DM'd Ella "check what's left in my To Do". The message was
delivered at 01:38:30, a restart happened at 01:39:31, and her turn vanished.
The operator had checked that the queue was empty. That check does not show
whether a restart is safe, because a delivered message has already left the
queue.

## Design

### 1. In-flight turn tracking (`services/restart/in-flight-turn-tracker.service.ts`)

In memory, per session: the open deliveries (text, preview, time, and queue
metadata such as message id, source, conversation id, original content, and
the JSON-safe part of sourceMetadata), capped at 5 per session.

- Recorded in `AgentRegistrationService.sendMessageToAgent` after a successful
  PTY write (`sendMessageWithRetry` returned true) or an in-process dispatch.
  Deliveries that were only queued are not recorded.
- The queue processor `annotate`s the record after delivery with its queue
  metadata, so a resumed message can be re-enqueued with its original Slack
  thread or chat conversation.
- **Completion signal.** A PTY session is judged by a probe
  (`services/restart/turn-probe.ts`), which combines two existing signals:
  - `containsBusyStatusBar` ("esc to interrupt"). Claude Code and Codex show
    this bar for the whole turn, including while a tool runs. The codebase
    already treats it as the definitive busy signal.
  - `PtyActivityTracker` idle time, the last meaningful PTY output. This covers
    Gemini, which shows no bar.

  The agent counts as resting only when there is no bar and the PTY has been
  quiet for at least 15s. A missing session or an exited runtime counts as
  "gone". A delivery younger than 5s always counts as busy.
- In-process (crewly-agent) turns end exactly when `handleMessage` settles
  (`.finally`), so they are never probed.
- `agent:idle` events (ActivityMonitor) trigger a re-probe but never decide on
  their own. They come from a 30s poll, and ActivityMonitor force-emits them
  after 15 min of continuous output even when the agent is still working.
- Replies (report-status, reply-slack, chat) are **not** treated as
  completion. An agent says "on it" and keeps working, which is the Ella case.
- Before each PTY write the session is settled, so deliveries from a finished
  turn are dropped.

### 2. Drain on shutdown (`services/restart/restart-drain.service.ts`, `index.ts#shutdown`)

1. `pauseDelivery()`. After this:
   - `sendMessageToAgent` puts messages on the persistent
     `SubAgentMessageQueue` (answering `[RESTART_DRAIN]`, `queued: true`).
   - The queue processor stops dequeuing, and requeues a message whose agent
     became ready after the pause began.
   - The runtime-exit callback no longer clears queued messages.
2. Wait until no tracked agent is mid-turn, polling every 2s. The cap is
   `SAFE_RESTART.DRAIN_TIMEOUT_MS` (120s), overridden by
   `CREWLY_RESTART_DRAIN_MS`; `0` disables the wait. The drain logs who it is
   waiting on (session, since, preview) when that set changes and every 15s,
   then logs the outcome: `drained`, `timed-out`, `skipped`, or `disabled`.
3. Turns still in flight are persisted to `<CREWLY_HOME>/interrupted-turns.json`
   (see below).
4. The existing shutdown runs next. Its 5s/10s force-exit timer now starts
   after the drain.

The drain runs first, while HTTP, Slack and the queues are still up, so agents
can finish their turns and reply.

Signals (`handleShutdownSignal`):
- The first SIGTERM or SIGINT starts shutdown.
- A repeat within 1s (`SIGNAL_DEDUP_WINDOW_MS`) is ignored. Ctrl+C reaches
  the whole process group, and the CLI parent forwards the signal too.
- A later repeat during the drain skips the wait.
- A later SIGINT after the drain forces an exit, as before.
- Crash paths (uncaughtException, unhandledRejection) skip the wait but still
  persist interrupted turns.

`POST /api/system/restart` runs the same drained shutdown through
`RestartDrainService.requestGracefulShutdown` and exits with
`RESTART_REQUESTED` (120), so the CLI respawns the backend. Before this change
it called `process.exit` directly.

### 3. Resume after restart (`services/restart/interrupted-turns.ts`)

- File: `{version, savedAt, reason, turns: [{sessionName, deliveredAt, text,
  preview, messageId?, source?, conversationId?, originalContent?,
  sourceMetadata?}]}`, written atomically. Each save is merged with entries a
  previous boot had not resumed yet.
- `[SYSTEM]`-marked pings are not persisted, because their producers fire
  again after the restart.
- On boot, the file is loaded before orchestrator start. Entries older than 6h
  are dropped. `restore-filter.sessionsToRestore` adds the interrupted
  sessions to the "work in hand" set, so auto-restore brings those agents back.
- After auto-restore, a background pass re-delivers each entry with the notice
  "[CREWLY] You were interrupted by a restart while handling this message;
  pick it up again:" in front of the original message:
  - An entry with queue metadata (known non-system source, conversationId,
    originalContent) goes back through `messageQueueService.enqueue` with the
    original source, conversation and sourceMetadata, plus `targetSession` for
    non-orc agents. The normal delivery path then keeps Slack and chat reply
    routing.
  - Any other entry goes through `sendMessageToAgent`. Its registration gate
    holds the message until register-self. For orc entries, the pass first
    waits (up to 10 min) for the orchestrator to become `active`.
  - Non-orc sessions that are not running after boot are skipped and logged.
  - The file is rewritten after each entry and removed when the pass is done.

### 4. Operator visibility

`GET /api/system/restart-readiness` returns
`{ safe, busyAgents: [{session, since, messagePreview}], queued, draining }`.
`queued` is the main queue's pending count plus the sub-agent queue. Queued
messages survive a restart, so they do not make it unsafe.

## Supervisors

| Path | Before | After |
|---|---|---|
| CLI `start` parent (wrapper `crewly-start.command`, systemd `ExecStart`) | SIGTERM to backend, SIGKILL after 5s | SIGKILL after drain + 30s margin (150s by default). A repeated signal is forwarded so the backend can skip the drain. |
| `crewly-start.command` bash loop | Only restarts after the CLI exits | Unchanged; it sends no signals |
| systemd unit | Default `KillMode=control-group` (SIGTERM to every agent at once), `TimeoutStopSec` 90s | `KillMode=mixed`, `TimeoutStopSec=` drain + margin. Takes effect only after `crewly service install --force` or `crewly service upgrade` regenerates the unit. |
| `crewly service restart/stop` | SIGTERM, then continued immediately (no-wrapper restart waited 10s, then usually found the process still running) | Prints readiness, SIGTERMs, waits up to the budget. `--now` sends a second SIGTERM (or `systemctl kill` twice on Linux) to skip the drain. |
| `crewly service upgrade` | `stopService` returned at once, and `npm install -g` ran under a live backend | Waits for the drained exit first |
| `crewly stop` | Swept every `crewly\|backend` process with SIGTERM, which included agent runtimes | First SIGTERMs only the port listener and waits up to the budget, then sweeps. `--force` is unchanged. |

## Known limits

- The probe is a heuristic. A runtime without a busy bar that stays silent for
  15s mid-turn (for example, a long silent tool call in Gemini) is treated as
  resting.
- Up to 5 open deliveries per session. If an agent finished message A less
  than 15s before message B arrived, a later interruption resumes both. The
  notice lets the agent see that A was already answered.
- The in-flight tracker only knows turns started by a delivery. An agent that
  keeps working on its own long after its turn is not waited on.
- Interrupted non-orc agents are only brought back when `autoResumeOnRestart`
  is on.
- Closing the Terminal.app tab (SIGHUP) or `kill -9` bypasses everything.
