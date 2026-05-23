---
name: Wiki Queue Add
description: Enqueue wiki-worthy content (from a chat turn, spec write, PR merge, learning) for later agent-driven classification + ingest. Agents must justify with --reason.
version: 1.0.0
category: knowledge
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
---

# Wiki Queue Add

Enqueue a candidate item for the LLM-wiki. This skill **does not write** to the vault — it adds the item to a queue. A separate `wiki-process-queue` run (later, batch or bookkeep-triggered) decides whether the item is actually worth saving and where in the vault it lands.

## When to use

After a chat turn (yours OR a teammate's), pause briefly and ask:

- Did this turn produce content with **lasting value**?
  - a decision (pricing, scope, scheduling)
  - a fact about a person, customer, partner
  - a pattern that future-me would want to find
  - a new constraint, gotcha, or learning
- Was a fact mentioned that the team will need to look up later?

If YES, call `wiki-queue-add`. **DO NOT call it for**:

- Routine status checks ("standup", "?", "ok")
- Implementation details captured in code/PRs
- Conversation pleasantries
- Anything already in the wiki

## Required arguments

| Flag | Required | Purpose |
|---|---|---|
| `--vault <path>` | yes | Absolute path to the vault root. |
| `--content <text>` | yes | The text to capture. |
| `--reason <text>` | **yes** | One sentence: WHY is this wiki-worthy? Audit + helps the processor decide where it goes. |
| `--source-ref <ref>` | yes | Stable reference: chat msg id, slack thread, file path, WI id. |
| `--source-type <type>` | no | Default `user_chat`. Use `slack_message`, `spec_file`, `pr_merge`, `record_learning`, `task_verified` when appropriate. |
| `--queued-by <sess>` | no | Defaults to `$CREWLY_SESSION_NAME` or `crewly-orc`. |

## Examples

**A pricing decision the team should remember:**
```bash
bash execute.sh \
  --vault ~/Desktop/projects/crewly-projects/crewly/.crewly/wiki \
  --content "Anthropic SMB pilot signed at \$799/month, 12-month commit, 30-day onboarding clause" \
  --reason "first paid SMB customer + concrete pricing validation point + new contract pattern" \
  --source-ref "slack://D0AC7NF5N7L/1779509999.111"
```

**A learning a worker just surfaced:**
```bash
bash execute.sh \
  --vault ~/.crewly/teams/ad923b66-…/wiki \
  --content "Gemini text-embedding-004 returned 404 — deprecated. Falling back to keyword search." \
  --reason "infra gotcha — affects every team using vector search; future-me will hit this" \
  --source-ref "wi:6cf2d54d-…" \
  --source-type record_learning
```

## Output

```json
{
  "success": true,
  "item": {
    "id": "uuid",
    "status": "pending",
    "queuedAt": "2026-05-22T...",
    "vaultPath": "...",
    "content": "...",
    "reason": "...",
    ...
  }
}
```

The item sits in the queue until processed. Use `wiki-queue-list` to see pending items and `wiki-process-queue` to claim + classify + ingest.

## Failure modes

- `400 reason is required` — agents MUST justify wiki-worthiness; refusal protects future-me from low-signal noise
- `400 content/sourceRef empty` — every queued item needs identifiable provenance
- `400 vaultPath must be absolute` — relative paths are rejected; the vault root is part of the audit trail
