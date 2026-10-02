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

## Ingest queue hygiene (#914)

`~/.crewly/wiki-queue/` is drained by `WikiWorkItemBridgeService`, which
creates one drain WI per discovered vault every tick (10 min). Each tick
first runs `WikiQueueService.sweep()`:

- **Claims** older than `WIKI_QUEUE_CONSTANTS.CLAIM_TIMEOUT_MS` (1 day) with
  no process/skip go back to `pending`.
- **Expiry**: `pending`/`claimed` items queued more than `MAX_ITEM_AGE_MS`
  (30 days) ago move to `~/.crewly/wiki-queue/dead-letter/<id>.json`, stamped
  `expiredAt` + `expireReason`, with one warn log line each. Never deleted.
- **Stale alert**: when a vault's oldest pending item is older than
  `STALE_ALERT_AGE_MS` (7 days), a `Wiki queue is stale` warn line and an
  owner Slack notification (`Wiki queue backlog`, same channel as auto-update)
  are sent, at most once per `STALE_ALERT_COOLDOWN_MS` (1 day) per vault.
- **Orphans**: pending items for a vault discovery does not return (no
  `SCHEMA.md`, project not in `projects.json`) are logged once. No WI is
  created for them, so they expire.

Things fixed here that had left items queued forever:
- `claim-next` took the newest item. A drain WI handles 5 to 20 items, so
  while agents kept queueing, the oldest items were never claimed. It now
  takes the oldest first (FIFO).
- Vault paths were compared as raw strings. An item stored as
  `…/.crewly/wiki/` never matched the discovered `…/.crewly/wiki`. Paths are
  now normalised on add and on filter.
- The drain count was capped at 200. Above that, every WI looked like no
  progress, and the cooldown backed off to 24h.
- Drain, cleanup and migrate briefs go to team leaders, but they carried a
  literal `{{ORCHESTRATOR_SKILLS_PATH}}` that only the orchestrator's prompt
  defines. The bridge now fills in the real path.

`GET /api/wiki/queue/stats` also returns `oldestPendingQueuedAt`.

## Judging whether it is alive

`GET /api/wiki/usage?vaultPath=…&days=7` → if `queries` is 0 for a month, the vault is dead: stop feeding it rather than tuning it.
