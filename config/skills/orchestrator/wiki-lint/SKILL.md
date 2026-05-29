---
name: Wiki Lint
description: Deterministic vault validation — frozen-path violations, dangling wikilinks, orphan pages, stale claims, restructure proposals. Reports only; the agent decides what to fix.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Lint

Per v2.1 spec §3, the third Phase 1 wiki skill (alongside `wiki-ingest` and `wiki-query`). Unlike `wiki-bookkeep` which surfaces HEALTH metrics (counts, recent activity, duplicate clusters), `wiki-lint` validates CORRECTNESS:

| Check | Surfaces | Why it matters |
|---|---|---|
| `frozenPathRespected` | Ingest-style files inside frozen folders | Frozen paths (`memory/`, `sop/`, `team-norm/`, `sop-overrides/`, `okr/`) are OSS-referenced; LLM-curated content there breaks `get-sops` / `remember` / etc. |
| `missingEntities` | `[[wikilinks]]` that resolve to no page in the vault | Renamed-target or hallucinated link; dead reference must be fixed or removed. |
| `orphanPages` | Pages with zero incoming wikilinks (excluding `log.md`, `index.md`, `README*`, `SCHEMA.md`) | Either the page should be linked from somewhere or it should be archived — orphans are "did anyone find this useful?" candidates. |
| `staleClaims` | Files un-touched for `staleDays` (default 90) | Old enough to need a freshness check — the claim may have been superseded by newer pages. |
| `restructureProposals` | Heuristic proposals (e.g. "add an index.md" for big folders) | LLM-curated only; lint refuses to alter frozen paths. |

**The skill never modifies the vault.** It produces a JSON report; the agent's LLM reads it, decides what to do, and routes through `wiki-ingest` for any rewrites.

## When to run

- After a `wiki-bookkeep` consolidation pass (verify the merges didn't create new orphans or dangling links).
- When you suspect drift — e.g. a customer page was renamed and other pages may still point at the old name.
- As part of a weekly cron (the bookkeep trigger may grow to fire lint too).

## Inputs

| Flag | Required | Default | Description |
|---|---|---|---|
| `--vault <path>` | yes | — | Absolute vault path (must contain `SCHEMA.md`). |
| `--stale-days <n>` | no | 90 | Files older than this count as stale claims. |

## What you do with the report

1. **`frozenPathRespected: false`** is the most serious finding — a `wiki-ingest` call somehow wrote into a frozen folder (the runtime usually rejects this with 422; if you see it here, file a bug). For each violation, move the file to `llm-curated/` (`wiki-ingest --target llm-curated/<…>`) and delete the original.
2. **`missingEntities`** — open the source page, fix or remove the dangling link.
3. **`orphanPages`** — for each, decide: add an inbound link (edit a parent index page) OR mark for archive in your reply.
4. **`staleClaims`** — for each, decide if the claim is still true. If superseded, link the newer page; if no longer relevant, mark for archive.
5. **`restructureProposals`** — pick the high-value ones and act on them via `wiki-ingest`.

## Output

```json
{
  "success": true,
  "report": {
    "vault": { "scope": "project", "id": "crewly", "path": "..." },
    "generatedAt": "2026-05-24T19:00:00.000Z",
    "staleDays": 90,
    "frozenPathRespected": true,
    "frozenViolations": [],
    "missingEntities": [
      { "sourcePath": "llm-curated/decisions/pricing.md", "target": "ghost-page", "lineNumber": 7 }
    ],
    "orphanPages": ["llm-curated/customers/forgotten.md"],
    "staleClaims": ["llm-curated/patterns/old-pattern.md"],
    "restructureProposals": [
      { "description": "llm-curated/decisions/ has 31 pages and no index.md ...", "path": "llm-curated/decisions" }
    ],
    "truncated": false
  }
}
```

## Failure modes

- `404 vault_missing` — vault directory does not exist.
- `404 schema_missing` — SCHEMA.md not found or unparseable.
- `400 invalid_input` — vaultPath not absolute / staleDays not positive.
