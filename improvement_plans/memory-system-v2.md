# Crewly Memory System v2 — Implementation Plan

## Context

The current memory system is a strong **knowledge storage system** (3-layer: agent/project/docs, confidence scoring, auto-capture, consolidation). But it's not yet a **decision-driving work memory system**. Six gaps identified:

1. Memory entries have no provenance — no link to tasks/objectives/outcomes
2. No shared user profile — each agent learns user preferences independently
3. No working memory — nothing between "session context" (dies) and "long-term memory" (forever)
4. `recall` and `get-my-context` are split — goals/focus missing from recall
5. Orchestrator can't access team-aggregated knowledge by default
6. No freshness/decay — old invalidated knowledge stays at full confidence

This plan addresses all 6 in priority order.

---

## Phase 1: Task-Linked Memory (Highest ROI)

**Why:** Every memory entry is currently a floating note. Adding provenance (which task, what outcome, where it applies) turns memory into **operational knowledge** that agents can trust and prioritize.

### 1a. Extend `RoleKnowledgeEntry`

**`backend/src/types/memory.types.ts`** — Add fields to `RoleKnowledgeEntry`:

```typescript
interface RoleKnowledgeEntry {
  // ... existing fields ...
  id: string;
  category: 'best-practice' | 'anti-pattern' | 'tool-usage' | 'workflow';
  content: string;
  learnedFrom?: string;
  confidence: number;
  createdAt: string;
  lastUsed?: string;
  tags?: string[];

  // === v2: Task-linked provenance ===

  /** Task ID where this knowledge was learned */
  sourceTaskId?: string;
  /** Objective/goal ID this knowledge relates to */
  sourceObjectiveId?: string;
  /** Outcome of the task where this was learned */
  sourceOutcome?: 'success' | 'failed' | 'partial';
  /** What contexts/domains this knowledge applies to */
  appliesTo?: string[];
  /** ISO timestamp when this knowledge was last verified as still valid */
  lastVerifiedAt?: string;
  /** Whether this entry has been superseded by newer knowledge */
  superseded?: boolean;
  /** ID of the entry that supersedes this one */
  supersededBy?: string;
}
```

### 1b. Extend `PatternEntry`, `GotchaEntry`, `DecisionEntry`

**`backend/src/types/memory.types.ts`** — Add to all three:

```typescript
// Add to PatternEntry, GotchaEntry, DecisionEntry:
sourceTaskId?: string;
sourceOutcome?: 'success' | 'failed' | 'partial';
lastVerifiedAt?: string;
```

### 1c. Update `RememberParams.metadata`

**`backend/src/services/memory/memory.service.ts`** — Extend `RememberParams.metadata`:

```typescript
metadata?: {
  // ... existing fields ...
  taskId?: string;          // existing but rename for clarity
  sourceTaskId?: string;    // alias
  sourceObjectiveId?: string;
  sourceOutcome?: 'success' | 'failed' | 'partial';
  appliesTo?: string[];
};
```

### 1d. Auto-populate on task completion

**`backend/src/services/memory/memory.service.ts`** — In `recordLearning()`, if `relatedTask` is provided, resolve the task to get outcome:

```typescript
async recordLearning(params: LearningParams): Promise<void> {
  // ... existing logic ...

  // v2: Auto-enrich with task provenance
  let sourceOutcome: 'success' | 'failed' | 'partial' | undefined;
  let sourceTaskId = params.relatedTask;
  if (sourceTaskId) {
    try {
      const taskTrackingService = TaskTrackingService.getInstance();
      const tasks = await taskTrackingService.getAllInProgressTasks();
      const task = tasks.find(t => t.id === sourceTaskId || t.taskName.includes(sourceTaskId!));
      if (task) {
        sourceTaskId = task.id;
        sourceOutcome = task.status === 'completed' || task.status === 'verified' ? 'success'
          : task.status === 'failed' ? 'failed'
          : 'partial';
      }
    } catch { /* non-fatal */ }
  }

  // Pass provenance to agent memory promotion
  // ... rest of method
}
```

### 1e. Update `AgentMemoryService.addRoleKnowledge()`

Pass through new fields when creating entries. No behavior change — just persist what's given.

### 1f. Update `AgentMemoryService.generateAgentContext()`

When formatting knowledge for prompt injection, include provenance hints:

```typescript
// Before: "- [best-practice] Always validate input (confidence: 0.8)"
// After:  "- [best-practice] Always validate input (confidence: 0.8, from: task-123 ✓)"
```

The `✓` / `✗` / `~` suffix signals success/failed/partial outcome — helps agents weigh advice.

### 1g. Update remember skill

**`config/skills/agent/core/remember/execute.sh`** — Accept `sourceTaskId`, `sourceOutcome`, `appliesTo` in metadata JSON passthrough. No script changes needed if metadata is already passed through as-is.

### Verify
- `remember` with `metadata.sourceTaskId` → entry stored with provenance
- `recordLearning` with `relatedTask` → auto-resolves outcome
- `generateAgentContext` output includes provenance hints
- Existing entries without provenance still work (all fields optional)

---

## Phase 2: Working Memory (Enables Architecture Upgrade)

**Why:** When an executor's session restarts mid-task, `get-my-tasks` tells them WHAT they were doing, but not WHERE they were in the process. Working memory fills the gap between "session context" (dies) and "long-term memory" (forever).

### 2a. Add `workingNotes` to `InProgressTask`

**`backend/src/types/task-tracking.types.ts`** — Add:

```typescript
interface InProgressTask {
  // ... existing fields ...

  // === v2: Working Memory ===

  /** Free-form working notes persisted across sessions.
   *  Agent saves current hypothesis, retry state, partial results here. */
  workingNotes?: string;

  /** ISO timestamp of last working notes update */
  workingNotesUpdatedAt?: string;
}
```

### 2b. Add `updateWorkingNotes()` to `TaskTrackingService`

**`backend/src/services/project/task-tracking.service.ts`** — New method:

```typescript
/**
 * Save working notes for a task — persists agent's current working state
 * across session restarts. Not long-term memory; cleared on task completion.
 */
async updateWorkingNotes(taskId: string, sessionName: string, notes: string): Promise<void> {
  const data = await this.loadTaskData();
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.assignedSessionName !== sessionName) {
    throw new Error(`Session '${sessionName}' is not the assignee`);
  }
  task.workingNotes = notes;
  task.workingNotesUpdatedAt = new Date().toISOString();
  await this.saveTaskData(data);
}
```

### 2c. New `save-working-state` skill

**`config/skills/agent/core/save-working-state/execute.sh`**

```bash
# POST /task-management/save-working-notes
# Input: { taskId, sessionName, notes }
# Called by agents when context is getting full or before session ends
```

### 2d. New API endpoint

**`backend/src/controllers/task-management/task-management.controller.ts`** — New `saveWorkingNotes`:

```typescript
export async function saveWorkingNotes(this: ApiController, req: Request, res: Response): Promise<void> {
  const { taskId, sessionName, notes } = req.body;
  // validate, call taskTrackingService.updateWorkingNotes(), respond
}
```

**Route:** `POST /task-management/save-working-notes`

### 2e. Include working notes in `get-my-tasks` response

**`backend/src/controllers/task-management/task-management.controller.ts`** — The `listTasks` handler already returns full `InProgressTask` objects when using `sessionName` query. Working notes will be included automatically since they're on the task object.

### 2f. Update Recovery module to reference working notes

**`backend/src/services/ai/prompt-modules/recovery.module.ts`** — After the `get-my-tasks` step, add:

```markdown
If any task has workingNotes, read them carefully — they contain your previous working state
(current hypothesis, what you've tried, where you left off). Resume from there, don't restart.
```

### 2g. Auto-clear working notes on task completion

**`backend/src/services/project/task-tracking.service.ts`** — In `updateTaskStatus()`, when status transitions to `completed` or `verified`, clear `workingNotes` (the knowledge should have been promoted to long-term memory by then).

### Verify
- Agent saves working notes → persists in task data
- Agent restarts → `get-my-tasks` returns task with workingNotes
- Recovery module instructs agent to read working notes
- Task completes → workingNotes cleared
- Wrong session → rejected

---

## Phase 3: Shared User Profile

**Why:** If the orchestrator learns "user prefers Chinese detailed reports," every other agent should know too. Currently each agent learns independently.

### 3a. New type

**`backend/src/types/memory.types.ts`** — Add:

```typescript
/**
 * Shared user profile — preferences that apply across ALL agents.
 * Stored once at ~/.crewly/user-profile.json, readable by all agents.
 */
export interface SharedUserProfile {
  /** Display language preference (e.g., 'zh-CN', 'en') */
  language?: string;
  /** Communication style: concise vs detailed */
  reportingStyle?: 'concise' | 'detailed' | 'structured';
  /** Risk tolerance for autonomous decisions */
  riskTolerance?: 'conservative' | 'moderate' | 'aggressive';
  /** Timezone for scheduling and reporting */
  timezone?: string;
  /** Domain knowledge context (e.g., "fintech startup, Series A") */
  domainContext?: string;
  /** Things the user explicitly does NOT want */
  prohibitions?: string[];
  /** Preferred tools, frameworks, or approaches */
  preferences?: Record<string, string>;
  /** Free-form notes about working with this user */
  notes?: string[];
  /** ISO timestamp of last update */
  updatedAt?: string;
  /** Who last updated this profile */
  updatedBy?: string;
}
```

### 3b. New service

**`backend/src/services/memory/user-profile.service.ts`** (+test)

```typescript
export class UserProfileService {
  private profilePath: string; // ~/.crewly/user-profile.json

  async getProfile(): Promise<SharedUserProfile>;
  async updateProfile(updates: Partial<SharedUserProfile>, updatedBy: string): Promise<SharedUserProfile>;
  async generateProfileContext(): Promise<string>; // formatted for prompt injection
}
```

### 3c. New prompt module (or extend existing)

**`backend/src/services/ai/prompt-modules/user-profile-reference.module.ts`** — Currently this module just gives instructions about HOW to handle preferences. Extend `build()` to also inject the actual shared profile content:

```typescript
async build(config: ModuleConfig): Promise<string> {
  const instructions = this.buildInstructions(); // existing
  const profile = await this.loadSharedProfile(config.projectRoot);
  if (profile) {
    return `${instructions}\n\n## User Profile\n${profile}`;
  }
  return instructions;
}
```

### 3d. API endpoints

**Route:** `GET /memory/user-profile` and `POST /memory/user-profile`

The orchestrator (or any agent) can update the shared profile. All agents read it via prompt injection.

### 3e. New skill

**`config/skills/agent/core/update-user-profile/execute.sh`** — Calls `POST /memory/user-profile`.

### 3f. Orchestrator prompt update

**`config/roles/orchestrator/prompt.md`** — Add to the capabilities section:

```markdown
### User Profile Management
When you learn user preferences (language, style, risk tolerance, timezone, prohibitions):
- Save them to the shared user profile via `update-user-profile` skill
- This makes preferences available to ALL agents, not just you
- Check the current profile before assuming defaults
```

### Verify
- Orchestrator saves language preference → all agents see it in their prompts
- Agent reads shared profile on startup
- Profile persists across restarts
- Partial updates merge correctly

---

## Phase 4: Unified Recall with Operational Context

**Why:** `recall` returns knowledge (patterns/gotchas/decisions) but NOT operational state (goals, focus, current tasks, recent failures). Agents must call two different endpoints. This phase unifies them.

### 4a. Extend `RecallResult`

**`backend/src/services/memory/memory.service.ts`** — Add operational fields to `RecallResult`:

```typescript
interface RecallResult {
  // ... existing fields ...
  agentMemories: string[];
  projectMemories: string[];
  combined: string;
  knowledgeDocuments?: KnowledgeDocumentSummary[];

  // === v2: Operational context (lightweight) ===

  /** Current project goals (if projectPath provided) */
  activeGoals?: string[];
  /** Current team focus (if projectPath provided) */
  currentFocus?: string;
  /** Active tasks for this agent (if agentId provided) */
  activeTasks?: Array<{ id: string; name: string; status: string; workingNotes?: string }>;
}
```

### 4b. Update `MemoryService.recall()`

After the existing knowledge search, append a lightweight operational section:

```typescript
async recall(params: RecallParams): Promise<RecallResult> {
  // ... existing knowledge recall ...

  // v2: Append operational context if projectPath available
  if (params.projectPath) {
    try {
      const goals = await this.goalTrackingService.getGoals(params.projectPath);
      result.activeGoals = goals?.goals || [];
      const focus = await this.goalTrackingService.getFocus(params.projectPath);
      result.currentFocus = focus || undefined;
    } catch { /* non-fatal */ }
  }

  if (params.agentId) {
    try {
      const tasks = await this.taskTrackingService.getTasksBySessionName(params.agentId);
      result.activeTasks = tasks
        .filter(t => !['completed', 'verified', 'cancelled'].includes(t.status))
        .map(t => ({ id: t.id, name: t.taskName, status: t.status, workingNotes: t.workingNotes }));
    } catch { /* non-fatal */ }
  }

  // Append to combined text
  if (result.activeGoals?.length || result.currentFocus || result.activeTasks?.length) {
    result.combined += '\n\n### Operational Context\n';
    if (result.currentFocus) result.combined += `**Current Focus:** ${result.currentFocus}\n`;
    if (result.activeGoals?.length) result.combined += `**Goals:** ${result.activeGoals.join('; ')}\n`;
    if (result.activeTasks?.length) {
      result.combined += `**Your Active Tasks:**\n`;
      for (const t of result.activeTasks) {
        result.combined += `- [${t.status}] ${t.name}${t.workingNotes ? ' (has working notes)' : ''}\n`;
      }
    }
  }

  return result;
}
```

### 4c. Orchestrator team-distilled summary

**`backend/src/services/memory/memory.service.ts`** — New method:

```typescript
/**
 * Generate a lightweight team knowledge summary for the orchestrator.
 * NOT full recallFromAllAgents (too expensive). Instead:
 * - Recent team learnings (last 5)
 * - High-confidence project gotchas (critical/high only)
 * - Active decisions
 * - Current blockers from task tracking
 */
async getTeamDistilledSummary(projectPath: string): Promise<string> {
  const parts: string[] = ['### Team Knowledge Summary'];

  // Recent learnings (last 5)
  const learnings = await this.projectMemoryService.getRecentLearnings(projectPath, 5);
  if (learnings) parts.push(`**Recent Learnings:**\n${learnings}`);

  // Critical gotchas only
  const gotchas = await this.projectMemoryService.getGotchas(projectPath, 'critical');
  if (gotchas.length) {
    parts.push('**Critical Gotchas:**');
    for (const g of gotchas.slice(0, 5)) parts.push(`- ${g.title}: ${g.problem}`);
  }

  // Active decisions
  const decisions = await this.projectMemoryService.getDecisions(projectPath);
  const active = decisions.filter(d => d.status === 'active').slice(0, 5);
  if (active.length) {
    parts.push('**Active Decisions:**');
    for (const d of active) parts.push(`- ${d.title}: ${d.decision}`);
  }

  return parts.join('\n');
}
```

Wire into `get-my-context` for orchestrator role:

```typescript
// In my-context endpoint, if role === 'orchestrator':
const teamSummary = await memoryService.getTeamDistilledSummary(projectPath);
```

### Verify
- `recall` with projectPath → response includes goals and focus
- `recall` with agentId → response includes active tasks
- Orchestrator's `get-my-context` → includes team distilled summary
- All existing recall behavior unchanged (new fields are additive)

---

## Phase 5: Memory Scoring & Decay

**Why:** A 90-day-old bug workaround for a bug that was fixed should not have the same weight as a verified best practice. Currently only `confidence` controls injection — no recency, no verification status, no staleness.

### 5a. Effective score calculation

**`backend/src/services/memory/agent-memory.service.ts`** — New method:

```typescript
/**
 * Calculate effective score for a knowledge entry.
 * Combines confidence, recency, and verification status.
 *
 * effectiveScore = confidence × recencyFactor × verificationFactor
 *
 * recencyFactor: 1.0 if used/verified in last 30 days, decays to 0.5 at 90 days, 0.25 at 180 days
 * verificationFactor: 1.0 if verified, 0.8 if never verified, 0.3 if superseded
 */
calculateEffectiveScore(entry: RoleKnowledgeEntry): number {
  const now = Date.now();

  // Recency: based on lastUsed or lastVerifiedAt or createdAt
  const lastActive = entry.lastVerifiedAt || entry.lastUsed || entry.createdAt;
  const daysSinceActive = (now - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
  const recencyFactor = daysSinceActive <= 30 ? 1.0
    : daysSinceActive <= 90 ? 0.75
    : daysSinceActive <= 180 ? 0.5
    : 0.25;

  // Verification: superseded entries heavily penalized
  const verificationFactor = entry.superseded ? 0.3
    : entry.lastVerifiedAt ? 1.0
    : 0.8;

  return entry.confidence * recencyFactor * verificationFactor;
}
```

### 5b. Use effective score in `generateAgentContext()`

Replace the current `confidence >= 0.6` filter with `effectiveScore >= 0.4`:

```typescript
// Before:
const relevant = knowledge.filter(k => k.confidence >= 0.6).slice(0, 20);

// After:
const scored = knowledge.map(k => ({
  entry: k,
  score: this.calculateEffectiveScore(k),
}));
const relevant = scored
  .filter(s => s.score >= 0.4)
  .sort((a, b) => b.score - a.score)
  .slice(0, 20);
```

### 5c. Auto-decay on session startup

**`backend/src/services/memory/agent-memory.service.ts`** — New method called during `initializeAgent()`:

```typescript
/**
 * Run decay sweep: halve confidence of entries unused for 90+ days.
 * Mark entries unused for 180+ days as candidates for pruning.
 * Skip entries with lastVerifiedAt in last 30 days (recently validated).
 */
async runDecaySweep(agentId: string): Promise<{ decayed: number; pruned: number }> {
  const memory = await this.loadMemory(agentId);
  if (!memory) return { decayed: 0, pruned: 0 };

  const now = Date.now();
  let decayed = 0;
  let pruned = 0;

  memory.roleKnowledge = memory.roleKnowledge.filter(entry => {
    // Skip if recently verified
    if (entry.lastVerifiedAt) {
      const verifiedDaysAgo = (now - new Date(entry.lastVerifiedAt).getTime()) / 86400000;
      if (verifiedDaysAgo <= 30) return true;
    }

    const lastActive = entry.lastUsed || entry.createdAt;
    const daysInactive = (now - new Date(lastActive).getTime()) / 86400000;

    if (daysInactive > 180 && entry.confidence < 0.3) {
      pruned++;
      return false; // remove
    }

    if (daysInactive > 90) {
      entry.confidence = Math.max(0.1, entry.confidence * 0.5);
      decayed++;
    }

    return true;
  });

  await this.saveMemory(agentId, memory);
  return { decayed, pruned };
}
```

### 5d. Supersession propagation

**`backend/src/services/memory/agent-memory.service.ts`** — When adding a new entry that supersedes an old one:

```typescript
async addRoleKnowledge(agentId: string, entry: ..., supersedesId?: string): Promise<string> {
  // ... existing logic ...

  // v2: Mark superseded entry
  if (supersedesId) {
    const old = memory.roleKnowledge.find(k => k.id === supersedesId);
    if (old) {
      old.superseded = true;
      old.supersededBy = newEntry.id;
    }
  }
}
```

### 5e. Update `remember` skill metadata

Allow passing `supersedes` in metadata to trigger supersession:

```typescript
metadata?: {
  // ... existing ...
  supersedes?: string; // ID of entry being replaced
};
```

### Verify
- Entry unused for 91 days → confidence halved on next startup
- Entry unused for 181 days with confidence < 0.3 → auto-pruned
- Superseded entry → effectiveScore drops to 30% of original
- Recently verified entry → protected from decay
- `generateAgentContext` uses effectiveScore, not raw confidence

---

## New File & Directory Summary

```
backend/src/
├── types/
│   └── memory.types.ts                    ← MODIFIED (RoleKnowledgeEntry, SharedUserProfile)
├── services/
│   ├── memory/
│   │   ├── memory.service.ts              ← MODIFIED (recall, getTeamDistilledSummary)
│   │   ├── agent-memory.service.ts        ← MODIFIED (effectiveScore, decay, supersession)
│   │   ├── project-memory.service.ts      ← MODIFIED (sourceTaskId on entries)
│   │   └── user-profile.service.ts        ← NEW (+test)
│   ├── ai/prompt-modules/
│   │   └── user-profile-reference.module.ts ← MODIFIED (inject shared profile)
│   └── project/
│       └── task-tracking.service.ts       ← MODIFIED (workingNotes, updateWorkingNotes)
├── controllers/
│   ├── memory/
│   │   └── memory.controller.ts           ← MODIFIED (user-profile endpoints)
│   └── task-management/
│       └── task-management.controller.ts  ← MODIFIED (save-working-notes endpoint)
└── routes/
    └── modules/
        └── task-management.routes.ts      ← MODIFIED (save-working-notes route)

config/
├── skills/agent/core/
│   ├── save-working-state/
│   │   └── execute.sh                     ← NEW
│   └── update-user-profile/
│       └── execute.sh                     ← NEW
└── roles/orchestrator/
    └── prompt.md                          ← MODIFIED (user profile management section)

~/.crewly/
└── user-profile.json                      ← NEW (created by UserProfileService)
```

---

## Implementation Order

| Step | Phase | Depends On | Effort | Files Changed |
|------|-------|-----------|--------|---------------|
| 1 | Phase 1: Task-Linked Memory | — | Small-Medium | memory.types.ts, memory.service.ts, agent-memory.service.ts |
| 2 | Phase 2: Working Memory | — | Small | task-tracking.types.ts, task-tracking.service.ts, controller, skill |
| 3 | Phase 3: Shared User Profile | — | Medium | NEW user-profile.service.ts, memory.types.ts, module, controller, skill |
| 4 | Phase 4: Unified Recall | Phase 2 (working notes in recall) | Medium | memory.service.ts, controller |
| 5 | Phase 5: Memory Scoring & Decay | Phase 1 (needs provenance fields) | Medium | agent-memory.service.ts |

Phases 1, 2, 3 can be parallelized. Phase 4 needs Phase 2 (working notes). Phase 5 needs Phase 1 (provenance fields for verification tracking).

---

## Verification Plan

After all phases:
1. `npm run build` — zero TypeScript errors
2. `npm test` — all existing + new tests pass
3. Remember with `sourceTaskId` → recall shows provenance hint (`✓` / `✗`)
4. Agent saves working notes → restarts → `get-my-tasks` returns notes → agent resumes where it left off
5. Orchestrator saves user language preference → executor agent sees it in prompt
6. `recall` with projectPath → response includes goals + focus + active tasks
7. Orchestrator `get-my-context` → includes team distilled summary
8. Entry unused 91 days → confidence halved on next startup
9. Superseded entry → effectiveScore drops significantly
10. Entry with `lastVerifiedAt` in last 30 days → protected from decay

---

## What This Does NOT Change (Intentionally)

- **Storage format** — Still JSON files, not a database. Files are the source of truth.
- **Memory limits** — MAX_ROLE_KNOWLEDGE_ENTRIES stays at 500. Decay handles cleanup naturally.
- **Semantic search** — Unchanged. Still optional Gemini embeddings.
- **Learning accumulation** — what_worked.md / what_failed.md unchanged.
- **Knowledge documents** — docs system unchanged.
- **Consolidation service** — Unchanged (it can benefit from provenance later, but not now).

The philosophy: **make existing memory smarter, not bigger.**
