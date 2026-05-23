---
name: Wiki Ingest
description: Append a source (spec / decision / chat / pr / learning) into a vault's llm-curated/ tree. Refuses writes into frozen paths.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Ingest

Append a source to a vault's `llm-curated/log.md` (default) or to a dedicated page under `llm-curated/` (via `--target`). Per Atlas v2.1 §2 + §3.

The chat subscriber **already** auto-ingests every user→ORC chat message; this skill is for explicit manual ingest:

- TL promoting a decision to `llm-curated/decisions/<date>-<slug>.md`
- ORC archiving a synthesis memo into `~/.crewly/global-wiki/llm-curated/`
- A worker filing a `record-learning`-style pattern page

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--vault <path>` | yes | Absolute vault root (must contain `SCHEMA.md`). |
| `--source-type <t>` | yes | One of: `user_chat`, `slack_message`, `spec_file`, `pr_merge`, `record_learning`, `task_verified`. |
| `--source-ref <ref>` | yes | Stable reference for audit (URL, file path, message id, …). |
| `--source-body <text>` | yes | Body content to ingest. |
| `--caller <sess>` | no | Session/user that authored the source (defaults to source-ref). |
| `--target <relpath>` | no | Override the default `llm-curated/log.md`. Must NOT be inside a frozen folder. |

## Output

```json
{
  "success": true,
  "result": {
    "ok": true,
    "pagesWritten": ["llm-curated/log.md"],
    "logEntry": "## [ISO] sourceType | caller ...",
    "frozenPathsTouched": []
  }
}
```

## Failure modes

- `422 frozen_path` — target lives under a `hardcoded:` (frozen) folder. The `outcome.frozenFolders` field lists every frozen path in the vault.
- `404 schema_missing` — vault has no `SCHEMA.md`.
- `400 invalid_input | empty_body` — missing/invalid args.

## Example: ingest a TL-promoted decision

```bash
bash execute.sh \
  --vault ~/.crewly/teams/ad923b66-19dd-4d73-9c92-dc1107d37501/wiki \
  --source-type user_chat \
  --source-ref slack://thread/D0ABC/1779363330.313849 \
  --source-body "Pricing locked at \$999 setup + \$799/month." \
  --caller user/steve \
  --target llm-curated/decisions/2026-05-22-crewly-pro-pricing.md
```
