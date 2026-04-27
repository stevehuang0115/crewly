/**
 * Onboarding Routes — REST API for Cloud Portal onboarding sessions.
 *
 * Provides session lifecycle management for KR3 sub-5-minute onboarding:
 *   POST   /api/onboarding/sessions         — Create a new session
 *   GET    /api/onboarding/sessions          — List all sessions
 *   GET    /api/onboarding/sessions/:id      — Get session by ID
 *   PUT    /api/onboarding/sessions/:id      — Update session (website URL, answers)
 *   POST   /api/onboarding/sessions/:id/prefill   — Store AI-extracted prefill data
 *   POST   /api/onboarding/sessions/:id/approve   — Approve reviewed profile
 *   POST   /api/onboarding/provision         — Provision final team (handoff to Template Engine)
 *
 * @module controllers/onboarding/onboarding.routes
 */

import { Router, type Request, type Response } from 'express';
import { OnboardingService } from '../../services/onboarding/onboarding.service.js';
import { provisionFromOnboarding } from '../../services/onboarding/onboarding-provision.service.js';

export function createOnboardingRouter(): Router {
  const router = Router();
  const service = OnboardingService.getInstance();

  /**
   * Create a new onboarding session.
   * Body: { websiteUrl: string } (optional)
   */
  router.post('/sessions', (req: Request, res: Response) => {
    try {
      const session = service.createSession(req.body.websiteUrl);
      res.status(201).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * List all onboarding sessions.
   */
  router.get('/sessions', (_req: Request, res: Response) => {
    const sessions = service.listSessions();
    res.json({ success: true, data: sessions });
  });

  /**
   * Get an onboarding session by ID.
   */
  router.get('/sessions/:id', (req: Request, res: Response) => {
    const session = service.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    res.json({ success: true, data: session });
  });

  /**
   * Update an onboarding session (website URL, discovery answers).
   * Body: Partial<OnboardingSession>
   */
  router.put('/sessions/:id', (req: Request, res: Response) => {
    try {
      const session = service.updateSession(req.params.id, req.body);
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
   * Body: OnboardingPrefillData
   */
  router.post('/sessions/:id/prefill', (req: Request, res: Response) => {
    try {
      const session = service.setPrefillData(req.params.id, req.body);
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
   * Body: { answers: DiscoveryAnswers }
   */
  router.post('/sessions/:id/approve', (req: Request, res: Response) => {
    try {
      const session = service.approveProfile(req.params.id, req.body.answers);
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
   * and creates a fully configured team via TemplateService.
   *
   * Body: OnboardingProvisionRequest
   * Returns 200 with OnboardingProvisionResponse on success.
   * Returns 400 with error details on validation failure or budget gate.
   */
  router.post('/provision', async (req: Request, res: Response) => {
    try {
      const result = await provisionFromOnboarding(req.body);

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
