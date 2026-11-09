# Rule metadata: prevents / seenOn / reviewBy (crewly#877)

**Status:** shipped 2026-10-23. **Check:** `npm run check:rule-metadata`
(`backend/src/scripts/check-rule-metadata.ts`, also run by its jest suite against the real tree).

## Why

Role prompts, SOPs and norms are accumulated rules. None recorded which failure they fix or on
which model it was seen, so nothing could ever be removed with confidence — and rules written for
one model over-constrain the next ("in the limit, CLAUDE.md goes away"; add rules only for repeated
failures).

## The fields (SOP frontmatter)

| Field | Meaning |
|---|---|
| `prevents` | The concrete failure the rule stops. `none recorded …` when the rule was never tied to one — those are the first candidates for removal. |
| `seenOn` | The model / harness where the failure was seen (`unknown` when not recorded). |
| `reviewBy` | `YYYY-MM-DD`. By this date the rule is re-tested (below) and either kept with a new date or deleted. |
| `source` | Optional: the issue, PR or commit that documents the failure. |

The check passes when ≥ 80% of SOPs carry all three well-formed fields; rules with no recorded
failure and overdue reviews are listed as notes (the cleanup's work list), never as errors. A file
without frontmatter is reported as skipped (the SOP loader ignores it too).

## The review (when `reviewBy` passes or the model changes)

1. Pick the overdue rules (`npm run check:rule-metadata` lists them).
2. For a sample of tasks the rule would apply to, run with the rule switched off (remove it from the
   SOP set for those tasks) and with it on; compare the outcomes the rule claims to prevent.
3. Delete the rules that make no difference; for the rest record what the comparison showed in
   `prevents` and set a new `reviewBy`.
4. The cleanup's result (how many removed, the comparison behind each) goes in the PR body.

## Coverage today

13 SOPs carry the fields. 3 record a concrete failure (#411, #413, #427). 10 record none: the two
from #1277 were adopted from mattpocock/skills without an incident behind them, and 8 are the
original default library (2026-01-29), marked `none recorded` with `reviewBy: 2026-12-31`.
`config/sops/xhs-requirement-log.v1.md` has no frontmatter and is reported as skipped.
