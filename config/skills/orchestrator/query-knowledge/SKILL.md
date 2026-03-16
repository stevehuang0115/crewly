---
name: Query Knowledge
description: Search the company knowledge base for SOPs, runbooks, architecture docs, and other documentation.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - query knowledge
  - search knowledge
  - find docs
  - search docs
  - find runbook
  - find SOP
tags:
  - memory
  - knowledge
  - search
  - documentation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Query Knowledge

Search the company knowledge base for relevant documents. Use this to find SOPs, runbooks, architecture docs, team norms, and other documentation before delegating process-oriented tasks.

Knowledge documents are stored at two scopes:
- **global** (`~/.crewly/docs/`) — company-wide documents accessible to all agents
- **project** (`{projectPath}/.crewly/docs/`) — project-specific documents

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search text to match against document titles, tags, and content |
| `scope` | No | `global` (default) or `project` |
| `category` | No | Filter by category: `SOPs`, `Team Norms`, `Architecture`, `Onboarding`, `Runbooks`, `General` |
| `projectPath` | Conditional | Required when scope is `project` |

## Examples

### Search global knowledge for deployment docs

```bash
bash config/skills/orchestrator/query-knowledge/execute.sh '{"query":"deployment","scope":"global"}'
```

### Search project-specific architecture docs

```bash
bash config/skills/orchestrator/query-knowledge/execute.sh '{"query":"API design","scope":"project","projectPath":"/path/to/project","category":"Architecture"}'
```

### Search for runbooks before delegating

```bash
bash config/skills/orchestrator/query-knowledge/execute.sh '{"query":"incident response","scope":"global","category":"Runbooks"}'
```

## When to Use

- **Before delegating process-oriented tasks** — check for SOPs/runbooks to include in task context
- **Before architecture decisions** — search for existing architecture docs
- **When onboarding agents to a project** — find onboarding guides and team norms
- **Before answering user questions** about processes, conventions, or infrastructure

## Output

JSON response with `success: true` and a `data` array of matching document summaries (id, title, category, tags, preview).
