---
name: Wiki Cleanup
description: Detect + remove low-quality pages from a wiki vault (low confidence, agent memory dumps, per-agent overflow). Default dry-run; archives every deletion; idempotent.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Cleanup

Removes low-quality pages from a wiki vault. Origin: the 2026-05-27 migrate pass dumped every agent's `memory.json roleKnowledge[]` entries as their own wiki page (~3,277 pages across 6 project vaults). Many are stream-of-consciousness daily memory rather than team-level patterns. This skill identifies + deletes them safely.

## Two modes

### scan (default) — dry-run

Walks `<vault>/llm-curated/**/*.md`, parses each page's frontmatter, and returns the list of pages flagged by at least one cleanup rule. **No filesystem mutation.** Use this to eyeball what would be deleted before running apply.

```bash
bash execute.sh --vault /Users/me/proj/.crewly/wiki
bash execute.sh --vault /Users/me/proj/.crewly/wiki --min-confidence 0.4
bash execute.sh --vault /Users/me/proj/.crewly/wiki --max-per-agent 20
```

Output:
```json
{
  "candidates": [
    { "relPath": "llm-curated/patterns/x.md", "reasons": ["confidence 0.3 < 0.5"], ... }
  ],
  "scannedCount": 526,
  "summary": { "lowConfidence": 412, "agentMemoryDump": 380, "perAgentCapped": 18 },
  "truncated": false
}
```

### apply — execute deletes

Deletes the explicit `--pages` list and archives each page's body + frontmatter to `<vault>/.wiki-cleanup-archive.json`. The migrate manifest (`.migration-state.json`) is **deliberately left intact** so that `wiki-migrate --apply` sees "already migrated" for the cleaned-up `sourceId`s and skips re-import. Touching the manifest would break that idempotence and the page would resurrect on the next bridge tick (the 2026-05-28 cleanup-then-migrate-resurrection bug).

```bash
bash execute.sh --vault /Users/me/proj/.crewly/wiki \
  --apply \
  --pages "llm-curated/patterns/a.md,llm-curated/patterns/b.md"
```

Output:
```json
{
  "deleted": ["llm-curated/patterns/a.md", "llm-curated/patterns/b.md"],
  "skipped": [],
  "archivePath": "/Users/me/proj/.crewly/wiki/.wiki-cleanup-archive.json",
  "manifestEntriesInvalidated": 2
}
```

## Scan rules

| Rule | Default | Disables via | What it catches |
|---|---|---|---|
| `--min-confidence FLOAT` | `0.5` | `--min-confidence 0` | Pages with frontmatter `confidence < threshold`. Migrate sets this when the classifier was uncertain — usually correlates with low-quality content. |
| (drop agent memory dumps) | ON | `--no-drop-agent-memory` | Pages with `migrated_from: "agent/<id>/memory.json"`. These are verbatim daily-memory dumps, NOT team-level patterns. |
| `--max-per-agent INT` | `0` (off) | omit flag | Keeps top-N pages per `original_author` (by confidence desc, original_date desc). Useful for taming pathological cases where one agent dumped 100+ entries. |

A page is a candidate if it matches **any** rule (union, not intersection). The per-agent cap only considers pages NOT already flagged by other rules — so a low-confidence page doesn't "use up" a cap slot.

## Safety guarantees

- **Default dry-run.** Without `--apply`, nothing is written.
- **Archive before delete.** Every deleted page's body + frontmatter is appended to `.wiki-cleanup-archive.json` BEFORE the file is removed. Rollback = "paste body back into the path from the archive."
- **Migrate manifest is preserved.** Cleanup deletes the file on disk but never touches `.migration-state.json` — the manifest is what makes `wiki-migrate --apply` idempotent. Future migrate runs see the matching `sourceId` + content hash and skip re-import. Page stays deleted.
- **Frozen folders are protected.** `memory/`, `sop/`, `sop-overrides/`, `okr/` are NEVER scanned and NEVER deleted (even if the caller passes a frozen-folder path to `--pages`, apply skips it with `reason: 'frozen'`).
- **Path-traversal guard.** Any `--pages` entry that resolves outside the vault (`../../etc/passwd` etc) is skipped with `reason: 'outside_vault'`.
- **Idempotent.** A `--apply` re-run on the same `--pages` list with already-deleted entries is a no-op (each missing file → `reason: 'not_found'`).
- **Legacy source files are NEVER touched.** `~/.crewly/agents/*/memory.json` and `<project>/.crewly/knowledge/*` stay as-is. Cleanup only removes wiki pages.

## When to invoke

- **Operator one-shot**: you notice `<project>/.crewly/wiki/llm-curated/patterns/` has 500+ entries. Run `scan` to see candidates, then `apply` with the page list you actually want gone.
- **Bridge-auto**: starting 2026-05-28 the `WikiWorkItemBridge` periodically scans every vault and creates `wiki_quality_cleanup` WorkItems with a chunked candidate list. The agent claims the WI, reads the brief, and calls `--apply` with the explicit list of pages it decided to delete. See your prompt's "Bridge-auto WorkItems — DO NOT bulk-delete" rule.

## Failure modes

- `400 invalid_input` — `vaultPath` missing or `pages` empty on apply.
- `404 vault_missing` — `vaultPath` does not exist on disk.
- `400 confirm_required` — apply was POSTed without `confirm: true` (the skill always sets this; see the underlying HTTP route for raw clients).
