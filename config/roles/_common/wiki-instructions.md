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

**Bookkeep cadence:** when you receive `[BOOKKEEP] vault=…`, run `wiki-bookkeep` for that vault. The report surfaces duplicate clusters and consolidation candidates — use your LLM to merge them.
