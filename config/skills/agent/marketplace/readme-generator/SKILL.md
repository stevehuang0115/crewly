---
name: README Generator
description: Auto-generate a README.md from package.json and project structure.
version: 1.0.0
category: documentation
skillType: claude-skill
assignableRoles:
  - developer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - product-manager
  - generalist
triggers:
  - generate readme
  - create readme
  - readme
  - project docs
tags:
  - readme
  - documentation
  - markdown
  - project-setup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# README Generator

Auto-generate a README.md from package.json metadata and project directory structure. Detects TypeScript, Docker, test frameworks, and available scripts.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectPath` | No | Path to the project (defaults to current directory) |
| `outputPath` | No | Where to write the README (defaults to `projectPath/README.md`) |
| `dryRun` | No | Set to `true` to preview without writing |

## Examples

### Generate README for current project

```bash
bash config/skills/agent/readme-generator/execute.sh '{"projectPath":"."}'
```

### Dry run to preview

```bash
bash config/skills/agent/readme-generator/execute.sh '{"projectPath":"/path/to/project","dryRun":true}'
```

## Output

Success:
```json
{"success": true, "outputPath": "/path/to/README.md", "lines": 45}
```

Dry run:
```json
{"dryRun": true, "outputPath": "/path/to/README.md", "contentLength": 1200, "preview": "# my-project\n..."}
```
