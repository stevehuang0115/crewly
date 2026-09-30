# Project Tickets — a project's own durable backlog, tracked in git

**Filed:** 2026-09-28 · **Owner design:** Steve · **Status:** implemented on `feat/project-tickets`
**Supersedes the leftovers of:** `specs/2026-05-06-projecttask-md-deprecation.md`,
`specs/2026-05-06-task-management-v1-deprecation.md` (the retired `.crewly/tasks/` md system)

---

## 1. Two layers

| Layer | What | Where | Changes here |
|---|---|---|---|
| **Harness tickets** | `Request` (TKT-xxx, `specs/ticket-loop.md`) + `WorkItem` (task pool) — Crewly's internal machinery that makes agents work | `{projectDataDir}/requests/`, `~/.crewly/task-pool/pool.json` | none (one new consumer hook) |
| **Project tickets** | The project's own backlog: one markdown file per ticket, in the project folder, tracked in git | `<project>/.crewly/tickets/` | new |

A project ticket is worked through a harness WorkItem: claiming a ticket creates exactly one linked
WorkItem (`metadata.projectTicket = { projectPath, id }`); the WorkItem's lifecycle drives the
ticket's status back. The harness does not know about project tickets beyond that metadata key.

## 2. File format

`<project>/.crewly/tickets/<ID>-<slug>.md`

```markdown
---
id: CRW-12
title: Export the report as CSV
status: ready            # backlog | ready | in_progress | review | done | cancelled
priority: P1             # P0 (highest) … P3
assignee: null           # agent session name or a human's name
team: null               # optional team id that owns it; empty = any team on the project
labels: [export]
ownerReview: false       # true: a verified WorkItem lands the ticket in `review`, not `done`
createdAt: 2026-09-28T10:00:00.000Z
updatedAt: 2026-09-28T10:00:00.000Z
workItemId: null         # the current linked WorkItem
requestId: null          # optional harness ticket (Request) this came from
source: owner            # owner | agent:<session> | request:<TKT> | v1-migration
---

## Description

Free text. Humans edit freely.

## Acceptance criteria

- [ ] A header row is present
- [ ] Opens in Excel

## Log

- 2026-09-28T10:00:00.000Z · owner · created
```

Rules:
- **Owned fields.** The service only rewrites the frontmatter keys above (via the `yaml` Document
  API, so unknown keys, key order and comments survive; when an owned key changes the YAML
  printer may normalise spacing inside the frontmatter, e.g. before a trailing comment) and only
  *appends* lines to the `## Log` section. The body outside the Log is preserved byte-for-byte
  (the Description / Acceptance sections are replaced only on an explicit update of them). If
  `## Log` is missing it is appended at the end. The file is never renamed, even when the title
  changes.
- **Tolerant reads.** A file that is not `<something>.md`, has no frontmatter, invalid YAML, or
  invalid `id/title/status/priority` is skipped with a warning and reported in `invalid[]` of the
  list response. Nothing crashes.
- **IDs** are project-scoped: `<KEY>-<n>`. `KEY` = up to 4 uppercase letters/digits of the project
  name (fallback `T`), fixed on first allocation. The counter lives in
  `.crewly/tickets/.counter.json` (`{ "prefix": "CRW", "next": 13 }`, tracked); allocation takes
  `max(counter.next, highest existing n + 1)` so a git merge that brings in higher ids never
  reuses one.
- **Concurrency.** Every mutation of a folder holds an in-process operation lock *and* a
  cross-process lockfile (`.crewly/tickets/.lock`, `O_EXCL`, stale after 30 s). Writes are atomic
  (temp + fsync + rename). `.crewly/tickets/.gitignore` ignores `.lock` and temp files.
- **Change pickup.** Reads go through an mtime-keyed cache (cheap `readdir` + `stat` per list);
  a human edit or a `git pull` is visible on the next read. A periodic sweep (60 s) reconciles
  ticket ↔ WorkItem state for every registered project.

### Git tracking

The folder must be tracked. On the first write into a project that is a git repo, the service asks
`git check-ignore` whether `.crewly/tickets/` is ignored. Only if it is, it appends this block to the
project's root `.gitignore` (never rewrites existing lines):

```
# Crewly project tickets are tracked in git
!.crewly/
.crewly/*
!.crewly/tickets/
!.crewly/tickets/**
```

(A bare `!.crewly/tickets/` cannot re-include a path whose parent directory `.crewly/` is excluded —
git does not descend into excluded directories — so the block re-includes `.crewly/`, re-ignores
its contents, then re-includes `tickets/`. Net effect: only `tickets/` becomes visible.)
If the path is still ignored afterwards (global excludes), a warning is logged.

## 3. State machine

```
backlog ──▶ ready ──▶ in_progress ──▶ done
   ▲  ╲       │  ▲          │  ╲──────▶ review ──▶ done
   │   ╲      ▼  │          ▼             │
   │    ╲▶ cancelled ◀──────┴─────────────┘  (review → ready = sent back)
   └── cancelled (restore)      done → ready (reopen)
```

| from | allowed to |
|---|---|
| backlog | ready, in_progress, cancelled |
| ready | backlog, in_progress, cancelled |
| in_progress | ready, backlog, review, done, cancelled |
| review | done, ready, cancelled |
| done | ready |
| cancelled | backlog |

Moving a ticket out of `in_progress` by hand (API / board / skill) cancels the linked WorkItem if it
is still live (queued/blocked → `cancelQueued`; running → released and cancelled; an item already
submitted for review is left to its reviewer). `ready`, `backlog` and `cancelled` also clear the
assignee and the WorkItem link. A hand edit of the file itself does not touch the WorkItem.

## 4. Who may do what

"Project members" = members of teams whose `projectIds` contains the project (a ticket with `team`
set narrows claims to that team). Caller identity is the `X-Agent-Session` header; no header = the
owner (dashboard / CLI).

| action | owner | orchestrator | TL of a project team | member | other agent |
|---|---|---|---|---|---|
| list / show | ✓ | ✓ | ✓ | ✓ | ✓ |
| create | ✓ | ✓ | ✓ | ✓ (always `backlog`) | ✗ |
| update fields | ✓ | ✓ | ✓ | ✓ | ✗ |
| backlog → ready, done, cancel, reopen | ✓ | ✓ | ✓ | ✗ | ✗ |
| claim a `ready` ticket (self) | – | – | ✓ | ✓ | ✗ |
| assign to someone | ✓ | ✓ | ✓ | ✗ | ✗ |
| release own ticket (→ ready) | ✓ | ✓ | ✓ | ✓ (own) | ✗ |

Workers can put things in the backlog, but only the owner/lead/orc makes them `ready` (claimable).
This keeps agents from self-authorising work (see the 2026-09 approval-boundary incidents).

## 5. Claim, assign and status sync

**Claim (atomic, under the folder lock):**
1. re-read the ticket; must be `ready` (assign: `backlog` or `ready`); caller must be a member of an
   eligible team;
2. refuse if any live WorkItem in the pool already carries `metadata.projectTicket` for this ticket
   (one ticket = one active WorkItem; never two agents);
3. create the WorkItem: `type: project_task`, `owner: agent`, `target: <assignee>`,
   `targetSource: assigned`, `projectTaskId: <ID>`, `requestId` when the ticket links one,
   `briefMarkdown` = ticket body, `metadata: { projectTicket, projectId, projectPath, teamId,
   priority, requiresVerification: true }`;
4. write `status: in_progress`, `assignee`, `workItemId` + a Log line. If the file write fails the
   WorkItem is cancelled (rollback).
Self-claim additionally claims the WorkItem for the caller (`claimSpecificItem`) so it is `running`
immediately; assignment leaves it `queued`, and the normal dispatch path wakes the assignee.

**AutoClaim order:** an idle agent first takes WorkItems targeted at it (existing claim policy, order
unchanged). Only when that yields nothing, and the agent is not already the assignee of an
`in_progress` project ticket, it claims the highest-priority `ready` ticket (P0 first, then oldest)
of its teams' projects, then is dispatched like any auto-claimed item. Skipped while the agent
still has queued/running WorkItems of its own. A team lead is not auto-fed tickets in a team that
has other members (leads delegate; they may still claim or assign explicitly); a lead who is the
only member of its team is treated like any member.

**Sync (WorkItem → ticket)**, run on `task:verified | task:done | task:rejected | task:cancelled |
task:failed` for items with `metadata.projectTicket`, and by the 60 s sweep for every `in_progress`
ticket. The linked WorkItem is followed through its successors (`metadata.disposition.succeeded_by`
from a reviewer's retry, `metadata.supersededBy` on a cancel):

| linked chain ends in | ticket becomes |
|---|---|
| `verified` / `done` | `done` (or `review` when `ownerReview: true`) |
| a live item (queued … done_by_worker) with a new id | stays `in_progress`, `workItemId` relinked |
| `cancelled` without successor, `failed`/`rejected` disposed `terminal`, or the item is gone | `ready`, assignee + workItemId cleared, Log line with the reason |
| `failed`/`rejected` not yet disposed | unchanged (the harness is still deciding: retry in place or successor) |

Owner review uses the existing flow: WorkItems are `requiresVerification: true`, so the worker's
lead (or the orchestrator) verifies through the normal review WorkItem. `ownerReview` adds one more
human step on the ticket itself (`review → done` by the owner) — the simplest mapping that does not
fork the harness verification flow.

## 6. API (`/api/project-tickets`, mounted in `api.routes.ts`)

`:project` = project id, name, or URL-encoded absolute path.

| method | path | body / query | notes |
|---|---|---|---|
| GET | `/project-tickets` | `?session=` | tickets of every project the caller's (or `session`'s) teams work on |
| GET | `/project-tickets/:project` | `?status=&assignee=&label=` | `{ tickets, invalid }` |
| POST | `/project-tickets/:project` | `{ title, description?, acceptance?[], priority?, labels?, team?, status?, ownerReview?, requestId? }` | create |
| GET | `/project-tickets/:project/:id` | | ticket + raw body |
| POST | `/project-tickets/:project/:id/update` | `{ title?, priority?, labels?, team?, ownerReview?, description?, acceptance?, status?, note? }` | `description`/`acceptance` replace those sections only |
| POST | `/project-tickets/:project/:id/transition` | `{ status, note? }` | |
| POST | `/project-tickets/:project/:id/claim` | | caller claims |
| POST | `/project-tickets/:project/:id/assign` | `{ assignee, start? }` | TL/owner/orc; `start:false` only records the assignee |
| POST | `/project-tickets/:project/:id/log` | `{ note }` | append a Log line |
| POST | `/project-tickets/:project/:id/link` | `{ workItemId }` | owner/orc/TL: link a live WorkItem already in flight (§11) |
| POST | `/project-tickets/:project/:id/ask-owner` | `{ question }` / `{ clear: true, note? }` | owner/orc/TL: `needs-owner` mark (§12) |
| POST | `/project-tickets-migrate/:project` | `{ apply?, milestones?[] }` | v1 migration (dry-run unless `apply: true`) |

All mutations are POST so the relay can carry them; the mobile/portal relay allowlist gets
`GET /project-tickets` and `POST /project-tickets/` (the migration path is deliberately outside that
prefix).

## 7. Skills

- `config/skills/agent/core/project-tickets` (all roles incl. team-leader and orchestrator):
  `list | show | create | update | claim | release | assign | log | link | ask-owner | autopilot` (`assign`, `link` and `ask-owner` are
  refused by the backend unless the caller is the owner, the orchestrator or a lead of a project team;
  `autopilot` unless it is the owner or the orchestrator — §12).
- `delegate-task` (team-leader and orchestrator) takes `--ticket <ID>`; see §11.
- `config/skills/team-leader/assign-ticket` (`tl-assign-ticket`): assign a ticket to a member.
- Owner → backlog: the orchestrator/TL uses `project-tickets create --project … --source request:TKT-…`
  when the owner asks to "put this in the backlog". No heuristics or classifiers.

## 8. v1 migration

`crewly tickets migrate [projectPath] [--apply] [--milestone m1 --milestone m2]` and
`POST /api/project-tickets-migrate/:project`.

- Scans `.crewly/tasks/**/{open,in_progress}/*.md`; `done/` (and `blocked/`) are not imported.
- Each file → a `backlog` ticket: title from frontmatter `title` / first `# ` heading / file name;
  priority from frontmatter or `**Priority:**` (critical→P0, high→P1, medium→P2, low→P3, P0–P3 kept);
  labels from frontmatter `labels` + `milestone:<name>`; the original body (minus its frontmatter,
  headings pushed two levels down so it cannot open sections of its own) becomes the Description;
  `## Acceptance Criteria` bullets become checkboxes; `createdAt` is the original file's birth time;
  `migratedFrom: .crewly/tasks/<…>.md`, `source: v1-migration`.
- Originals are never modified or moved.
- Idempotent: a file whose `migratedFrom` already exists in the tickets folder is skipped.
- Dry-run (default) reports what would be created per milestone.

## 9. Cleanup of the retired `.crewly/tasks` system (this change)

| item | decision |
|---|---|
| `TaskService`, `TaskFolderService`, `TaskAssignmentMonitorService`, `task-planning.service.ts` + tests | deleted (no live callers) |
| YAML `TicketEditorService`, `controllers/task-management/tickets.controller.ts`, `/api/projects/:id/tickets*` + `/ticket-templates*` routes | deleted (no frontend caller) |
| `StorageService.getTickets/saveTicket/deleteTicket` (YAML under `.crewly/tasks`) | project stats now count project tickets; YAML readers removed |
| `/api/projects/:id/tasks*` (V3 projection readers) | kept — live readers of the pool projection |
| checklist endpoints (`.crewly/tasks/checklist-<id>.json`) | kept — separate quality-gate concern, still used by design-checklist / verify-output |
| `project-search` over `.crewly/tasks` | switched to project tickets |
| ProjectDetail Tasks tab (milestone board, Create task / Create milestone, `/api/tasks/create-from-config`, `/api/build-tasks/*`) | replaced by the project-tickets board; dead calls removed |
| MCP `crewly_assign_task` (fabricated an id) | now creates a real WorkItem via the running backend (`POST /api/task-pool/add`) |
| prompts / SKILL.md pointing at `.crewly/tasks` (orc role, TL prompt + addon, orc project-start / check-in / assign templates, project-reference module, report-status, complete-task, delegate-task, decompose-goal, verify-output, aggregate-results, developer SOP) | rewritten to the project-tickets guidance |
| `config/task_starters` build-tasks + e2e-test-plan starters (wrote `.crewly/tasks` milestone folders) | deleted; the removed ProjectDetail buttons were their only caller. `build_spec` kept |
| new-project scaffolding (`.crewly/tasks/` + sample YAML task), `crewly onboard` scaffolding | now `.crewly/tickets/`, no sample |
| `TicketModel`, backend `Ticket` / `TicketFilter` types, frontend api.service ticket wrappers | deleted (only served the YAML store) |
| still mentioning `.crewly/tasks`: historical code comments, `aggregate-results` (reads arbitrary md paths), `FileWatcherService` "tasks" category, `tests/integration/*` self-contained fake routes | left as is — not guidance, or out of scope |

## 10. Risks

- A git merge can produce conflicting edits in the same ticket file; the file then fails to parse and
  is skipped (reported in `invalid[]`) until a human resolves it.
- The sweep relies on WorkItems still being in the pool; the pool archives terminal items after
  7 days, long after the sweep (60 s) and events have synced them.
- Tickets are written to the main checkout; an agent in a per-WorkItem worktree sees its branch's
  copy of `.crewly/tickets/` (read the API/skill, not the file, for the live state).

## 11. Delegation through tickets + link (2026-09-29)

**Why.** Measured on the owner's Mac: a team lead handed out a day of work with `delegate-task`,
which creates `delegate` WorkItems directly — 0 of 631 WorkItems carried `metadata.projectTicket`.
Tickets created afterwards stayed `backlog`, unassigned and unlinked while the same work ran as
plain delegate items. Tickets were an optional side path; this makes them the path, in the
harness, so it does not depend on agent discipline.

**Where.** `POST /api/task-pool/add` (the endpoint every delegating skill calls). After the item is
built and passes the existing guards (target check, ServiceContract gate), the controller asks
`ProjectTicketWorkflowService.routeDelegation`. A routed item is added to the pool by the workflow
(under the ticket folder lock, through the same `startWork` as `assign`); anything else is added
as before. The body field `projectTicketId` (`delegate-task --ticket`) is taken off the body and
never lands on the WorkItem.

**The rule** (`decideDelegationTicketRoute`, one pure function with unit tests). Routed when all hold:
- `type: delegate`, not already linked (`metadata.projectTicket`);
- not a review/verify item (`metadata.verifyOf`), not `owner: system`, no `triggerId`, no `scheduledAt`;
- it has a `target`, and the delegator is known (X-Agent-Session, else `metadata.delegatedBy`
  stamped by the skill) and is **not** the target (self-reminders get no ticket);
- the target's (non-archived) teams work on at least one project.

The owner (no session) is routed only with an explicit `--ticket`. `--ticket` on an item the rule
excludes is **refused** (400), not ignored. When the target works on several projects the one
matching `metadata.projectPath` wins; with `--ticket` the project holding that ticket; otherwise the
item is not routed (logged).

**With `--ticket <ID>`:** caller must be owner/orc/lead of the project; the ticket must exist
(404), be `backlog`/`ready` (409 otherwise — done, cancelled, in progress) and have no live WorkItem
(409); the target must be on an eligible team (403). Then the ticket is assigned exactly like
`assign` (Log: `delegated by <caller>`, `assigned to <target> — WorkItem <id>`).

**Without `--ticket`:** a ticket is created — title = first line of the WorkItem title (heading
marks dropped, ≤ 120 chars), Description = the brief (`briefMarkdown`, else `description`),
`team` = the target's team, priority from `metadata.priority` (critical/urgent → P0, high → P1,
normal/medium → P2, low → P3), `source: agent:<caller>`, `requestId` from the WorkItem — and assigned
at once (`in_progress`, assignee, workItemId; Log: `created from delegation by <caller>`). If the
ticket cannot be created at all (store not writable) the delegation proceeds without one (warned);
if the WorkItem cannot be added (e.g. budget gate) the new ticket is cancelled and the error returned.

**The WorkItem** keeps every field the delegator set (type, owner, title, brief, description,
`requiresVerification`, `directDelivery`, …). Only `metadata.projectTicket` is added, plus
`projectId` / `projectPath` / `teamId` when missing. Status sync back to the ticket is the existing
§5 machinery (events + sweep); nothing new.

**Refusals reach the skill.** A refusal answers `{ success:false, error, code: "project_ticket_refused" }`.
The TL `delegate-task` then exits 1 **without delivering** the brief (its usual "pool add failed →
deliver anyway" path is skipped for this code); the orc `delegate-task` already exits on a failed add
and now prints the backend's reason. A successful add returns `data.projectTicket = { id, status,
projectPath, project, created }`, which both skills print.

**Link** — `POST /api/project-tickets/:project/:id/link { workItemId }` (owner / orc / TL of a
project team; skill: `project-tickets link --id <ID> --work-item <id>`). For work already in flight.
Under the folder lock: the ticket is not `done`/`cancelled` (409); the WorkItem exists (404), is live
(queued … done_by_worker; 409 otherwise) and carries no other ticket (409); the ticket has no other
live WorkItem (409). Then `metadata.projectTicket` is merged onto the item (rolled back if the ticket
write fails) and the ticket gets `status: in_progress` (a `review` ticket stays `review`),
`assignee` = the item's target, `workItemId`, and a Log line
`linked to WorkItem <id> (<status>, <target>) by <caller>`. Linking the same pair again is a no-op.

**Prompts.** TL prompt + addon and the orchestrator's backlog section say: project work for a
teammate always has a ticket (pass `--ticket` when one exists, otherwise one is created); use
`link` for work already in flight; make backlog tickets `ready` when they should be picked up.

**Not changed.** Other creators of `delegate` items through the same endpoint (`create-task`,
`decompose-goal`, `break-down-request`) follow the same rule — they are delegations too. Internal
`addToPool` callers (triggers, reconciler, review items) do not pass through the endpoint and are
untouched.


## 12. Ticket autopilot (2026-09-30)

A per-project switch (default off) that wakes the project's lead with one `ticket_triage` WorkItem
to groom the backlog while someone on the team is idle, with brakes (one live triage, 30-minute
cadence, daily USD budget, in-progress cap per member) and phone-first owner notices (batched
`needs-owner` questions, an evening digest). The approval boundary is unchanged. Adds the
`ask-owner` endpoint (`POST /project-tickets/:project/:id/ask-owner`, owner / orc / lead) and the
`needs-owner` label. Full design: `specs/2026-09-30-ticket-autopilot.md`.
