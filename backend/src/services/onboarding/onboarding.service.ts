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
 * const session = svc.createSession('https://acme.com');
 * svc.setPrefillData(session.id, { businessName: 'Acme', confidence: 'high' });
 * svc.approveProfile(session.id, { identity: { name: 'Acme', vertical: 'Software/Tech', size: 'small' } });
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
   * Create a new onboarding session.
   *
   * Generates a UUID v4 id, stamps `createdAt`/`updatedAt`, and stores the
   * session in memory. Status starts at `'created'`.
   *
   * @param websiteUrl - Optional website URL to seed the session with
   * @returns The newly created session
   */
  createSession(websiteUrl?: string): OnboardingSession {
    const now = new Date().toISOString();
    const session: OnboardingSession = {
      id: randomUUID(),
      ...(websiteUrl ? { websiteUrl } : {}),
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * List all onboarding sessions currently in memory.
   *
   * Order is insertion order (Map iteration semantics) so callers that care
   * about chronology can rely on it without an explicit sort.
   *
   * @returns Snapshot array of all sessions
   */
  listSessions(): OnboardingSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a session by id.
   *
   * @param sessionId - Session id
   * @returns The session, or `null` if no session has that id
   */
  getSession(sessionId: string): OnboardingSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Apply a partial update to a session.
   *
   * Identity fields (`id`, `createdAt`) are protected from mutation — the
   * caller's `updates` payload may carry them (e.g. when echoing the body
   * back from the frontend) but they are stripped before merge. Status is
   * never auto-mutated here — callers must set `status` explicitly if they
   * want to advance the lifecycle. `updatedAt` is always refreshed.
   *
   * @param sessionId - Session id
   * @param updates - Fields to merge into the existing session
   * @returns The updated session, or `null` if no session has that id
   */
  updateSession(
    sessionId: string,
    updates: Partial<OnboardingSession>,
  ): OnboardingSession | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    // Strip identity/timestamps so the caller can't accidentally rewrite them.
    const { id: _ignoredId, createdAt: _ignoredCreatedAt, updatedAt: _ignoredUpdatedAt, ...safeUpdates } = updates;
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
   * payloads keeps the latest one.
   *
   * @param sessionId - Session id
   * @param data - The AI-extracted prefill payload
   * @returns The updated session, or `null` if no session has that id
   */
  setPrefillData(
    sessionId: string,
    data: OnboardingPrefillData,
  ): OnboardingSession | null {
    const existing = this.sessions.get(sessionId);
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
   * @param sessionId - Session id
   * @param answers - The user-approved discovery answer payload
   * @returns The updated session, or `null` if no session has that id
   */
  approveProfile(
    sessionId: string,
    answers: DiscoveryAnswers,
  ): OnboardingSession | null {
    const existing = this.sessions.get(sessionId);
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
