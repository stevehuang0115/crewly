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
 *   POST   /api/onboarding/sessions/:id/complete  — Complete onboarding (generate guide)
 *   GET    /api/onboarding/questions          — Get all questionnaire questions
 *   POST   /api/onboarding/provision          — Provision a team from onboarding discovery
 *
 * @module controllers/onboarding/onboarding.routes
 */

import { Router, type Request, type Response } from 'express';
import { BrandOnboardingService } from '../../services/onboarding/brand-onboarding.service.js';
import { WebsiteExtractorService } from '../../services/onboarding/website-extractor.service.js';
import type { OnboardingPrefill, BrandProfile } from '../../services/onboarding/brand-onboarding.types.js';
import { provisionFromOnboarding } from '../../services/onboarding/onboarding-provision.service.js';

/**
 * Create the onboarding router with all session management endpoints.
 *
 * @returns Express Router for /api/onboarding
 */
export function createOnboardingRouter(): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // GET /sessions — list all onboarding sessions
  // ---------------------------------------------------------------------------

  /**
   * List all onboarding sessions.
   */
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const sessions = service.listSessions();
      res.json({ success: true, data: sessions, count: sessions.length });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /sessions — create a new onboarding session
  // ---------------------------------------------------------------------------

  /**
   * Create a new onboarding session.
   *
   * Body: { teamId: string, templateId: string, websiteUrl?: string }
   */
  router.post('/sessions', (req: Request, res: Response) => {
    try {
      const { teamId, templateId, websiteUrl } = req.body as {
        teamId?: string;
        templateId?: string;
        websiteUrl?: string;
      };

      if (!teamId || !templateId) {
        res.status(400).json({
          success: false,
          error: 'teamId and templateId are required',
        });
        return;
      }

      const service = BrandOnboardingService.getInstance();
      const session = service.startSession(teamId, templateId);

      // Optionally set website URL for AI prefill
      if (websiteUrl) {
        service.setWebsiteUrl(session.id, websiteUrl);
      }

      res.status(201).json({ success: true, data: service.getSession(session.id) });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /sessions/:id — get a session by ID
  // ---------------------------------------------------------------------------

  /**
   * Get an onboarding session by ID.
   */
  router.get('/sessions/:id', (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const session = service.getSession(req.params.id);

      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      res.json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /sessions/:id — update session (website URL, submit answers)
  // ---------------------------------------------------------------------------

  /**
   * Update an onboarding session.
   *
   * Body options:
   *   { websiteUrl: string }  — set/update the website URL
   *   { answer: string }      — submit answer to current question
   *   { answers: Record<string, string> } — batch submit all answers
   */
  router.put('/sessions/:id', (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const { id } = req.params;
      const { websiteUrl, answer, answers } = req.body as {
        websiteUrl?: string;
        answer?: string;
        answers?: Record<string, string>;
      };

      let session = service.getSession(id);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      // Update website URL
      if (websiteUrl !== undefined) {
        session = service.setWebsiteUrl(id, websiteUrl);
      }

      // Submit single answer
      if (answer !== undefined) {
        session = service.submitAnswer(id, answer);
      }

      // Batch submit answers
      if (answers !== undefined) {
        session = service.submitAllAnswers(id, answers);
      }

      res.json({ success: true, data: session });
    } catch (err) {
      const status = (err instanceof Error && err.message.includes('required')) ? 400 : 500;
      res.status(status).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/prefill — store AI-extracted prefill data
  // ---------------------------------------------------------------------------

  /**
   * Store AI-extracted prefill data for an onboarding session.
   *
   * Body: OnboardingPrefill — each field is a PrefillField with value,
   *       sourceUrls, confidence, extractionMethod, needsReview.
   */
  router.post('/sessions/:id/prefill', (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const prefill = req.body as OnboardingPrefill;

      if (!prefill || typeof prefill !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Request body must be a valid OnboardingPrefill object',
        });
        return;
      }

      const session = service.setPrefill(req.params.id, prefill);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      res.json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/approve — approve reviewed profile
  // ---------------------------------------------------------------------------

  /**
   * Approve the user-reviewed brand profile.
   * Transitions the session to 'completed' with the approved profile.
   *
   * Body: BrandProfile — the user-corrected brand profile
   */
  router.post('/sessions/:id/approve', (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const profile = req.body as BrandProfile;

      if (!profile || !profile.businessName) {
        res.status(400).json({
          success: false,
          error: 'Request body must be a valid BrandProfile with at least businessName',
        });
        return;
      }

      const session = service.approveProfile(req.params.id, profile);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      res.json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/complete — generate brand voice guide
  // ---------------------------------------------------------------------------

  /**
   * Complete the onboarding flow: extract/use approved profile, generate guide.
   *
   * Body: { teamKnowledgeDir: string } — path to store the generated guide
   */
  router.post('/sessions/:id/complete', (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const { teamKnowledgeDir } = req.body as { teamKnowledgeDir?: string };

      if (!teamKnowledgeDir) {
        res.status(400).json({
          success: false,
          error: 'teamKnowledgeDir is required',
        });
        return;
      }

      const session = service.completeOnboarding(req.params.id, teamKnowledgeDir);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found or not in completed status',
        });
        return;
      }

      res.json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /sessions/:id/extract — trigger AI extraction from session's websiteUrl
  // ---------------------------------------------------------------------------

  /**
   * Trigger AI-powered website extraction for an onboarding session.
   * Scrapes the session's websiteUrl and stores the extracted prefill data.
   *
   * Returns the updated session with prefill and missingFields populated.
   */
  router.post('/sessions/:id/extract', async (req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const session = service.getSession(req.params.id);

      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      if (!session.websiteUrl) {
        res.status(400).json({
          success: false,
          error: 'Session has no websiteUrl set. Update the session with a websiteUrl first.',
        });
        return;
      }

      const extractor = WebsiteExtractorService.getInstance();
      const prefill = await extractor.extract(session.websiteUrl);

      const updated = service.setPrefill(session.id, prefill);
      if (!updated) {
        res.status(500).json({ success: false, error: 'Failed to store extraction result' });
        return;
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /questions — get all onboarding questions
  // ---------------------------------------------------------------------------

  /**
   * Get all onboarding questionnaire questions.
   */
  router.get('/questions', (_req: Request, res: Response) => {
    try {
      const service = BrandOnboardingService.getInstance();
      const questions = service.getQuestions();
      res.json({ success: true, data: questions, count: questions.length });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /provision — provision a team from onboarding discovery data
  // ---------------------------------------------------------------------------

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
  router.post('/provision', (req: Request, res: Response) => {
    try {
      const result = provisionFromOnboarding(req.body);

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
