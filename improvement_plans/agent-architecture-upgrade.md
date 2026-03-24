# Crewly Agent Architecture Upgrade — Master Plan (v2)

## Context

Crewly's multi-agent system has strong infrastructure (11-module prompt assembly, file-based task tracking, 10 triggering mechanisms) but three critical gaps:

1. **No role boundaries** — Orchestrator does too much (routing + strategy + decomposition). Executors can redefine scope. No Try-Before-Refuse protocol.
2. **No task contracts** — No formal acceptance handshake, no startup task loading, no strict state machine.
3. **No action trigger chain** — System is reactive (health checks, crash recovery) but nothing drives "task done → wake next actor." The orchestrator is a single bottleneck for ALL workflow progression.

This plan combines four improvement tracks:
- **Track A:** Role hierarchy & prompt refactoring (Phases 1-4)
- **Track B:** Task workflow contracts & state machine (Phases 5, 5.5)
- **Track C:** Event-driven action trigger chain (Phase 6)
- **Track D:** Domain specialization — constraint layer first (Phases 7-8)

The goal: evolve from "AI-assisted team" toward "self-operating organization."

---

## Phase 1: Type System Extensions (Foundation) ✅ DONE

**Why:** All downstream modules need `orgRole`, `autonomyLevel`, and capability metadata on `ModuleConfig`.

### Changes

**`backend/src/services/ai/prompt-modules/prompt-module.interface.ts`** — Added to `ModuleConfig`:
```typescript
orgRole?: 'orchestrator' | 'team-lead' | 'executor';
autonomyLevel?: 'directed' | 'bounded' | 'domain_autonomous';
capabilities?: string[];   // e.g., ['can-decide', 'can-verify']
domainSOP?: string;        // e.g., 'stock-operator'
riskPolicy?: string;       // e.g., 'financial-risk'
```

**`backend/src/types/index.ts`** — Added to `TeamMember` and `TeamMemberSessionConfig`:
```typescript
autonomyLevel?: 'directed' | 'bounded' | 'domain_autonomous';
domainSOP?: string;
riskPolicy?: string;
```

**`backend/src/services/agent/agent-registration.service.ts`** — Derives `orgRole` when building `ModuleConfig`:
```typescript
orgRole: role === 'orchestrator' ? 'orchestrator'
       : foundMember?.canDelegate ? 'team-lead'
       : 'executor',
```

### Status: COMPLETE

---

## Phase 2: Role Boundary Module (Highest Value)

**Why:** The single most impactful change. Prevents orchestrator from coding, executors from redefining scope, and enforces the Try-Before-Refuse protocol per role.

### New Files

**`backend/src/services/ai/prompt-modules/role-boundary.module.ts`** (+test)
- Priority: 3 (after identity/soul/recovery, before skills)
- Compactable: **false** (never trimmed — role boundaries are more important than skill lists)
- Branches on `config.orgRole`:

**Orchestrator boundary:**
```
You ARE: user secretary, message router, context compressor, status coordinator, thread continuity manager
You are NOT: strategy maker, task decomposer, code writer, quality verifier, worker manager

Before refusing any request:
1. Check if a skill can handle it
2. Check if an agent can be delegated to
3. Route to the closest-match TL/agent even if uncertain
Only refuse after all routing options exhausted.

When you receive task:verified events: you are NOTIFIED for awareness/reporting only.
You do NOT re-take workflow control. The TL continues driving same-team next steps.
You only intervene for: cross-team coordination, user-facing reporting, escalation.
```

**Team Lead boundary:**
```
You ARE: objective owner, planner, task decomposer, delegator, verifier, result aggregator
You are NOT: direct user communicator (route through orchestrator), orchestration-level router

Before refusing any task:
1. Check subordinate availability via get-team-status
2. Check if task can be decomposed differently
3. Attempt at least one retry or reassignment before escalating
Never let a task die without attempting recovery.

After task:verified: YOU drive the next step within your team scope.
Only route to orchestrator for cross-team or user-facing actions.
```

**Executor boundary:**
```
You ARE: scoped implementer, tester, progress reporter, blocker escalator
You are NOT: task redefiner, scope expander, priority changer, final verifier

Try-Before-Refuse Protocol (ENFORCED):
1. Re-read requirements — did you misunderstand?
2. Check available tools, skills, and project files via recall
3. Attempt a reasonable approach (partial solution counts)
4. After 3 failed attempts on the same obstacle, escalate with STRUCTURED report

When reporting blocked/failed, you MUST include:
- what_tried: what approaches you attempted
- what_failed: specific errors or obstacles
- what_needed: what would unblock you
- partial_result: any partial solution that exists

A blocked report without attempt records is invalid.

Task Acceptance: Confirm scope, deliverables, and acceptance criteria before starting.
Scope Control: Only touch files/systems specified in task. Report adjacent work separately.
Definition of Done: Build passes + tests pass + ready for TL verification. You do NOT self-verify as complete.
```

**Fragment overrides** (create `fragments/` dirs where missing):
- `config/roles/orchestrator/fragments/role-boundary.md`
- `config/roles/developer/fragments/role-boundary.md`
- `config/roles/team-leader/fragments/role-boundary.md`

**Register** in `prompt-assembly.service.ts` `registerDefaultModules()`.

### Verify
- Module appears in assembled prompt for all three org roles
- Fragment override works when file exists
- Content differs by role
- Non-compactable: never trimmed even at budget pressure

---

## Phase 4: Orchestrator Prompt Refactor

**Why:** Current orchestrator prompt bleeds into TL territory (decomposition, strategy). With Role Boundary module in place, clean up the base prompt.

### Changes

**`config/roles/orchestrator/prompt.md`** — Remove/soften:
- "Breaks large tasks into parallelizable subtasks" → TL responsibility
- "Decide best approach" / "Strategy" → TL responsibility
- "If idle, find something to do proactively" → Change to "If idle, check pending routing/status/blockers"

Keep:
- GOLDEN RULE (delegate, don't implement)
- Startup registration sequence
- Autonomous mode protocol
- Notification/event routing

Add cross-reference: "Your role boundaries are defined in the Role Boundary section. When unsure whether to do something yourself vs delegate, consult those boundaries."

### Verify
- Orchestrator still initializes and routes messages correctly
- No regression in agent delegation flow

---

## Phase 5: Task Acceptance Handshake + Startup Task Loading

**Why:** Agents currently receive tasks as terminal messages with no formal acceptance. This causes misunderstandings, scope drift, and "agent does wrong thing for 20 minutes."

### 5a. Extended task state machine

**`backend/src/types/task-tracking.types.ts`** — Full state machine:

```typescript
// Complete task lifecycle states
| 'backlog'              // Known but not yet ready for assignment
| 'ready'                // Ready for assignment
| 'assigned'             // Assigned to an agent
| 'accepted'             // Agent acknowledged with structured understanding
| 'needs_clarification'  // Agent accepted but needs more info before starting
| 'in_progress'          // Agent actively working
| 'blocked'              // Agent hit an obstacle (requires structured report)
| 'done'                 // Agent reports complete (pending TL verification)
| 'verifying'            // TL reviewing the work
| 'verified'             // TL approved
| 'failed'               // Verification failed / max retries
| 'cancelled'            // Explicitly cancelled
```

**Why `needs_clarification`:** Without it, agents either force-accept unclear tasks (doing wrong work for 20 min) or silently stall. This status makes "I don't understand the task" a first-class workflow signal that triggers TL/delegator response.

Add to `InProgressTask`:
```typescript
acceptedAt?: string;
acceptanceNote?: string;         // Agent's structured understanding
clarificationRequest?: string;   // What the agent needs clarified
```

### 5b. Accept & Clarify endpoints

**`backend/src/controllers/task-management/task-management.controller.ts`** — New methods:

**`acceptTask`:**
- Input: `{ taskId, sessionName, understanding }`
- Validates: task exists, status is `assigned`, sessionName matches assignee
- Updates: status → `accepted`, sets acceptedAt + acceptanceNote
- Returns: updated task

**`requestClarification`:**
- Input: `{ taskId, sessionName, question }`
- Validates: task exists, status is `assigned` or `accepted`, sessionName matches
- Updates: status → `needs_clarification`, sets clarificationRequest
- Returns: updated task

**Routes:**
```
POST /task-management/accept
POST /task-management/clarify
```

### 5c. New `get-my-tasks` skill

**`config/skills/agent/core/get-my-tasks/execute.sh`** — Calls `GET /task-management/tasks?sessionName={sessionName}`, returns structured summary of active/pending tasks.

### 5d. Update Recovery module

**`backend/src/services/ai/prompt-modules/recovery.module.ts`** — Add step between "Load context" and "Register self":

```markdown
### Step 2.5: Check for pending tasks
bash {skillsPath}/core/get-my-tasks/execute.sh '{"sessionName":"{agentId}"}'
If you have assigned tasks from a previous session, review and accept them.
```

### 5e. TaskTrackingService query method

**`backend/src/services/project/task-tracking.service.ts`** — Add:
```typescript
async getTasksBySession(sessionName: string): Promise<InProgressTask[]>
```

### Verify
- Assign task → status is `assigned`
- Call accept → status transitions to `accepted`
- Call clarify → status transitions to `needs_clarification`
- Wrong session → rejected
- Recovery module includes get-my-tasks step
- New agents see their pending tasks on startup

---

## Phase 5.5: Task State Ownership Matrix

**Why:** Phase 6 will trigger wake chains on status transitions. If any role can write any status, the event chain becomes unpredictable. This matrix is the guard rail.

### State Ownership Rules

**Who can write what status:**

| Status | Executor | Team Lead | Orchestrator |
|--------|----------|-----------|-------------|
| `accepted` | ✅ | - | - |
| `needs_clarification` | ✅ | - | - |
| `in_progress` | ✅ | - | - |
| `blocked` | ✅ (with structured report) | - | - |
| `done` | ✅ | - | - |
| `verifying` | - | ✅ | - |
| `verified` | - | ✅ | - |
| `failed` | - | ✅ | - |
| `cancelled` | - | ✅ | ✅ |
| `assigned` | - | ✅ (reassign) | ✅ (initial) |
| `ready` | - | ✅ | ✅ |
| `backlog` | - | ✅ | ✅ |

**Illegal transitions (enforced in code):**
- `assigned` → `verified` (skip execution)
- Executor setting `verified` (self-approval)
- Orchestrator setting `done` (not the implementer)
- `done` → `assigned` without explicit reassign action (must go through `failed` first)

### Legal Transition Graph

```
backlog → ready → assigned → accepted → in_progress → done → verifying → verified
                      ↓            ↓           ↓                  ↓
                 needs_clarification  blocked     ↓              failed
                      ↓                ↓         ↓                ↓
                   assigned         in_progress  cancelled      assigned (reassign)
```

### Implementation

**`backend/src/services/project/task-tracking.service.ts`** — Add validation in `updateTaskStatus()`:

```typescript
/**
 * Validate that the requesting role is allowed to set this status.
 * Enforces the Task State Ownership Matrix.
 */
private validateStatusTransition(
  currentStatus: InProgressTaskStatus,
  newStatus: InProgressTaskStatus,
  requestorOrgRole: OrgRole
): { valid: boolean; reason?: string }
```

**`backend/src/types/task-tracking.types.ts`** — Add structured blocked report type:

```typescript
interface BlockedReport {
  whatTried: string[];
  whatFailed: string;
  whatNeeded: string;
  partialResult?: string;
}
```

Executor must provide `BlockedReport` when setting status to `blocked`. Without it, the transition is rejected.

### Verify
- Executor cannot set `verified` → rejected with clear error
- Orchestrator cannot set `done` → rejected
- `blocked` without structured report → rejected
- All legal transitions work correctly

---

## Phase 6: Task Event Chain (Action Trigger Layer)

**Why:** This is the key to autonomous operation. Currently the system is reactive (health checks, crash recovery) but nothing drives "task done → wake next actor." The orchestrator is a single bottleneck. This phase makes the system **event-driven**.

### Problem Today
```
executor finishes → reports status → message sits in orc queue
→ orc eventually processes → orc decides next step → orc delegates
→ if orc is busy/crashed, everything stops
```

### Target State
```
executor finishes → task:done event emitted → TL auto-wakes to verify
→ TL verifies → task:verified event → TL drives next same-team step
→ orc notified for awareness/reporting only
→ if task blocked → TL + orc both notified immediately
```

**Key principle: orchestrator receives `task:verified` for AWARENESS, not re-takeover.** TL continues driving within team scope. Orchestrator only intervenes for cross-team coordination, user-facing reporting, or escalation.

### 6a. Emit events on task status transitions

**`backend/src/services/project/task-tracking.service.ts`** — In `updateTaskStatus()`, emit events for transitions that require a different actor:

| Task Event | When | Purpose |
|-----------|------|---------|
| `task:assigned` | Task created with assignee | Executor needs to start |
| `task:needs_clarification` | Agent requests clarification | Delegator needs to respond |
| `task:done` | Worker marks complete | TL needs to verify |
| `task:verified` | TL approves | Orc notified (awareness), TL drives next step |
| `task:blocked` | Anyone marks blocked | TL + orchestrator need to act |
| `task:failed` | Verification fails / max retries | TL needs retry/reassign decision |

Events NOT emitted for: `task:accepted` (executor already awake), `task:in_progress` (no new actor needed).

Each event payload includes:
```typescript
{
  taskId: string;
  taskName: string;
  taskStatus: InProgressTaskStatus;
  assignedSessionName: string;
  ownerMemberId: string;
  teamId: string;
  parentTaskId?: string;      // for sub-task rollup
  delegatedBySession: string;
}
```

### 6b. Standing auto-subscriptions at agent startup

**`backend/src/services/agent/agent-registration.service.ts`** — After agent registers, set up standing subscriptions based on `orgRole`:

**Orchestrator auto-subscribes to:**
- `task:verified` (all teams) — awareness / reporting only
- `task:blocked` (all teams) — escalation awareness
- `task:failed` (all teams) — escalation awareness

**Team Lead auto-subscribes to:**
- `task:done` (own team scope) — trigger verification
- `task:blocked` (own team scope) — unblock/reassign
- `task:failed` (own team scope) — retry/reassign decision
- `task:needs_clarification` (own team scope) — respond to agent questions

**Executor auto-subscribes to:**
- `task:assigned` (self scope) — accept and start work

These are **standing subscriptions** (not oneShot, long TTL) created once at startup. Replaces per-task monitoring setup in `delegate-task`.

### 6c. Event delivery wakes agents

**`backend/src/services/event-bus/event-bus.service.ts`** — When a task event matches a subscription:

1. If target agent is **active**: deliver via `MessageQueueService.enqueue()` (existing path)
2. If target agent is **idle/suspended**: auto-resume via `AgentSuspendService.resumeAgent()` then deliver
3. If target agent is **inactive**: auto-start via `AgentRegistrationService.createAgentSession()` if `autoStart` flag set

This is the key behavior change: events don't just queue for later — they **wake the target agent**.

### 6d. Reduce reliance on per-task monitoring

**`config/skills/orchestrator/delegate-task/execute.sh`** and **`config/skills/team-leader/delegate-task/execute.sh`** — Simplify monitoring setup:

- Remove: per-task idle event subscription (standing subscriptions handle this now)
- Keep: fallback `schedule-check` as safety net (reduced frequency, e.g., 15 min instead of 5 min)
- Keep: `addMonitoringIds` for cleanup tracking

### 6e. Heartbeat demoted to safety net

| Mechanism | Responsibility |
|-----------|---------------|
| **Event bus** | Primary workflow driver (task done → next actor wakes) |
| **Heartbeat** | Safety net for infrastructure (agent died → restart) |
| **Scheduler** | Periodic non-workflow tasks (daily summary, stale detection sweep) |

No code changes needed for heartbeat — it already does the right thing.

### 6f. Work Discovery trigger (`team:all_tasks_done`)

**`backend/src/services/event-bus/event-bus.service.ts`** — Composite event with race condition protection:

`team:all_tasks_done` — emitted when the last active execution task for a team completes.

**Race condition guards:**
1. Only count `active execution tasks` (assigned/accepted/in_progress/blocked/done/verifying) — not backlog/ready/cancelled
2. Before emitting, re-read the team's current task snapshot to confirm zero active tasks
3. Apply a 3-second quiescence window — if a new active task appears within 3s, suppress the event

This prevents false wake-ups when tasks complete and new ones are assigned nearly simultaneously.

### Verify
- Complete a task → `task:done` event emitted in logs
- TL receives the event and starts verification without orchestrator involvement
- Blocked task → both TL and orchestrator notified
- Idle executor auto-wakes when new task is assigned
- `delegate-task` no longer creates per-task subscriptions
- `task:verified` → orchestrator receives but does NOT re-take workflow control
- `team:all_tasks_done` not emitted when new tasks are being assigned concurrently
- End-to-end: executor done → TL verifies → TL drives next step → orc notified for reporting

---

## Phase 3: Capability Overlay Module

**Why:** Enables "Autonomous Specialist Executor" (e.g., stock operator) without forcing them into Team Lead role. **Must come after task contracts and event chain are in place** — autonomy without contracts produces "better at running off the rails" agents.

### New Files

**`backend/src/services/ai/prompt-modules/capability-overlay.module.ts`** (+test)
- Priority: 7 (after team references, before communication)
- Compactable: true
- `shouldInclude`: only when `autonomyLevel !== 'directed'` OR `capabilities.length > 0`

Content: Decision Rights Matrix based on `autonomyLevel`:
- **directed**: Execute assigned tasks only. Escalate all ambiguity.
- **bounded**: Make decisions within task/domain scope. Log rationale. Escalate if risk/ambiguity exceeds limits.
- **domain_autonomous**: Monitor domain continuously. Make approved decisions without waiting. Log reasoning + outcome. Escalate anomalies and threshold breaches.

**Important: V1 of capability overlay is a CONSTRAINT layer, not an action authorization layer.**
- V1: defines decision boundaries, escalation conditions, logging requirements
- V2 (future): may authorize autonomous actions (auto-deploy, auto-trade, auto-reply to users)

**Overlay markdown files** — `config/overlays/`:
- `can-decide.md` — Decision-making authority, when to escalate
- `can-delegate.md` — Delegation rights and constraints
- `can-verify.md` — Quality gate authority
- `can-user-reply.md` — Direct user communication rights

### Verify
- Module excluded when autonomyLevel=directed and no capabilities
- Correct overlays loaded from files
- Decision matrix varies by autonomy level

---

## Phase 7: Domain SOP Module

**Why:** Specialized agents (stock operator, content reviewer) need domain-specific procedures without changing the base executor prompt.

**V1 scope: constraint & procedure layer only.** Does NOT authorize fully autonomous behavior (no auto-trading, no auto-deploying). That's V2 after the system proves stable.

### New Files

**`backend/src/services/ai/prompt-modules/domain-sop.module.ts`** (+test)
- Priority: 9, compactable: true
- `shouldInclude`: only when `config.domainSOP` is set
- Loads `config/domain-sops/{domainSOP}.sop.md`
- Graceful fallback if file missing

**`config/domain-sops/`** — New directory with `EXAMPLE.sop.md` template

### Verify
- Module excluded when domainSOP undefined
- Correct file loaded when set
- Graceful fallback message when file missing

---

## Phase 8: Risk Policy Module

**Why:** Agents handling sensitive operations (financial trading, production deploys) need explicit risk guardrails.

**V1 scope: constraint layer only.** Defines what agents CANNOT do and when they MUST escalate.

### New Files

**`backend/src/services/ai/prompt-modules/risk-policy.module.ts`** (+test)
- Priority: 10, compactable: true
- `shouldInclude`: only when `config.riskPolicy` is set
- Loads `config/risk-policies/{riskPolicy}.policy.md`

**`config/risk-policies/`** — New directory with `EXAMPLE.policy.md` template

### Verify
- Module excluded when riskPolicy undefined
- Correct file loaded when set

---

## Token Budget Adjustment

**`backend/src/services/ai/prompt-modules/prompt-assembly.service.ts`** — Increase `DEFAULT_TOKEN_BUDGET` from 25000 to 28000.

Rationale: Role Boundary (~800 tokens, non-compactable) is the only guaranteed addition. SOP/Risk/Capability are conditional and compactable. 3K headroom covers worst case (all overlays active).

### Non-compactable discipline (CRITICAL)

These modules must NEVER be compactable — they are more important than skill lists:
- **Identity** (priority 1) — who am I
- **Soul** (priority 2) — how I behave
- **Recovery** (priority 2) — how to restart correctly
- **Role Boundary** (priority 3) — what I can and cannot do
- **Memory References** (priority 4) — what I remember

Everything else CAN be compactable:
- Skills References, Communication, Capability Overlay, Domain SOP, Risk Policy, Learning Reference, User Profile, Lifecycle

**For an autonomous system, role boundaries and recovery procedures are more important than knowing how many skills you have.**

---

## Final Module Architecture (15 modules)

```
[Identity]            priority 1   non-compactable  ← existing
[Soul]                priority 2   non-compactable  ← existing
[Recovery]            priority 2   non-compactable  ← modified (add get-my-tasks step)
[Role Boundary]       priority 3   non-compactable  ← NEW
[Memory References]   priority 4   non-compactable  ← existing
[Skills References]   priority 5   compactable      ← existing
[Team References]     priority 6   non-compactable  ← existing
[Capability Overlay]  priority 7   compactable      ← NEW (conditional)
[Project Reference]   priority 7   compactable      ← existing
[Communication]       priority 8   compactable      ← existing
[Domain SOP]          priority 9   compactable      ← NEW (conditional)
[User Profile]        priority 9   compactable      ← existing
[Risk Policy]         priority 10  compactable      ← NEW (conditional)
[Learning Reference]  priority 10  compactable      ← existing
[Lifecycle]           priority 11  compactable      ← existing
```

---

## New Directories & Files Summary

```
config/
├── overlays/                          ← NEW
│   ├── can-decide.md
│   ├── can-delegate.md
│   ├── can-verify.md
│   └── can-user-reply.md
├── domain-sops/                       ← NEW
│   └── EXAMPLE.sop.md
├── risk-policies/                     ← NEW
│   └── EXAMPLE.policy.md
├── roles/
│   ├── developer/fragments/           ← NEW dir
│   │   └── role-boundary.md
│   ├── team-leader/fragments/         ← NEW dir
│   │   └── role-boundary.md
│   └── orchestrator/fragments/
│       └── role-boundary.md           ← NEW file
├── skills/agent/core/
│   └── get-my-tasks/                  ← NEW
│       └── execute.sh

backend/src/services/ai/prompt-modules/
├── role-boundary.module.ts            ← NEW (+test)
├── capability-overlay.module.ts       ← NEW (+test)
├── domain-sop.module.ts              ← NEW (+test)
└── risk-policy.module.ts             ← NEW (+test)
```

---

## Implementation Order (Revised)

| Step | Phase | Depends On | Effort |
|------|-------|-----------|--------|
| 1 | Phase 1: Type System | — | Small ✅ DONE |
| 2 | Phase 2: Role Boundary | Phase 1 | Medium |
| 3 | Phase 5: Task Handshake + State Machine | Phase 1 | Medium-Large |
| 4 | Phase 5.5: Task State Ownership Matrix | Phase 5 | Small-Medium |
| 5 | Phase 6: Task Event Chain | Phase 5.5 | Medium-Large |
| 6 | Phase 4: Orchestrator Refactor | Phase 2 | Small-Medium |
| 7 | Phase 3: Capability Overlay | Phase 6 (needs contracts first) | Medium |
| 8 | Phase 7: Domain SOP | Phase 1 | Small |
| 9 | Phase 8: Risk Policy | Phase 1 | Small |

**Key ordering change:** Capability Overlay (Phase 3) now comes AFTER Phase 6, because bounded/domain autonomy must be built on top of task contracts + state machine + action trigger chain. Without those foundations, autonomous agents just "run off the rails better."

Phases 2 and 5 can be parallelized after Phase 1. Phase 5.5 is a gate before Phase 6. Phase 4 waits for Phase 2. Phases 7 and 8 can be done anytime after Phase 1.

---

## Verification Plan

After all phases:
1. `npm run build` — zero TypeScript errors
2. `npm test` — all existing tests pass + new module tests pass
3. Restart Crewly → orchestrator starts, calls register-self, transitions to `active`
4. Send Slack message → enqueued, delivered to orc, orc responds
5. Orc delegates to Sam → Sam receives task, calls get-my-tasks, calls accept-task
6. Sam reports unclear task → status transitions to `needs_clarification` → TL notified
7. Sam completes task → `task:done` event → TL auto-wakes → verifies → `task:verified` → **TL drives next step** → orc notified for awareness
8. Create test agent with `autonomyLevel: 'bounded'` → verify Capability Overlay appears in prompt
9. Create test agent with `domainSOP: 'EXAMPLE'` → verify Domain SOP loaded
10. Verify Role Boundary content differs for orchestrator vs TL vs executor
11. Block a task without structured report → REJECTED
12. Block a task with structured report → both TL and orchestrator notified
13. Executor tries to set `verified` → REJECTED by ownership matrix
14. All team tasks done → `team:all_tasks_done` fires (with quiescence window, no false positives)
