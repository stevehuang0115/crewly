---
type: norm
version: 1.0.0
owner: crewly-product-quinn-47ce967d
status: active
triggers:
  - mutation check
  - verifying a test actually fails
  - proving a test guards a fix
  - reverting a fix to check coverage
---

# Norm: A Mutation Check Must Revert Against a Base Ref

## The covenant

When you prove a new test actually guards your fix — revert the fix, confirm
the test fails — **revert against a base ref, never against the working tree.**

```bash
# ✅ correct in BOTH states
git checkout <base-ref> -- <path>    # e.g. git checkout origin/main -- src/foo.ts
<run tests>                          # expect the new tests to FAIL
git checkout HEAD -- <path>          # restore

# ❌ silently conditional
git checkout <path>                  # reverts, or restores — depends on commit state
```

This is a constraint on how you verify, applied every time. It is not a
procedure to step through.

## Why `git checkout <file>` is a trap

`git checkout <file>` restores the file **from the index/HEAD**. So it means
two opposite things depending on whether your fix is committed yet:

| Fix state | `git checkout <file>` does | Mutation check is |
|---|---|---|
| Uncommitted | discards the fix → file reverts | **valid** |
| Committed | restores the fix *from HEAD* | **a silent no-op** |

In the committed state the command appears to work, the tests run, and
everything passes — because the fix was never removed. You get a green result
from a check that checked nothing.

The state flips silently in the middle of ordinary work. Committing does it.
So does rebasing. Nothing warns you.

## How I got it wrong (PR #735, 2026-08-21)

I ran the mutation check *before* committing. It worked: revert the source,
3 of the 7 new tests failed, the negative test stayed green. Correct signature,
correctly verified.

Then I rebased onto `origin/main` — which committed the fix — and re-ran the
same check with the same command. It reported **47/47 passing**, and I reported
that number to my TL as evidence the fix was still verified after the rebase.

It was not evidence of anything. `git checkout <file>` had restored the fix from
HEAD. The suite passed because the code was still there. I had produced a
verification artifact that verified nothing, and shipped it into a status report
as though it were proof.

I caught it on re-reading my own command, not from any failure signal — there is
no failure signal. Redone as `git checkout origin/main -- <file>`, the real
signature came back: 3 failed, 44 passed.

The reason this is worth a norm rather than a personal note: the failure mode is
**invisible and self-confirming**. A broken mutation check does not look broken.
It looks like a passing test suite, which is exactly what you were hoping to see.

## Companion signal: the negative test should STAY green

In a suite that includes a negative test — one asserting the *absence* of a
widening, a regression, or an over-broad gate — that test should **still pass**
when you revert the fix. It is asserting something that was already true.

So the healthy signature is mixed:

```
✕ positive test   (fix removed → capability gone → fails)
✕ positive test
✓ negative test   (asserting absence → still true → passes)
```

If your negative test *also* flips to red under revert, it was passing for the
wrong reason — it depends on the fix rather than constraining it. Investigate
before shipping.

## Applies to

Any "prove the test catches it" check: mutation checks, revert-and-rerun,
deliberately breaking a fix to confirm coverage. The same trap exists for
`git stash` (state-dependent) and for editing a file back by hand (you may
restore it imperfectly). Naming an explicit base ref is what makes the check
deterministic.
