/**
 * Website Analysis Routes — SSE Streaming + REST API
 *
 * Provides endpoints for the KR3 "magic onboarding" website analysis pipeline:
 *   POST /api/website-analysis/analyze       — Start analysis (SSE stream)
 *   POST /api/website-analysis/analyze-sync  — Start analysis (JSON response)
 *   POST /api/website-analysis/recommend     — Get template recommendation from draft
 *
 * The SSE endpoint streams 4-stage progress events as the analysis runs,
 * then sends the final AnalysisResult and closes the connection.
 *
 * @module controllers/onboarding/website-analysis.routes
 */

import { Router, type Request, type Response } from 'express';
import { WebsiteAnalysisService } from '../../services/onboarding/website-analysis.service.js';
import type {
  AnalysisOptions,
  AnalysisProgressEvent,
  AnalysisDraft,
} from '../../services/onboarding/website-analysis.types.js';

// ---------------------------------------------------------------------------
// SSE Helper
// ---------------------------------------------------------------------------

/**
 * Send an SSE event to the response stream.
 *
 * @param res - Express response configured for SSE
 * @param eventName - SSE event name
 * @param data - Event data (will be JSON-stringified)
 */
function sendSSE(res: Response, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Create the website analysis router with SSE streaming and REST endpoints.
 *
 * @returns Express Router for /api/website-analysis
 */
export function createWebsiteAnalysisRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /analyze — SSE streaming analysis
  // -------------------------------------------------------------------------

  /**
   * Start a website analysis and stream progress events via SSE.
   *
   * Request body: { url: string, maxPages?: number, timeoutMs?: number }
   *
   * SSE events:
   * - `progress` — AnalysisProgressEvent (emitted ~6 times during pipeline)
   * - `result` — Final AnalysisResult
   * - `error` — Error details if analysis fails fatally
   *
   * The connection closes automatically after the result or error event.
   */
  router.post('/analyze', async (req: Request, res: Response): Promise<void> => {
    const { url, maxPages, timeoutMs } = req.body as {
      url?: string;
      maxPages?: number;
      timeoutMs?: number;
    };

    const trimmedUrl = typeof url === 'string' ? url.trim() : '';
    if (!trimmedUrl) {
      res.status(400).json({
        success: false,
        error: 'url is required and must be a non-empty string',
      });
      return;
    }

    if (!/^https?:\/\//i.test(trimmedUrl)) {
      res.status(400).json({ success: false, error: 'URL must use http:// or https:// scheme' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Track if client disconnected
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    const service = WebsiteAnalysisService.getInstance();

    const options: AnalysisOptions = {
      url: trimmedUrl,
      maxPages,
      timeoutMs,
      onProgress: (event: AnalysisProgressEvent) => {
        if (!clientDisconnected) {
          sendSSE(res, 'progress', event);
        }
      },
    };

    try {
      const result = await service.analyze(options);

      if (!clientDisconnected) {
        sendSSE(res, 'result', result);
        res.end();
      }
    } catch (err) {
      if (!clientDisconnected) {
        sendSSE(res, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.end();
      }
    }
  });

  // -------------------------------------------------------------------------
  // POST /analyze-sync — Synchronous JSON analysis
  // -------------------------------------------------------------------------

  /**
   * Start a website analysis and return the full result as JSON.
   * Use this for simpler integrations that don't need streaming progress.
   *
   * Request body: { url: string, maxPages?: number, timeoutMs?: number }
   * Response: AnalysisResult
   */
  router.post('/analyze-sync', async (req: Request, res: Response): Promise<void> => {
    const { url, maxPages, timeoutMs } = req.body as {
      url?: string;
      maxPages?: number;
      timeoutMs?: number;
    };

    const trimmedSyncUrl = typeof url === 'string' ? url.trim() : '';
    if (!trimmedSyncUrl) {
      res.status(400).json({
        success: false,
        error: 'url is required and must be a non-empty string',
      });
      return;
    }

    if (!/^https?:\/\//i.test(trimmedSyncUrl)) {
      res.status(400).json({ success: false, error: 'URL must use http:// or https:// scheme' });
      return;
    }

    try {
      const service = WebsiteAnalysisService.getInstance();
      const result = await service.analyze({
        url: trimmedSyncUrl,
        maxPages,
        timeoutMs,
      });

      const status = result.success ? 200 : 422;
      res.status(status).json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Analysis failed',
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /recommend — Template recommendation from draft
  // -------------------------------------------------------------------------

  /**
   * Get a template recommendation based on an existing AnalysisDraft.
   * Useful when the user edits the draft and wants an updated recommendation.
   *
   * Request body: AnalysisDraft
   * Response: TemplateRecommendation
   */
  router.post('/recommend', (req: Request, res: Response): void => {
    const draft = req.body as AnalysisDraft;

    if (!draft || typeof draft !== 'object') {
      res.status(400).json({
        success: false,
        error: 'Request body must be a valid AnalysisDraft object',
      });
      return;
    }

    try {
      const service = WebsiteAnalysisService.getInstance();
      const recommendation = service.recommendTemplate(draft);
      res.json({ success: true, data: recommendation });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Recommendation failed',
      });
    }
  });

  return router;
}
