---
name: Record Learning
description: Record a learning or insight gained during task execution for team knowledge sharing.
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
triggers:
  - record learning
  - learned that
  - new insight
  - knowledge share
tags:
  - memory
  - learning
  - knowledge
  - insight
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Record Learning

Record a learning or insight gained during task execution. These learnings are shared with the team and accumulated over time to improve future work.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--agent` / `-a` | `agentId` | Yes | Your agent ID / session name |
| `--role` / `-r` | `agentRole` | Yes | Your role (e.g., `developer`, `qa`) |
| `--project` / `-p` | `projectPath` | Yes | Absolute path to the project |
| `--learning` / `-l` | `learning` | Yes | The learning or insight (or pipe via stdin) |
| `--learning-file` | — | No | Read learning from a file path |

---

## Mandated Format: Karpathy-lite (Entity-Centric)

To support future automated knowledge synthesis, all new learnings MUST follow the **Entity-Centric** format. This moves from "logging what happened" to "building a compounding wiki."

### Formatting Rules:
1. **Entity First**: Start with the primary entity (concept, file, function, or component) in brackets: `[[Entity Name]]`.
2. **Concise**: 1-3 sentences maximum. No fluff.
3. **Linked**: Reference related entities or components.
4. **Sourced**: Reference the specific Task ID, PR, or Log line where this was learned.

### Examples:

**✅ CORRECT (Entity-Centric):**
> `[[Fts5IndexService]] SQLite FTS5 rank is a negative double (more-negative = more-relevant). Invert to 100 - rank for score consistency. Learned during PR #320.`

**✅ CORRECT (Component Relationship):**
> `[[LearningReferenceModule]] injects memory usage instructions via PromptAssemblyService. Related to [[record-learning]] skill. Ref: backend/src/services/ai/prompt-modules/index.ts.`

**❌ INCORRECT (Log-style):**
> `I fixed a bug today in the FTS5 service where the ranking was inverted. It took me 2 hours because I didn't know SQLite's sign convention.`

### Why this format

The `LearningReferenceModule` (prompt-layer) and the LEARN-1 auto-record subscriber both join learnings on entity references. Free-form prose breaks that join. The `[[Entity]]` bracket convention also matches the cross-doc linking pattern used elsewhere in the project (mirrors Obsidian/Roam-style backlinks for future synthesis tooling).

---

## Examples — CLI Flags (preferred)

```bash
# Record a learning
bash execute.sh --agent dev-1 --role developer --project /projects/app --learning "Jest mock resets are required between tests"

# Learning via stdin (for text with special characters)
echo "Don't use git add -A — it catches .env files" | bash execute.sh --agent dev-1 --role developer --project /projects/app

# Learning from file
bash execute.sh --agent dev-1 --role developer --project /projects/app --learning-file /tmp/insight.txt
```

## Examples — Legacy JSON (backward compatible)

```bash
bash execute.sh '{"agentId":"dev-1","agentRole":"developer","projectPath":"/projects/app","learning":"Jest mock resets are required between tests"}'
```

## Output

JSON confirmation that the learning was recorded.
