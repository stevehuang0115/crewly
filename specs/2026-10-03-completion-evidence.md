# Completion evidence contract — no "done" without evidence (#873)

Status: implemented, **warn mode** this release. Owner: task-pool. Related:
`specs/2026-09-26-workitem-verification-gate.md` (who may verify),
`specs/2026-09-27-give-up-recovery.md` (blocked/failed stops).

## Claim this makes true

A WorkItem is marked done only with evidence the server can check: artifacts
that exist and commands that exited 0. A worker that could not finish says
which step failed and why, and the item is recorded as **blocked**, not done.

Why: after a tool call fails, tool-using agents often still report success. A
structured evidence contract cut false-success from 22.8% to 0.8% in the
reference study (an instruction alone: 9.3%). Before this, `complete` needed
only a free-text `summary`.

## The contract — `body.result.evidence`

`POST /api/task-pool/complete/:id` body:

```json
{
  "agentId": "<session>",
  "result": {
    "summary": "what I produced",
    "evidence": [
      { "type": "artifact", "path": "src/importer.ts" },
      { "type": "artifact", "path": "https://github.com/o/r/pull/7" },
      { "type": "command", "command": "npx jest src/importer", "exitCode": 0, "outputTail": "Tests: 9 passed" },
      { "type": "blocked", "step": "deploy to staging", "reason": "no credentials" }
    ]
  }
}
```

Types and the shape validator: `backend/src/types/v2/completion-evidence.types.ts`
(`CompletionEvidence`, `validateCompletionEvidence`, `isCompletionEvidence`).
The decision: `backend/src/services/task-pool/completion-evidence.service.ts`
(`decideCompletion`). Evidence goes inside `result` (it is persisted with the
result onto `WorkItem.output.evidence`); a top-level `evidence` is a 400
(`evidence_misplaced`) rather than silently ignored.

## What the server does (in order)

| Evidence | Response | WorkItem |
|---|---|---|
| missing or `[]`, **warn** mode | 200 + `warning`, `evidenceMode: "warn"`; logged | done (as before) |
| missing or `[]`, **enforce** mode | 400 `evidence_required`, message says exactly what to send | unchanged |
| malformed (any mode) | 400 `evidence_malformed`, names `evidence[i]` and the field | unchanged |
| any `blocked` entry | 200 `{recordedAs: "blocked"}` | **blocked** via the same path as `POST /task-pool/block/:id` (claim released, `task:blocked`, give-up classification, projection). Reason: `Blocked at "<step>": <reason>` |
| a `command` with `exitCode ≠ 0` | 400 `evidence_command_failed` ("a failing command is not evidence of done; report blocked/failed") | unchanged |
| an `artifact` local path that does not exist | 400 `evidence_artifact_not_found`, names it and where it looked | unchanged |
| a relative `artifact` path, no project/worktree on the item | 400 `evidence_artifact_relative_path` (send an absolute path) | unchanged |
| otherwise | 200 | done; evidence persisted on `output.evidence` |

- Relative paths resolve against `metadata.worktree.workdir`, then
  `metadata.worktree.path`, then `metadata.projectPath`. `~/` expands to the
  server user's home; `file://` URLs are checked like paths; `http(s)://` URLs
  are accepted without fetching; other schemes are malformed.
- A review item's verdict completion (`result.verdict` set) is exempt from the
  missing-evidence rule — the verdict is the deliverable. Malformed evidence is
  still rejected.
- The decision is made before anything is written, so a rejected completion
  leaves the WorkItem as it was.

## Rollout

- **Mode:** `COMPLETION_EVIDENCE_CONSTANTS.EVIDENCE_ENFORCEMENT_MODE`
  (`backend/src/constants.ts`), overridden per process by
  `CREWLY_EVIDENCE_MODE=warn|enforce` (read per request).
- **This release: `warn`.** Completions without evidence still land; the
  response carries `warning` and the skills print it on stderr. Everything else
  (malformed, missing artifact, failing command, blocked) is enforced now — it
  is new input, so there is no back-compat concern.
- **Next release: flip the default to `enforce`.** Before flipping, check the
  backend log for `completed without evidence (warn mode)` to find callers
  still sending none. Known callers that do not send evidence yet:
  - `V3DataService.onTaskCompleted` (`v3:task_completed` event) calls
    `pool.completeItem` directly, bypassing the controller. Nothing emits that
    event in production today; if it is revived it must pass evidence or be
    treated as system completion.
  - `OpenItemsService` follow-up closes (`open-items.wiring.ts`) move items to
    `done` as `system` without the controller — owner-promise follow-ups, not
    worker deliverables; left as is.
  - Free-form callers (direct curl, role prompts that show `report-status`
    without evidence flags) — they get the warning this release.

## Callers updated

| Caller | How it sends evidence |
|---|---|
| `config/skills/agent/core/complete-task` | `evidence` JSON array; prints the server `warning` on stderr |
| `config/skills/agent/core/report-status` (`--status done`) | `--artifact` (repeatable), `--command … --exit-code N [--output-tail …]` (repeatable), `--blocked-step/--blocked-reason`, `--evidence '<json>'` or JSON `evidence`; prints `warning` / `markedAs: blocked` |
| `config/skills/orchestrator/complete-task` | `evidence` JSON array |
| `packages/crewly-agent` tools `complete_task`, `report_status` | optional zod-typed `evidence` |

## Reviewers read the evidence first

- `config/skills/team-leader/verify-output` returns `evidence` as the first
  field of its verdict and sets `evidenceWarning` (leading `feedback`) when a
  done item carries no evidence, or reports blocked steps.
- The bridge's `Verify: …` review item description now has an `Evidence:` line
  (counts, or `NONE — … check the work directly or send it back`).

## Prompts

Worker communication module (`communication.module.ts`) states the contract
("Reporting Done — Evidence Contract"); the TL rules add "Done needs evidence"
and "read its evidence first"; the developer role's task-pool steps and the
orchestrator's skill table show evidence.
