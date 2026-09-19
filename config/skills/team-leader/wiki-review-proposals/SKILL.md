---
name: Wiki Review Proposals
description: List, accept or reject wiki pages proposed by workers (pages under llm-curated/_proposed/). Canonical roles only.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - team-leader
  - orchestrator
triggers:
  - review wiki proposals
  - accept proposal
  - reject proposal
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

# Wiki Review Proposals

Workers and researchers can write pages, but the vault's `write_policy` parks them under `llm-curated/_proposed/` until someone canonical decides. You decide.

```bash
bash execute.sh --vault <vault>                                              # what is waiting
bash execute.sh --vault <vault> --accept llm-curated/_proposed/decisions/x.md  # into place + indexed
bash execute.sh --vault <vault> --reject llm-curated/_proposed/decisions/x.md --reason "already covered by decisions/y.md"
```

Accept when the page passes the same bar you hold yourself to: it changes a decision, contradicts what we believed, is a citable hard fact, or a reusable method — and its `summary` states a conclusion, not a recap. Rejections are logged in `log.md` with your reason so the proposer learns the standard.
