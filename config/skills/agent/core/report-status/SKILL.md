---
name: Report Status
description: Proactively notify the orchestrator when a task is done, blocked, or failed.
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
triggers:
  - report status
  - notify orchestrator
  - task done
  - task blocked
  - task failed
tags:
  - task
  - status
  - notification
  - orchestrator
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Report Status

Proactively notify the orchestrator when a task is done, blocked, or failed. Use this skill to keep the orchestrator informed without waiting for a scheduled check-in.

When `status` is `done` and a `taskPath` is provided, the task file is automatically moved from `in_progress/` to `done/` in the project's `.crewly/tasks/` directory.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--session` / `-s` | `sessionName` | Yes | Your agent session name |
| `--status` / `-S` | `status` | Yes | Status: `done`, `blocked`, `failed`, `in_progress`, `active`, `milestone`. `milestone` = a SHIPPED artifact inside an open goal (PR merged / spec finalized / build pass); emits a `[MILESTONE]` envelope that orc's Smart Notification Protocol always forwards to the owner. See `config/sops/common/mid-flight-milestone-surface.md` (#435). Summary must be ≥30 chars. |
| `--summary` / `-m` | `summary` | Yes | Brief description (or pipe via stdin) |
| `--summary-file` | — | No | Read summary from a file path |
| `--project` / `-p` | `projectPath` | No | Project path for auto-remember on completion |
| `--task-path` | `taskPath` | No | Task file path; auto-moves to `done/` on completion |
| `--task-id` | `taskId` | No | Task ID (for structured StatusReport format) |
| `--progress` | `progress` | No | Progress percentage 0-100 |
| `--structured` | `structured` | No | Use structured StatusReport format |
| `--work-item-id` / `--wi-id` | `workItemId` | **Pass this when `status=done`** | Which WorkItem to complete. See below — without it the skill infers, and refuses when the choice is ambiguous |

## This skill COMPLETES a WorkItem, not just reports

When `status=done`, this skill closes a WorkItem in the task pool as a side
effect. That is a surprising amount of authority for something named
`report-status`, and the name/behaviour mismatch is exactly why nobody
anticipated it silently closing the wrong item. It is not renamed here only
because too many callers reference it.

**Pass `workItemId` whenever you report done.** Resolution order:

1. **`workItemId` given** — that item is completed. Always prefer this.
2. **Omitted, exactly one WorkItem running for your session** — that one is
   completed, and the resolved id is echoed so you can see what closed.
3. **Omitted, more than one running** — the skill **refuses** and names the
   candidates. It will not guess.

Case 3 exists because guessing destroyed real work: on 2026-08-21 the skill
completed an arbitrary first running item, silently closing a queued WorkItem
nobody had started while the agent was reporting a different one done. Nothing
failed, and the false completion spawned a verify WorkItem for a delivery that
had never happened.

If the completion itself fails, the skill says so explicitly — a reported
status never implies the WorkItem actually closed.

## Examples — CLI Flags (preferred)

```bash
# Report done
bash execute.sh --session dev-1 --status done --summary "Finished auth module, all tests pass" --project /path/to/project

# Report a blocker
bash execute.sh --session dev-1 --status blocked --summary "Waiting on API credentials from ops team"

# Report failure
bash execute.sh --session dev-1 --status failed --summary "Build fails due to missing dependency"

# Surface a milestone (#435) — a SHIPPED artifact inside an open goal.
# Emits the [MILESTONE] envelope orc's Smart Notification table always
# forwards to the owner. Summary must carry both WHAT shipped AND
# WHAT-IT-MEANS-FOR-OWNER (≥30 chars).
bash execute.sh --session dev-1 --status milestone \
  --summary "PR #420 merged — agent state file is now corruption-resistant + auto-snapshots every 30s"

# Multi-line summary via stdin (avoids shell escaping)
echo "Fixed the bug — it's working now" | bash execute.sh --session dev-1 --status done --project /path

# Summary from file
bash execute.sh --session dev-1 --status done --summary-file /tmp/summary.txt --project /path
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"sessionName":"dev-1","status":"done","summary":"Finished implementing auth module","taskPath":"/path/.crewly/tasks/delegated/in_progress/implement_auth_1234.md"}'
```

## Output

JSON confirmation that the status notification was sent to the orchestrator. If `taskPath` was provided with `done` status, also returns the task completion result.
