---
name: Wiki Supersede
description: A conclusion changed — mark the old wiki page as superseded by the new one (kept, hidden from default retrieval). Canonical roles only.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - team-leader
  - orchestrator
triggers:
  - supersede page
  - conclusion changed
  - replace decision
tags:
  - wiki
  - knowledge
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Wiki Supersede

When a judgement changes, do **not** delete or overwrite the old page. Write the new page with `wiki-ingest`, then:

```bash
bash execute.sh --vault ~/.crewly/teams/<team-id>/wiki \
  --old llm-curated/decisions/2026-05-pricing.md \
  --new llm-curated/decisions/2026-09-pricing.md \
  --reason "Owner moved Pro to $800 + credits on 2026-09-01"
```

The old page gets `superseded_by`, `superseded_at`, `superseded_reason`; `wiki-query` and `recall` hide it by default (`--include-superseded` shows the history); the index line reads `⟶ superseded by …`. The change of judgement is itself knowledge — that is why the page stays.

Refused with 403 unless your role is in the vault's `write_policy.canonical`.
