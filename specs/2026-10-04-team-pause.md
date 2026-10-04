# Team temporary pause

Status: implemented (PR "feat(teams): temporary team pause")
Date: 2026-10-04

## Why

The owner asked for a temporary pause button for a team: "once paused, the
team disappears from other agents' view, and the orc won't deliberately wake
them either."

The Crewly product team kept getting work: autopilot retro tickets were
routed to it, the orc delegated to it, a teammate reassigned work to it. The
harness work is handled by a separate harness-admin session. While a team is
paused, other teams should file GitHub issues instead of handing it work.

## Data

`Team` gains two optional fields, persisted in the team's `config.json`. A
pause therefore survives restarts.

```ts
paused?: { pausedAt: string; by: 'owner'; reason?: string; until?: string };
issueRepo?: string; // 'owner/name', e.g. 'stevehuang0115/crewly'
```

`TeamModel` carries both fields through `fromJSON` / `toJSON`. Before this
change `toJSON` dropped every field it did not list, so `paused` would have
been lost on the next read.

A pause is **in force** while `paused` is set and `until` is unset or in the
future (`isPauseActive`). A pause whose `until` has passed counts as resumed
immediately. The auto-resume sweep then clears it from storage.

## Index (services/team/team-pause.registry.ts)

Most gates only have a session name and must not await storage, so they use
a synchronous module-level index:

- team id → `{teamName, issueRepo, pause, sessions, memberNames}`;
- every session name a member may run under → team. These are the live
  `sessionName`, the permanent `agentId` and `deriveMemberSessionName`, so a
  stopped member (its `sessionName` is cleared) still matches.

The index is rebuilt by `syncPausedTeams` on every `StorageService.getTeams()`
and at boot, and updated by `notePausedTeam` on every `saveTeam`. It is
cleared for a team on `deleteTeam`.

API: `isSessionPaused`, `isTeamIdPaused`, `pausedTeamOfSession`,
`pausedTeamById`, `isTeamPausedNow(team)`, which is pure and reads the team
object, and `pausedRefusalMessage`.

`isOwnerStopped(session)` (the owner-stopped registry) is now also true for a
member of a paused team. That reuses the queued-message hold and the watchdog
rule, and it persists because the pause is stored.

## 1. Not woken by automation

**Hard stop.** `_startTeamMemberCore` refuses a paused team unless
`ownerStart` is set. Only `POST /teams/:id/start` and
`POST /teams/:teamId/members/:memberId/start` set it, and only for an owner
credential (`isOwnerDashboardRequest`). Every automated start goes through
`activateAgentBySession` without the flag and is refused. That covers the
queued-message wake, the watchdog, chat-v2 activate-on-send, the ticket
assignee waker, the claim-target waker and the cron/auto-claim HTTP wakes.

Each automation path also skips a paused team before it acts. It logs the
skip and leaves the work where it is.

| Path | Where | Behaviour |
|---|---|---|
| Reconciler hybrid wake / redeliver | `reconcile-rules.ts` `detectUnclaimedTasks`; `reconciler.service.ts` `runHybridWake` | paused agents are not wake candidates |
| Auto-claim (idle → claim) | `agent-auto-claim.service.ts` `tryAutoClaimForAgent` | nothing claimed |
| Auto-claim startup recovery | `agent-auto-claim.service.ts` `recoverPendingTasks` | paused targets not woken |
| WorkItem dispatch | `workitem-dispatch.subscriber.ts` `dispatchTo` | not dispatched, stays queued |
| Unassigned-work router | `untargeted-router.ts` `initialDecider` / `nextDecider` | paused members never decide; goes up a level / to the orc |
| Ticket autopilot | `ticket-autopilot.service.ts` `projectTeams` | paused team is never the driver (triage, replan, retro, gap notes), not in the triage brief; spend still counted |
| Ticket auto-claim | `project-ticket-workflow.service.ts` `claimNextForAgent` | no ticket fed |
| Cron tasks | `cron-task.service.ts` `evaluateSingleTask` | slot skipped, `lastSkipReason: team_paused`, agent not started |
| Triggers | `trigger-engine.service.ts` `fire` / `pausedTargetOfTrigger` | action skipped, `lastFireResult: skipped` |
| Scheduled check-ins | `scheduler.service.ts` `executeCheck` | skipped |
| Scheduled messages | `message-scheduler.service.ts` `executeMessage` | not delivered (logged failure) |
| Owner-message watchdog | `owner-message-watchdog.wiring.ts` | blocked `asleep`, detail "you paused <team>" |
| Queued-message wake | `index.ts` `wakeIfMessagesQueued` (via `isOwnerStopped`) | held |
| Idle drain | `index.ts` agent:idle → `flushQueuedAgentMessages` | held |
| Room responder / fallback | `chat-v2.dispatcher.service.ts` target planning; `slack-team-channel.service.ts` `localRoomLead` | paused agents removed from the room's member set, never the woken router, never the fallback lead |

## 2. Hidden from other agents

- `GET /api/teams` (agent `get-team-status`, the auto-claim recovery lookup)
  goes through `hidePausedTeamsFromAgents`, which runs before the response
  cache. Agents other than the orc do not see paused teams; members of the
  paused team itself still do. The orc sees them with `pausedNow: true,
  pauseLabel: "paused (owner)"`, and its compact `get-team-status` shows
  `status: "paused (owner)"`.
- `GET /api/slack/directory` (`list-colleagues`) and the room roster line in
  prompts leave out this machine's paused agents. They are filtered on every
  read, so the directory cache does not delay a pause.
- The ticket triage brief (the assignee picker leads use) leaves out paused
  teams.

**Refusals.** An explicit target gets HTTP 409 with `code: "team_paused"` and
an English message from `pausedRefusalMessage`:

> `<team> is paused by the owner. File a GitHub issue instead: gh issue create -R <repo> --title "<short title>" --body "<what is needed and why>"`

Without an `issueRepo`, the message says: "Do not hand it work. Tell the orc
what you need instead." When the orc itself is refused it says: "…tell the
owner."

| Endpoint | Refused when |
|---|---|
| `POST /task-pool/add` (delegate-task, orc + TL) | `target` is a paused member or `metadata.teamId` a paused team |
| `POST /task-pool/claim` | claiming on behalf of a paused member |
| `POST /task-pool/items/:id/handoff` (assign-task, handoff-task) | `newTarget` paused |
| `POST /terminal/:s/write`, `/deliver` (send-message) | target paused |
| `POST /project-tickets/:p/:id/assign` (assign-ticket) | agent caller, assignee paused |
| `POST /teams/:id/start`, `/members/:m/start` | non-owner caller |

The owner is never refused, and a paused team's own members may act within
it. This matters when the owner explicitly started one of them.

**In-flight work.** Pausing does not cancel running work:

- queued, unclaimed WorkItems targeting the team are unassigned
  (`TaskPoolService.unassignQueuedForSessions`, which records
  `metadata.pausedTeamUnassigned`). The unassigned-work router then hands
  them to a decider that is not paused;
- `backlog` / `ready` tickets assigned to the team lose their assignee;
- an `in_progress` ticket whose WorkItem is still `queued` goes back to
  `ready`, unassigned, and that WorkItem is cancelled
  (`ProjectTicketWorkflowService.releaseForPausedTeam`). Each change is
  written to the ticket log;
- running or claimed items stay where they are, for the owner to see.

## 3. Slack

- `@`-mention of a paused agent in a team or ad-hoc room
  (`slack-team-channel.service.ts` `declinePausedMentions`): the agent is
  taken off the mentions and not woken. The thread gets one short English
  line from that agent's bot, at most once per thread and team
  (`PausedThreadNotices`). A message that @'d only paused or dedicated agents
  is recorded and not dispatched.
- DM to a paused agent's bot (`slack-agent-dm.service.ts`): recorded, not
  dispatched, one notice per thread.
- The legacy `@name` routing in the orc bridge: same notice, nothing
  delivered.
- Responder choice: see the table in section 1.

The notice to a person: "<Name> is on <Team>, which the owner has paused, so
<Name> won't pick this up. To bring the team back, DM the orc "resume
<Team>"." An agent author gets the refusal message instead.

## 4. Owner controls

- **API.** `POST /api/teams/:id/pause {reason?, until?}` and
  `POST /api/teams/:id/resume`. Both are owner-only (`rejectNonOwner`: agents
  get 403, callers without an owner credential get 401). `until` must be a
  future date/time and `reason` can be up to 500 characters. Pausing a team
  that is already paused updates its reason and `until`.
  `PUT /api/teams/:id {issueRepo}` sets or clears the issue repo. Changing it
  is owner-only, and the value must look like `owner/name`.
- **Pause effects.** Pausing saves the pause first, so no automation can
  restart a member mid-stop. It then stops each running member the way
  stop-team does (`stopTeamMemberGracefully`: owner-stopped mark, terminate,
  status inactive) and releases unstarted work (section 2).
- **Resume.** Resuming clears the pause and the owner-stopped marks. It does
  not start anyone: members start when work arrives or the owner starts them.
- **Auto-resume.** `TeamPauseService.sweepExpired` runs at boot and every
  minute. It clears expired pauses and DMs the owner "<team> is no longer
  paused…".
- **Dashboard.**
  - Teams list (`TeamRow`): a "Paused" badge with the reason and until time
    in its tooltip, Resume as the visible action, and Pause team… / Resume
    team in the overflow menu.
  - Team page (`TeamHeader`): a "Paused" badge next to the status, a
    "Resume team" button, and Pause team… / Resume team in the overflow menu.
  - `PauseTeamDialog` takes an optional reason and an optional auto-resume
    time.
  - The team edit modal has an "Issue repo while paused" field.
- **Slack DM to the orc**
  (`services/team/team-pause-command.ts`, wired in `team-pause.wiring.ts`):
  the backend handles these as owner commands, never the orc's LLM, and only
  for the owner's own messages in their DM with the orc (`ownerDmScope ===
  'orc'`). Forms:
  - `pause <team>`, `pause team <team>`
  - `… for 3d` / `… until 2026-10-10`
  - `… because <reason>` / `…: <reason>`
  - `resume <team>`, `unpause <team>`
  - the Chinese aliases `暂停` / `恢复` / `取消暂停`

  A message is consumed only when the name resolves to a team, or when it
  says `pause team X` explicitly. "pause the deploy" still goes to the orc.

## 5. Orc prompt and skills

- `config/roles/orchestrator/prompt.md` Step 1 tells the orc which teams are
  paused (owner) and that it must never wake, start, delegate to or assign
  tickets to them. Their work becomes a GitHub issue or a note to the owner.
- `get-team-status` (orc) shows `status: "paused (owner)"`, `pausedUntil`,
  `pauseReason` and `issueRepo`.
- The SKILL.md files for delegate-task (orc, TL), send-message (orc, agent),
  assign-ticket, start-agent and start-team document the `team_paused`
  refusal.

The harness enforces all of the above regardless of the prompt.

## Tests

- `team-pause.registry.test.ts`: index, session aliases, expiry, refusal
  text.
- `team-pause.service.test.ts`: pause, resume, stop, release, auto-resume,
  persistence across a simulated restart (a fresh `StorageService` on the
  same `CREWLY_HOME`).
- `team-pause-command.test.ts`: parsing, owner-only, consumed only for real
  teams.
- `team-pause.controller.test.ts`: owner-only routes, the agent filter on
  `GET /teams`.
- Gates have one test each, in the existing suites:
  - reconciler rules
  - auto-claim
  - dispatch
  - untargeted router
  - autopilot
  - ticket assign / claim / release
  - cron
  - triggers
  - scheduler
  - watchdog
  - dispatcher room planning
  - Slack directory
  - Slack room mention
  - Slack agent DM
  - task-pool refusals
  - terminal refusal
  - start refusal
