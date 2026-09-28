---
id: CREW-1
title: '[P3 — backlog] delegate-task → "Failed to create WorkItem in TaskPool"'
status: backlog
priority: P2
assignee: null
team: null
labels: [ milestone:backlog ]
ownerReview: false
createdAt: 2026-04-30T13:38:48.950Z
updatedAt: 2026-09-28T16:49:52.898Z
workItemId: null
requestId: null
source: v1-migration
migratedFrom: .crewly/tasks/backlog/open/p3_delegate_task_taskpool_failure_followup_pr386_1777517500000.md
---

## Description

### [P3 — backlog] delegate-task → "Failed to create WorkItem in TaskPool"

#### Source
- Filed as out-of-scope follow-up in PR #386 (commit ee024829, merged 2026-04-30 05:27 UTC)
- Quoted from PR #386 commit body, Out-of-scope section:
  > delegate-task → "Failed to create WorkItem in TaskPool" (TaskPool path, not terminal)

#### What we know
- Symptom: when calling `delegate-task` skill, the WorkItem creation in TaskPool fails
- This is on the TaskPool service path, NOT the terminal/PTY path that PR #386 fixed
- Did not block PR #386 because it's a separate failure mode
- No reproduction details captured — needs investigation

#### Investigation steps (when picked up)
1. Search backend/src/services/queue/ + backend/src/services/task-pool/ for `Failed to create WorkItem` message
2. Check if it's a race condition (e.g. delegate-task fires before TaskPool service finished startup)
3. Check if there's a missing dependency injection or storage backend issue
4. Reproduce locally: run delegate-task skill against a fresh project, capture stack trace
5. Check TaskPool.createWorkItem() preconditions — does it require an active session, project context, or other state that delegate-task might not satisfy in some flows?

#### Expected fix scope
Unknown until reproduced. Likely small (single service file, error path handling).

#### Priority justification — why P3
- Not blocking customer demos (workaround: agents fall back to file-based tasks under .crewly/tasks/)
- Not a regression (existed pre-PR #386)
- Not security-sensitive
- Triage post-demo per orc directive 2026-04-30

#### Task Information
- **Priority**: P3
- **Milestone**: backlog
- **Created at**: 2026-04-30T13:50:00.000Z
- **Status**: Open
- **Created by**: crewly-product-sam-dd2b46f7

#### Assignment Information
- **Assigned to**: (unassigned — pick up when capacity available)
- **Status**: Open

#### References
- PR #386 commit ee024829 (Out-of-scope section)
- Likely files: backend/src/services/queue/QueueProcessorService.ts, backend/src/services/task-pool/*

## Acceptance criteria

_None yet._

## Log

- 2026-09-28T16:49:52.898Z · crewly-migration · created (backlog)
