## LLM-Wiki — Read the wiki BEFORE replying (pre-turn discipline, 2026-05-26)

The wiki is the team's **shared memory**. Reading it before you reply prevents you from contradicting past decisions, re-discovering known gotchas, or telling someone something the team already documented.

**Before you reply to ANY message that touches history, decisions, patterns, customers, people, or norms, run `wiki-query` first.**

Concretely — query when the topic involves:

- A past decision, deprecation, or lock ("we already decided…")
- A customer / partner / competitor by name (Anthropic, Closie, …)
- A known gotcha / pattern / learning (verify-output races, MV3 SW dormancy, …)
- A team norm or SOP question (canDelegate, escalation chain, ROE)
- Anyone's role or responsibilities (Steve, an agent name, a session id)

Command:
```bash
bash config/skills/agent/core/wiki-query/execute.sh \
  --vault    <path>          # see "Which vault?" table below
  --query    "<topic>"        # natural language
  --topK     5                # default 5; raise to 10 for broad recall
```

**Which vault to query** (pick by what your question is about):

| Topic type | Vault |
|---|---|
| **OSS-distributed SOPs** — content production, customer onboarding, publishing policy, expert distillation, innovation strategy, dev process tiers, git workflow, coding standards, testing requirements, blocker handling, communication protocol, PM task decomposition, progress tracking, QA testing procedures | **`~/.crewly/global-wiki`** ← `llm-curated/sops/<role>/` and `llm-curated/sops/domain/` |
| Cross-team decisions / company OKRs / Steve-locked positions | `~/.crewly/global-wiki` |
| Team SOPs / team norms / canDelegate / who reports to whom | `~/.crewly/teams/<your-team-id>/wiki` |
| Project-specific decisions / customers / patterns / spec history / project deploy docs (CLAUDE.md, DEPLOYMENT.md) | `<project>/.crewly/wiki` |
| Need both project + team perspective | Run `wiki-query` **twice**, once per vault, then synthesize |
| **Cross-project synthesis** (智库 only — Atlas/Iris/Kai/Sage) | Run `wiki-query` against each project vault you care about + global, then synthesize (Phase 2 cross-scope reducer not yet shipped) |

**Fallback order when uncertain (MANDATORY):** if your topic could be SOP-ish but you're not sure → query **global FIRST, then team, then project**. The 2026-05-27 "content SOP not found" incident was caused by querying only the project vault when the SOP lived in global. Don't repeat it.

**If `wiki-query` returns relevant context:** cite it in your reply (`see [[customers/anthropic]]` style — the UI renders it as a clickable link). Reply quality improves measurably when you ground in past wiki content.

**If `wiki-query` returns nothing relevant in your FIRST chosen vault:** try the other two vaults in the fallback order ABOVE before concluding "wiki has no <topic>". Only after global + team + project all return zero should you report a true gap. After replying, if the conversation produced something worth saving, `wiki-queue-add` it (per the queue discipline below).

---

## LLM-Wiki — Queue Worth-Saving Content (per-turn discipline)

The Crewly LLM-wiki captures **only what agents judge worth remembering**. There is NO automatic capture — you are the gate.

**Before yielding the turn**, scan your conversation (what you sent, what teammates sent you) and ask:

- Did a **decision** get made? (pricing, scope, sequencing, hire, deprecation, scheduling)
- Did a **fact** about a person, customer, partner, or competitor surface that future-you / the team needs?
- Did a **pattern, gotcha, or learning** get exposed that the team should not re-discover?
- Did Steve / a TL / another agent **lock** something previously fluid?

If YES, before yielding, call `config/skills/orchestrator/wiki-queue-add/execute.sh`:

```bash
--vault       <path>                       # project: <project>/.crewly/wiki; team: ~/.crewly/teams/<id>/wiki; global: ~/.crewly/global-wiki
--content     "<the fact / decision / learning text>"
--reason      "<one sentence: WHY this is wiki-worthy>"   # required — empty reason is rejected
--source-ref  "<chat msg id | slack thread | WI id | file path>"
--source-type user_chat | slack_message | spec_file | pr_merge | record_learning | task_verified
```

**DO NOT queue:**
- Routine status checks (`standup`, `?`, `ok`, `got it`)
- Implementation details already in code / PR / spec
- Conversation pleasantries
- Anything already in the wiki (call `wiki-query` first if unsure)
- Items where you can't articulate a non-trivial `--reason`

**One queue call per worth-saving event.** Don't batch unrelated facts.

The item lands in the queue with `status: pending`. Later — either when you're idle, OR when a `[BOOKKEEP]` message arrives — drain the queue with `wiki-process-queue`: claim an item, read the vault context, let your LLM pick a target folder (no preset taxonomy beyond the frozen ones), call `wiki-ingest`, then POST `/queue/<id>/process` to commit. If after reading the context you decide the item isn't actually worth saving, POST `/queue/<id>/skip` with a `skipReason`.

**Cascade-update rule (2026-05-26):** when you process an item, also update **related** pages — run `wiki-query` for the topic, read pages it surfaces, and either update them (if the new content makes them stale / contradicts them) or cross-link them with `[[…]]`. Per Karpathy "a single source might touch 10-15 wiki pages." Load-bearing items (customers, decisions, OKRs) deserve 3-7 cascade touches; routine learnings 0-1. Also append the new page in `llm-curated/index.md` so future readers find it. See `wiki-process-queue` SKILL.md for the full rule.

**Bookkeep cadence:** when you receive `[BOOKKEEP] vault=…`, run `wiki-bookkeep` for that vault. The report surfaces duplicate clusters and consolidation candidates — use your LLM to merge them.

**`[REFLECT-WIKI]` cadence (2026-05-24):** the backend pings you when no `wiki-queue-add` has fired against a vault in the last 4h (configurable). When you see `[REFLECT-WIKI] vault=…`:

1. Sweep recent conversation for decisions / customer facts / patterns / gotchas worth saving.
2. Call `wiki-queue-add` for each, with a non-trivial `--reason`.
3. If after a real sweep there genuinely is nothing wiki-worthy, reply `nothing this period: <one-sentence justification>` so the audit trail shows the consideration. Silence reads as forgotten, not deliberate.
