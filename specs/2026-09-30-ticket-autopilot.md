# Ticket autopilot — keep a project's backlog moving while the owner is away

**Filed:** 2026-09-30 · **Owner design:** Steve (approved 2026-09-29) · **Status:** implemented on `feat/ticket-autopilot`
**Builds on:** `specs/2026-09-28-project-tickets.md` (project tickets, §4 permissions, §5 AutoClaim, §11 delegation)

---

## 1. Problem

Project tickets in `backlog` never move unless the owner nags. Only the owner, the orchestrator or a
team lead can make a ticket `ready`; idle members auto-claim only `ready` tickets; nothing wakes the
lead to groom the backlog. Measured: the CE project had 14 backlog tickets sitting still.

The owner is usually on a phone (owner-away rule): he can tap or answer a line, not groom a board.

## 2. The switch

Per project, **default off**, stored on the project record (`projects.json` → `Project.ticketAutopilot`):

```ts
ticketAutopilot: {
  enabled: boolean;                 // master switch
  driver?: string;                  // session that triages; default = the lead of the project's team
  dailyBudgetTokens?: number;       // default 20M (TICKET_AUTOPILOT_CONSTANTS.DEFAULT_DAILY_BUDGET_TOKENS); was dailyBudgetUsd, see specs/2026-10-02-spend-cap.md §6
  maxInFlightPerMember?: number;    // default 1, 1..5
}
```

`driver` is an optional override. By default the driver is the lead of the project's (first) team by
the harness-wide team-lead rule (`specs/2026-09-30-team-lead-rule.md`: explicit `leaderIds`, else a
`team-leader` / `tech-lead` member); an override must itself be such a lead of a non-archived team
working on the project. No lead → the autopilot does nothing for that project.

**API** (owner / orchestrator only — the caller is `X-Agent-Session`, no header = owner; everyone
else gets 403):

| method | path | body |
|---|---|---|
| GET | `/api/project-ticket-autopilot/:project` | — → `{ project, settings, driver, spentTodayUsd, pausedForToday, triageInFlight, lastTriageAt }` |
| POST | `/api/project-ticket-autopilot/:project` | `{ enabled?, driver?, dailyBudgetTokens?, maxInFlightPerMember? }` (`null` resets a field) |

The prefix is deliberately outside `/project-tickets/`: project settings are not writable over the
mobile/portal relay today, so the switch is not added to the relay allowlist either.

**Skill** (orchestrator, when the owner says so in chat): `project-tickets autopilot --project P
[--on|--off] [--driver <session>|default] [--daily-budget <usd>] [--max-in-flight <n>]` (no flags =
show). Kill switch for the whole service: `CREWLY_TICKET_AUTOPILOT=0`.

## 3. Waking the driver

`TicketAutopilotService` evaluates every enabled project on a 5-minute tick, and a single project
right away when a member of its teams goes idle and AutoClaim found nothing for it (the
`tryProjectTicketClaim` fallback returned null — this also covers the lead itself going idle).

**What needs triage** (`selectTriageCandidates`):
- `backlog` tickets without the `needs-owner` label;
- `ready` tickets nobody can take (no eligible claimer per the §5 AutoClaim rule — e.g. reserved for
  a team that only has leads), or `ready` and untouched for 24 h;
- minus tickets already listed in a triage brief and unchanged since (`updatedAt`), until 4 h have
  passed — a ticket the lead chose to leave is not re-sent every half hour.

**When** (`decideTriage`, in order): switch off → no driver → daily budget reached → a triage item
for the project is still live → nothing to triage → nobody on the project's teams idle
(`agentStatus` active/started and `workingStatus` idle, or the member that just went idle) → too
soon (30 min since the last triage on the tick; 5 min on the idle trigger) → **triage**.

**The item** — ONE WorkItem per project at a time:
`type: ticket_triage`, `owner: team_lead`, `target: <driver>`, `targetSource: assigned`,
`metadata: { kind: 'ticket_triage', projectId, projectPath, teamId, requiresVerification: false,
ticketIds, trigger }`. It reaches the lead through the normal paths (`workitem:queued` dispatch,
AutoClaim of targeted items, reconciler redelivery, hybrid wake for a dormant lead — with its
approval gate unchanged). A triage item still `queued` after 6 h is cancelled and may be replaced.

**The brief** lists, per ticket: id, priority, why it is listed, age, title, creator, labels, team,
a description excerpt, and **worker-created — review first** for tickets filed by a member (source
`agent:<session>` that is neither the orchestrator nor a lead). At most 20 tickets (P0 first, then
oldest).

It lists the team, one line per member — session, name, role, `lead` mark, availability and
in-progress count — plus a `role:` line saying what the member is responsible for (the member's
`jobDescription`, else its role's description from `role.json` / a user override, else
`TICKET_AUTOPILOT_CONSTANTS.ROLE_RESPONSIBILITY_FALLBACKS`). Availability (`memberAvailability`) has
three states:
- **idle** — running (`active`/`started`, or still `starting`) and not in a turn;
- **working** — running and `workingStatus: in_progress`;
- **stopped: available, will be started when assigned** — `inactive` / `suspended` (idle-stopped
  included). Never "busy": the 2026-09-30 CE brief listed an idle-stopped content strategist as
  "busy" and the lead took every content ticket himself.

A stopped member's in-progress count is its real count (normally 0), and the per-member in-flight cap
(§5) applies to it like to anyone. A **Who does what** section (`TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE`,
same words in the team-leader prompts) says: delegate by role; take a ticket yourself only for
lead-level work (review, decisions, owner communication, cross-team coordination) or when no member
fits; a split written in an old ticket is only a hint — decide by current fit and availability and
split a mixed ticket so each part goes to the right role. It then asks for each ticket one of:
1. ready + assign (`assign`, or `update --status ready` for the next idle member);
2. split into smaller tickets, cancel the original with a note;
3. needs the owner — `project-tickets ask-owner --question "<one line>"`;
4. cancel with a reason.
Then the lead completes the item (no verification).

## 4. Boundaries (unchanged by the autopilot)

In the brief and the team-leader prompt: even with the autopilot on, these need the owner's
explicit OK —
- sending email or messages to outside people;
- publishing content publicly;
- deploying to production;
- spending money.

A ticket whose completion needs one of these may be worked up to a draft or a PR, then flagged
`needs-owner` for the final step. The autopilot itself never makes a ticket ready, assigns, or
starts work: it only wakes the lead and talks to the owner. Worker-created tickets still land in
`backlog` (§4 of the tickets spec) and are flagged for review in the brief.

Assigning a ticket to a stopped member starts it (tickets spec §5a).

## 5. Brakes

- **In flight per member.** AutoClaim keeps its one-ticket lock (an agent that is the assignee of
  an `in_progress` ticket gets no other; unchanged). While the autopilot is on, `assign` by an agent
  (lead / orchestrator) is refused with 409 when the assignee already holds `maxInFlightPerMember`
  in-progress tickets of the project. The owner assigning by hand is not capped; delegation through
  tickets (§11) is not capped.
- **Daily budget unit (crewly#1090).** The budget is read in cost-weighted *budget tokens* (cache reads x0.1, cache writes x1.25 for Claude; `getSessionUsageSince(...).budgetTokens`), not raw tokens. The paused notice and the `budget_paused` trace show both figures; the status carries `usedTodayTokens` (weighted) and `usedTodayRawTokens`. See specs/2026-10-02-spend-cap.md §1.
- **Daily budget.** Spend = Σ `TokenUsageService.getSessionUsageSince(session, localMidnight).cost`
  over the sessions of the project's teams (the same ledger ClaudeTranscriptSync and the in-process
  runtimes feed). At or above `dailyBudgetTokens` (plus today's boosts on the project's teams): no triage, AutoClaim takes no `ready` ticket of that
  project, and the owner gets one notice that day. Resumes by itself after local midnight.
- **Stop.** Nothing to triage, or the switch off → nothing happens.

These are wired as `ProjectTicketAutopilotPolicy` on `ProjectTicketWorkflowService`
(`isAutoClaimPaused`, `maxInFlightPerMember`), installed when the autopilot starts.

## 6. The owner: questions and digest (phone-first)

Both go through the usual owner-notification path (`SlackService.sendNotification`, which DMs the
owner — the same path as auto-update and the low-disk guard). A failed send is retried on the next
tick. Texts carry ticket ids but no harness mechanics (no WorkItem ids, claims, pool states).

- **Questions.** `ask-owner` (`POST /api/project-tickets/:project/:id/ask-owner { question }`,
  owner / orchestrator / lead) adds the `needs-owner` label and a Log line `owner question: …`
  (≤ 280 chars); `{ clear: true, note? }` removes the label once answered. Open `needs-owner`
  tickets of every enabled project are sent as ONE numbered message ("1. CE-4 Partner email — Send
  the draft to the 3 partners?" … "Reply with the number and your answer"), only when at least one
  question is new, at most every 2 h — a new P0 question goes out at once (marked urgent).
- **Digest.** Once a day at or after 21:00 local: per enabled project, done today / in progress
  (with assignee) / waiting on the owner (`review` tickets and `needs-owner` ones). Skipped when no
  ticket changed since the previous digest.
- **Answers.** The owner replies in the Slack DM, which reaches the orchestrator; it maps the number
  to the ticket id and passes the answer to the project's lead, who acts on it and clears the mark.
  No new parser.

## 7. State

`~/.crewly/ticket-autopilot-state.json` (CREWLY_HOME): per project `lastTriageAt`,
`lastTriageWorkItemId`, `listed` (ticket → `{updatedAt, at}`), `budgetNoticeDate`; global
`questions { lastSentAt, sentKeys }` and `digest { lastSentDate, lastSentAt }`. Survives restarts so
a restart does not re-wake the lead or re-send the owner anything.

## 8. Constants

`TICKET_AUTOPILOT_CONSTANTS` in `backend/src/constants.ts`: tick 5 min, triage every 30 min, idle
trigger ≥ 5 min apart, relist after 4 h, ready-stale 24 h, stale queued triage 6 h, 20 tickets per
brief, questions every 2 h (P0 at once), digest at 21:00 local, default budget $20/day, in-flight
default 1 (max 5), label `needs-owner`, env switch `CREWLY_TICKET_AUTOPILOT`.

## 9. Files

| file | role |
|---|---|
| `backend/src/types/ticket-autopilot.types.ts` | settings shape, defaults, input validation |
| `backend/src/services/project-tickets/ticket-autopilot-decision.ts` | pure rules (candidates, triage, questions, digest) |
| `backend/src/services/project-tickets/ticket-autopilot-messages.ts` | brief, owner questions, digest, budget notice |
| `backend/src/services/project-tickets/ticket-autopilot.service.ts` | the service (settings, tick, idle trigger, notices, policy) |
| `project-ticket-workflow.service.ts` | `askOwner`, `setAutopilotPolicy`, in-flight cap on `assign`, paused projects skipped by AutoClaim |
| `agent-auto-claim.service.ts` | idle trigger when nothing was ready |
| `project-tickets.controller.ts` / `.routes.ts`, `api.routes.ts` | API |
| `config/skills/agent/core/project-tickets` | `ask-owner`, `autopilot` actions |
| `config/roles/team-leader/{prompt,tl-addon}.md`, `config/roles/orchestrator/prompt.md` | prompt sections |

## 10. Risks / open points

- A lead that never completes its triage item blocks the next one until the reconciler's
  redelivery or the 6 h stale-queued rule (a `running` item is never cancelled by the autopilot).
- Spend attribution is by session: an agent on several teams counts toward every project its teams
  work on.
- The budget default ($20/day) is a guess; the owner sets his own with `--daily-budget`.
