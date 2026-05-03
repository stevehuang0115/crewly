/**
 * Onboarding Routes — REST API for Cloud Portal onboarding sessions.
 *
 * Provides session lifecycle management for KR3 sub-5-minute onboarding:
 *   POST   /api/onboarding/sessions         — Create a new session
 *   GET    /api/onboarding/sessions          — List the caller's sessions
 *   GET    /api/onboarding/sessions/:id      — Get session by ID (owner-scoped)
 *   PUT    /api/onboarding/sessions/:id      — Update session (owner-scoped)
 *   POST   /api/onboarding/sessions/:id/prefill   — Store prefill data (owner-scoped)
 *   POST   /api/onboarding/sessions/:id/approve   — Approve profile (owner-scoped)
 *   POST   /api/onboarding/sessions/:id/complete  — Mark session terminal (owner-scoped, KR3 magic-moment timestamp)
 *   POST   /api/onboarding/provision         — Provision final team (owner-scoped)
 *
 * Every endpoint runs behind `requireAuth` so each request carries
 * `req.user.userId` (the authenticated principal). The principal is
 * forwarded to {@link OnboardingService} as the owner scope for every
 * read and mutation, which closes the cross-tenant leak originally
 * introduced in `b29de620` and surfaced by Arch's review of PR #347
 * (item N1, Phase E pre-beta).
 *
 * @module controllers/onboarding/onboarding.routes
 */

import { Router, type Request, type Response } from 'express';
import { OnboardingService } from '../../services/onboarding/onboarding.service.js';
import { provisionFromOnboarding } from '../../services/onboarding/onboarding-provision.service.js';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../../middleware/require-auth.middleware.js';

/**
 * Resolve the authenticated principal from a request that has already
 * passed through `requireAuth`. Centralised so a future change to the
 * auth shape (e.g. `tenantId` instead of `userId`) only edits one site.
 *
 * @param req - Express request known to have an attached user
 * @returns The owner id used as the tenant scope for service calls
 */
function ownerIdFor(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

export function createOnboardingRouter(): Router {
  const router = Router();
  const service = OnboardingService.getInstance();

  /**
   * Create a new onboarding session.
   * Body: { websiteUrl: string } (optional).
   * The session is owned by `req.user.userId` (the authenticated principal).
   */
  router.post('/sessions', requireAuth, (req: Request, res: Response) => {
    try {
      const session = service.createSession(req.body.websiteUrl, ownerIdFor(req));
      res.status(201).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * List onboarding sessions owned by the caller.
   *
   * The list is always scoped to `req.user.userId`; sessions owned by
   * other tenants are not returned and there is no admin-bypass surface
   * here (admin tools should use a separate, deliberately-gated route).
   */
  router.get('/sessions', requireAuth, (req: Request, res: Response) => {
    const sessions = service.listSessions(ownerIdFor(req));
    res.json({ success: true, data: sessions });
  });

  /**
   * Get an onboarding session by ID (owner-scoped).
   *
   * Returns 404 when the session does not exist OR when the caller does
   * not own it — the two cases are intentionally indistinguishable so
   * cross-tenant id enumeration cannot probe for existence.
   */
  router.get('/sessions/:id', requireAuth, (req: Request, res: Response) => {
    const session = service.getSession(req.params.id, ownerIdFor(req));
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    res.json({ success: true, data: session });
  });

  /**
   * Update an onboarding session (website URL, discovery answers).
   * Body: Partial<OnboardingSession>.
   *
   * Cross-tenant updates resolve to 404 (same shape as missing) so
   * tenants cannot probe for ids belonging to others. The service
   * additionally strips any `ownerUserId` from the update payload —
   * ownership is set at creation time only.
   */
  router.put('/sessions/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const session = service.updateSession(
        req.params.id,
        req.body,
        ownerIdFor(req),
      );
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      res.json({ success: true, data: session });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Store AI-extracted prefill data for a session.
   * Body: OnboardingPrefillData. Cross-tenant calls resolve to 404.
   */
  router.post('/sessions/:id/prefill', requireAuth, (req: Request, res: Response) => {
    try {
      const session = service.setPrefillData(
        req.params.id,
        req.body,
        ownerIdFor(req),
      );
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      res.json({ success: true, data: session });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Approve the reviewed profile and move to provision-ready.
   * Body: { answers: DiscoveryAnswers }. Cross-tenant calls resolve to 404.
   */
  router.post('/sessions/:id/approve', requireAuth, (req: Request, res: Response) => {
    try {
      const session = service.approveProfile(
        req.params.id,
        req.body.answers,
        ownerIdFor(req),
      );
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      res.json({ success: true, data: session });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Mark an onboarding session terminal and stamp the KR3 magic-moment
   * telemetry timestamp.
   *
   * Called by the frontend wizard's post-provision success screen so we can
   * measure end-to-end onboarding wall-clock time (createdAt → completedAt).
   * Body: { teamKnowledgeDir?: string } — opaque metadata stored on the
   * session for downstream tooling that wants to recover the knowledge dir
   * the wizard used.
   *
   * Cross-tenant calls resolve to 404 (same shape as a missing session) so
   * cross-tenant id enumeration cannot probe for existence.
   */
  router.post('/sessions/:id/complete', requireAuth, (req: Request, res: Response) => {
    try {
      const session = service.completeSession(
        req.params.id,
        ownerIdFor(req),
        { teamKnowledgeDir: req.body?.teamKnowledgeDir },
      );
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      res.json({ success: true, data: session });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Provision a team from the Onboarding Agent's discovery output.
   *
   * Validates the handoff payload, resolves the best-match template,
   * and creates a fully configured team via TemplateService. The team
   * is attributed to the authenticated principal — `ownerIdFor(req)`
   * is forwarded to {@link provisionFromOnboarding} so the resulting
   * `Team.ownerUserId` is bound to `req.user.userId` and never sourced
   * from the request body (N1b — Arch's PR #350 follow-up).
   *
   * Body: OnboardingProvisionRequest
   * Returns 200 with OnboardingProvisionResponse on success.
   * Returns 400 with error details on validation failure or budget gate.
   */
  router.post('/provision', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await provisionFromOnboarding(req.body, ownerIdFor(req));

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
