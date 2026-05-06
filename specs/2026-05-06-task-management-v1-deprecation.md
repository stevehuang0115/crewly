# Layer 2 Deprecation — task-management v1 Subsystem → Unified V3 WorkItem Workflow

**Filed by:** Steve (owner) + dogfood collaboration
**Filed on:** 2026-05-06
**Severity:** P3 — architectural debt. No user-visible bug; everything works. The cost is "two parallel worker workflows" — V3 task-pool (claim / running / verified) and v1 task-management (take-next / submit / done .md folder transitions).
**Owner:** TBD (proposal: Sam coordinates; ~2-3 sprints, multi-agent execution)
**Companion specs:**
- `specs/2026-05-06-projecttask-md-deprecation.md` — Layer 1 deprecation (V3↔.md bridge), DONE in PRs #482/#483/this-PR
- `specs/2026-05-05-pipeline-dogfood-prompt-amendment.md` — pipeline-first planning discipline (refers to V3 path as canonical)

---

## Why this is a separate spec from Layer 1

The 2026-05-06 dogfood originally framed the duplicate-architecture problem as "V3 vs `.md` bridge". When we drilled into the code, two distinct duplication layers surfaced:

**Layer 1 — V3 ↔ `.md` bridge (resolved)**

`ProjectTaskWatcherService` scanned `.crewly/tasks/delegated/` on backend boot and re-created WorkItems for every actionable `.md` file. It plus the matching consumer `session-handoff.scanPendingTasks` constituted a one-way file-watch bridge between two systems that were *intended* to be unified. The bridge is the source of "pool refuses to stay empty after cleanup".

**Layer 2 — Two parallel worker workflows (this spec)**

Independently of the bridge, the codebase carries **two complete implementations** of the worker-task-flow contract:

| Surface | V3 path | v1 task-management path |
|---|---|---|
| Worker claims work | `POST /api/task-pool/claim` | `POST /api/task-management/take-next` |
| Status: running | `WorkItem.status = 'running'` | mv `.md` from `open/` → `in_progress/` |
| Worker submits output | (no canonical V3 endpoint yet) | `POST /api/task-management/submit-output` writes `<task>.output.json` |
| Worker reports complete | `POST /api/task-pool/items/:id/complete` | `POST /api/task-management/complete-by-session` mv `.md` → `done/` |
| Worker reports blocked | `WorkItem.status = 'blocked'` (transitionStatus) | `POST /api/task-management/block` mv `.md` → `blocked/` |
| Worker requests retry | `WorkItem.status = 'queued'` (auto via reconciler retry rule) | `POST /api/task-management/retry` mv `.md` back |
| Long-form task brief | NONE (only `WorkItem.title` + `description.substring(0,500)`) | `.md` body — full markdown, ~kB scale |
| Task TL verification | `WorkItem.done_by_worker → verified` | (no formal step; complete = done) |

The two systems do **not** know about each other in any sense beyond Layer 1's bridge (now gone). Layer 1's removal exposed Layer 2 cleanly: agents that go through the V3 path stay V3; agents that go through the v1 path stay v1. There is no production drift today, only architectural drift.

Layer 1 was small, low-risk, and addressed an active operator pain (pool resurrection). Layer 2 is an order of magnitude larger and addresses *engineering hygiene*, not user pain. Bundling them would have made Layer 1 unshippable.

## Goal

Single source of truth for "delegated worker task" = `WorkItem` (V3 task-pool). Retire `task-management.controller.ts` + `task-planning.service.ts` `.md`-write paths + matching agent skills + the `.crewly/tasks/delegated/` directory. Migrate the 331 currently-resident `.md` files to V3 records (preserving audit trail).

## Non-goals

- Mission-level task tracking (`.crewly/tasks/<mission_id>/`) — different domain (KR-tracked deliverables), out of scope.
- Spec markdown files in `specs/` — durable design artifacts, untouched.
- Worker private worktree task briefs (`/tmp/crewly-worktrees/...`) — short-lived per-PR scratch space, untouched.
- The `task-planning.service.ts` plan-folder pattern (`plan.md` / `findings.md` / `progress.md` per task) — that is a worker thinking artifact, not duplicate task tracking. Untouched in this spec; revisit if it later proves to overlap with V3 reasoning surface.

---

## Dependency Inventory

### v1 producers (write `.md` and/or call task-management API)

| # | Site | What it does |
|---|---|---|
| P1 | `config/skills/team-leader/delegate-task/execute.sh:185` | Calls `POST /task-management/create` which writes `.md` to `delegated/in_progress/` and emits `v3:task_delegated` |
| P2 | `config/skills/orchestrator/delegate-task/execute.sh` | Calls `/task-pool/add` only — already V3-native ✓ (no migration needed) |
| P3 | `backend/src/controllers/task-management/task-management.controller.ts` lines 247, 421, 548, 589, 614, 618, 662, 751, 822 | 22 `writeFile` / `rename` calls — full lifecycle: create / move-to-running / submit-output / mark-done / mark-blocked / retry |
| P4 | `backend/src/services/v3/v3-data.service.ts:825` | Mission decompose writes per-sub-task `.md` into `delegated/open/` so workers can `take-next` them |

### v1 consumers (read `.md` + call task-management API)

| # | Site | What it does |
|---|---|---|
| C1 | `config/skills/agent/core/report-status/execute.sh:210,216` | Worker reports complete via `POST /task-management/complete{-by-session}` |
| C2 | `config/skills/agent/core/take-next-task/...` (and similar) | Worker pulls next active `.md` via `POST /task-management/take-next` |
| C3 | `config/skills/agent/core/block-task/...` | Worker marks blocked → `POST /task-management/block` |
| C4 | `backend/src/services/agent/task-planning.service.ts:39` | Reads `taskPath` from delegated `.md` to seed plan-folder context |
| C5 | Agent prompt boilerplate (~20 role files) | Tells agents "read your task .md before starting" |

### Already migrated (Layer 1 cleanup, done)

- `backend/src/services/v3/project-task-watcher.service.ts` — DELETED (this PR)
- `backend/src/services/session/session-handoff.scanPendingTasks` — REWRITTEN to V3 query (this PR)

---

## Architecture Target

### V3 must reach feature parity before deletion

The v1 path supports a richer worker workflow than V3 currently does. We cannot simply delete v1 — V3 must ship the equivalents first.

**V3 gaps that block deletion:**

1. **`WorkItem.briefMarkdown`** — long-form task description field. Today `WorkItem.description` is truncated to 500 chars; v1's `.md` body is unbounded. Without this field, agents lose context when v1 is removed.
2. **Submit-output endpoint** — workers currently `POST /task-management/submit-output` to attach an artifact JSON. V3 needs an equivalent: `POST /api/task-pool/items/:id/output` that persists to a structured field on the WorkItem (e.g. `WorkItem.output: TaskOutput`).
3. **Take-next-by-role + canonical claim flow** — v1's `take-next` uses role-based pull; V3's `claim` already supports this via `filters.types`, but the worker prompt is unaware. Documentation + skill alignment needed.
4. **`block` transition with reason** — V3 has `WorkItem.status = 'blocked'` but no canonical "post a block reason" endpoint. v1 lets the worker write a reason into the `.md`. Need API + field.
5. **Retry / re-queue with reason** — v1 records retry attempts in the `.md`. V3 has `retryCount` + reconciler auto-retry, but no "human-triggered retry with reason" path.

### Frontend implications

The Work Items page already exists and renders WorkItems. Post-migration:
- Add markdown render for `briefMarkdown` (priority feature)
- Add output-artifact viewer for `WorkItem.output`
- Add per-WI activity log surface (timeline of status transitions + reasons)
- Deprecate any UI surface still pointing at `.crewly/tasks/`

### Worker prompt sweep

After V3 has parity, the agent prompts must be rewritten:
- Replace "look in `.crewly/tasks/delegated/in_progress/` for your active task" with V3 query SOPs
- Replace "mv your task to `done/` when finished" with `report-status` skill (which already calls a stable API — only the API target changes)
- Audit each role prompt under `config/roles/` for `\.crewly/tasks` mentions; ~20 files

---

## Phased Migration Plan

### Phase A — V3 reaches feature parity (~1 sprint)

**Workstream A1** — `WorkItem.briefMarkdown` (~150 LOC)
- Add field to `WorkItem` interface + Zod validator + tests
- Update `/api/task-pool/add` + `/api/task-pool/items/:id` body shapes
- Frontend: render markdown on WI detail page
- Length cap recommendation: 16 KB inline; longer briefs reference an attachment file (file path stored on WI, optional)

**Workstream A2** — Output endpoint (~120 LOC)
- New field `WorkItem.output: TaskOutput | null`
- `POST /api/task-pool/items/:id/output` endpoint (PATCH semantics)
- Frontend: render output artifact on WI detail
- Migration story: existing `.crewly/tasks/<id>.output.json` files copied at Phase C migration time

**Workstream A3** — Block / retry with reason (~80 LOC)
- Add `WorkItem.statusReason?: string`
- Persist on every state transition that records a reason
- `POST /api/task-pool/items/:id/block` and `/retry` endpoints (thin wrappers around `transitionStatus` with reason)

**Acceptance criteria for Phase A:**
- [ ] V3 WorkItem can carry equivalent task data (brief, output, block reason, retry reason)
- [ ] Frontend renders all V3 WorkItem surfaces
- [ ] Existing V3-only producers (`orchestrator/delegate-task`) successfully populate `briefMarkdown`
- [ ] Drift-detector / parity test covers each new field round-trip

### Phase B — v1 producers/consumers dual-write to V3 (~1 sprint)

**Workstream B1** — Producer migration (~120 LOC)
- `team-leader/delegate-task/execute.sh`: pass `briefMarkdown` to `/task-pool/add`, KEEP the `/task-management/create` call (dual-write)
- `task-management.controller.ts` `/create` endpoint: persist to V3 first, then `.md` (V3 is authoritative for parity check)
- `v3-data.service.ts` mission decompose: write to V3 first

**Workstream B2** — Consumer migration (~150 LOC)
- `report-status` skill: PATCH V3 status, AND call `/task-management/complete{-by-session}` (dual-call)
- `take-next-task` skill: query V3 first, fall back to `/task-management/take-next`
- `block-task` skill: same dual-call pattern

**Workstream B3** — Drift detector (~120 LOC)
- New service `task-system-drift-reconciler.service.ts` runs every 5min
- Compare each `.md` in `delegated/in_progress/` against V3 WorkItem with matching id; log drift
- Telemetry-only by default; behind a feature flag, can auto-converge (V3 wins)

**Acceptance criteria for Phase B:**
- [ ] All worker-task-flow surfaces dual-write/dual-read V3 + v1
- [ ] Drift detector reports drift rate
- [ ] After 1 week of normal operation, drift rate is **< 1%**
- [ ] No regressions in worker take-next / complete / block flow during this period

### Phase C — Delete v1, archive `.md`, V3-only (~1 sprint)

**Pre-requisite:** Phase B drift rate stable < 1% for ≥ 1 week. **Pre-requisite:** No customer-facing demo within 2 weeks of Phase C deploy (Flopost 6/1, onboarding 5/9).

**Workstream C1** — Drop v1 writes (~100 LOC delta, mostly deletes)
- `task-management.controller.ts`: drop all `writeFile` / `rename` calls; preserve endpoints as thin V3 wrappers for one release for backwards compat
- `team-leader/delegate-task/execute.sh`: drop `/task-management/create` call; only V3
- `v3-data.service.ts:825`: drop `.md` write; only V3

**Workstream C2** — Delete task-management subsystem (~5000 LOC delta, deletes)
- After 1 release with thin-wrapper compat: delete `task-management.controller.ts` + routes + `task-management.controller.test.ts`
- Delete v1 skills: `take-next-task`, `block-task`, etc. that have V3 equivalents
- Update agent prompts to point at V3-only SOPs
- ~20 role-prompt edits

**Workstream C3** — Migrate stale `.md` files (~150 LOC script + manual verify)
- One-shot script `scripts/migrate-delegated-tasks-to-v3.ts`:
  - For each `.md` in `delegated/in_progress/` and `delegated/open/`:
    - If matching V3 WorkItem exists by `taskId` slug → copy `.md` body to `briefMarkdown`, mv `.md` to `archive/`
    - If no matching WI → synthesize a `cancelled` WI with the body preserved (audit trail), then archive
  - For each `.md` in `delegated/done/` and `delegated/blocked/`:
    - Synthesize terminal-status WI with body, archive `.md`
  - Idempotent — re-running is a no-op
- Pre-migration snapshot to `~/.crewly/cleanup-backup-<timestamp>/delegated/`
- Post-migration verification: `delegated/{open,in_progress,done,blocked}/` all empty; archive populated; WI count matches expected

**Acceptance criteria for Phase C:**
- [ ] `task-management.controller.ts` deleted
- [ ] All v1 worker skills deleted; agent prompts contain zero `\.crewly/tasks/` mentions
- [ ] All 331 stale `.md` files migrated to V3 + archived
- [ ] Workers continue normal operation with V3-only flow

---

## Risk Register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Worker prompt sweep misses callsite, agents look for `.crewly/tasks/` and stall silently | Phase B's drift detector logs missing-`.md` reads; promote to error before Phase C |
| R2 | `WorkItem.briefMarkdown` field hits size limit for very long briefs (50 KB+) | Phase A1 attachment escape hatch + length cap + warn log |
| R3 | Frontend Work Items page becomes unreadable when `briefMarkdown` is large | Truncate-with-expand UI; full markdown only on WI detail page |
| R4 | `submit-output` migration loses existing `.output.json` artifacts | Phase C migration script copies them in along with `.md` body |
| R5 | A skill or agent prompt depends on `.md` filename slug for correlation (matches WI by id) | Phase A migration script generates a slug→WI-id map; Phase B retrofits any caller that's slug-matching |
| R6 | task-planning.service plan-folder pattern is mis-categorized as overlap and inadvertently broken | Phase A explicitly excludes plan-folder from migration; it stays as worker private notes |
| R7 | A demo lands during Phase B dual-write window — drift detector noise alarms ops | Drift detector default to debug-log-only; promote to warn only after demo ships |

## Coordination

- **Sequencing**: A → B → C strict, with the 1-week stable-drift gate between B and C.
- **Concurrency with current work**: WorkItem schema (`briefMarkdown`, `output`, `statusReason`) overlaps with any in-flight WI schema work (Bug C lifecycle gate, Bug B backfill). Phase A1 must wait for current Bug-A/B/C wave to settle.
- **Owner**: This is a multi-agent, multi-PR project. Recommend a TL (Sam) coordinates with explicit PR scope per workstream. Each workstream is independently reviewable; no big-bang.

## What success looks like

1. The directory `.crewly/tasks/delegated/` exists only as an archive, never written to.
2. Every "what is this worker doing" question is answered exclusively by V3 task-pool.
3. The `task-management.controller.ts` file no longer exists.
4. Agent prompts contain zero references to filesystem-based task tracking.
5. `pool.json` is the authoritative durable record of in-flight work; cleaning it has well-defined semantics (no resurrection, no drift).

## References

- Layer 1 spec: `specs/2026-05-06-projecttask-md-deprecation.md` (PR #482)
- Layer 1 startup-backfill removal: PR #483
- Layer 1 watcher full deletion + handoff migration: this PR
- Origin discussion: 2026-05-06 dogfood + owner directive "我不想要有重复的架构"
