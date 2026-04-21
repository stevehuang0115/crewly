/**
 * ServiceContractGate — runtime enforcement of team `ServiceContract`s.
 *
 * Cross-team requests must pass through the gate before a WorkItem is
 * enqueued on the target team's pool. The gate makes a pure-function
 * decision by matching the requested `requestType` string against the
 * target team's `serviceContract.accepts` and `serviceContract.avoids`
 * phrases.
 *
 * Design choices:
 * - **No LLM.** Plain case-insensitive substring match — predictable and
 *   cheap enough to run on every dispatch.
 * - **Fail closed.** If `accepts` is missing, empty, or matches nothing,
 *   the request is rejected. Teams must explicitly declare what they take.
 * - **`avoids` beats `accepts`.** An avoided phrase wins even if the
 *   request also matches an accepted phrase — the negative signal is
 *   assumed stronger (e.g. "frontend bugfix" is accepted but "production
 *   frontend bugfix" is avoided).
 * - **Same-team requests skip the gate.** Teams don't contract with
 *   themselves; internal work flows normally.
 *
 * Wired into the task-pool `addItem` flow via `maybeEnforceContract` in
 * `controllers/task-pool/task-pool.controller.ts`. The service itself is
 * stateless and standalone so it can also be called from skills or a
 * future ServiceGateway layer.
 *
 * @module services/v3/service-contract-gate.service
 */

import type { Team } from '../../types/index.js';
import type { ServiceContract } from '../../types/team-template.types.js';
import { matchRule } from './contract-matcher.js';

export { matchRule } from './contract-matcher.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Reason codes for a rejected request. Callers use these to produce a
 * targeted error message (e.g. "out of scope" vs "ambiguous, please
 * specify a supported service type").
 */
export type GateRejectionReason =
  | 'missing_target'        // target team could not be resolved
  | 'missing_request_type'  // caller supplied no usable requestType
  | 'no_contract'           // target team has no serviceContract
  | 'empty_contract'        // contract exists but accepts[] is empty
  | 'in_avoids'             // request matched an `avoids` phrase (fail closed)
  | 'no_match';             // request matched neither accepts nor avoids

/**
 * The decision returned by the gate.
 */
export type GateDecision =
  | {
      outcome: 'accept';
      /** The accepts[] phrase that matched the request. */
      matchedRule: string;
    }
  | {
      outcome: 'reject';
      reason: GateRejectionReason;
      /** Which rule matched (only populated for `in_avoids`). */
      matchedRule?: string;
      /** Human-readable explanation suitable for surfacing to the requester. */
      message: string;
    };

/**
 * Inputs the gate needs to make a decision.
 */
export interface GateRequest {
  /** Team making the request. Optional — undefined means "external/user". */
  fromTeamId?: string;
  /** Team that would receive the work. */
  toTeam: Team | undefined;
  /** Free-text description of the requested service type (short phrase). */
  requestType: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Stateless gate that evaluates a cross-team request against the target's
 * `ServiceContract`. Safe to instantiate once and reuse, or to call
 * {@link check} via an ad-hoc instance.
 *
 * @example
 * ```typescript
 * const gate = new ServiceContractGate();
 * const decision = gate.check({
 *   fromTeamId: 'marketing',
 *   toTeam: engineeringTeam,
 *   requestType: 'frontend bugfix',
 * });
 * if (decision.outcome === 'reject') {
 *   throw new Error(decision.message);
 * }
 * ```
 */
export class ServiceContractGate {
  /**
   * Decide whether the target team may accept this request.
   *
   * @param req - Request details (from, to, type)
   * @returns Structured decision with outcome + reason + message
   */
  check(req: GateRequest): GateDecision {
    // Internal work bypasses the contract entirely.
    if (req.fromTeamId && req.toTeam && req.fromTeamId === req.toTeam.id) {
      return { outcome: 'accept', matchedRule: '<internal>' };
    }

    if (!req.toTeam) {
      return {
        outcome: 'reject',
        reason: 'missing_target',
        message: 'Target team could not be resolved.',
      };
    }

    // A missing requestType is a caller bug (no metadata in the WorkItem),
    // not a policy decision. Surface it explicitly so the caller doesn't
    // misread "no_match" as "the target team rejected my work".
    if (!req.requestType || !req.requestType.trim()) {
      return {
        outcome: 'reject',
        reason: 'missing_request_type',
        message: 'Cross-team requests must supply a non-empty `requestType` (or a title/description fallback).',
      };
    }

    const contract = req.toTeam.serviceContract;
    if (!contract) {
      return {
        outcome: 'reject',
        reason: 'no_contract',
        message: `Team "${req.toTeam.name}" has no service contract — cross-team requests are not accepted until one is declared.`,
      };
    }

    // `avoids` wins over `accepts` — fail closed on negative signal.
    const avoidHit = matchRule(req.requestType, contract.avoids ?? []);
    if (avoidHit) {
      return {
        outcome: 'reject',
        reason: 'in_avoids',
        matchedRule: avoidHit,
        message: `Team "${req.toTeam.name}" explicitly avoids requests matching "${avoidHit}".`,
      };
    }

    const accepts = contract.accepts ?? [];
    if (accepts.length === 0) {
      return {
        outcome: 'reject',
        reason: 'empty_contract',
        message: `Team "${req.toTeam.name}" has a service contract with no accepted task types.`,
      };
    }

    const acceptHit = matchRule(req.requestType, accepts);
    if (acceptHit) {
      return { outcome: 'accept', matchedRule: acceptHit };
    }

    return {
      outcome: 'reject',
      reason: 'no_match',
      message: buildNoMatchMessage(req.toTeam.name, req.requestType, contract),
    };
  }
}

/**
 * Build a helpful rejection message that lists what the team does accept,
 * so the caller can reframe or re-route.
 */
function buildNoMatchMessage(
  teamName: string,
  requestType: string,
  contract: ServiceContract,
): string {
  const accepts = (contract.accepts ?? []).filter((a) => a.trim()).join(', ');
  return accepts
    ? `Team "${teamName}" does not accept "${requestType}". Accepted services: ${accepts}.`
    : `Team "${teamName}" does not accept "${requestType}" and has no listed services.`;
}
