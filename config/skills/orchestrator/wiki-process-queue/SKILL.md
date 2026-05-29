---
name: Wiki Process Queue
description: Claim the next pending wiki-queue item and get the vault context your LLM needs to classify it into llm-curated/<folder>/<page>.md. No preset taxonomy — your LLM picks the target.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Process Queue

Claim the next pending queue item and get back the vault state your runtime's LLM should classify against. **This skill does not call an LLM.** It returns the structured context; your runtime concatenates with the per-LLM task-instruction prompt and synthesizes a target page.

## After this skill returns, YOUR runtime MUST:

1. Read `result.item.content` + `result.item.reason` (the agent who queued it justified why).
2. Read `result.vaultContext` (SCHEMA, frozen paths, recent log, candidate pages).
3. Use your LLM to pick a target. Options:
   - **Merge** into an existing `result.vaultContext.candidatePages[i].path` — preferred if a candidate fits.
   - **Create** a new page under `llm-curated/<freshly-invented-subfolder>/<slug>.md`. You may invent subfolder names; there is NO preset taxonomy.
   - **Skip** if you decide the item isn't wiki-worthy after all.
4. **Cascade-update related pages (2026-05-26 — Karpathy 10-15-pages-per-source rule).** After writing the primary target, ask: *"what existing pages in this vault are now stale or contradicted because of this new content?"* Run `wiki-query` with the topic to surface related pages, read each, and decide:
   - **Update**: the new content changes the truth of that page → `wiki-ingest --target <that-page>` with the updated body
   - **Cross-link**: just add a `[[<primary-target-slug>]]` to that page so future readers find the connection
   - **Leave alone**: no contradiction, no overlap — skip
   - **Update `index.md`**: if you created a new sub-folder or added a load-bearing page, append a link in `llm-curated/index.md` (create the file if absent)
   - Aim for **3-7 cascade touches per primary ingest** when the topic is load-bearing (customers, decisions, OKRs). Routine learnings may have 0-1 cascade touches.
5. Commit:
   - To write: call `wiki-ingest` with `--vault`, `--source-type`, `--source-ref`, `--source-body`, and `--target <relative-path>`.
   - Then POST `/api/wiki/queue/<id>/process` with `{ingested:true, pagesWritten:[…], targetPath:'…', summary:'…'}`.
     - `pagesWritten` should list ALL pages touched in step 4 + step 5 — primary + every cascade update.
   - To skip: POST `/api/wiki/queue/<id>/skip` with `{skipReason:'…'}`.

## Hard rules your LLM must honor

- **NEVER target a frozen folder** (`result.vaultContext.schemaSummary.frozenPaths`). The ingest call will reject these with HTTP 422.
- **PREFER merging into an existing page** over creating a new one. Only create new when nothing fits.
- **DO NOT re-justify wiki-worthiness** — the agent who queued the item already did (`result.item.reason`). Your job is classification, not gatekeeping. The exception is skip: if context reveals the item is a duplicate / low signal, skip with a `skipReason`.
- **Cascade updates are cheap and load-bearing — do not skip them.** A wiki where every page is a disconnected snapshot is no better than chat history. Per Karpathy: *"updating cross-references, keeping summaries current, noting when new data contradicts old claims — humans abandon wikis because of this. LLMs don't get bored."* The compounding value of the wiki comes from these cascade touches, not from the primary write.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--claimed-by <session>` | yes | Your agent session name. Defaults to `$CREWLY_SESSION_NAME` or `crewly-orc`. |
| `--vault <path>` | no | Filter to a specific vault. Default: any vault with pending items. |
| `--offset <n>` | no | Skip the first N pending items. Useful for retry after a skip. |
| `--top-k <n>` | no | How many candidate pages to surface (default 5). |
| `--recent-log <n>` | no | How many tail log entries to include (default 10). |

## Output

```json
{
  "success": true,
  "result": {
    "item": { "id": "uuid", "content": "...", "reason": "...", "status": "claimed", ... },
    "vaultContext": {
      "vault": { "scope": "project", "id": "crewly", "path": "..." },
      "schemaSummary": { "hardcoded": [...], "llmCurated": [...], "frozenPaths": ["memory/", "sop-overrides/"], "writePolicy": {...} },
      "recentLog": [...],
      "candidatePages": [{"path": "llm-curated/customers/anthropic.md", "score": 9, "excerpt": "..."}],
      "callerNotes": ["Cite pages by path.", "Refuse writes into frozenPaths.", ...]
    },
    "classifierNotes": [
      "You have ALREADY decided this item is wiki-worthy at queue-add time...",
      "Pick the target page path under llm-curated/...",
      ...
    ]
  }
}
```

## Failure modes

- `404 no_pending_items` — queue is empty (for the filter you provided). Not an error; nothing to do this turn.
- `400 claimedBy is required` — every claim is owned by a session for audit.
