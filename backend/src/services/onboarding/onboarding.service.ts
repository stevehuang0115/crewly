/**
 * Cloud Portal Onboarding Service.
 *
 * Manages session lifecycle for the KR3 sub-5-minute Cloud Portal onboarding
 * flow exposed under `/api/onboarding/*`. Sessions are kept in memory for the
 * duration of the backend process — see {@link OnboardingSession} for the
 * data model and the rationale for in-memory storage.
 *
 * This service is intentionally distinct from {@link BrandOnboardingService}
 * (marketing brand-voice questionnaire). They share the `provisionFromOnboarding`
 * sink but model their session shapes independently, so each flow can evolve
 * without coupling.
 *
 * ## Tenant scoping (Phase E pre-beta — N1)
 *
 * Every read and mutation method accepts an optional `ownerUserId` scope
 * parameter. When provided, the method only returns / mutates sessions
 * owned by that user — cross-owner reads return `null` (the same shape as
 * a missing session, so callers cannot enumerate ids that belong to other
 * tenants). When omitted, the method runs unscoped — preserves OSS
 * single-user behaviour and admin/test access.
 *
 * The HTTP layer at `controllers/onboarding/onboarding.routes.ts` is
 * responsible for resolving the principal from the auth context and
 * always passing `req.user.userId` to the service in Cloud Portal mode.
 *
 * @module services/onboarding/onboarding.service
 */

import { randomUUID } from 'crypto';
import type {
  DiscoveryAnswers,
  OnboardingPrefillData,
  OnboardingSession,
} from './onboarding.types.js';

/**
 * In-memory singleton service implementing Cloud Portal onboarding session
 * lifecycle (`createSession`, `listSessions`, `getSession`, `updateSession`,
 * `setPrefillData`, `approveProfile`).
 *
 * @example
 * ```typescript
 * const svc = OnboardingService.getInstance();
 * const session = svc.createSession('https://acme.com', 'user-123');
 * svc.setPrefillData(session.id, { businessName: 'Acme', confidence: 'high' }, 'user-123');
 * svc.approveProfile(session.id, { identity: { name: 'Acme', vertical: 'Software/Tech', size: 'small' } }, 'user-123');
 * ```
 */
export class OnboardingService {
  private static instance: OnboardingService | null = null;
  private readonly sessions: Map<string, OnboardingSession> = new Map();

  /**
   * Get the singleton instance, constructing it on first access.
   *
   * @returns The shared service instance
   */
  static getInstance(): OnboardingService {
    if (!OnboardingService.instance) {
      OnboardingService.instance = new OnboardingService();
    }
    return OnboardingService.instance;
  }

  /**
   * Reset the singleton (intended for tests). Discards all in-memory sessions.
   */
  static resetInstance(): void {
    OnboardingService.instance = null;
  }

  /**
   * Internal: returns the stored session if (a) it exists and (b) the
   * caller's `ownerUserId` matches (or the call is unscoped). Returns
   * `null` otherwise — this is the canonical "either missing or
   * not-owned" fallthrough that prevents id-enumeration leaks across
   * tenants (cross-owner attempts look identical to "not found").
   *
   * @param sessionId - Session id to look up
   * @param ownerUserId - Optional owner scope; undefined disables the check
   * @returns The session if visible to the caller, else `null`
   */
  private resolveOwned(
    sessionId: string,
    ownerUserId?: string,
  ): OnboardingSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (ownerUserId !== undefined && session.ownerUserId !== ownerUserId) {
      return null;
    }
    return session;
  }

  /**
   * Create a new onboarding session.
   *
   * Generates a UUID v4 id, stamps `createdAt`/`updatedAt`, and stores the
   * session in memory. Status starts at `'created'`. When `ownerUserId` is
   * provided, the session is bound to that owner for all subsequent
   * lookups and mutations (Cloud Portal mode); when omitted, the session
   * is unscoped and visible to any caller that also runs unscoped (OSS
   * single-user mode).
   *
   * @param websiteUrl - Optional website URL to seed the session with
   * @param ownerUserId - Optional owner principal id (`req.user.userId` in HTTP)
   * @returns The newly created session
   */
  createSession(websiteUrl?: string, ownerUserId?: string): OnboardingSession {
    const now = new Date().toISOString();
    const session: OnboardingSession = {
      id: randomUUID(),
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * List onboarding sessions visible to the caller.
   *
   * When `ownerUserId` is provided, only sessions owned by that user are
   * returned. When omitted, the full set is returned — this preserves
   * existing OSS test/admin behaviour and is the implicit default for
   * callers that never set the scope. Iteration order matches insertion
   * order (Map iteration semantics) so callers that care about chronology
   * can rely on it without an explicit sort.
   *
   * @param ownerUserId - Optional owner scope (`req.user.userId` in HTTP)
   * @returns Snapshot array of the sessions visible to the caller
   */
  listSessions(ownerUserId?: string): OnboardingSession[] {
    const all = Array.from(this.sessions.values());
    if (ownerUserId === undefined) return all;
    return all.filter((s) => s.ownerUserId === ownerUserId);
  }

  /**
   * Get a session by id, scoped to the caller.
   *
   * Returns `null` when (a) the session does not exist OR (b) the caller
   * does not own it. The two cases are intentionally indistinguishable
   * to the caller so cross-tenant id enumeration cannot probe for
   * existence.
   *
   * @param sessionId - Session id
   * @param ownerUserId - Optional owner scope (`req.user.userId` in HTTP)
   * @returns The session, or `null` if missing or not owned by the caller
   */
  getSession(sessionId: string, ownerUserId?: string): OnboardingSession | null {
    return this.resolveOwned(sessionId, ownerUserId);
  }

  /**
   * Apply a partial update to a session.
   *
   * Identity fields (`id`, `createdAt`) are protected from mutation — the
   * caller's `updates` payload may carry them (e.g. when echoing the body
   * back from the frontend) but they are stripped before merge. The
   * `ownerUserId` field is also stripped — ownership is set at creation
   * time only and cannot be re-targeted via PUT. Status is never
   * auto-mutated here — callers must set `status` explicitly if they
   * want to advance the lifecycle. `updatedAt` is always refreshed.
   *
   * Cross-tenant updates are rejected with a `null` return — same shape
   * as a missing session, so callers cannot probe for existence.
   *
   * @param sessionId - Session id
   * @param updates - Fields to merge into the existing session
   * @param ownerUserId - Optional owner scope (`req.user.userId` in HTTP)
   * @returns The updated session, or `null` if missing or not owned
   */
  updateSession(
    sessionId: string,
    updates: Partial<OnboardingSession>,
    ownerUserId?: string,
  ): OnboardingSession | null {
    const existing = this.resolveOwned(sessionId, ownerUserId);
    if (!existing) return null;
    // Strip identity/timestamps and ownerUserId so the caller can't accidentally
    // rewrite them.
    const {
      id: _ignoredId,
      createdAt: _ignoredCreatedAt,
      updatedAt: _ignoredUpdatedAt,
      ownerUserId: _ignoredOwnerUserId,
      ...safeUpdates
    } = updates;
    const merged: OnboardingSession = {
      ...existing,
      ...safeUpdates,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, merged);
    return merged;
  }

  /**
   * Store AI-extracted prefill data on a session and advance status to
   * `'prefilled'`.
   *
   * Idempotent w.r.t. prefill replacement — calling this twice with different
   * payloads keeps the latest one. Cross-tenant calls return `null` (no
   * enumeration leak).
   *
   * @param sessionId - Session id
   * @param data - The AI-extracted prefill payload
   * @param ownerUserId - Optional owner scope (`req.user.userId` in HTTP)
   * @returns The updated session, or `null` if missing or not owned
   */
  setPrefillData(
    sessionId: string,
    data: OnboardingPrefillData,
    ownerUserId?: string,
  ): OnboardingSession | null {
    const existing = this.resolveOwned(sessionId, ownerUserId);
    if (!existing) return null;
    const merged: OnboardingSession = {
      ...existing,
      prefillData: data,
      status: 'prefilled',
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, merged);
    return merged;
  }

  /**
   * Record the user's approved discovery answers and advance status to
   * `'approved'`.
   *
   * Cross-tenant calls return `null` (no enumeration leak).
   *
   * @param sessionId - Session id
   * @param answers - The user-approved discovery answer payload
   * @param ownerUserId - Optional owner scope (`req.user.userId` in HTTP)
   * @returns The updated session, or `null` if missing or not owned
   */
  approveProfile(
    sessionId: string,
    answers: DiscoveryAnswers,
    ownerUserId?: string,
  ): OnboardingSession | null {
    const existing = this.resolveOwned(sessionId, ownerUserId);
    if (!existing) return null;
    const merged: OnboardingSession = {
      ...existing,
      discoveryAnswers: answers,
      status: 'approved',
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, merged);
    return merged;
  }
}
