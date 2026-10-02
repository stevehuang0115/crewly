---
name: Report Status
description: Proactively notify the orchestrator when a task is done, blocked, or failed.
version: 1.1.0
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

Pass the `workItemId` of the work you are reporting on (from your `[CREWLY-DISPATCH]` notice or `get-my-tasks`) so the right WorkItem is closed. When that WorkItem belongs to a project ticket, the ticket follows it (done once the WorkItem is verified). The old `taskPath` field is still accepted but no longer moves any file.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--session` / `-s` | `sessionName` | Yes | Your agent session name |
| `--status` / `-S` | `status` | Yes | Status: `done`, `blocked`, `failed`, `in_progress`, `active`, `milestone`. `milestone` = a SHIPPED artifact inside an open goal (PR merged / spec finalized / build pass); emits a `[MILESTONE]` envelope that orc's Smart Notification Protocol always forwards to the owner. See `config/sops/common/mid-flight-milestone-surface.md` (#435). Summary must be ≥30 chars. |
| `--summary` / `-m` | `summary` | Yes | Brief description (or pipe via stdin) |
| `--summary-file` | — | No | Read summary from a file path |
| `--project` / `-p` | `projectPath` | No | Project path for auto-remember on completion |
| `--role` / `-r` | `role` | No | Agent role recorded with the failed/blocked learning (default: `$CREWLY_ROLE`, else `agent`) |
| `--task-path` | `taskPath` | No | Task file path; auto-moves to `done/` on completion |
| `--task-id` | `taskId` | No | Task ID (for structured StatusReport format) |
| `--progress` | `progress` | No | Progress percentage 0-100 |
| `--structured` | `structured` | No | Use structured StatusReport format |
| `--work-item-id` / `--wi-id` | `workItemId` | **Pass this when `status` is `done`, `blocked` or `failed`** | Which WorkItem to complete, block or fail. See below — without it the skill infers, and refuses when the choice is ambiguous |

### Evidence (status `done`) — #873

"Done" needs evidence. Add one or more of:

| Flag | JSON | Entry sent |
|------|------|------------|
| `--artifact <path>` (repeatable) | — | `{"type":"artifact","path":…}` — absolute, relative to your worktree/project, or an `https://` URL. Must exist on the server. |
| `--command <cmd> --exit-code <n> [--output-tail <text>]` (repeatable group) | — | `{"type":"command","command":…,"exitCode":n,"outputTail":…}` — `exitCode` must be 0 |
| `--blocked-step <step> --blocked-reason <why>` | — | `{"type":"blocked",…}` — the WorkItem is recorded as **blocked**, not done |
| `--evidence '<json array>'` | `evidence` | The raw array, sent ahead of any flag entries |

The server rejects (400) a missing artifact, a non-zero exit code, or a
malformed entry; the skill then prints `{"warning":"… completing the WorkItem
FAILED …","error":…}` with the reason. Without any evidence, `done` is accepted
**this release** with a `warning` on stderr; from the next release it is
refused. If you could not finish, report `--status blocked` (or `done` with
`--blocked-step/--blocked-reason`), never `done`.

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

**`blocked` and `failed` move the WorkItem too**, with the same resolution
order: the item is marked `blocked` (claim released, it waits until someone
unblocks it) or `failed`, your summary is stored on it as the reason, and its
team lead is told. Pass `workItemId` here as well; with several items running
the skill refuses instead of guessing.

## Examples — CLI Flags (preferred)

```bash
# Report done, with evidence
bash execute.sh --session dev-1 --status done --summary "Finished auth module, all tests pass" --project /path/to/project \
  --work-item-id <id> --artifact src/auth.ts --command "npx jest src/auth" --exit-code 0 --output-tail "Tests: 14 passed"

# Could not finish one step: recorded as blocked, not done
bash execute.sh --session dev-1 --status done --summary "Auth module written; e2e blocked" --work-item-id <id> \
  --blocked-step "npx playwright test" --blocked-reason "staging login returns 503"

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
bash execute.sh '{"sessionName":"dev-1","status":"done","summary":"Finished implementing auth module","workItemId":"<your WorkItem id>","evidence":[{"type":"command","command":"npm test","exitCode":0}]}'
```

## Output

JSON confirmation that the status notification was sent to the orchestrator. If `taskPath` was provided with `done` status, also returns the task completion result.
