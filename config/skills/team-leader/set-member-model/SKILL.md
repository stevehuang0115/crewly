---
name: Set Member Model (TL)
description: "Move a subordinate member to Opus, Sonnet, or back to the team default. Only after the owner explicitly agreed to the change. Validates that the member reports to this Team Leader."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - set member model
  - upgrade member to opus
  - change agent model
tags:
  - agent
  - management
  - model
  - hierarchy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Set Member Model (TL Version)

Changes the model one of your members runs on. Members with a lead above them run on **Sonnet** by default; leads run on **Opus**. This skill overrides that per member.

## Only after the owner said yes

**Never run this on your own judgment.** When a member repeatedly falls short for capability reasons (not missing information), propose the upgrade to the owner in your own words, in one line. Run this skill only after the owner explicitly agreed. Moving a member back to `default` also needs the owner's yes.

## Usage

```bash
bash {{TL_SKILLS_PATH}}/set-member-model/execute.sh '{"teamId":"{{TEAM_ID}}","memberId":"worker-member-uuid","tlMemberId":"{{MEMBER_ID}}","model":"opus"}'
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `teamId` | Yes | The team's UUID |
| `memberId` | Yes | The member's UUID |
| `tlMemberId` | Yes | Your own member ID (hierarchy check) |
| `model` | Yes | `opus`, `sonnet`, or `default` (clears the override) |

## When it takes effect

The new model applies the next time the member starts. If it should apply now, wait until the member is idle, then `stop-agent` and `start-agent` it.

## Output

`{"success":true,"memberId":"...","model":"opus","modelId":"opus","note":"..."}`

## Related Skills

- `start-agent` / `stop-agent` — restart the member so the change applies now
- `verify-output` — judging the member's work
