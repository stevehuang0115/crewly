---
id: common-dev-process-tiers
version: 1
createdAt: 2026-05-03T00:00:00Z
updatedAt: 2026-05-03T00:00:00Z
createdBy: leo
role: all
category: process
priority: 9
title: Development Process Tiers
description: Pick the right development rigor for the work — Fast, Standard, or Release Path — based on customer-facing risk, reversibility, and audience.
triggers:
  - which tier
  - dev process
  - process tier
  - fast path
  - release path
  - rigor
  - tiering
  - greenfield
  - customer-facing
tags:
  - process
  - delivery
  - quality
  - tiering
---

# Development Process Tiers

Crewly delivery uses three tiers. Pick a tier per task — not per repo, not per agent. The tier decides how much rigor (tests, review, gates, docs) the work requires.

**Hard rule:** Default to the higher tier when in doubt. It is cheaper to over-rigor a 30-minute task than to under-rigor a customer-facing change.

---

## Decision matrix (use this to pick a tier)

| Question | Yes → at least Standard | Yes → Release Path |
|---|---|---|
| Touches a customer-facing surface (UI, public API, marketing site, billing, auth)? | ✅ |  |
| Touches data persistence (schema, migration, durable storage)? | ✅ |  |
| Touches money, security, identity, or compliance? |  | ✅ |
| Reversible without user-visible impact within minutes? | (No → at least Standard) |  |
| Cuts a public release (npm publish, docker tag, web deploy to crewlyai.com)? |  | ✅ |
| Greenfield internal exploration / spike / prototype? | (No → use Fast) |  |
| Internal tooling / agent prompt / SOP / dev-only script? | (Often Fast is correct) |  |

**Default selection rule:**
- Greenfield internal work, prototypes, internal tooling → **Fast**
- Customer-facing OR persistence OR shared infra → **Standard**
- Money / security / identity / compliance / public release cut → **Release Path**

If two rules disagree, the higher tier wins.

---

## Tier 1 — Fast Path

**Purpose:** Rapid iteration on internal-only or exploratory work where the cost of being wrong is low and the work can be unwound quickly.

**Use when:**
- Greenfield prototype or spike (no users yet).
- Internal tooling (CLI flags, dev scripts, debug overlays).
- Agent prompt / SOP / role-config tweak with rollback by file revert.
- Internal dashboard or admin-only view.

**Required:**
1. Build green (`npm run build`).
2. Tests for new logic that has branching behavior. Trivial config / prompt changes need at least one rendering / parse test.
3. One reviewer (any teammate, async OK) — TL waiver allowed for solo-owned modules.
4. PR description states **why** in plain language.

**Skipped vs Standard:**
- No mandatory integration test.
- No mandatory eval criteria pre-write — eval can be implicit ("does it run, does it not crash").
- No release notes / CHANGELOG entry needed.
- No staged rollout.

**Typical merge latency:** Same-day. Self-merge after one approval.

---

## Tier 2 — Standard Path

**Purpose:** The default tier for any work that touches a customer-facing surface, durable data, or shared infrastructure. Most product work lives here.

**Use when:**
- Customer-facing UI change (Crewly Cloud, web portal, desktop app).
- Public API behavior change (request/response shape, status codes, headers).
- Database schema change or migration.
- Shared service / library used by more than one component.
- Bug fix that affects user behavior.

**Required:**
1. Build green AND `npm run typecheck` AND `npm run lint`.
2. Tests at unit + integration level. 1:1 source-to-test ratio (per `crewly/CLAUDE.md`).
3. Eval criteria in PR description (testable list — how we know this is good enough).
4. One TL or senior reviewer + one peer reviewer.
5. CHANGELOG entry if user-visible.
6. Manual smoke test of the changed flow before merge.
7. Rollback plan stated in PR description (how to revert + what data state requires fixup).

**Skipped vs Release Path:**
- No staged rollout (merge-and-deploy together).
- No formal security review unless `category: security`.
- No marketing / pricing / docs sign-off.

**Typical merge latency:** 1–2 days. Reviewer acceptance gates merge.

---

## Tier 3 — Release Path

**Purpose:** Cuts a public release or touches money / security / identity / compliance. Mistakes are expensive — pricing miscalculations, data loss, account takeover, license bypass.

**Use when:**
- Cutting a public release (npm publish, docker image promote, crewlyai.com deploy, desktop installer).
- Stripe / billing / pricing logic.
- Authentication, authorization, license verification, JWT / OAuth flows.
- PII / customer data handling, encryption, key management.
- Compliance-relevant change (GDPR, SOC, retention policies).

**Required (everything in Standard, plus):**
1. **Eval criteria written and approved BEFORE coding starts.** TL signs off the eval.
2. **Two TL-or-higher reviewers**, one of whom must be different team if cross-team impact.
3. **Pre-publish verification SOP** (`config/sops/developer/git-workflow.md` Code Commit SOP) — 9-step / 3-review-round flow is mandatory.
4. **Staged rollout** — internal flag, then 10%, then 100%, with abort criteria documented.
5. **Smoke tests on staging environment** before production cut.
6. **Owner approval of release notes / pricing copy / customer messaging.** No silent change to anything customer-visible.
7. **Rollback rehearsal** — verify the rollback path works on staging before production cut.
8. **Post-deploy monitoring window** (4 hours minimum) with named on-call.

**Typical merge latency:** 3–5 days. No same-day cuts unless explicit owner override for a P0 hotfix (which itself follows the security-hotfix branch pattern).

---

## How to declare your tier

In every PR description, include:

```markdown
**Tier:** Fast | Standard | Release Path
**Why this tier:** <one sentence — which rule above applied>
```

A reviewer who disagrees with the tier choice can block the PR with a re-tier comment. If TL flips the tier from Fast → Standard, the author MUST add the missing tier-2 deliverables before merge.

---

## When tier is ambiguous

Ask the TL. Do not default downward. The TL's call is final unless owner overrides.

Common ambiguity examples and their resolution:

| Case | Tier | Reason |
|---|---|---|
| Internal SOP doc that gets loaded into agent prompts | Standard | Affects every agent's behavior; rollback is per-file but blast radius is wide. |
| Adding a new agent role used only by one team | Fast | Greenfield, scoped to that team. |
| Bumping a public npm package version | Release Path | Public release cut. |
| Changing a CLI flag default | Standard | User-visible behavior change. |
| Refactor that is pure type-level with no runtime effect | Fast | Reversible, no user impact. |
| Adding a new column to an existing migration | Release Path | Schema + data persistence. |

---

## Anti-patterns

- Picking Fast because "the change is small." Size is not tier. Risk and audience are tier.
- Picking Standard to avoid the Release Path checklist on a billing change. Billing is always Release Path.
- Picking Release Path to look thorough on an internal prototype. Over-rigor blocks the team.
- Splitting one Release Path change across multiple Fast PRs to dodge review. Reviewers will reject and re-tier.

---

## See also

- `config/sops/developer/git-workflow.md` — Code Commit SOP, branch naming, worktrees
- `config/sops/developer/coding-standards.md` — language-level standards
- `config/sops/common/blocker-handling.md` — when stuck, escalate
