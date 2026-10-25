# Knowledge evidence merge on write (#914 P1, first slice)

**Status:** shipped in 1.20.399 (deterministic dedup, OSS). LLM adjudication of keep / modify / supersede is a later, possibly Pro, slice.

## Why

`addRoleKnowledge` deduped by exact match or substring containment only. The same fact restated with a different id, count or date in it became a second entry, and recall surfaced both:

```
Claimed WorkItem 'Refresh standing answer "What decisions are in force?" — ce-core (1 newer)' (id: 869f…, claim: fdae…)
Claimed WorkItem 'Refresh standing answer "What decisions are in force?" — ce-core (1 newer)' (id: 27af…, claim: 6ea4…)
```

Replaying the owner's 71 agent stores (3,697 entries, 2026-10-25) through the old rule found 0 exact duplicates — those were already stopped on write — and 166 restatements of an existing entry that it let through. Among them corrections of a wrong assertion written as a near-copy of it ("I asserted X is a working symlink" → "X is a DANGLING symlink"), which is why a near match does not keep the old wording.

## What

`backend/src/services/memory/knowledge-similarity.ts` (pure):

| Function | Does |
|---|---|
| `knowledgeTokens(text)` | lowercase; strip uuids; split on non-alphanumerics; drop hex runs ≥ 4 chars with a digit (partial ids, shas), digit runs ≥ 6 (epoch, compact dates, random suffixes), single letters. Numbers up to five digits stay, single digits included: "entry 0" and "entry 1" are two facts |
| `jaccard(a, b)` | set overlap |
| `numbersCompatible(a, b)` | one side's numbers are all present on the other. "verify CE-140" vs "verify CE-196" → false; "snapshot 10/13 03:40Z" vs "snapshot 10/13" → true. Disagreeing counts ("1 newer" / "6 newer") stay apart on purpose: a false merge loses knowledge, a missed one leaves a duplicate |
| `sameScope(existing, incoming)` | same category when the incoming entry names one; a shared tag when both carry tags |
| `isSameText` / `containsText` / `isExactMatch` | the legacy rule, split: equality; containment when the incoming text is longer than `SUBSTRING_MIN_CHARS` |
| `findNearestKnowledge(knowledge, incoming, {threshold, now})` | skips superseded and expired entries and entries out of scope; same text wins outright, then a containment match (`kind: 'exact'`), then the highest Jaccard ≥ threshold among number-compatible entries (`kind: 'near'`); incoming texts under `MIN_TOKENS_FOR_NEAR` tokens match exactly or not at all |
| `mergeKnowledgeEvidence(existing, incoming, now)` | exact match: evidence union (legacy `learnedFrom` and `sourceTaskId` count), importance max, `lastVerifiedAt` / `lastUsed` stamped; content stays |
| `restateKnowledge(old, incoming, {id, now, score})` | near match: the incoming wording becomes a new entry carrying the old provenance (evidence union, importance max) and reinforcement (max confidence of the two + one step); the old entry gets `superseded`, `supersededBy` and an evidence ref `supersession-reason:restated (jaccard 0.83)`, the same shape `MemorySupersessionService.supersede` writes, so it is hidden from recall and kept for audit |
| `evictionIndex(knowledge)` | what a full store drops: the oldest superseded entry first, else the lowest confidence |

`AgentMemoryService.addRoleKnowledge`:

1. exact match → merge evidence into the existing entry, one confidence step, save, return the existing id (log `Merged duplicate knowledge into existing entry`);
2. store full → evict by `evictionIndex`;
3. near match → `restateKnowledge`, push the new entry, save, return the new id (log `Restated role knowledge entry` with `supersedes` and `score`);
4. else append as before.

Constants: `MEMORY_CONSTANTS.DEDUP` — `NEAR_DUPLICATE_JACCARD` 0.8, `MIN_TOKENS_FOR_NEAR` 4, `SUBSTRING_MIN_CHARS` 20.

## Threshold

Replay of the real stores, each entry checked against the entries written before it in the same store and category, numbers guard on:

| Jaccard ≥ | would merge | the band holds |
|---|---|---|
| 0.9 | 151 | id-only variants of one claim; verbatim repeats of a blocked-task note; "(1 newer)" vs "(1 newer, 1 basis invalidated)" |
| 0.8 | 166 | a re-check of the same item ("Check Lyra's fixed LinkedIn image" / "Check Lyra's re-rendered LinkedIn image"); a correction of the same assertion (the symlink case); two verify items on one ticket (CE-216 publish / fee draft) |
| 0.7 | 173 | different items in one frame start to collide: "Schedule X stops after 3 more runs" / "Schedule Y stops …"; "cover v4: Steve OK?" / "cover v6: Steve's pick?" |
| 0.6 | 201 | mostly different items |

The numbers guard alone kept 106 pairs apart that scored ≥ 0.8 on words ("Vera idle — verify CE-140" / "— verify CE-196 release", "Sweep PASS (20:00 tick)" / "(20:30 tick)", "(1 newer)" / "(6 newer)").

0.8 is the lowest value at which every sampled pair is the same item said again. The CE-216 pair shows the residual risk: two work items on one ticket written in one frame merge, and recall keeps the newer. Both are task-pool boilerplate the P0 noise filter is meant to keep out of memory.

## Not in this slice

- Judgment-based adjudication (an LLM deciding keep / modify / supersede when the texts disagree in substance); the rule here is deterministic: same text merges, same fact restated supersedes.
- Rewriting existing stores: the 166 historical restatements stay; the check runs on new writes only.
- Project knowledge (`project-memory.service.ts`) has its own dedup paths and is unchanged.

## Tests

`knowledge-similarity.test.ts` (fixtures are real shapes with shortened ids): tokenizer drops uuids, partial ids, shas and long numbers, keeps single digits, years, ticket numbers and hex-letter words; `numbersCompatible` both ways; id-only variant is near, changed count and different ticket are not; shorter restatement without a timestamp is near; containment beats near, same text beats both; superseded and expired entries never match; scope by category and tags; short texts only exact; explicit threshold; evidence union with legacy fields; importance only rises; `restateKnowledge` provenance, reinforcement, supersession refs, confidence cap; `evictionIndex` order. `agent-memory.service.test.ts` unchanged and green (its "reinforce similar" and "unique entry i … feature i*100" cases exercise the exact and the kept-apart paths). `constants.test.ts` pins the DEDUP bounds.
