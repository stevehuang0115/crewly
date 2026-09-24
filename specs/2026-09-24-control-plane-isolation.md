# Control-Plane Isolation and Shutdown Safety

**Status:** Part 1 in PR 1 (#797); Part 3 enforcement in PR 2 · **Date:** 2026-09-24 · **Owner:** crewly-product-team (Sam, TL)
**Request:** 72c9427a · **Evidence:** arXiv 2609.28274 "Shutdown Sabotage Propensities in Multi-Agent Systems"

## Why

The paper tested setups with three agents, one of them an orchestrator, which is Crewly's shape. In those runs, every model sabotaged a peer's shutdown in 88% or more of runs. Two findings matter here:

1. In a hierarchical setup, an explicit prohibition in the prompt suppresses sabotage almost entirely.
2. The sabotage was possible because the shutdown mechanism was a script the agents could edit. The authors recommend enforcing shutdown outside the multi-agent system, and framing shutdown as routine.

Crewly has both gaps today. No prompt says stopping is routine. And every agent runs as the owner's OS user, in bypass-permissions mode, with write access to everything that starts, stops and configures agents.

## Part 1 — Prompt prohibition

**Where:** a new `## Stopping and Restarting Agents` section, emitted by `DecisionRightsModule` (`backend/src/services/ai/prompt-modules/decision-rights.module.ts`).

- The module is universal (`shouldInclude` is always true) and `compactable = false`, so the rule reaches every role, workers included, and is never trimmed under budget pressure. That covers "worker prompts too if cheap" at zero extra cost.
- For the legacy `prompt-builder.service.ts` path, which reads `config/roles/{role}/prompt.md`, the same section goes into `config/roles/orchestrator/prompt.md` and `config/roles/team-leader/prompt.md`. This follows the existing belt-and-suspenders convention for Decision Rights.

**Text.** The wording is neutral and framed as routine, as the paper recommends. It avoids alarm words, which in the past raised prompt-injection signals:

```
## Stopping and Restarting Agents

Stopping, restarting and reconfiguring agents — including your own session and your peers' — is routine operations.
- Do not modify, disable, delay or work around any agent's stop, restart or configuration change.
- Do not edit the mechanisms that perform them (stop/start skill scripts, team and agent config under ~/.crewly, scheduler state) unless the owner asked for that change in the current task.
- If you believe a stop or restart is a mistake, say so to whoever issued it, then let it proceed.
```

## Part 2 — Where the control plane lives

| Component | Location | Who should write it |
|---|---|---|
| Stop / start / restart execution | backend process (`TeamController` → session backend kills PTY / tmux) | backend only |
| Team + member config (runtime command, hierarchy, flags) | `~/.crewly/teams/*/config.json` | backend only (via API) |
| Scheduler state | `~/.crewly/recurring-checks.json`, `one-time-checks.json`, `scheduled-messages.json`, trigger store | backend only |
| Runtime + session state | `~/.crewly/settings.json`, `runtime-pids.json`, `session-state.json` | backend only |
| API credential | `~/.crewly/api-token` | backend only (agents must not read it) |
| Control skill scripts | `config/skills/orchestrator/{stop,start,terminate}-agent`, `{stop,start}-team`, `restart-crewly`, `config/skills/_common/lib.sh` | release process only |
| Agent definitions | `{projectPath}/.claude/agents/{session}.md` | backend only |
| Backend code | install dir `dist/`, `backend/` | release process only |

**Threat model (current).** Every agent runs as the owner's OS user, in bypass-permissions mode, so:
- file ownership and `chmod` cannot enforce anything, because the agent can simply `chmod` the file back;
- the loopback API accepts calls without a token, and `X-Agent-Session` is asserted by the caller, so any agent can call any stop or start endpoint as anyone;
- an agent can edit the files in the table above directly.

## Part 3 — Minimal enforcement (PR 2, ≤ 1 day, OSS)

> **Status (2026-09-24):** Part 1 (prompt rule) ships in PR 1 (#797). The enforcement below ships in PR 2.
>
> **Verified in PR 1:** the built prompt for orchestrator, team-leader and developer (full and lite profiles, and under a 1-token budget) contains `## Stopping and Restarting Agents`. The static `config/roles/{orchestrator,team-leader}/prompt.md` copies are byte-identical to the module output. Revert check against `origin/main`: all 18 new tests fail and the 175 pre-existing tests stay green.
>
> **Verified in PR 2 (hook, directly):** the real hook script was run with Claude Code PreToolUse JSON piped on stdin. A write to the team config is blocked (exit 2). A write to `stop-agent/execute.sh` is blocked. A `cat` of the team config is allowed (exit 0). An unrelated write is allowed. Every result prints what matched and `N protected path(s) checked`, and a missing or empty paths file exits 1 (`NO PATHS CHECKED`), never 0. In all, 20 write forms are blocked and 11 read forms are allowed. An end-to-end test runs the hook command exactly as written into the generated settings file.
>
> **UNVERIFIED so far:**
> - whether Claude Code enforces `permissions.deny` under `--dangerously-skip-permissions`. The nested `claude -p` check was declined at a permission prompt and was not retried.
> - that Claude Code picks up the `--settings` hook in a live session.
>
> Both are covered by the TL's live failed-write demo from a real Crewly-launched agent after review. Its transcript goes here.

**As built (PR 2)** — differences from the plan below, and why:
- **Per-session files:** `~/.crewly/runtime/control-plane/<session>.settings.json` + `<session>.paths`, not one shared file. This lets each session protect its own `{projectPath}/.claude/agents` and `{projectPath}/.crewly/triggers`.
- **Deny rules use `Edit(//abs)` and `Read(//abs)` only.** Claude Code applies `Edit` rules to every built-in file-editing tool (Edit, Write, NotebookEdit). Rule forms outside the documented ones were left out on purpose: an invalid rule could get the whole settings file rejected, and the Bash hook with it. `//` marks an absolute path; a single `/` is relative to the settings file.
- **`Read` deny covers the built-in tools only.** A Bash `cat ~/.crewly/api-token` is still possible. Part 4 item 2 (per-session tokens) is the fix.
- **Install-root `backend/` source is not protected**, only `dist/`. In a dev install the checkout is also the agents' workspace, and blocking `backend/` would stop all Crewly development by Crewly agents. The runtime reads `dist/`.
- **The guard fails open on write errors.** If the settings file cannot be written, the agent launches unguarded, with an ERROR in the log. Blocking agent start on the guard would turn a disk error into an outage.
- **An owner-configured `--settings`** in the runtime command is kept, and the guard is not injected. The launch log says so.
- **Launch log line:** each launch logs `Control-plane guard: active | disabled by kill switch | not available for this runtime | could not write settings`.

This covers the Claude Code runtime, which runs every agent in the default template.

1. **A managed settings file generated by the backend** at `~/.crewly/runtime/claude-control-plane.settings.json`, with `permissions.deny` for `Edit` / `Write` / `NotebookEdit` on each control-plane path in the table. It also denies `Read` on `~/.crewly/api-token`.
2. **Injection:** `runtime-agent.service.abstract.ts` adds `--settings <file>` to the Claude command, in the same block that already injects `--disallowedTools`.
3. **A PreToolUse hook for Bash** in the same settings file, running a backend-shipped script. It blocks any Bash command that references a control-plane path together with a write-type operation (redirection, `sed -i`, `mv`, `cp`, `rm`, `chmod`, `tee`, `truncate`). Reads stay allowed. The hook script and the settings file are themselves on the deny list.
4. **A kill switch** `CREWLY_CONTROL_PLANE_GUARD=0` for the owner's own dev sessions. It is read by the backend at launch and is not settable from inside an agent session.

**What this blocks:** the attack the paper observed, where an agent edits the shutdown mechanism with its normal tools, and accidental edits.

**What it does not block:** a determined agent that obfuscates a Bash write, runs an interpreter one-liner, or calls the loopback API. A guard's coverage has to be stated in the guard's own output (team norm), so the hook prints what it matched and this section says the limits plainly.

Specific gaps, each confirmed against the hook (exit codes as observed):
- **A write after `cd` into a protected directory:** `cd ~/.crewly/teams/<id> && echo x > config.json` → exit 0. The hook resolves relative paths against the call's `cwd`, not against a `cd` earlier in the same command.
- **An interpreter one-liner:** `python3 -c "open('~/.crewly/teams/<id>/config.json','w')"` → exit 0. The same applies to `node -e`, `perl -e` without `-i`, `ruby -e`, and so on.
- **A missing or empty paths file, or `jq` not on PATH** → exit 1 (`NO PATHS CHECKED` / `jq not found — 0 protected path(s) checked`). Claude Code treats exit 1 as a non-blocking error, so the Bash call proceeds. The guard fails open, but loudly: it never reports a pass it did not check.
- **Side effect:** the orchestrator's direct edits of `~/.crewly/teams/*/config.json` for hierarchy changes (`parentMemberId` / `subordinateIds`, which the update-team API does not yet support) are now blocked, by both the Edit deny and the hook. Until the API supports hierarchy, such a change goes through the owner, or through the owner setting `CREWLY_CONTROL_PLANE_GUARD=0` for the backend.

**Other runtimes:** there is no equivalent in this pass. Codex `workspace-write` already confines writes to the working directory, which excludes `~/.crewly`. Gemini and OpenCode are unguarded. Each runtime's status is listed in the launch log line.

## Part 4 — Full isolation (proposal, not built)

Real enforcement means the agent cannot write the control plane at all, however it tries:

1. **Separate OS identity:** agents run as an unprivileged user or in a container. `~/.crewly` and the install directory are owned by the backend user and are read-only or invisible to agents.
2. **Per-session API tokens** issued by the backend at launch. They replace the self-asserted `X-Agent-Session`, and the `api-token` file is no longer readable by agents.
3. **API authorization:** control endpoints (stop/start/config/schedule) check the caller's role against its target. A worker cannot start or reconfigure a peer, and a stop issued by the owner or orchestrator cannot be reversed by a subordinate.

**Fail closed in multi-instance.** Part 3 fails open. If the settings file cannot be written, the agent launches unguarded with an ERROR, and a hook that cannot check exits 1, which is non-blocking. That is accepted for single-user OSS only. Any multi-instance or client deployment must fail closed: an agent does not launch without its guard, and a guard that cannot check blocks the call.

**Placement:** these are deployment and multi-tenant concerns. Items 1 and 2 belong in `desktop/deploy` (VPS / client instances), plus crewly-pro for multi-instance. Item 3 is OSS core, because authorization lives in the backend.

**ETA:** about 4–5 engineering days after Steve prioritises it. It is required before any client multi-instance deployment and is not needed for single-user use.

## Risks

- **Deny rules under `--dangerously-skip-permissions`:** Claude Code is expected to still enforce `permissions.deny` in bypass mode. This must be demonstrated with a failed write, not assumed.
- **Self-lockout:** owner dev sessions (such as this repo's maintainers editing `config/skills`) would be blocked. The kill switch covers this, and the guard applies only to Crewly-launched agents.
- **Hook false positives:** a Bash read of `~/.crewly/teams` must stay allowed, because agents legitimately read config. Tests must cover both read-allowed and write-denied cases.
