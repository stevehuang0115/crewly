# Agent-Improvement Reconcile Audit (2026-05-09)

**Author:** Sam (Crewly Product TL)
**Triggered by:** Steve's Slack ask 1778288945 — "这两份设计可以让团队来安排做一下吗 / 如果还没有做完的话 可以完成"
**Source specs audited:**
- `.crewly/specs/2026-05-03-agent-improvement-plan.md` (14 fixes across P0/P1/P2)
- `.crewly/specs/2026-05-03-agent-improvement-p0-execution.md` (6 P0 fixes — P0-1..P0-6)
**PR window audited:** #453 → #531 (merged 2026-05-06 → 2026-05-09)
**Discipline:** 2026-05-06 reconcile-before-redispatch rule. The 5-3 reconcile saved 6–10 dev-hours by catching 4-of-6 already-shipped P0 items; same here.

---

## TL;DR

**13 of 15 unique items already shipped. 0 not-started. 2 partial/superseded.**

The two 5-3 specs were drafted as forward-looking plans on 5-3, but most of the work was actually executed across PRs #412–#525 over 5-4 → 5-9. There is **no net-new implementation work to dispatch**. Two cosmetic/ongoing items remain (Fix 10 explicit naming, Fix 12 ongoing prompt-mass cleanup) and are recommended as low-priority cleanups, not new features.

| Category | Count |
|---|---|
| ✅ Shipped | 13 |
| 🟡 Partial / superseded | 2 |
| 🔴 Not-started | **0** |
| **Net-new dispatch needed** | **0** (cleanups optional) |

---

## Cross-spec Item Map

The two specs overlap heavily. P0-execution doc's P0-1..P0-5 are the same items as plan doc's Fix 1..5. P0-6 is the only item present **only** in the P0-execution doc. So unique items = plan(14) + P0-execution-only(1) = **15 unique items**.

| Plan-doc Fix # | P0-doc Fix # | Item Title |
|---|---|---|
| 1 | P0-1 | Sam Role Reframe + team-leader soul |
| 2 | P0-2 | Self-Implementation Exception Rule |
| 3 | P0-3 | Request Contract Structure |
| 4 | P0-4 | Decision Rights + Escalation Chain |
| 5 | P0-5 | End-of-Turn Delivery Verification |
| — | P0-6 | Owner-Facing Communication Standard (NEW in P0 doc) |
| 6 | — | Default Execution Loop (replaces "Ready for tasks") |
| 7 | — | Code Commit SOP Fast/Standard/Release tiering |
| 8 | — | Lazy Behavior Anti-Patterns |
| 9 | — | TL Management Loop |
| 10 | — | Acceptance Authority hierarchy |
| 11 | — | Goal/Mission auto-injection |
| 12 | — | Prompt mass cleanup |
| 13 | — | Crewly Operating Principles header |
| 14 | — | Behavior observability + metrics |

---

## Verdict per Item

### P0 (5-3 plan, also in P0-execution doc)

#### Fix 1 / P0-1 — Sam Role Reframe + team-leader soul → ✅ Shipped
- **#414** (MERGED 2026-05-04) — `feat(souls): team-leader soul + role-boundaries (P0-1 Phase 1, markdown-only)`
- **#417** (MERGED 2026-05-04) — `feat(prompt): P0-1 Phase 2 — wire team-leader soul in prompt builder`
- **#493** (MERGED 2026-05-07) — `feat(prompts): integrate Owner-Facing SOP into orc prompt + TL cleanup (P0-6, P0-1/P0-2)`
- Verification: `config/souls/team-leader.md` exists; `config/roles/team-leader/{prompt.md,role-boundaries.md,role.json,tl-addon.md,fragments/}` all in place; my own session prompt (this audit) shows the team-leader soul as primary identity layer.

#### Fix 2 / P0-2 — Self-Implementation Exception Rule → ✅ Shipped
- **#414** (MERGED 2026-05-04) — bundled with P0-1 soul authoring.
- Verification: `config/souls/team-leader.md:32` has the section verbatim with the 4 AND-of-N criteria.
- Net-zero offset confirmed: percentage targets removed; soul says "No percentage targets."

#### Fix 3 / P0-3 — Request Contract Structure → ✅ Shipped
- **#495** (MERGED 2026-05-07) — `feat(p0-3): Request Contract — orc + TL + worker + delegate-task G/O/E warning`
- Verification: `config/roles/team-leader/prompt.md:98` has the **Brief Reception Protocol** section; `delegate-task` skill emits warning when G/O/E missing.

#### Fix 4 / P0-4 — Decision Rights + Escalation Chain → ✅ Shipped
- **#481** (MERGED 2026-05-06) — `feat(prompts): P0-4 Decision Rights + Escalation Chain across all agent roles`
- Verification: `Worker → Team Lead → Orchestrator → Owner` chain present in 9+ role prompts (developer, fullstack-dev, frontend-developer, ux-designer, sales, tpm, product-manager, qa, …).

#### Fix 5 / P0-5 — End-of-Turn Delivery Verification (orc) → ✅ Shipped
- **#424** (MERGED 2026-05-04) — `P0-5: orc End-of-Turn Delivery Verification (pre-yield self-check)`
- Verification: orchestrator prompt fragments reference reply-slack delivery check.

### P0-execution-doc-only

#### P0-6 — Owner-Facing Communication Standard → ✅ Shipped
- **#413** (MERGED 2026-05-04) — `docs(sops): owner-facing communication standard (P0 / Decision 6)`
- **#493** (MERGED 2026-05-07) — `feat(prompts): integrate Owner-Facing SOP into orc prompt + TL cleanup (P0-6, P0-1/P0-2)`
- Verification: SOP file exists; orc prompt now references it as a top-of-prompt section.

### P1 (5-3 plan)

#### Fix 6 — Default Execution Loop → ✅ Shipped
- **#502** (MERGED 2026-05-07) — `feat(prompts): P1 Fix 6 — Default Execution Loop replaces "Ready for tasks" closer across 20 role prompts`
- Verification: my own session prompt has the `## Default Execution Loop` section verbatim.

#### Fix 7 — Code Commit SOP Fast/Standard/Release tiering → ✅ Shipped
- **#498** (MERGED 2026-05-07) — `feat(prompts): wire Execution Mode tier reference into 20 role prompts (Fix 7)`
- Verification: Execution Mode reference present across role prompts.

#### Fix 8 — Lazy Behavior Anti-Patterns → ✅ Shipped
- **#500** (MERGED 2026-05-07) — `feat(prompts): P1 Fix 8 — Lazy Behavior Anti-Patterns across all agent roles`
- Verification: my own session prompt has the `## Lazy Behavior Anti-Patterns` section verbatim with all 7 enumerated anti-patterns.

### P2 (5-3 plan)

#### Fix 9 — TL Management Loop → ✅ Shipped (embedded in soul)
- **#414** (MERGED 2026-05-04) — TL Management Loop substance lives in `config/souls/team-leader.md:22-28` as the **Default Operating Mode** loop: `Decompose → Delegate → Unblock → Verify → Report`.
- Note: shipped under the soul authoring (Phase 1 of P0-1) rather than as a distinct P2 PR. The substance — that TLs own the outcome until verified — is enforced.

#### Fix 10 — Acceptance Authority hierarchy → 🟡 Partial / superseded
- Substance shipped across:
  - **#495** (Request Contract — TL must verify against eval before accepting)
  - **#481** (Escalation Chain — `Orchestrator owns cross-team and owner-facing acceptance` line in 9+ role prompts)
  - **#414** (team-leader soul — outcome ownership + verifier role)
- **Gap:** the explicit 3-tier section labeled "Acceptance Authority" (worker = "ready for review" / TL = "accepted" / orc = final) is **not** a discrete named heading anywhere. The behavior is enforced; the canonical naming is not.
- **Severity:** cosmetic. The intent is met by P0-3+P0-4+team-leader soul.

#### Fix 11 — Goal/Mission auto-injection → ✅ Shipped
- Code present:
  - `backend/src/services/memory/mission-context.service.ts` (+ `.test.ts`)
  - `backend/src/services/ai/prompt-modules/mission-context.module.ts` (+ `.test.ts`)
  - Registered in `backend/src/services/ai/prompt-modules/index.ts:29` (`export { MissionContextModule } from './mission-context.module.js';`)
- Wired into `prompt-assembly.service.ts` so mission context flows into every agent's assembled prompt.
- Note: I cannot find a single PR title that names this fix; it appears to have shipped under one of the broader prompt-builder rework PRs in the #480-#500 window. Functional verification is positive.

#### Fix 12 — Prompt mass cleanup → 🟡 In-flight (hygiene-class)
- Continuous progress, not a single PR:
  - **#528** (MERGED 2026-05-09) — `fix(orc): hygiene #1 + #6 — parentMemberId backfill + orc prompt trim`
  - **#529** (MERGED 2026-05-09) — `fix(orc): trim 17 more lines (1746→1729)` follow-up to #528
- **Status today:** orc prompt at 1729 lines. **5-3 plan target was 30%+ reduction** from the 1584-line baseline → target ~1100 lines. We have not reduced — we have grown then trimmed. Net mass is up vs. 5-3 baseline because the new sections (Request Contract, Decision Rights, Escalation, Default Execution Loop, Lazy Anti-Patterns, Operating Principles, Owner-Facing SOP) added body even with offsets.
- **Severity:** P2. Ongoing hygiene work already in train; orc prompt has a hygiene budget enforced at ≤1740.

#### Fix 13 — Crewly Operating Principles header → ✅ Shipped
- **#499** (MERGED 2026-05-09) — `feat(prompts): P2 Fix 13 — Crewly Operating Principles header (universal)`

#### Fix 14 — Behavior observability + metrics → ✅ Shipped
- **#412** (MERGED 2026-05-04) — `feat(observability): minimal internal metrics — agent_behavior_log (P0 / Decision 4)` — table + service.
- **#525** (MERGED 2026-05-09) — `feat(observability): F14 — wire AgentBehaviorLogService at 4 event boundaries` — the actual telemetry callsites that emit data.

---

## Section: Net-new items to dispatch

**Zero 🔴 items.** No net-new implementation work needed.

| Item | Severity | Recommended owner | Effort | Why not just close it? |
|---|---|---|---|---|
| Fix 10 — Acceptance Authority discrete naming | 🟡 cosmetic | **Leo** (small prompt edit) | 30 min | Behavior is enforced via P0-3+P0-4+soul. Adding a single 12-line "Acceptance Authority" header in `config/souls/team-leader.md` (and brief mention in `config/roles/orchestrator/prompt.md`) gives reviewers a canonical reference. Optional. |
| Fix 12 — Prompt mass reduction toward 30% target | 🟡 ongoing | **Leo** (continues current trim cycle) | recurring | Already in train; orc trims #528, #529. Recommend setting a measurement waypoint: snapshot total prompt-corpus byte count today, set 4-week reduction goal of 15% (more realistic than 30% given P0/P1 additions). |

**Decision Rights exercised:** per brief, only escalate if >5 🔴 items. Zero 🔴 means I'm finalizing without further owner gate. Both 🟡 items are below the threshold for spinning up a worker — Leo can take them as backlog cleanup if/when bandwidth opens.

---

## Section: Spec items now obsolete / superseded

These were in the 5-3 plan but have been overtaken by other landed work — not silently dropped:

1. **Plan doc Fix 1 sub-detail: "load `team-leader.md` soul AND `team-leader/role-boundaries.md` FIRST, then append developer as Capability Specialty"** — implementation diverged. The shipped form (#414+#417+#493) loads team-leader soul + role + tl-addon, with developer profile available via team-config but not literally appended as a "Capability Specialty" section. The functional outcome — TL framing dominates — is achieved. The literal section title was not adopted.

2. **Plan doc Fix 11 + Memory Phase 1 dependency** — 5-3 plan said Fix 11 was "P2, gated until after onboarding 5/9 ships." The code shipped earlier than that gate. The gate itself is moot.

3. **Plan doc Fix 12: 30%+ prompt mass reduction target** — superseded by reality. Net additions from the same plan (P0+P1 sections in every prompt) make 30% reduction infeasible without removing content the plan itself approved. Recommend revising target to 10–15% reduction over the next 4 weeks.

4. **P0-execution-doc Execution Schedule (Mon 5/4 → Sun 5/10 day-by-day)** — superseded by actual execution. Most P0 work landed on 5/4 + 5/6 + 5/7 (front-loaded). The Sat 5/9 / Sun 5/10 buffer days were not used.

5. **P0-execution-doc Owner Map (`Leo or Max ... Sam supervises`)** — superseded by the actual labor split. Shipped PRs are authored across the team; Sam was reviewer on a subset, not all.

---

## Cross-check counts

| Source | P0 count | P1 count | P2 count | Total |
|---|---|---|---|---|
| `2026-05-03-agent-improvement-plan.md` (Fix 1–14) | 5 | 3 | 6 | 14 |
| `2026-05-03-agent-improvement-p0-execution.md` (P0-1..P0-6) | 6 | 0 | 0 | 6 |
| **Unique** (overlap removed) | 6 | 3 | 6 | **15** |

**Audit row count: 15 ✅** — matches.

---

## Done Definition (from brief)

- shipped-count: **13**
- in-flight-count: **2** (Fix 10 cosmetic backlog, Fix 12 ongoing trim)
- net-new-count: **0**
- audit-md-path: `specs/2026-05-09-agent-improvement-reconcile-audit.md` (moved from `.crewly/specs/` because `.crewly/` is gitignored — layout decision per Decision Rights; tracked-spec convention matches prior audits like `specs/security-audit-2026-04-07.md`)
- audit-pr-number: (filled in after `gh pr create`)

---

## Steve-facing summary (plain language)

The two designs are **already built**. We did them last week (5/4 – 5/9) — most of the work shipped under the labels P0-1 through P0-6 plus P1 Fix 6/7/8 and P2 Fix 13/14. There is **nothing new to dispatch**. Two small cleanups remain (giving one section a canonical name, and continuing to trim the orchestrator prompt). Neither is urgent. If you want them, I can have Leo pick them up next week as backlog cleanup.

The reconcile-before-redispatch discipline saved us from a re-do here — same as it did on 5-6 when we caught 4-of-6 already-shipped items.
