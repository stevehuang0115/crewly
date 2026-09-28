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
  API, so unknown keys and comments survive) and only *appends* lines to the `## Log` section.
  Everything else is preserved byte-for-byte. If `## Log` is missing it is appended at the end.
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

Leaving `in_progress` for anything but `review/done` cancels the linked WorkItem if it is still live
(queued/blocked → `cancelQueued`; running → released and cancelled).

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
of its teams' projects, then is dispatched like any auto-claimed item.

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
| POST | `/project-tickets-migrate/:project` | `{ apply?, milestones?[] }` | v1 migration (dry-run unless `apply: true`) |

All mutations are POST so the relay can carry them; the mobile/portal relay allowlist gets
`GET /project-tickets` and `POST /project-tickets/` (the migration path is deliberately outside that
prefix).

## 7. Skills

- `config/skills/agent/core/project-tickets` (all roles incl. team-leader and orchestrator):
  `list | show | create | update | claim | release | log`.
- `config/skills/team-leader/assign-ticket` (`tl-assign-ticket`): assign a ticket to a member.
- Owner → backlog: the orchestrator/TL uses `project-tickets create --project … --source request:TKT-…`
  when the owner asks to "put this in the backlog". No heuristics or classifiers.

## 8. v1 migration

`crewly tickets migrate [projectPath] [--apply] [--milestone m1 --milestone m2]` and
`POST /api/project-tickets-migrate/:project`.

- Scans `.crewly/tasks/**/{open,in_progress}/*.md`; `done/` (and `blocked/`) are not imported.
- Each file → a `backlog` ticket: title from frontmatter `title` / first `# ` heading / file name;
  priority from frontmatter or `**Priority:**` (critical→P0, high→P1, medium→P2, low→P3, P0–P3 kept);
  labels from frontmatter `labels` + `milestone:<name>`; the original body (minus its frontmatter)
  becomes the Description; `## Acceptance Criteria` bullets become checkboxes;
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
| MCP `crewly_assign_task` (fabricated an id) | now creates a real WorkItem through the task pool |
| prompts / SKILL.md pointing at `.crewly/tasks` | rewritten to the project-tickets guidance |

## 10. Risks

- A git merge can produce conflicting edits in the same ticket file; the file then fails to parse and
  is skipped (reported in `invalid[]`) until a human resolves it.
- The sweep relies on WorkItems still being in the pool; the pool archives terminal items after
  7 days, long after the sweep (60 s) and events have synced them.
- Tickets are written to the main checkout; an agent in a per-WorkItem worktree sees its branch's
  copy of `.crewly/tickets/` (read the API/skill, not the file, for the live state).
