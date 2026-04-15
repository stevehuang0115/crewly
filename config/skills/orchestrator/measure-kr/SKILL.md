---
name: Measure Key Result
description: Execute a measurement for a Key Result and submit the value. For KRs with skill_output measurement source, the runtime follows the measurementConfig instructions to collect the metric.
version: 1.0.0
category: planning
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
triggers:
  - measure kr
  - check key result
  - measure metric
tags:
  - mission
  - okr
  - measurement
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Measure Key Result

Measures a Key Result value and submits it to the tracking service.
For `skill_output` KRs, the runtime follows the `measurementConfig`
instructions to collect the actual metric value.

## Usage

```bash
bash config/skills/orchestrator/measure-kr/execute.sh \
  --mission-id <uuid> \
  --kr-id <uuid> \
  --project-path /path/to/project
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--mission-id` | Yes | UUID of the parent Mission |
| `--kr-id` | Yes | UUID of the Key Result to measure |
| `--project-path` | Yes | Project root path |
