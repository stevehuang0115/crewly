---
name: Wiki Migrate
description: One-shot conversion from legacy `.crewly/knowledge/*.json` + loose `.md` + agent `memory.json` into the v2.1 three-scope vault structure. Default dry-run; idempotent; never deletes legacy files.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Migrate

For users who installed Crewly BEFORE the v2.1 LLM-wiki landed (2026-05-22+). The legacy knowledge stores live at:

| Legacy source | New target |
|---|---|
| `<project>/.crewly/knowledge/decisions.json[]` | `<project>/.crewly/wiki/llm-curated/decisions/<date>-<slug>.md` |
| `<project>/.crewly/knowledge/patterns.json[]` | `<project>/.crewly/wiki/llm-curated/patterns/<date>-<slug>.md` |
| `<project>/.crewly/knowledge/gotchas.json[]` | `<project>/.crewly/wiki/llm-curated/patterns/<date>-<slug>.md` |
| `<project>/.crewly/knowledge/relationships.json[]` | `<project>/.crewly/wiki/llm-curated/people/<date>-<slug>.md` |
| `<project>/.crewly/knowledge/learnings.md` | appended to `<project>/.crewly/wiki/llm-curated/log.md` |
| `<project>/.crewly/knowledge/*.md` (loose) | `<project>/.crewly/wiki/llm-curated/decisions/<slug>.md` |
| `<project>/.crewly/docs/*.md` ← **legacy `query-knowledge` storage** | `<project>/.crewly/wiki/llm-curated/docs/<slug>.md` |
| `<project>/CLAUDE.md` / `AGENTS.md` / `DEPLOYMENT*.md` | `<project>/.crewly/wiki/llm-curated/runbooks/<slug>.md` |
| `<project>/deploy/*.md`, `<project>/docs/deploy*.md`, `<project>/.claude/commands/deploy*.md` | `<project>/.crewly/wiki/llm-curated/runbooks/<slug>.md` |
| `~/.crewly/agents/<id>/memory.json roleKnowledge[]` | `<project>/.crewly/wiki/llm-curated/{patterns,decisions}/<date>-<slug>.md` (copy; original retained) |
| `<crewly-src>/config/sops/<role>/*.md` (OSS-distributed) | `~/.crewly/global-wiki/llm-curated/sops/<role>/<slug>.md` (via `migrate/oss-sops`) |
| `<crewly-src>/config/domain-sops/*.sop.md` | `~/.crewly/global-wiki/llm-curated/sops/domain/<slug>.md` |
| `<crewly-src>/config/templates/pro-sops/norms/*.md` | `~/.crewly/global-wiki/llm-curated/sops/pro-norms/<slug>.md` |

Per spec §6 the agent's `memory.json` stays put — this skill **copies** its `roleKnowledge` entries to the wiki rather than moving them, so private agent memory keeps working unchanged.

## What the legacy stores were (and what replaces them)

The migration **fully retires** the legacy `query-knowledge` skill (2026-05-27). After migration:

- `<project>/.crewly/docs/*.md` → still on disk (NOT deleted) but no agent skill reads them; **all content is in the wiki**
- `<project>/.crewly/knowledge/*` → same — preserved as source of truth but consumers now use `wiki-query`
- The single replacement skill is `wiki-query` (v2.1) — same query verb, richer vault routing (global / team / project)

If you're updating prompts that referenced `query-knowledge`, swap to:

```bash
bash {{AGENT_SKILLS_PATH}}/core/wiki-query/execute.sh --vault <vault-path> --query "<topic>" --top-k 5
```

Vault picker:
- Org-wide SOPs / cross-team decisions / OKR → `~/.crewly/global-wiki`
- Team SOPs / team norms → `~/.crewly/teams/<team-uuid>/wiki`
- Project decisions / customers / project runbooks → `<project-root>/.crewly/wiki`

## Guarantees

- **Default dry-run.** No writes happen unless `--apply` (or `confirm: true` in JSON body) is passed.
- **Idempotent.** A manifest at `<vault>/.migration-state.json` records every migrated entry's content hash + sourceId. Re-runs skip duplicates.
- **Legacy preserved.** `.crewly/knowledge/` and `memory.json` files are NEVER deleted. Rollback is just "ignore the new vault."
- **Bootstrap on apply.** If the project / global / team vaults are missing `SCHEMA.md`, they're created with the v2.1 skeleton before any content lands.
- **Routing default.** Everything goes to the project vault. Items whose body looks cross-project (mention foreign team UUIDs, "company-wide", OKR lingo, cross-project codenames) are tagged `routing_uncertain: true` in frontmatter; `wiki-lint` surfaces them later for human review / promotion to global.

## Inputs

| Flag | Required | Default | Description |
|---|---|---|---|
| `--project-root <abs path>` | yes | — | The dir containing `.crewly/`. |
| `--apply` | no | off | Execute writes. Without this, run a dry-run scan. |
| `--no-memory` | no | off | Skip the per-agent `memory.json` import. |

## What you do with the report

**On scan (dry-run):**
- Read `proposedPages` — each row tells you target path, source file, sourceId.
- Look at `bootstrapNeeded` — confirms which vaults will be created.
- Look at `summary` — counts per source type.
- Look for `routingUncertain: true` rows — these will land in the project vault but flagged for later human review.

**On apply:**
- Confirm `applied` count matches the proposal.
- `bootstrapped` lists the vault dirs newly created.
- `manifestPath` is the persistent ledger — `cat` it to audit the migration.
- Run `wiki-lint --vault <project-vault>` afterwards to surface any `routing_uncertain` items.

## Examples

**Dry-run:**
```bash
bash execute.sh --project-root /Users/me/code/myproject
```

**Apply for real:**
```bash
bash execute.sh --project-root /Users/me/code/myproject --apply
```

**Apply but skip agent memory.json copies:**
```bash
bash execute.sh --project-root /Users/me/code/myproject --no-memory --apply
```

## Failure modes

- `400 invalid_input` — `projectRoot` is not absolute, or `confirm` was missing on apply (skill handles this automatically).
- `404 project_root_missing` — the directory doesn't exist.
