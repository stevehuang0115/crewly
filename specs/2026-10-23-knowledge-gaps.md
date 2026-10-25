# Knowledge gaps from zero-hit queries (2026-10-23)

crewly#914 P1 ("turn zero-hit queries into a gap list"). Related:
`specs/wiki-knowledge-base.md` (the usage ledger), #1345 (the maintenance
daily pass this hangs off).

## Problem

`wiki-query` and `recall` append every query to
`llm-curated/usage.jsonl`, including the ones that found nothing. On the
owner's machine that was 2,900 queries and 31 misses by 2026-10-21. The only
reader was the bookkeep report, which quoted five missed queries in a
recommendation line the bookkeeping agent rarely saw. Nothing turned "we
were asked X and had no answer" into work for anyone.

## Design

`WikiKnowledgeGapsService`
(`backend/src/services/wiki/wiki-knowledge-gaps.service.ts`), run from the
`WikiMaintenanceService` daily pass after the digest compile, once per ISO
week per vault. Deterministic, no LLM.

1. **Roll up.** Read the ledger events of the last `WINDOW_DAYS` (7). A miss
   is `miss: true` or an empty hit list. Fold misses by normalised query
   (`gapKey`: case, whitespace, trailing punctuation) into distinct gaps:
   count, agents (most frequent first, capped), retrieval paths, first and
   last time. A gap the vault **answered later in the window** (the same
   question later returned hits) is dropped and counted. A query shorter
   than `QUERY_MIN_CHARS` is a stray token and ignored; longer than
   `QUERY_MAX_CHARS` is pasted text, counted but not listed. The list is
   most-asked first, then most recent, capped at `MAX_GAPS_PER_PAGE`.
2. **Page.** `llm-curated/gaps/<ISO week>.md` through the normal ingest path
   (frontmatter, index line, history), `replace: true` so a forced re-run in
   the same week rewrites rather than appends. Title `Knowledge gaps
   2026-W43`, `keep_because: changes_decision`, tags `knowledge-gaps`,
   `<week>`. Body: a dated heading with the counts, one bullet per gap, and
   a "What to do" section for the lead.
3. **Lead WorkItem.** One `delegate` WorkItem to the vault's team lead
   (`resolveWikiOwner`; the orchestrator for the global vault or when no
   lead resolves), `owner: team_lead` (or `orchestrator`), brief = the page,
   `metadata.kind = wiki-knowledge-gaps`. Never raised when the lead is
   dormant (`isTargetAwake`, errors count as dormant): a weekly chore is not
   worth a wake. A later forced run in the same week raises it once the
   lead is back; never twice for one week.
4. **State.** `<vault>/.wiki-gaps-state.json` holds `lastWeek`,
   `lastCompiledAt`, `workItemId`. Same week → `not_due`.

Nothing is written when the vault had no queries or no gaps.

### Cross-vault recall (1.20.397 fix)

A global recall searches the global vault and every team vault at once.
Until 1.20.397 `wikiRecallSearch` recorded a row in every searched vault,
`miss: true` wherever that vault contributed no hit, so one unanswered
recall became a miss in fifteen team vaults, and the first weekly run
(2026-10-24) produced 33 identical phantom gaps per dormant team and six
WorkItems for the orchestrator. Two rules now hold:

- The ledger records a recall hit only in the vaults that surfaced a page,
  and a recall miss once, in the vault that owns the question: the global
  vault for a global recall, the project vault for a project recall. Team
  vaults get recall rows only when they answered.
- The roll-up reads a team vault's `wiki-query` rows only (recall rows are
  cross-vault echoes), counts only `miss: true` rows, and raises a WorkItem
  for a team or project vault only when a lead resolves — the orchestrator
  fallback is for the global vault alone. WorkItem titles carry the team
  name, not its folder id.

## What the lead sees

The WorkItem title: `Review knowledge gaps 2026-W43 — crewly (3 unanswered
questions)`. The brief lists each question, how often and who asked, and
asks for one decision per question: write the page (wiki-ingest with a
summary and `keep_because`) or say in one line why it does not deserve one.
The owner is not involved and the brief says so (the owner's thread is not
a log).

## Not doing

- Low-score queries: the ledger records hit paths, not scores, so only
  zero-hit queries are rolled up. Add scores to the ledger first if
  low-score gaps turn out to matter.
- Deciding which gaps deserve a page: that is the lead's call, with its
  LLM. The service only lists.
- A UI page: the vault page and the index are enough for now.

## Verification

`backend/src/services/wiki/wiki-knowledge-gaps.service.test.ts` covers the
rollup (grouping, ranking, answered-later, stray tokens, pasted text, cap),
the page and index write, the WorkItem shape, same-week quiet, forced
replace without a second WorkItem, dormant lead then back, orchestrator
fallback, no pool, dry run, and a throwing vault in `compileAll`.
`wiki-maintenance.service.test.ts` checks the daily pass calls it with the
same dry-run flag.
