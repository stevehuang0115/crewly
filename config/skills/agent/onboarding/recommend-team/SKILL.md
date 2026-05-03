---
name: Recommend Team
description: Recommend a team configuration (template + agents) based on the user's business context. Onboarding-only.
version: 0.1.0
category: onboarding
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - recommend a team
  - propose team
  - suggest team
  - team recommendation
tags:
  - onboarding
  - recommendation
  - team
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 10000
---

# Recommend Team (Onboarding v3)

Turn the discovery answers gathered in phases 1–3 of the onboarding
conversation into a concrete team proposal: a template id + 2–4 agents
with responsibilities and skill ids.

This skill is callable **only when orc is in `'onboarding'` mode**. The
runtime gate enforces that via `ONBOARDING_SKILL_ALLOWLIST`.

## Parameters

| Flag             | JSON Field | Required | Description |
|------------------|------------|----------|-------------|
| `--industry` / `-i` | `industry` | Yes | Free-text industry / domain (e.g. "small Shopify skincare shop") |
| `--scale` / `-s`    | `scale`    | Yes | One of: `solo`, `small-team`, `company` |
| `--tasks` / `-t`    | `tasks`    | No  | JSON array of `{ name: string, tier: <FeasibilityTier> }`. Empty allowed. |
| `--json` / `-j`     | —          | No  | Whole request as a JSON object. |

Feasibility tier vocabulary (must match the system prompt):
`yes-today` | `collaborative` | `roadmap` | `out-of-scope`.

## Examples

```bash
# Anchor demo (Steve's e-commerce skincare shop)
bash execute.sh \
  --industry "small Shopify skincare shop" \
  --scale solo \
  --tasks '[{"name":"weekly content","tier":"yes-today"},{"name":"customer support","tier":"yes-today"}]'

# Or one-shot JSON
bash execute.sh '{
  "industry": "growth marketing agency",
  "scale": "small-team",
  "tasks": [
    {"name":"lead gen","tier":"yes-today"},
    {"name":"content distribution","tier":"yes-today"}
  ]
}'
```

## Output

```json
{
  "success": true,
  "recommendation": {
    "templateId": "dtc-viral-content-team",
    "agents": [
      { "role": "content-drafter", "responsibilities": "...", "skillIds": [...] },
      { "role": "support-triage",  "responsibilities": "...", "skillIds": [...] }
    ],
    "reasoning": "...",
    "source": "hardcoded:ecommerce-content-support"
  }
}
```

## Notes

- v0 (Mon 5/4 EOD): 5 hardcoded heuristic mappings + a generic 2-agent
  fallback. ~80% of users land on a hardcoded mapping.
- Wed–Fri: real RAG over Mia's spec v3 + doc 69 + the live template
  registry. The `recommendation` shape stays stable — orc does not need
  to be re-prompted when the strategy changes.
