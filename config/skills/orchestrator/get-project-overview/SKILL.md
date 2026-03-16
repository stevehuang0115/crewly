---
name: Get Project Overview
description: Get an overview of all configured projects.
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - project overview
  - list projects
  - show projects
tags:
  - project
  - overview
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get Project Overview

Get an overview of all configured projects.

## Usage

```bash
bash config/skills/orchestrator/get-project-overview/execute.sh
```

## Parameters

None required.

## Output

JSON array of projects with their details.
