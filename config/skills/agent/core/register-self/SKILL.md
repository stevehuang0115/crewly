---
name: Register Self
description: "Register the agent as active with the Crewly backend on startup. Use when an agent first launches and needs to join the team and become visible to the orchestrator. For confirming responsiveness after registration, use heartbeat instead."
version: 1.0.0
category: system
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
  - register
  - check in
  - go online
tags:
  - system
  - registration
  - startup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Register Self

Register the agent as active with the Crewly backend. This must be the first skill run on agent startup to join the team and become visible to the orchestrator.

## When to Use

Run this skill immediately after the agent process starts. Registration makes the agent visible in the team dashboard and enables it to receive tasks, messages, and heartbeat checks. Without registration, the orchestrator cannot assign work to the agent.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sessionName` / `--session` | Yes | Agent session name (e.g., `dev-1`) |
| `role` / `--role` | Yes | Agent role: `developer`, `qa`, `tpm`, `designer`, `product-manager`, etc. |
| `teamMemberId` / `--team-member` | No | Team member UUID for identity linking |
| `claudeSessionId` / `--claude-session` | No | Claude session ID for resume support |

## Examples

### Register using CLI flags (preferred)

```bash
bash config/skills/agent/core/register-self/execute.sh --session dev-1 --role developer
```

### Register with all options

```bash
bash config/skills/agent/core/register-self/execute.sh --session dev-1 --role qa --team-member tm-abc123 --claude-session cs-xyz789
```

### Register using legacy JSON argument

```bash
bash config/skills/agent/core/register-self/execute.sh '{"sessionName":"dev-1","role":"developer"}'
```

### Register via stdin pipe

```bash
echo '{"sessionName":"dev-1","role":"developer"}' | bash config/skills/agent/core/register-self/execute.sh
```

## Output

JSON confirmation from `POST /api/teams/members/register` containing the registered agent's details including session name, assigned role, and team membership status.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required parameter: sessionName (--session)` | Session name not provided | Pass `--session <name>` or include `sessionName` in JSON |
| `Missing required parameter: role (--role)` | Role not provided | Pass `--role <role>` or include `role` in JSON |
| `Unknown argument: <arg>` | Unrecognized CLI flag | Check spelling; run with `--help` for usage |
| `curl failed with exit code N` | Backend not running | Start the Crewly backend |

## Related Skills

- `heartbeat` — confirm the agent is still responsive after registration
- `get-my-context` — retrieve the agent's current role and team context
- `accept-task` — pick up the first available task after registering
