# In-process sub-agents: `spawn_subagent` for the crewly-agent runtime (#1317 slice 1)

## Problem

Agents on Claude Code can hand a bounded piece of work to a short-lived helper
(`Agent`/fork) and get a report back. Crewly already guards those helpers
(#852, `specs/2026-10-03-subagent-guard.md`).

Agents on the in-process runtime (`packages/crewly-agent`: DeepSeek, Gemini
API, OpenAI, Anthropic API) had no such tool. `createTools()` offers only
`delegate_task` / `handoff_task` / `send_message` / `start_agent`, which all
target an existing, named team member. A DeepSeek Team Lead that wanted to
research three things in parallel, or keep a large file read out of its own
context, had to do everything serially in one growing context or bother a
teammate.

## Design

A new module `packages/crewly-agent/src/runtime/subagent.ts`; the runner wires
it in at tool-creation time (`AgentRunnerService.attachSubagentTools`). Nothing
in `tool-registry.ts` changes except two sensitivity entries, so the registry's
33-tool contract is untouched.

### Parent side: `spawn_subagent`

```
spawn_subagent({ task, cwd?, readOnly?, maxSteps?, model? })
  → { success, stoppedReason, summary, toolCalls, toolNames, filesChanged,
      usage, steps, sessionName, durationMs, error? }
```

- Runs a **fresh `AgentRunnerService`** in the same process with its own
  history. The child sees only the task text, never the parent's history.
- `cwd` defaults to the parent's project path and is resolved under it.
- `model` is `modelId` (same provider) or `provider/modelId`; an unknown
  provider is refused before any runner is built.
- Bounds (`CREWLY_AGENT_DEFAULTS.SUBAGENT`): `maxSteps` default 30, cap 60;
  wall clock 10 min (AbortController passed to `run`); at most 3 children per
  parent at once (a 4th call is refused as `error`); task text ≤ 12 000 chars.
- The child runner is always `shutdown()` afterwards. Nothing persists: no
  session, no TeamMember, no Slack identity.
- Children are numbered `<parent>/sub-<n>` in spawn order.

### Child side: restricted tools

`config.subagent` (a `SubagentPolicy`) on a runner's config marks it as a
child. The runner then builds the full tool map and cuts it down with
`restrictToolsForSubagent`:

| Kept | Removed |
|---|---|
| `read_file`, `glob`, `grep`, `git_status`, `git_diff`, `web_search` | every communication, delegation, lifecycle, memory, ticket, schedule, audit, browser and desktop tool, `git_commit`, MCP tools, `spawn_subagent` |
| `bash_exec`, `edit_file`, `write_file` (dropped when `readOnly`) | |
| `report_to_parent` (added) | |

- `edit_file` / `write_file`: the path (after `~`/`$HOME`/relative expansion
  against cwd) must be inside cwd, or the call returns
  `{ success: false, error: 'refused: … outside the sub-agent working directory' }`.
  Accepted paths are passed on absolute.
- `bash_exec`: `cwd` is forced to the sandbox cwd unless the requested one is
  inside it. (The shell can still `cd ..`; the confinement is a guard against
  honest mistakes, not a security boundary. A `readOnly` child has no shell.)
- A child never gets `spawn_subagent`, so depth stays 1 by construction.
- The child's system prompt is a short fixed one (`buildSubagentPrompt`), not
  the parent's role prompt, plus the usual harness rules.

### Evidence, not trust (the lesson of #852)

- `stoppedReason` priority: `timeout` > `did_nothing` > `steps_exhausted` >
  `incomplete` > `done`. **Zero working tool calls → `did_nothing`,
  `success: false`**, even if the child wrote a confident report.
- `toolCalls` / `toolNames` / `filesChanged` (successful `edit_file` /
  `write_file` targets ∪ what the child reported) always come back.
- `summary` = the `report_to_parent` summary, else the final text, capped.

### Cost

Child usage is reported to the parent (`recordChildUsage`) and folded into the
parent's **next** `AgentRunResult.usage` and `state.totalTokens`
(`absorbChildUsage`), so whoever writes the ledger / enforces the spend cap
from run results sees the children's tokens. Context occupancy is not touched:
a child's tokens never sat in the parent's window.

## Files

- `packages/crewly-agent/src/runtime/subagent.ts` (new) + `subagent.test.ts`
- `packages/crewly-agent/src/runtime/types.ts`: `SubagentPolicy`,
  `CrewlyAgentConfig.subagent`, `CREWLY_AGENT_DEFAULTS.SUBAGENT`
- `packages/crewly-agent/src/runtime/tool-registry.ts`: sensitivity entries
- `packages/crewly-agent/src/runtime/agent-runner.service.ts`:
  `attachSubagentTools`, `getSubagentReport`, `recordChildUsage`,
  `absorbChildUsage`

## Not in this slice (slice 2)

- Codex / Gemini CLI: check their native sub-agents at the pinned versions;
  otherwise a `spawn-subagent` skill wrapping a one-shot in-process run.
- Traces / board visibility of `<parent>/sub-<n>`.
- The one-line addition to the shared delegation guidance (the tool
  description carries it for now).
- Live check: a DeepSeek TL splits a 3-part research task across 3 children.
