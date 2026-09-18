---
name: Record Prediction
description: Record a prediction with a confidence level so your calibration can be measured once it resolves.
version: 1.0.0
category: memory
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
  - orchestrator
triggers:
  - record prediction
  - I predict
  - confidence
  - estimate
tags:
  - memory
  - calibration
  - self-improvement
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Record Prediction

Write down a falsifiable prediction ("this PR lands today", "the flaky test is a race in the mock") with a confidence between 0 and 1. Later, close it with `resolve-prediction`. Your calibration score (how well confidence tracks reality) is shown in your prompt once predictions resolve, with guidance when you are over- or under-confident.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--statement` / `-p` | `statement` | Yes | What you predict will happen |
| `--confidence` / `-c` | `confidence` | Yes | 0–1 (e.g. `0.7`) |
| `--resolve-by` | `resolveBy` | No | ISO date by which it should be resolved |
| `--session` / `-s` | `sessionName` | No | Your session name — defaults to `$CREWLY_SESSION_NAME` |

## Examples

```bash
bash execute.sh --statement "checkout PR merges before Friday" --confidence 0.7 --resolve-by 2026-10-03
bash execute.sh '{"statement":"checkout PR merges before Friday","confidence":0.7}'
```

## Output

`{ "success": true, "id": "pred-...", "prediction": {...} }` — keep the `id`; you need it to resolve.
