---
type: norm
version: 1.0.0
owner: crewly-product-quinn-47ce967d
status: active
triggers:
  - writing a guard
  - reviewing a check
  - test reports pass
  - verifying a fix
---

# Norm: A Guard Must Report What It Examined, Not Just Its Verdict

## The covenant

Every check — test, guard, lint, audit, safety gate — must report **what it looked at**, not
only whether it passed. Concretely:

- Emit a **count of items examined**: `0 symlink(s) checked`, `3 file(s) checked`, `12 callsites scanned`.
- **Refuse to report success when that count is zero.** An empty input set is an unknown result, not a pass.
- If coverage is structurally limited, say so **in the output**, not only in the docs.

And the reviewer half, which costs nothing:

> **When a check reports clean, ask what it looked at before believing it.**

This is a constraint on how you build and read checks. It is not a procedure to step through.

## Why: a passing check and a check that ran on nothing look identical

On 2026-08-21 this happened **seven times in one day**, across three engineers and a team lead.
That frequency is the point. It is not carelessness — it is a property of how checks are built.

A guard reports a verdict. A verdict is one bit. One bit cannot distinguish
*"I examined 40 things and they were fine"* from *"I examined nothing."*
Both render as green. Nothing fails. Nobody looks.

## The concrete trap (both halves are needed, neither is obviously wrong)

A worktree-safety check declared an **unmerged** worktree safe to delete. Deleting it would
have destroyed unmerged work. It was built from two reasonable-looking pieces:

**Half 1 — this environment runs zsh, which does not word-split unquoted parameters.**

```
zsh -c  'FILES="a\nb\nc"; for f in $FILES; do n=$((n+1)); done'   -> 1 iteration
bash -c 'FILES="a\nb\nc"; for f in $FILES; do n=$((n+1)); done'   -> 3 iterations
```

Verified on this host: `SHELL=/bin/zsh`, `ZSH_VERSION=5.9`, `BASH_VERSION` unset. So
`for f in $FILES` ran **once**, with `$f` set to the entire multi-line string.

(The same behaviour explains a separate oddity: `grep --include=*.ts` fails with
`no matches found` because zsh globs the unquoted pattern. Quote it: `--include="*.ts"`.)

**Half 2 — git reports "no differences" for a pathspec that matches nothing.**

```
git diff --quiet HEAD -- "definitely-not-a-real-path"   -> exit 0
```

Exit 0 means *no differences*. A pathspec matching nothing is **indistinguishable** from a
pathspec whose files are unchanged.

Compose them and the check examined nothing and reported clean. Neither half is a bug on its
own. That is what makes this class hard to review your way out of.

**Portable fix, and the shape to copy:**

```bash
CHECKED=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  CHECKED=$((CHECKED+1))
  ...
done < <(command_producing_lines)

if [ "$CHECKED" -eq 0 ]; then
  echo "NO ITEMS CHECKED — refusing to report success"; exit 1
fi
echo "$CHECKED item(s) checked"
```

## The seven

Listed plainly, including the team lead's, because a norm that only records the workers'
mistakes reads as blame. One that includes everyone's reads as physics.

1. **Mutation check that restored instead of reverting.** `git checkout HEAD -- <path>` restores
   from HEAD, so with an *uncommitted* fix it puts the fix back rather than removing it. Reported
   47/47 from a check that verified nothing. (See `norm-mutation-check-base-ref`.)
2. **A contract test asserting specific fields.** It could not catch a field nobody knew existed —
   you cannot write an assertion for an unknown. Fixed by a key-*subset* assertion, which fails the
   whole class instead of one field at a time.
3. **The worktree-safety check above.** Examined nothing; declared unmerged work safe to delete.
4. **A dangling-symlink guard.** Would have had the same hole had it not printed
   `N symlink(s) checked` — green over an empty set.
5. **A strict value-drift scanner.** Zero false positives, but structurally limited recall, so its
   silence is not evidence of no drift. A clean report from a low-recall tool means very little.
6. **A stale-build guard** that would have emitted WARN where everyone assumed FAIL. Disclosed by
   its own author.
7. **A team lead reporting "4 conflicts"** that were 4 changed-in-both lines — the thing claimed to
   be counted was never counted. Self-disclosed.

Six of the seven were caught by the person who made them, usually by checking a claim against
reality rather than by being careful. That is the practice this norm is trying to make routine.

## Applies to

Any check whose output is consumed as evidence: unit and contract tests, mutation checks, CI gates,
static scanners, safety checks before a destructive operation (deleting worktrees or branches,
force-pushing, dropping data), and audit scripts. Especially anything whose input set is computed
rather than fixed — a computed set can be empty, and an empty set is where this bug lives.
