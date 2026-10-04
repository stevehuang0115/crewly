---
name: Delegate Task (TL)
description: "Assign a task to a worker within the Team Leader's subordinate scope. Validates that the target worker's parentMemberId matches the TL's memberId before delegation. Includes auto-monitoring setup."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - delegate task
  - assign to worker
  - send task to worker
  - delegate to subordinate
tags:
  - task
  - delegation
  - management
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Delegate Task (TL Version)

Assigns a task to a worker within the Team Leader's subordinate scope. Validates hierarchy before delegation — the target worker's `parentMemberId` must match the TL's `memberId`.

## When to Use

- After `decompose-goal` creates sub-tasks
- When `handle-failure` decides to `reassign` a task
- When a new worker needs to be given work

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--to` / `-t` | `to` | Yes | Target worker's PTY session name |
| `--task` / `-T` | `task` | Yes | Task description (or pipe via stdin) |
| `--task-file` | — | No | Read task description from a file path |
| `--priority` / `-P` | `priority` | No | Priority: `low`, `normal`, `high` (default: `normal`) |
| `--context` / `-c` | `context` | No | Additional context for the worker. Scanned for the Request Contract alongside `--task` |
| `--project` / `-p` | `projectPath` | No | Project path; recorded on the WorkItem (`metadata.projectPath`) |
| `--team` / `-g` | `teamId` | No | Team ID for hierarchy validation |
| `--tl-member` | `tlMemberId` | No | TL's member ID for hierarchy validation |
| `--from` | `fromSession` | No | Delegating TL's session name (for monitoring) |
| `--request-id` / `-R` | `requestId` | No | Ticket this work is for: the id (or `TKT-123`) from the `[TICKET:TKT-123 <id>]` line of the message you are acting on. Omit it and the task is still linked when your current turn has exactly one ticket |
| `--ticket` | `ticket` | No | Project ticket this work is for (e.g. `APP-12`). Without it a ticket is created for you when the target works on a project — see Project tickets |
| `--thread` | `thread` | No | Owner request from Slack: the key from the `[SLACK-THREAD:<key>]` of the owner's message. The member answers the owner in that thread itself — see Owner requests |
| `--no-member-fits` | `noMemberFits` | No | You keep the work: record what is missing (access, tool, permission, everyone busy). Needs `--task`; nothing is delegated — see No member fits |
| `--work-item` | `workItemId` | No | With `--no-member-fits`: the WorkItem you keep (gets a `[NO-MEMBER-FITS]` note) |

## Who to delegate to

Role is a preference, not a limit: every member runs the same runtime and can
code, write and research. Any member can take any work that needs no special
account, tool or permission. Prefer an idle (or stopped) member over doing it
yourself. Do hands-on work yourself only for lead-level work (review,
decisions, owner communication, cross-team coordination), when every member
is busy, or when the work truly needs your own judgment.

## Owner requests (`--thread`)

When the owner asked in Slack, pass the thread key from the owner message's
`[SLACK-THREAD:<key>]`:

```bash
bash execute.sh --to sage-session --task "Goal: … Outcome: … Eval: …" --thread C0THINK:1790000000.000100
```

The WorkItem carries the thread and the member is told to post its progress
and result there itself (`reply --work-item <id>`), under its own name. You do
not relay its answer; the room's reply gate never holds the member's post.
Without `--thread` the thread of your last owner message is used. (A thread
in your DM with the owner: the member's bot cannot post there, so it answers
in its own DM with the owner, opened with `Re: <task>`.)

## No member fits (`--no-member-fits`)

Rare. When you keep work yourself, record why — what is missing, not a role
mismatch — so the owner sees missing roles in the daily report:

```bash
bash execute.sh --no-member-fits "needs the owner's Stripe login" --task "Update billing settings" [--work-item <id>] [--ticket CE-7]
```

Nothing is delivered. With `--work-item` the WorkItem gets a
`[NO-MEMBER-FITS] <reason>` note.

## Project tickets

Work for a teammate on a project always runs through a project ticket
(`<project>/.crewly/tickets/`, spec `2026-09-28-project-tickets.md` §11):

- `--ticket APP-12` — that ticket (must be `backlog` or `ready`, with no other
  live WorkItem) is assigned to `--to` and this WorkItem becomes its work. A
  ticket that is already being worked, done, cancelled or unknown is refused:
  nothing is delivered and the reason is printed.
- no `--ticket` — a ticket is created from this delegation (title, brief,
  the target's team, priority) and set `in_progress` for the target. The
  output names it (`projectTicket`).

No ticket is made for work you target at yourself, review/verify items,
system or scheduled items, or targets whose team has no project. Work already
in flight without a ticket: `project-tickets link --project P --id APP-12 --work-item <id>`.

## Request Contract check

Before delegating, the skill scans the brief for Goal, Expected Outcome, and
Eval Criteria markers, and emits a non-fatal warning on stderr naming any that
are missing. Workers use that warning to decide whether to push back under the
Brief Reception Protocol.

`--task` and `--context` are scanned **together**, so the contract may live in
either field or be split across both. A marker absent from both still warns.

Recognised synonyms: `Objective` for Goal; `Acceptance Criteria` or
`Evaluation Criteria` for Eval Criteria.

## Usage — CLI Flags (preferred)

```bash
# Basic delegation
bash execute.sh --to worker-session --task "Implement login form" --priority high --project /path/to/project

# With hierarchy validation
bash execute.sh --to worker-session --task "Implement login form" --priority high --team team-123 --tl-member tl-member-id --project /path/to/project

# Task from stdin (for long descriptions with special characters)
echo "Implement the OAuth2 flow — it's critical for launch" | bash execute.sh --to worker-session --priority high --project /path

# Task from file
bash execute.sh --to worker-session --task-file /tmp/task-description.txt --priority high --project /path
```

## Usage — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"to":"worker-session","task":"Implement login form","priority":"high","teamId":"team-123","tlMemberId":"tl-member-id","projectPath":"/path/to/project"}'
```

## Hierarchy Validation

When `teamId` and `tlMemberId` are provided, the script fetches team data and validates:
- The target worker exists in the team
- The worker's `parentMemberId` matches the TL's `memberId`

If validation fails, delegation is rejected with a hierarchy violation error.

## Auto-Start Offline Workers

If the target worker is offline (delivery fails), the skill automatically:
1. Looks up the worker's `memberId` from team data
2. Calls `POST /teams/:teamId/members/:memberId/start` to boot the worker
3. Waits 10 seconds for the agent to initialize
4. Retries task delivery

This requires `--team` to be provided. Without team context, offline workers cannot be auto-started.

## Differences from Orchestrator delegate-task

| Aspect | Orchestrator | Team Leader |
|--------|-------------|-------------|
| Scope | Any agent in any team | Only subordinates |
| Message prefix | "New task from orchestrator" | "New task from Team Leader" |
| Hierarchy check | None | Validates parentMemberId |
| Monitoring subscriber | Orchestrator session | TL session |

## Output

JSON confirmation of task delivery, same format as orchestrator delegate-task.

## Related Skills

- `decompose-goal` — Create sub-tasks before delegating
- `verify-output` — Verify completed task output
- `handle-failure` — Handle delegation failures

## Paused teams

The owner can pause a team temporarily (specs/2026-10-04-team-pause.md). A
paused team is hidden from agents and takes no work: handing it work, or
messaging, starting or assigning a ticket to one of its members, fails with
`code: "team_paused"` and a message saying what to do instead — usually
`gh issue create -R <repo> --title "…" --body "…"` (the team's issue repo),
otherwise tell the orc. Do that; do not retry or route around the pause.
