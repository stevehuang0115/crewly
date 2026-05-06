# ProjectTask `.md` System Deprecation — Unify Work Tracking on V3 WorkItem

**Filed by:** Steve (owner) + ORC drafted via dogfood collaboration
**Filed on:** 2026-05-06
**Severity:** P2 — architectural debt, not blocking. Currently causes operational friction (stale WI auto-resurrect on backend restart) but not data loss.
**Origin:** OSS — `backend/src/services/v3/project-task-watcher.service.ts` + skill ecosystem
**Owner:** TBD (proposal: Sam (TL) coordinates phased migration; Leo + Quinn execute)
**Target:** Multi-sprint phased migration. No big-bang rewrite.

---

## Problem Statement

Crewly currently has **two parallel systems for tracking active agent work**:

| | V3 WorkItem | Legacy ProjectTask |
|---|---|---|
| **Data shape** | TS interface, structured | Markdown file with metadata block |
| **Storage** | `~/.crewly/task-pool/pool.json` (single JSON) | `.crewly/tasks/{milestone}/{status}/*.md` (one file per task) |
| **Status transitions** | API + state machine | File path moves (`open/` → `in_progress/` → `done/`) |
| **Producers** | `RequestService.plan()` → `TaskPoolService.addToPool` | `delegate-task` skill, `/api/tasks/create-and-delegate` controller |
| **Consumers** | `AgentAutoClaim`, `WorkItemDispatchSubscriber`, frontend Work Items page | `ProjectTaskWatcher` (reads → translates to WorkItem), `session-handoff.service`, agent prompts |

The two systems are linked by a **one-way bridge**: `ProjectTaskWatcherService` scans `.crewly/tasks/delegated/` on backend startup and auto-creates WorkItems for any actionable task (`status ∈ {open, in_progress}`, age ≤ 48h). There is no reverse bridge — closing a WorkItem does NOT update the source `.md` file.

## Symptom — what the user sees

Operationally, the dual system manifests as:

1. **Pool "uncleanability"** — clearing `pool.json` does not stop targeted WorkItems from reappearing. On backend restart, `ProjectTaskWatcher` re-fires the same WI for every `.md` file still in `in_progress/`. Reproduced 4× during 2026-05-06 dogfood.
2. **Stale `.md` files accumulate** — 331 files currently in `.crewly/tasks/delegated/in_progress/`, of which the majority correspond to PRs already merged. Workers complete the code but the `.md` file is rarely moved. The 48h startup-age filter masks the full count but ~14 stale `.md` files still leak through per restart.
3. **State drift between systems** — a WorkItem can be `cancelled` while its sourcing `.md` is still in `in_progress/`. On the next restart the cancelled WI gets re-created from the same `.md`. The cleanup scripts shipped via PR #476 only operate on the V3 pool side; they cannot clean `.md` files because that requires reverse coupling we never built.

## Why both systems exist

Historical: `.md`-based ProjectTasks predate V3. They served three roles:

1. **Durable artifact** — survives backend restarts (file system is more durable than the in-memory pool we used to have).
2. **Human-readable** — owner / TL can `cat` a task file, edit it, share it.
3. **Agent input** — the delegated `.md` body carries the task brief (much longer than fits in a typical `WorkItem.title` + 1-line description). Workers read the `.md` to know what to do.

V3 WorkItem solved (1) by adding `pool.json` persistence + (2) partial via the frontend Work Items page, but did **not** address (3) — the WI structure has no canonical "task brief markdown" field, so producers (delegate-task skill, controllers) kept writing `.md` files alongside creating WorkItems.

The bridge (ProjectTaskWatcher) was added to make those `.md` files appear in V3 UIs without forcing skill rewrites. It was meant as transitional, not terminal.

## Why deprecate now

- **Owner ask (2026-05-06)**: "I don't want duplicate architectures. Long term should be one system."
- **Concrete pain**: dogfood pool-cleanup loop revealed the bridge silently re-fires WIs on every restart. Without deprecation we will keep paying this cost on every cleanup.
- **Recent V3 maturity**: PR #461 (request-decompose subscriber), PR #480 (workitem-dispatch subscriber), PR #481 (decision-rights module) brought V3 WorkItem path to feature-parity with `.md` for the dispatch leg. The remaining gap is (3) — task brief content storage.

## Out of scope

- Mission-level task tracking (`.crewly/tasks/<mission_id>/`) — different domain (KR-tracked deliverables), not addressed here. We deprecate ONLY the `delegated/` ad-hoc dispatch system.
- Spec markdown files in `.crewly/specs/` — those are durable design artifacts, not work-tracking. Untouched.
- Worktree task briefs in `/tmp/crewly-worktrees/...` — those are short-lived per-PR scratch space. Untouched.

---

## Dependency Inventory (what touches `.crewly/tasks/delegated/`)

This section is the truth-source for the migration scope. Every callsite below must either be (a) deleted, (b) ported to V3 API, or (c) explicitly preserved with rationale.

### Producers — write `.md` files

| # | Site | Action | Phase 2/3 disposition |
|---|---|---|---|
| P1 | `config/skills/orchestrator/delegate-task/execute.sh` | Writes `.md` to `delegated/in_progress/` after `POST /api/task-pool/add` | Port to V3 — write goes through new `briefMarkdown` field on WI, no FS write |
| P2 | `config/skills/team-leader/delegate-task/execute.sh` | Same pattern as orc version | Port (or alias to orc version) |
| P3 | `backend/src/controllers/task-management/task-management.controller.ts:275` | `/api/tasks/create-and-delegate` writes `.md` + emits `v3:task_delegated` | Keep endpoint signature, drop `.md` write, `briefMarkdown` payload field |
| P4 | `backend/src/services/v3/v3-data.service.ts:827` | `break-down-mission` writes sub-task `.md` files under `delegated/open/` | Same — drop FS write, store on WI |

### Consumers — read `.md` files

| # | Site | Action | Phase 2/3 disposition |
|---|---|---|---|
| C1 | `backend/src/services/v3/project-task-watcher.service.ts` | Watches `.crewly/tasks/`, creates WIs from `.md` | DELETE entire service in phase 3 |
| C2 | `backend/src/services/session/session-handoff.service.ts:426` | Scans `delegated/` to recover in-flight tasks on session resume | Port to query V3 pool by `target` |
| C3 | `config/skills/agent/core/report-status/SKILL.md` | Worker moves `.md` from `in_progress/` → `done/` | Port to PATCH `/api/task-pool/items/<id>/status` |
| C4 | Agent prompts (~20 role files) referencing `.crewly/tasks/` | Behavior guidance, e.g. "look in your delegated folder" | Prompt sweep — replace with V3 query SOPs |

### Indirect consumers — assume `.md` exists

| # | Where | Assumption |
|---|---|---|
| I1 | Multiple skills (`watch-for-event`, `schedule-followup`) reference task IDs that match `.md` filename slug | Skills should accept WorkItem id directly; slug-naming convention can be retired |
| I2 | Sam (TL) human review pattern: `cat .crewly/tasks/delegated/in_progress/<task>.md` | Replace with `crewly wi show <id>` CLI or frontend deep-link |

---

## Proposed Architecture (post-migration)

### Single source of truth: V3 WorkItem

- WorkItem becomes the only persistent record of a delegated task.
- Add field `WorkItem.briefMarkdown?: string` — carries the long-form task description that previously lived in `.md` body. Stored as part of `pool.json`. Length cap recommended (e.g. 16 KB) to keep pool.json readable; longer briefs reference an attachment.
- Status transitions are API-driven only. No file system involvement.

### Read access pattern

- Frontend Work Items page: existing UI, augmented to render `briefMarkdown` on click.
- Agent CLI: new skill `get-workitem-brief` that returns markdown for a given WI id (or current claim).
- Owner / TL terminal: `crewly wi show <id> | less` (CLI tool) — replaces `cat .crewly/tasks/...md` ergonomics.

### Migration of the existing 331 `.md` files

- Phase 3 includes a one-shot script `scripts/migrate-delegated-tasks-to-v3.ts`:
  - For each `.md` in `delegated/in_progress/` and `delegated/open/`: parse, find matching WI by title hash or task-id slug, copy body to `briefMarkdown`, mv `.md` → `.crewly/tasks/delegated/archive/`.
  - For `.md` files with NO matching WI: synthesize a `cancelled` WI with the body preserved, then archive (preserves audit trail).
  - Idempotent — running twice is a no-op.

---

## Phased Migration Plan

### Phase 1 — Spec + alignment (this spec)

**Deliverable:** this document. Acceptance: Steve approves direction; one TL volunteers as migration coordinator (proposal: Sam, given his TL-of-Crewly-product role).

**Acceptance criteria:**
- [ ] Steve reviews + approves direction
- [ ] Sam confirms ownership (or delegates to Leo / Quinn)
- [ ] No code changes in this phase

### Phase 2 — Dual-write + V3 read parity

**Goal:** every producer writes both V3 (canonical) and `.md` (legacy compatibility). Every consumer is moved to V3 read. ProjectTaskWatcher's startup backfill is removed but live-watch stays for safety.

**Workstream A (Leo or Max)** — V3 WorkItem `briefMarkdown` field
- Add `briefMarkdown?: string` to `WorkItem` interface + Zod validator + tests
- Update `/api/task-pool/add` body shape to accept it
- Frontend: render markdown on WI detail page
- ~150 LOC + tests

**Workstream B (Quinn)** — Producer migration to dual-write
- Skills `delegate-task/execute.sh` (orc + tl): pass `briefMarkdown` in API body, ALSO write `.md` (unchanged)
- `task-management.controller.ts`: persist `briefMarkdown` on WI, ALSO write `.md` (unchanged)
- `v3-data.service.ts:827` mission decompose: same dual-write
- ~120 LOC + tests

**Workstream C (Mia + Sam coordination)** — Consumer migration to V3
- `session-handoff.service.ts`: switch from FS scan to V3 pool query — `/api/task-pool/items?target=<session>&status=running,queued`
- `report-status` skill: PATCH WI status; keep `.md` move as belt-and-suspenders during this phase
- `ProjectTaskWatcher`: delete startup-backfill loop, keep live-watch (still bridges any stragglers)
- ~100 LOC + tests

**Workstream D (Mia)** — Drift detector reconciler
- New `task-md-vs-wi-reconciler.service.ts` runs every 5min:
  - For each `.md` in `delegated/in_progress/` with no matching V3 WI → log warning
  - For each V3 WI in terminal status with sourcing `.md` still in `in_progress/` → log warning + (optional, behind feature flag) auto-mv `.md` to `done/`
- Telemetry only; no destructive action without explicit operator opt-in.
- ~120 LOC + tests

**Acceptance criteria:**
- [ ] WorkItem.briefMarkdown round-trips through API + persists through restart
- [ ] Dual-write: every WI created via skill has both V3 record AND `.md` file (drift detector confirms parity)
- [ ] All consumers (session-handoff, frontend, agent skills) read V3 first, fall back to `.md` only on cache miss
- [ ] Drift detector reports < 5% drift over 1 week of normal operation
- [ ] Zero pool-resurrection on backend restart (because startup-backfill is removed)

**Estimated scope:** ~500 LOC + 4 PRs, ~2 sprint-weeks.

### Phase 3 — V3-only, retire `.md` write path

**Pre-requisite:** Phase 2 drift detector reports stable parity for ≥1 week.

**Workstream E (Quinn)** — Drop `.md` writes from producers
- `delegate-task` skills: remove `.md` write block
- `task-management.controller.ts`: remove `.md` write
- `v3-data.service.ts:827`: remove `.md` write
- ~50 LOC delta

**Workstream F (Leo)** — Delete ProjectTaskWatcher
- `backend/src/services/v3/project-task-watcher.service.ts` → delete
- `v3-data.service.ts` import + initialization → delete
- Tests → delete
- ~250 LOC delta

**Workstream G (Sam)** — Migrate the 331 stale `.md` files
- Run `scripts/migrate-delegated-tasks-to-v3.ts` (script delivered as part of this workstream)
- Snapshot pre-migration dir to `~/.crewly/cleanup-backup-<timestamp>/delegated-archive/`
- Verify count post-migration: WI count matches expected; `delegated/in_progress/` empty
- ~150 LOC script + manual verification

**Workstream H (Mia + all)** — Prompt sweep
- `grep -rn "\.crewly/tasks/" config/roles/` → audit each match
- Replace FS-based instructions with V3 CLI / skill equivalents
- Re-run agent eval suite to confirm no regression in delegation behavior
- ~30+ prompt edits, mostly small

**Acceptance criteria:**
- [ ] `.crewly/tasks/delegated/{open,in_progress}/` permanently empty
- [ ] No production code references `tasks/delegated/`
- [ ] Agent prompts contain zero `.crewly/tasks/` references
- [ ] Pool-resurrection bug stays fixed (verify with one nuclear-clean cycle)
- [ ] Frontend Work Items page renders `briefMarkdown` on every delegated WI

**Estimated scope:** ~500 LOC delta (mostly deletes) + 3 PRs, ~1 sprint-week.

---

## Risk Register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Agent prompt sweep misses callsite, agents look for `.crewly/tasks/` and fail silently | Workstream H runs eval suite + 1-week shadow mode where missing-`.md` is logged but not error |
| R2 | `briefMarkdown` field hits size limit, breaks for very long task briefs (e.g. 50 KB+) | Add length cap + attachment-pointer escape hatch in Phase 2 |
| R3 | Frontend Work Items page becomes unreadable when `briefMarkdown` is large | Truncate-with-expand UI; full markdown on detail page only |
| R4 | Session-handoff regression — V3 query returns subset that FS scan would have caught | Phase 2 keeps FS scan as fallback for one full sprint; only remove in Phase 3 |
| R5 | `.md` migration script (Workstream G) miscategorizes a stale `.md` and creates ghost cancelled WI | Idempotent, dry-run first, snapshot to backup dir before destructive operations |
| R6 | Customer-facing demo (e.g. Flopost 6/1) hits during Phase 2 dual-write window — extra noise from drift detector | Drift detector default to debug-log-only; promote to warn only after Flopost ships |

## Coordination

- **Sequencing**: Phase 2 must fully ship and Phase 2 acceptance criteria pass before Phase 3 starts. The 1-week stable-parity window is non-negotiable — too many silent assumptions baked into `.md` for big-bang.
- **Concurrency with other in-flight work**: Phase 2 Workstream A (`briefMarkdown` field) touches `WorkItem` types. Coordinate with Quinn's Bug C lifecycle gate work + any in-flight schema migrations. Probably wait for `WorkItem` schema to settle from current Bug A/B/C wave first.
- **Demo / release windows**: Phase 3 (deletion) MUST NOT land within 2 weeks of a customer-facing demo (Flopost 6/1, onboarding 5/9). Schedule for post-Flopost.

## Companion documents

- Architectural reference: `backend/src/services/v3/project-task-watcher.service.ts` (the bridge being deprecated)
- Related cleanup spec: PR #476 `cleanup-stale-pool.ts` — addresses the V3 side of the same drift problem
- V3 plumbing context: `2026-05-05-request-decompose-pipeline-gap.md` (PR #461 / #480 lineage)

## References

- Origin discussion: 2026-05-06 dogfood session — pool-cleanup loop revealed `ProjectTaskWatcher` as resurrection source.
- Owner directive: 2026-05-06 — "我不想要有重复的架构 但是可以按你的推荐来 最终能实现我的目标即可"
