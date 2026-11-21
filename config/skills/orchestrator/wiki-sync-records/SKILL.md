---
name: Wiki Sync Records
description: Keep a team's wiki entity pages (customers, people, projects, products) in step with the Crewly App that holds the records, so agents are handed current facts when a message names one. Use to add an App collection to a team vault, or to copy the records now instead of waiting for the periodic run.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - sync app records into the wiki
  - keep the customer pages up to date
  - copy the customers app into the wiki
tags:
  - wiki
  - memory
---

# Wiki Sync Records

A message that names a customer (or person, project, product) is delivered to
the agent with the wiki's page on them attached. Those pages go stale if the
team keeps the real record in a Crewly App. This skill keeps them current:
each App record becomes one entity page, rewritten when the record changes.
No model is involved; fields are copied as they are. The App stays the record
of truth.

Crewly runs the sync by itself a few minutes after start and every 6 hours.
Run it by hand after adding a source or when a record just changed.

## Add an App collection to a team's vault

Write `record-sources.json` at the vault root (`~/.crewly/teams/<team-id>/wiki/`):

```json
{
  "sources": [
    {
      "appId": "au35rbdmzt",
      "collection": "customers",
      "folder": "customers",
      "titleFields": ["company", "name"],
      "aliasFields": ["company", "name"],
      "summaryFields": ["stage", "nextStep"],
      "tags": ["customer"]
    }
  ]
}
```

- `folder`: `customers`, `people`, `projects` or `products`.
- `titleFields`: fields that make the page title. Required.
- `aliasFields`: fields holding the names the record goes by. A page is
  attached to a message that mentions one of them, so list every field with a
  company, contact or nickname. "RoboHub (Xin)" yields both names.
- `summaryFields`: fields that make the one-line summary.

Records are read as the vault's team lead, under the App's own access rule: the
team must have published the App or been added to it. A vault cannot copy
another team's App.

## Sync now

```bash
bash config/skills/orchestrator/wiki-sync-records/execute.sh '{}'
bash config/skills/orchestrator/wiki-sync-records/execute.sh '{"vaultPath":"/Users/me/.crewly/teams/<team-id>/wiki"}'
```

The result lists, per vault, the pages written, how many were already
current, and anything skipped or refused (with the reason).

## What stays on a page

Everything above a `## Notes` heading is replaced on each sync. Write what the
App does not hold (how the customer likes to be contacted, what was promised on
a call) under `## Notes` at the end of the page; it is kept. Names added to a
page by hand are kept too. A record deleted from the App leaves its page in
place.
