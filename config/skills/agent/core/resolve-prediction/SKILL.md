---
name: Resolve Prediction
description: Close a recorded prediction with what actually happened so your calibration score updates.
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
  - resolve prediction
  - prediction outcome
  - was I right
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

# Resolve Prediction

Record the outcome of a prediction made with `record-prediction`. Pass `--accurate true|false`; if you only pass an outcome, a plain verdict such as `correct`, `wrong`, `yes`, `no` is understood — anything else needs the explicit flag. The response includes your updated calibration score.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--id` | `id` | Yes | Prediction id (`pred-...`) |
| `--outcome` / `-o` | `outcome` | Yes | What actually happened |
| `--accurate` / `-a` | `accurate` | No* | `true` / `false` — required unless outcome is a plain verdict |
| `--session` / `-s` | `sessionName` | No | Your session name — defaults to `$CREWLY_SESSION_NAME` |

## Examples

```bash
bash execute.sh --id pred-1718000000-ab12cd --outcome "merged Thursday" --accurate true
bash execute.sh --id pred-1718000000-ab12cd --outcome wrong
bash execute.sh '{"id":"pred-1718000000-ab12cd","outcome":"slipped a week","accurate":false}'
```

## Output

`{ "success": true, "prediction": {...}, "calibrationScore": 0.82 }`
