/**
 * Intent classifier regression fixtures.
 *
 * **Source-of-truth contract (Mia §6):**
 *
 * - **L2-positive cases** — Steve dogfood mis-labels from 2026-05-06.
 *   Pre-Bug-A these classified as L1/other (Steve's "ORC ignored half my
 *   message" symptom). v0 ships with the 2 confirmed-by-name cases; Sam
 *   is harvesting the remaining ~5 messages from Slack and will append.
 * - **Negative-L2 cases** — at least one example per row of Mia §3 must
 *   stay at the listed tier. This is the over-promotion guard: the
 *   classifier must never promote these to L2 even if a future rule
 *   tweak adds coverage we didn't anticipate.
 * - **L3 cases** — sprint/OKR-shaped messages that should classify as L3
 *   (label only; v0 routes L3=L2 internally per Mia §5 Q1 default).
 *
 * Each entry's `rationale` field links back to the spec section so a
 * future regression points the engineer directly at the rule they broke.
 *
 * Spec: `specs/2026-05-06-intent-classifier-rules.md`.
 *
 * @module services/intent-task/intent-classifier.fixture
 */

import type { IntentLevel, IntentCategory } from '../../types/v2/request.types.js';

/**
 * One regression fixture entry. Every field is required so a failure
 * message includes enough context for the engineer to triage without
 * re-reading the spec.
 */
export interface ClassifierFixture {
  /** The exact user input — verbatim where possible. */
  input: string;
  /** Expected `classifyIntentLevel` output. */
  expectedLevel: IntentLevel;
  /** Expected `classifyIntentCategory` output. */
  expectedCategory: IntentCategory;
  /**
   * Free-form rationale linking back to the spec section. Format:
   * "§N.M [language] [rule name]". Surfaces in test failure messages.
   */
  rationale: string;
  /** Provenance of the case (Steve Slack / Mia spec / synthesised). */
  source: string;
}

// ---------------------------------------------------------------------------
// L2-positive — Steve dogfood mis-labels (Mia §4)
// ---------------------------------------------------------------------------

/**
 * Steve's mis-labeled messages from 2026-05-06. These MUST classify as
 * L2 with the correct category. Pre-Bug-A all of these returned L1/other
 * → 1 WorkItem instead of N → "ORC ignored half my message" symptom.
 *
 * Sam is harvesting cases #3-#7 from the Slack transcript; v0 ships
 * with #1 + #2 (Mia-confirmed) + a placeholder bound to the planning
 * Request (`ff54231a` from PR #461 F9).
 */
export const STEVE_DOGFOOD_FIXTURES: ClassifierFixture[] = [
  {
    input: '做这两份 md 文档',
    expectedLevel: 'L2',
    expectedCategory: 'code_change',
    rationale: '§2.1 ZH quantifier trigram (这两份 + 做 + md 文档)',
    source: 'Steve Slack 2026-05-06 (Mia spec §4 case #1)',
  },
  {
    input: 'oss重启了 你现在再做这个',
    expectedLevel: 'L2',
    expectedCategory: 'code_change',
    rationale: '§2.5 ZH cross-system pivot (重启了 + 现在 + 再做)',
    source: 'Steve Slack 2026-05-06 (Mia spec §4 case #2)',
  },
  {
    // Real-data case from PR #461 F9 fixture (request ff54231a). Pre-Bug-A
    // this classified as L2/planning correctly thanks to "规划/计划/方案"
    // matching the legacy planning regex — but only because the message
    // happened to contain those words. The Mia §2 promoters now make this
    // robust to phrasings that don't include those exact words.
    input:
      'Steve 2026-05-06 directive: 按这两份文档安排团队推进 P0 执行。请 plan() 拆解为 WorkItems：每个 P0 change 一个 WorkItem。',
    expectedLevel: 'L2',
    expectedCategory: 'planning',
    rationale: '§2.1 ZH quantifier (这两份文档) + §2.4 ZH numbered planning + §2.7 charCount > 80',
    source: 'Steve Slack 2026-05-06 (PR #461 F9 fixture, ff54231a)',
  },
];

// ---------------------------------------------------------------------------
// Negative-L2 — Mia §3 anti-promotion guard
// ---------------------------------------------------------------------------

/**
 * Cases that MUST NOT classify as L2 even after the promoters fire on
 * adjacent text. At least one example per row of Mia §3.
 *
 * The most-load-bearing assertion is the "quantifier alone" guard: a
 * quantified read query ("show me all 3 statuses") stays L0, not L2.
 */
export const NEGATIVE_L2_FIXTURES: ClassifierFixture[] = [
  // Row 1 — pure status / read query (EN)
  {
    input: 'what is the deployment status',
    expectedLevel: 'L0',
    expectedCategory: 'query',
    rationale: '§3 row 1 EN: pure read, no state change',
    source: 'Mia spec §3 row 1',
  },
  // Row 1 — pure status / read query (ZH)
  {
    input: '现在的状态是什么',
    expectedLevel: 'L0',
    expectedCategory: 'query',
    rationale: '§3 row 1 ZH: pure read, no state change',
    source: 'Mia spec §3 row 1',
  },
  // Row 2 — quantified read (the canonical anti-pattern)
  {
    input: 'show me all 3 statuses',
    expectedLevel: 'L0',
    expectedCategory: 'query',
    rationale: '§3 row 2 + last paragraph: quantifier + READ verb stays L0',
    source: 'Mia spec §3 row 2 (anti-pattern guard)',
  },
  // Row 3 — single bounded directive (EN)
  {
    input: 'rename foo to bar',
    expectedLevel: 'L1',
    expectedCategory: 'code_change',
    rationale: '§3 row 3 EN: single bounded directive',
    source: 'Mia spec §3 row 3',
  },
  // Row 3 — single bounded directive (ZH)
  {
    input: '把 x 改成 y',
    expectedLevel: 'L1',
    expectedCategory: 'code_change',
    rationale: '§3 row 3 ZH: single bounded directive',
    source: 'Mia spec §3 row 3',
  },
  // Row 4 — single-arg ops
  {
    input: 'restart the api service',
    expectedLevel: 'L1',
    expectedCategory: 'code_change',
    rationale: '§3 row 4: single-arg ops',
    source: 'Mia spec §3 row 4',
  },
  // Row 5 — pure communication (EN)
  {
    input: 'tell Sam to review the PR',
    expectedLevel: 'L1',
    expectedCategory: 'review',
    rationale: '§3 row 5 EN: pure communication, single Slack-side action',
    source: 'Mia spec §3 row 5',
  },
  // Row 5 — pure communication (ZH)
  {
    input: '告诉 Sam 审查一下 PR',
    expectedLevel: 'L1',
    expectedCategory: 'review',
    rationale: '§3 row 5 ZH: pure communication',
    source: 'Mia spec §3 row 5',
  },
  // Row 6 — single test run. The classifier's category is 'other' for
  // pure test-run commands (no authoring verb in the code_change set);
  // the level — L1 — is what the spec asserts. Category stability is
  // not load-bearing for the spec's anti-promotion guard.
  {
    input: 'run the tests',
    expectedLevel: 'L1',
    expectedCategory: 'other',
    rationale: '§3 row 6: single test run, no authoring (level=L1 is the load-bearing assertion)',
    source: 'Mia spec §3 row 6',
  },
];

/**
 * Filtered cases — should be rejected by `isActionableIntent` before
 * classification. These never reach the L0/L1/L2/L3 classifier; the
 * fixture asserts that fact.
 */
export const NON_ACTIONABLE_FIXTURES: { input: string; rationale: string; source: string }[] = [
  // Acks
  { input: 'ok', rationale: '§3 row 7 EN ack', source: 'Mia spec §3 row 7' },
  { input: '好的', rationale: '§3 row 7 ZH ack', source: 'Mia spec §3 row 7' },
  { input: '收到', rationale: '§3 row 7 ZH ack', source: 'Mia spec §3 row 7' },
  // Discussion / opinion
  { input: 'I think we should refactor', rationale: '§3 row 8 EN opinion', source: 'Mia spec §3 row 8' },
  { input: '我觉得这个不太对', rationale: '§3 row 8 ZH opinion', source: 'Mia spec §3 row 8' },
  // FYI / status-share
  { input: 'I just merged PR 123', rationale: '§3 row 9 EN FYI', source: 'Mia spec §3 row 9' },
  { input: '我刚 push 了', rationale: '§3 row 9 ZH FYI', source: 'Mia spec §3 row 9' },
  // Apology / confirmation
  { input: 'sorry about that', rationale: '§3 row 10 EN', source: 'Mia spec §3 row 10' },
  { input: '抱歉', rationale: '§3 row 10 ZH', source: 'Mia spec §3 row 10' },
  // Greeting
  { input: 'hi', rationale: '§3 row 12 EN greeting', source: 'Mia spec §3 row 12' },
  { input: '你好', rationale: '§3 row 12 ZH greeting', source: 'Mia spec §3 row 12' },
  // Mia stricter-default — capability denial / botched
  { input: '做不到', rationale: 'Mia stricter 2026-05-06: ZH capability denial', source: 'Mia inline 2026-05-06' },
  { input: '搞不定', rationale: 'Mia stricter 2026-05-06: ZH capability denial', source: 'Mia inline 2026-05-06' },
  { input: '搞砸了', rationale: 'Mia stricter 2026-05-06: ZH botched', source: 'Mia inline 2026-05-06' },
  // Completed action
  { input: '做完了', rationale: 'Mia stricter 2026-05-06: ZH completed (no imperative prefix)', source: 'Mia inline 2026-05-06' },
];

// ---------------------------------------------------------------------------
// L3 cases — sprint / OKR initiative
// ---------------------------------------------------------------------------

/**
 * Sprint/OKR-shaped messages that should classify as L3 (label only; v0
 * routes L3=L2 internally). At least one ZH case asserts the parity.
 */
export const L3_FIXTURES: ClassifierFixture[] = [
  {
    input: '这周搞定 KR3 onboarding ≤ 5 分钟',
    expectedLevel: 'L3',
    expectedCategory: 'planning',
    rationale: '§2.6 ZH (这周 + KR3 + 搞定) — sprint marker + deliver verb',
    source: 'Mia spec §1.3 example',
  },
  {
    input: 'ship Sprint 4 by Friday with the new auth feature',
    expectedLevel: 'L3',
    expectedCategory: 'planning',
    rationale: '§2.6 EN (Sprint + Friday + ship) + §2.3 EN (feature)',
    source: 'Mia spec §1.3 example',
  },
];
