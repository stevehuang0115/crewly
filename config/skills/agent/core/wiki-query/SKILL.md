---
name: Wiki Query
description: Read a project/team/global vault and return the system-context payload your runtime feeds to the LLM for synthesis. Single-vault scope (Phase 1).
version: 1.0.0
category: knowledge
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
  - team-leader
  - researcher
---

# Wiki Query

Read a vault (`<project>/.crewly/wiki/`, `~/.crewly/teams/<id>/wiki/`, or `~/.crewly/global-wiki/`) and get back the structured context the caller's LLM uses for synthesis.

Per Atlas v2.1 §3, this skill **does not call an LLM itself**. It emits the LLM-agnostic system-context (vault SCHEMA, recent log entries, candidate pages by keyword overlap). The caller's runtime concatenates this with the per-LLM task-instruction prompt at `prompts/<runtime>.md` and makes the LLM call locally.

## When to use

- ORC assembling cross-team context for a planning turn.
- TL pulling the team's last 20 decisions for a sprint review.
- A worker checking "did we already record an opinion on X?" before writing one.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--vault <path>` | yes | Absolute path to a vault root (must contain `SCHEMA.md`). |
| `--query <text>` | yes | Natural-language question. Used for keyword-overlap candidate ranking. |
| `--top-k <n>` | no | How many candidate pages to return (default 5). |
| `--recent-log <n>` | no | How many tail log entries to include (default 20). |
| `--json <obj>` | alt | Pass all fields as JSON. |

## Output

JSON with `success`, `result.context`. The context has:

- `vault` — scope, id, absolute path
- `schemaSummary` — frozen folders, llm-curated layout, write_policy
- `recentLog` — last N entries (most-recent first), with timestamp / sourceType / caller / body
- `candidatePages` — top-K pages by keyword overlap with `query`
- `callerNotes` — synthesis hints the LLM should honor (e.g. refuse writes into frozen paths)

## Example

```bash
bash execute.sh \
  --vault ~/Desktop/projects/crewly-projects/crewly/.crewly/wiki \
  --query "what did we decide about Crewly Pro pricing in May"
```

## Failure modes

- `400 invalid_input` — missing vault/query or bad topK
- `404 schema_missing` — vault has no SCHEMA.md
