---
name: Wiki Bookkeep
description: Vault health report — md counts, duplicate clusters, queue snapshot, consolidation recommendations. Returns signals; your LLM decides what to merge or archive.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Bookkeep

Periodic vault health check. Returns a structured report (md counts, recent activity, duplicate clusters by filename similarity, stale-page count, queue snapshot, recommendations). **The skill does not write to the vault.** Your LLM reads the report and decides next actions.

## When to use

- When `wiki-process-queue` returns `no_pending_items` — quiet moment, good for housekeeping.
- When the report's `shouldFire` was `true` on the last run (you owe the vault a consolidation pass).
- When you receive a `[BOOKKEEP] vault=…` message (a future cron + threshold trigger will deliver these).

## Inputs

| Flag | Required | Default | Description |
|---|---|---|---|
| `--vault <path>` | yes | — | Absolute vault path. |
| `--window-days <n>` | no | 7 | "Recent activity" window for `recentMdCount`. |
| `--threshold <n>` | no | 10 | `shouldFire` triggers when `recentMdCount >= threshold` OR there are duplicate clusters. |

## What you do with the report

1. **Drain pending queue first** — if `queue.pending > 0`, run `wiki-process-queue` until empty before doing anything else.
2. **Consolidate duplicate clusters** — for each cluster in `duplicateCandidates`, read the member pages, ask your LLM whether they should merge, and if yes:
   - Call `wiki-ingest` with a consolidated body that supersedes the originals (preserve the most-load-bearing info, deduplicate restated facts).
   - Note: page DELETION is not in Phase 1 — surface "these N old pages can be archived" in your reply for human review.
3. **Hot-folder rollups** — if `countsByFolder` shows >20 pages in one bucket without a recent index page, generate one. Pattern: `llm-curated/<folder>/index.md` linking + summarizing each page.
4. **Stale-page flag** — if `staleCount > 0`, mention to the user — they decide which to keep.

## Output

```json
{
  "success": true,
  "report": {
    "vault": {"scope": "project", "id": "crewly", "path": "..."},
    "generatedAt": "2026-05-23T03:00:00Z",
    "windowDays": 7,
    "threshold": 10,
    "shouldFire": true,
    "totalMdCount": 47,
    "recentMdCount": 12,
    "countsByFolder": {"llm-curated/decisions": 8, "llm-curated/customers": 3, ...},
    "duplicateCandidates": [
      {"basis": "llm-curated/customers/anthropic-pricing", "pages": ["...-v1.md", "...-v2.md"]}
    ],
    "staleCount": 4,
    "queue": {"pending": 2, "claimed": 0, "processed": 11, "skipped": 1, "total": 14},
    "recommendations": [
      "Window has 12 new md(s) — at or above threshold (10). Consider a consolidation pass.",
      "1 likely-duplicate cluster(s) detected. ...",
      ...
    ]
  }
}
```

## Failure modes

- `404 vault_missing` — the vault directory does not exist.
- `404 schema_missing` — vault has no SCHEMA.md.
- `400 invalid_input` — vaultPath not absolute / windowDays or threshold non-positive.
