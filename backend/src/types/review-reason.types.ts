/**
 * ReviewReason — discriminator for `type: 'review'` WorkItems.
 *
 * Surfaces on the review WorkItem's `metadata.reviewReason` so the TL queue
 * can render context-appropriate UI (red badge on `off_track_kr`, neutral
 * badge on `scheduled_review`, escalation banner on `max_retries_exceeded`).
 *
 * The type was extracted out of `mission-reminder.service.ts` (REVIEW-1)
 * once a second producer (BRIDGE-1) needed to tag review WorkItems with
 * reasons it owns (`max_retries_exceeded`, `task_blocked`). Co-locating the
 * vocabulary at the type layer keeps both producers honest about which
 * reasons exist and avoids per-call-site string drift.
 *
 * @module types/review-reason
 */

/**
 * Why a `type: 'review'` WorkItem was created.
 *
 * Producers:
 * - {@link MissionReminderService} (REVIEW-1) emits the cadence-driven set
 *   (`scheduled_review`, `off_track_kr`, `no_active_work`, `phase_complete`).
 * - {@link EventToWorkItemBridge} (BRIDGE-1) emits the escalation set
 *   (`max_retries_exceeded`, `task_blocked`).
 */
export type ReviewReason =
  /** Cadence boundary fired without a more-actionable signal. Default REVIEW-1 reason. */
  | 'scheduled_review'
  /** At least one Mission KR is reported off-track. */
  | 'off_track_kr'
  /** Mission has no active project tasks (parked / waiting on plan refresh). */
  | 'no_active_work'
  /** Mission's `currentPhase` advanced since the last review (heuristic). */
  | 'phase_complete'
  /** BRIDGE-1 V2: source WorkItem rejected `>=` DEFAULT_MAX_RETRIES times. Escalates to TL. */
  | 'max_retries_exceeded'
  /** BRIDGE-1: source WorkItem entered `blocked` status; TL must unblock or re-scope. */
  | 'task_blocked';

/**
 * Enumerated values of {@link ReviewReason} for runtime iteration / validation.
 * Kept in declaration order to mirror the type alias.
 */
export const REVIEW_REASONS: readonly ReviewReason[] = [
  'scheduled_review',
  'off_track_kr',
  'no_active_work',
  'phase_complete',
  'max_retries_exceeded',
  'task_blocked',
] as const;

/**
 * Type guard for {@link ReviewReason}.
 *
 * Validates payloads coming off persisted WorkItems whose `metadata` field is
 * `Record<string, unknown>` — without this guard, downstream UIs and audit
 * tooling would have to cast and risk silent drift if a producer adds an
 * unrecognised reason string.
 *
 * @param value - Unknown candidate string
 * @returns True iff `value` is a registered ReviewReason
 *
 * @example
 * ```typescript
 * const reason = workItem.metadata?.reviewReason;
 * if (isReviewReason(reason)) {
 *   render(reason); // narrowed to ReviewReason
 * }
 * ```
 */
export function isReviewReason(value: unknown): value is ReviewReason {
  return typeof value === 'string' && (REVIEW_REASONS as readonly string[]).includes(value);
}
