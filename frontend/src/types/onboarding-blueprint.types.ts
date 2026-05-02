/**
 * Frontend types for the Onboarding V2.5 chat-first blueprint.
 *
 * These mirror the backend onboarding state machine described in
 * `docs/crewly-pro/68-onboarding-solution-spec-v2.md` §12.2 and are
 * consumed by the chat-thread shell + "Your AI Team Blueprint"
 * sidebar that Max owns (F1/F2). They are kept in a dedicated file —
 * separate from the legacy Magic Moment types in `onboarding.types.ts`
 * — so the two flows can evolve independently. When Sam ships the
 * canonical shared types, this module can re-export from there.
 *
 * @module types/onboarding-blueprint
 */

// =============================================================================
// Orchestrator runtime mode (B2 — Sam's W1 backend deliverable)
// =============================================================================

/**
 * The orchestrator's high-level runtime state.
 *
 * Drives whether the chat surface mounts the standard chat view
 * (`normal`), the onboarding two-pane layout (`onboarding`), or the
 * mismatch-recovery escape-hatch UI (`escape-hatch`).
 *
 * Spec ref: §3.2 Trigger Mechanism, B2 Orchestrator state machine.
 */
export type OnboardingMode = 'normal' | 'onboarding' | 'escape-hatch';

/**
 * Single-shape status payload exposed by `useOnboardingStatus()`.
 *
 * This is the contract Sam mirrors on the backend B2 state machine
 * so the W2 swap from the W1 stub to the live wire is a 1-line
 * change in the hook body — not a refactor at every call-site.
 *
 * - `mode`: required, defaults to `'normal'` until B2 says otherwise.
 * - `stage`: only meaningful when `mode === 'onboarding'`.
 * - `loading`: true while the initial fetch is pending; W1 stub
 *   always reports `false`.
 * - `error`: surfaced when the status fetch fails; W1 stub never sets.
 */
export interface OnboardingStatus {
  /** Orchestrator runtime mode. */
  mode: OnboardingMode;
  /** Conversation stage; absent when mode !== 'onboarding'. */
  stage?: OnboardingStage;
  /** True while the initial async fetch is pending. */
  loading: boolean;
  /** Human-readable error message; absent on success. */
  error?: string;
}

// =============================================================================
// Stage progression (S2 → S6)
// =============================================================================

/**
 * Conversation stage within the onboarding flow.
 *
 * Spec ref: §4 Conversation map.
 *  - S2: orc greeting (sidebar empty)
 *  - S3: discovery (business profile populates)
 *  - S4: match report (4-tier match block populates)
 *  - S5: delegation + brand (staffed workflows / guardrails / brand)
 *  - S6: provisioning (read-only, transition to normal mode)
 */
export type OnboardingStage = 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

// =============================================================================
// Business profile (D1–D6 captured fields)
// =============================================================================

/**
 * Captured discovery answers. Each field is optional because they
 * populate progressively as the user replies. Empty (`undefined`) is
 * the canonical "we haven't asked yet" signal — consumers should
 * render the empty state, not a placeholder string.
 *
 * Spec ref: §4.2 Discovery dimensions.
 */
export interface BusinessProfile {
  /** Industry / vertical the business operates in. (D1) */
  industry?: string;
  /** Target customer description. (D2) */
  customer?: string;
  /** Core repeatable workflow they want help with. (D3) */
  workflow?: string;
  /** Current pain point or bottleneck. (D4) */
  pain?: string;
  /** Tools they've already tried. (D5, optional) */
  priorTools?: string;
  /** Hard guardrails on what AI must / must not do. (D6, optional) */
  guardrails?: string;
}

// =============================================================================
// Hireable workflow descriptor (shared by Match Report and Staffed lists)
// =============================================================================

/**
 * A workflow row from doc 69 capability map. Present in both the
 * Match Report (autonomous / collaborative tiers) and the
 * Staffed Workflows block (user opted-in subset).
 *
 * Spec ref: §5.2 4-tier classification, B6 capability map.
 */
export interface HirableWorkflow {
  /** Stable workflow identifier from the cap-map. */
  workflowId: string;
  /** Human-readable workflow name. */
  name: string;
  /** Short description of what the workflow does. */
  description: string;
  /** Estimated value-add (optional, may be omitted). */
  estimatedValue?: string;
  /** Primary domain ("marketing", "sales", "ops", etc., optional). */
  domain?: string;
}

// =============================================================================
// Match Report (4-tier classification — B7)
// =============================================================================

/**
 * Match Report classification tier per spec §5.2.
 */
export type MatchTier =
  | 'autonomous'
  | 'collaborative'
  | 'roadmap'
  | 'out-of-scope';

/**
 * A roadmap entry — a workflow we plan to support but don't yet.
 */
export interface RoadmapEntry {
  /** Workflow we plan to add. */
  workflow: string;
  /** Optional ETA hint. */
  eta?: string;
}

/**
 * An out-of-scope entry — a task we cannot help with, optionally
 * with a workaround suggestion.
 */
export interface OutOfScopeEntry {
  /** The user-stated task. */
  task: string;
  /** Optional manual workaround. */
  workaround?: string;
}

/**
 * Candidate task surfaced during discovery; powers Match Report
 * generation.
 *
 * Spec ref: §5.2; B7 deterministic match algorithm.
 */
export interface CandidateTask {
  /** Raw verbatim from the user. */
  raw: string;
  /** Orc-extracted intent (normalised). */
  extractedIntent: string;
  /** Top-N matches with cosine score per B7. */
  topMatches: { workflowId: string; score: number }[];
  /** Final tier the orc landed on. */
  chosenTier: MatchTier;
}

/**
 * The 4-tier Match Report.
 *
 * Spec ref: §5.3 Match Report UX. Renders inline in chat as a card
 * (F3, W3) and as a sidebar block (F2 — this module).
 */
export interface MatchReport {
  autonomous: HirableWorkflow[];
  collaborative: HirableWorkflow[];
  roadmap: RoadmapEntry[];
  outOfScope: OutOfScopeEntry[];
}

// =============================================================================
// Brand block (F5/F6 — W4)
// =============================================================================

/**
 * Brand voice + ops captured during S5.
 *
 * Spec ref: §6 Brand & ops.
 */
export interface OnboardingBrand {
  /** 3-of-N selected voice chips. */
  voiceChips: string[];
  /** Single-select tone label. */
  tone: string;
  /** Where approval requests should land (Slack / email / etc.). */
  approvalChannel: string;
}

// =============================================================================
// Aggregate Blueprint (single source of truth for the sidebar)
// =============================================================================

/**
 * The full "Your AI Team Blueprint" — the sidebar's state.
 *
 * The sidebar rehydrates from this object; every field except `stage`
 * is optional and renders an empty-state placeholder when absent.
 *
 * Spec ref: §3 Onboarding state machine, B4 persistence, B8 live-update.
 */
export interface OnboardingBlueprint {
  /** Current conversation stage. */
  stage: OnboardingStage;
  /** Captured business profile (D1–D6). */
  businessProfile?: BusinessProfile;
  /** Candidate tasks pulled from discovery. */
  candidateTasks?: CandidateTask[];
  /** 4-tier Match Report. */
  matchReport?: MatchReport;
  /** Workflows the user opted into staffing. */
  staffedWorkflows?: HirableWorkflow[];
  /** Free-form guardrails the user supplied. */
  guardrails?: string[];
  /** Brand voice + ops snapshot. */
  brand?: OnboardingBrand;
}

// =============================================================================
// Empty-state factory (used by the W1 stub hook)
// =============================================================================

/**
 * Build an empty Blueprint stuck at stage S2. Used by tests and the
 * stub `useOnboardingBlueprint` hook in W1 before B8 server-sent
 * stream lands.
 *
 * @param overrides - Optional partial overrides (e.g. set `stage`).
 * @returns A fresh blueprint with no captured fields.
 *
 * @example
 * ```ts
 * const bp = createEmptyBlueprint({ stage: 'S3' });
 * expect(bp.stage).toBe('S3');
 * expect(bp.businessProfile).toBeUndefined();
 * ```
 */
export function createEmptyBlueprint(
  overrides: Partial<OnboardingBlueprint> = {}
): OnboardingBlueprint {
  return {
    stage: 'S2',
    ...overrides,
  };
}

/**
 * The five fixed sidebar block IDs, in render order.
 *
 * Used by the sidebar to drive `<BlueprintSidebar />` block ordering
 * and by tests to assert ordering correctness.
 */
export const BLUEPRINT_BLOCK_IDS = [
  'business-profile',
  'match-report',
  'staffed-workflows',
  'guardrails',
  'brand',
] as const;

/** Identifier for one of the five sidebar blocks. */
export type BlueprintBlockId = (typeof BLUEPRINT_BLOCK_IDS)[number];
