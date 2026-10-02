# Subagent guard: no silent no-op "completion", subagent rules at start (#852)

## Problem

An agent's `Agent` subagent (including `subagent_type: "fork"`) can report `completed` without doing anything. #852 has two cases:
- a fork that idled for about 24 minutes and exited with zero commits;
- a read-only fork that made **0 tool calls** and "delegated" its own task to an imaginary sub-fork.

Nothing distinguished either from real success.

A resumed fork also acted with the parent's full identity. It ran `report-status` to mark the parent's WorkItem done and notified the TL, even though its prompt said not to.

## What Claude Code lets Crewly see

From the hooks reference (https://code.claude.com/docs/en/hooks):
- `PreToolUse` / `PostToolUse` carry **no** field saying the call comes from a subagent (no `agent_id` / `agent_type`). Crewly therefore cannot deny an individual tool call because a subagent made it. This is an open upstream feature request.
- `SubagentStart` carries `agent_id`, `agent_type` and `agent_name`, and can return `additionalContext`. It cannot block.
- `SubagentStop` carries `agent_id`, `agent_type`, `agent_name`, `transcript_path` (the parent's) and `last_assistant_message`. It **can** return `decision: "block"` with a `reason`, which sends the subagent back to work.

Claude Code stores a subagent's transcript at `<project>/<session>/subagents/agent-<agent_id>.jsonl`, next to the parent's `<project>/<session>.jsonl`.

## Design

One hook script, `config/hooks/subagent-guard/subagent.sh`, registered on `SubagentStart` and `SubagentStop`. It goes in the control-plane guard's per-session settings file, the same single `--settings` file as the agent-status hook (#815). `buildControlPlaneSettings(paths, guardHook, statusHook, subagentHook)` adds only those two events. The guard's `PreToolUse` entry and the status hook's events are unchanged, and a test checks this.

| Event | Behaviour |
|---|---|
| `SubagentStart` | Returns `additionalContext` with Crewly's subagent rules: do the work yourself, with tools, and don't delegate it on; report only in your final message to the parent; don't run `report-status`, `complete-task`, `send-message`, `reply` or anything that closes, claims or verifies a WorkItem or messages another agent or a person; stay within the named files and branches; end with evidence (files, commits, commands with exit codes, or the blocking step). |
| `SubagentStop` | Counts `tool_use` blocks in the subagent's own transcript. **Zero** means `decision: "block"` with a reason: do the task now with your tools, or say exactly why you can't. |

### Never loops, fails open
- **Never loops.**
  - A subagent is sent back at most once. A marker `${CREWLY_HOME}/runtime/subagent-guard/<agent_id>.nudged` is created with `wx`, and if it already exists, the stop is allowed.
  - `stop_hook_active: true` is also honoured.
- **Fails open.** If node is missing, the JSON doesn't parse, the agent id isn't a plain identifier (`[A-Za-z0-9_-]{1,128}`, so no path tricks), or the transcript is missing, the hook allows the stop and prints nothing. It always exits 0.
- **Nothing leaves the machine.** The transcript is read only to count tool calls.

### Kill switch and protection
- `CREWLY_SUBAGENT_GUARD=0`: the backend doesn't register the hook, and the script also exits immediately.
- With the control-plane guard's own kill switch off, no settings file is written, so this hook is off too.
- `config/hooks/subagent-guard` is in the guard's write-protected install dirs, so an agent cannot rewrite or silence it.

## Parent side

The universal "Lazy Behavior Anti-Patterns" bullet, in the prompt module and in all 20 role prompts, now reads: *"Delegate without checking completion (a subagent's "completed" is not proof: check its commits, files or test output before you rely on it)."*

## Also covering #852's first gap: the evidence contract (#873)

A WorkItem can only be marked done with evidence: artifact paths that exist, or commands with exit codes. If a subagent (or anyone) marks a WorkItem done after doing nothing, it has no such evidence to give. The evidence contract is warn-only for one release, then enforced.

## Not covered (needs Claude Code)

A resumed fork still runs with its parent's full session identity. The `SubagentStart` rules make that explicit to the model, and the evidence contract stops an empty "done". But Crewly cannot *deny* a subagent's `report-status` call until `PreToolUse` says which agent is calling. When it does, the existing guard can deny completion and messaging skills when `agent_id` is present.

## Tests

- `config/hooks/subagent-guard/subagent.test.ts` runs the real script against a temp directory laid out like Claude Code's. It covers:
  - the start context;
  - a 0-tool subagent sent back;
  - a second stop allowed;
  - `stop_hook_active` honoured;
  - a subagent with tool calls allowed, including when its text mentions `tool_use`;
  - a missing transcript failing open;
  - a path-trick id ignored;
  - the kill switch;
  - non-JSON input.
- `control-plane-guard.service.test.ts` covers the events registered, the other hooks left unchanged, the write protection, the real script path, and the kill switch.
- Mutation check: removing the zero-tool block fails 2 tests.
