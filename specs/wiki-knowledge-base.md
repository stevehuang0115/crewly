# LLM-Wiki as a Knowledge Base (personal and enterprise)

Status: implemented 2026-09-19 (crewly 1.20.21). Supersedes the operational
gaps found in the 2026-09-19 design review of the v2.1 three-scope wiki
(`.crewly/specs/2026-05-22-atlas-crewly-llm-wiki-v2-three-scope.md` stays the
structural spec: three vault scopes, frozen vs `llm-curated/` folders,
skill-not-agent).

## Principles the implementation enforces

| # | Principle | Where it lives |
|---|---|---|
| 1 | One source of truth, many readers | Vault markdown is the truth; agent `memory.json` learnings mirror into `log.md` |
| 2 | Two-step retrieval, no embeddings | `llm-curated/index.md` (system-maintained, one line per page) → `wiki-query` returns it first, then `--pages` returns full pages. `WikiIndexService` |
| 3 | Readable where work happens | Files on disk; skills; Wiki UI; Obsidian BYO |
| 4 | Capture and processing are separate | `wiki-queue-add` (reason required) → bridge WI → `wiki-process-queue` → `wiki-ingest` |
| 5 | Inbox is a discussion queue | `_proposed/` pages + `wiki-review-proposals` for non-canonical writers |
| 6 | **Default is to NOT keep** | Retention gate in `wiki-ingest`: a page needs `title` + one-line `summary` (the conclusion) + `keep_because ∈ {changes_decision, contradicts, hard_fact, reusable_method}`; otherwise `log.md` |
| 7 | Superseded ≠ irrelevant | `wiki-supersede` marks `superseded_by`; page kept, hidden from default retrieval, index line marked |
| 8 | "What it means for us" is the core field | `summary` in frontmatter, shown in the index line |
| 9 | Record usage and misses | `llm-curated/usage.jsonl` written by `wiki-query` and `recall`; bookkeep reports unread pages and missed queries |
| 10 | Confidentiality boundary | Secrets always refused on write (pattern named, never the value); PII per vault `privacy.pii`; cleanup archive masked; per-page `visibility` roles |

## Page contract

```yaml
---
title: Pro pricing
summary: Pro is $800/mo + 1000 credits; overage billed monthly — quote this, not the old $799.
keep_because: changes_decision
tags: [pricing]
visibility: [sales, team-leader]      # optional; empty = everyone in the instance
source: slack C0…/1789…
caller: crewly-product-max-…
recorded: 2026-09-19T02:00:00.000Z
updated: 2026-09-19T02:00:00.000Z
superseded_by: llm-curated/decisions/2026-10-pricing.md   # only after wiki-supersede
---
# Pro pricing
…
```

## SCHEMA.md additions (per instance)

```yaml
retention:                       # optional; defaults shown
  keep_because: [changes_decision, contradicts, hard_fact, reusable_method]
  require_summary: true
privacy:                         # optional
  pii: allow | mask | refuse     # personal vault: refuse; enterprise vault: allow
  default_visibility: []         # roles a page is visible to when it declares none
write_policy:                    # now enforced (server-resolved role from X-Agent-Session)
  canonical: [team-leader, orchestrator]
  proposed_only: [worker, researcher]
```

## Personal vs enterprise

| Shared | Per instance (SCHEMA.md / vault) |
|---|---|
| Page contract, index, two-step retrieval, supersede, history, usage ledger | `retention.keep_because` (what counts), `privacy.pii` direction, `default_visibility` + per-page `visibility`, `write_policy` roles |

"For whom" is answered by scope: a team vault's `summary` means "what this means for this team"; the global vault, for the company; a project vault, for that project.

## Operations

- `POST /api/wiki/index/rebuild { all: true }` — regenerate every vault's index (run once after upgrading; then ingest keeps it current).
- Bookkeep report `kb` block: `usage` (queries/misses/top pages), `unreadPages`, `index` coverage, `proposalsPending`, `ungatedPages` — with recommendations. Curation WIs go to the vault's **team leader** (`wiki-owner.resolver`), the orchestrator only for the global vault.
- Lint: `contradictionCandidates` (same-folder pages with overlapping title+summary), `proposalsPending`, `index` coverage.
- Legacy migrate WIs stop after `MIGRATE_MAX_STRIKES` no-progress rounds.

## Judging whether it is alive

`GET /api/wiki/usage?vaultPath=…&days=7` → if `queries` is 0 for a month, the vault is dead: stop feeding it rather than tuning it.
