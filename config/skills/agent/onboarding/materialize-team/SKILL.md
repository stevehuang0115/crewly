---
name: Materialize Team
description: Materialize a confirmed team recommendation — writes the team config and flips the onboardingComplete flag. Onboarding-only.
version: 0.1.0
category: onboarding
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - materialize team
  - create team
  - confirm team
tags:
  - onboarding
  - materialize
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Materialize Team (Onboarding v3)

Take a confirmed `recommendation` (the object returned from
`recommend-team`) and create the actual team:

1. Writes `<teamsDir>/<uuid>/config.json` describing the team.
2. Persists `{ onboardingComplete: true, completedAt }` to
   `<projectFlagPath>` so the runtime knows onboarding is done.

Returns the new `teamId` + the on-disk paths.

This skill is callable **only when orc is in `'onboarding'` mode**.

## Parameters

| Flag                       | JSON Field         | Required | Description |
|----------------------------|--------------------|----------|-------------|
| `--recommendation` / `-r`  | `recommendation`   | Yes      | JSON object from `recommend-team` (templateId + agents + reasoning + source) |
| `--teams-dir`              | `teamsDir`         | No       | Override the teams directory (default: `~/.crewly/teams`) |
| `--project-flag-path`      | `projectFlagPath`  | No       | Override the project-flag path (default: `~/.crewly/onboarding-complete.json`) |
| `--json` / `-j`            | —                  | No       | Whole request as a JSON object |

## Examples

```bash
# Full payload via stdin
cat <<'EOF' | bash execute.sh
{
  "recommendation": {
    "templateId": "dtc-viral-content-team",
    "agents": [
      { "role": "content-drafter", "responsibilities": "...", "skillIds": ["content-drafter"] },
      { "role": "support-triage",  "responsibilities": "...", "skillIds": ["support-triage"]  }
    ],
    "reasoning": "...",
    "source": "hardcoded:ecommerce-content-support"
  }
}
EOF

# Or pass the recommendation JSON directly
bash execute.sh --recommendation '{"templateId":"...","agents":[...],"reasoning":"...","source":"..."}'
```

## Output

```json
{
  "success": true,
  "result": {
    "teamId": "ea0dd57a-15a9-4a34-9c6f-8f04534d89e7",
    "teamConfigPath": "/Users/.../.crewly/teams/<uuid>/config.json",
    "onboardingComplete": true,
    "projectFlagPath": "/Users/.../.crewly/onboarding-complete.json",
    "recommendation": { "...": "echo of the input" }
  }
}
```

## Notes

- v0 (Mon 5/4 EOD): writes a minimal team config (id, templateId,
  members[], onboardingSource) and flips the flag. No agent-soul
  personalisation, no project linkage.
- Wed–Fri: this skill will delegate to
  `services/onboarding/onboarding-provision.service.ts` for full
  template-engine provisioning + agent souls + goals.md generation.
  The skill's input/output shape stays stable.
- Errors propagate as `{success:false,error:"..."}`; orc surfaces them
  honestly to the user rather than retrying silently.
