---
name: Spawn Sub-agent
description: Run one short-lived helper for a bounded task (a large read, a parallel search, a scoped fix) and get its report back. Works on every runtime - Claude Code, Codex, Gemini, crewly-agent - because the helper runs in Crewly's own in-process runtime, not yours. The helper cannot message, delegate or schedule; it reads and edits under one directory and reports once. Treat the result as evidence, not as done work.
natural_language_description: Hand a bounded task to a short-lived helper and read its report.
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
  - researcher
  - team-leader
triggers:
  - spawn sub-agent
  - spawn subagent
  - run a helper
  - delegate to helper
  - parallel research
tags:
  - subagent
  - delegation
  - in-process
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 660000
---

# Spawn Sub-agent

Runs one short-lived helper for a single bounded task and returns its report.
The helper is a Crewly in-process worker (crewly#1317): it gets read tools
(`read_file`, `glob`, `grep`, `git_status`, `git_diff`, `web_search`),
write tools under its directory unless `--read-only`, and `report_to_parent`.
It cannot message anyone, delegate, schedule, touch tickets, or spawn helpers
of its own. The call blocks until the helper reports or its budget runs out.

Use it for work that is bounded and self-contained and that nobody needs to
own, review or hear about: reading a large tree for one question, three
searches in parallel, a scoped fix with a clear acceptance line. Do not use
it for work a teammate should own (that is a ticket) or for anything that
needs to talk to the owner.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--task` / `-t` | `task` | Yes | The task, in full, with the acceptance line. Max 12,000 chars: summarise context, do not paste it |
| `--cwd` / `-C` | `cwd` | No | Absolute directory the helper works in and may write under. Default `$CREWLY_PROJECT_PATH`, else `$PWD` |
| `--read-only` | `readOnly` | No | No shell and no file writes |
| `--max-steps` | `maxSteps` | No | Model steps granted (default 30, cap 60) |
| `--model` / `-m` | `model` | No | `provider/modelId`; default is the model Crewly's fallback settings name for in-process agents |
| `--task-file` | - | No | Read the task from a file instead of the flag |

## Examples

```bash
# A read-only question about the codebase
bash config/skills/agent/spawn-subagent/execute.sh --read-only \
  --task "Where is the retry delay for Slack posts set? Report file and line, and the default value."

# A scoped fix in a worktree
bash config/skills/agent/spawn-subagent/execute.sh --cwd /abs/path/to/worktree \
  --task "Rename helper foo() to bar() in src/x.ts and its test; run 'npx tsc --noEmit -p backend'. Report what changed and the tsc result."

# Three helpers in parallel from a shell
for q in "auth" "billing" "slack"; do
  bash config/skills/agent/spawn-subagent/execute.sh --read-only --task "List every file under src that handles $q, one line each" > "/tmp/sub-$q.json" &
done; wait
```

## Output

JSON. `success` is true only when the helper did work and stopped on its
own. `stoppedReason` is one of `done`, `did_nothing`, `steps_exhausted`,
`incomplete`, `timeout`, `error`. `summary` is its report (capped at 6,000
chars), `toolCalls` / `toolNames` what it did, `filesChanged` what it
wrote, `usage` its tokens (booked under `sessionName`, `<you>/sub-<n>`).

```json
{"success":true,"stoppedReason":"done","summary":"...","toolCalls":4,"toolNames":["grep","read_file"],"filesChanged":[],"usage":{"input":1200,"output":300,"cachedInput":0},"steps":5,"sessionName":"crewly-dev-1/sub-1","durationMs":18000,"model":"deepseek/deepseek-chat"}
```

A refusal is an error with a `code`: `nested` (a helper cannot spawn),
`too_many` (3 already running for you), `task_too_long`, `cwd_invalid`,
`model_invalid`, `parent_required` (no agent session in this shell).

## Reading the result

`toolCalls: 0` means the helper did nothing, whatever `summary` says. Check
`filesChanged` against what you asked for. The report is a claim from a
model with less context than you: verify anything you will act on, and
never relay it to the owner as your own finding without reading the files it
names.
