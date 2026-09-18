/**
 * Agent Self-Improvement Controller
 *
 * REST surface for the four metacognitive services under
 * `services/ai/self-improvement/` that were built but never consumed:
 * attention (focus / suppress), self-model, prediction calibration and
 * memory consolidation. No LLM calls — every handler is a thin adapter
 * over the file-backed services.
 *
 * Mounted at `/api/agents/:sessionName/self-improvement`:
 *
 * - GET  /                          — attention + self-model + calibration + latest consolidation
 * - POST /attention/focus           — replace focus items `{ items: string[] }`
 * - POST /attention/suppress        — add a suppressed topic `{ item }`
 * - POST /predictions               — record a prediction `{ statement, confidence, resolveBy? }`
 * - POST /predictions/:id/resolve   — resolve a prediction `{ outcome, accurate? }`
 *
 * The bash skills `set-focus`, `suppress-noise`, `record-prediction` and
 * `resolve-prediction` under `config/skills/agent/core/` call these routes.
 *
 * @module controllers/agent-self-improvement/agent-self-improvement.controller
 */

import { Router, type Request, type Response } from 'express';
import { AttentionService } from '../../services/ai/self-improvement/attention.service.js';
import { SelfModelService } from '../../services/ai/self-improvement/self-model.service.js';
import { PredictionCalibrationService } from '../../services/ai/self-improvement/prediction-calibration.service.js';
import type { MemoryConsolidationService } from '../../services/ai/self-improvement/memory-consolidation.service.js';
import { createMemoryConsolidationService } from '../../services/ai/self-improvement/agent-memory-provider.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { SELF_IMPROVEMENT_CONSTANTS } from '../../constants.js';

const logger = LoggerService.getInstance().createComponentLogger('AgentSelfImprovementController');

/**
 * Service bundle the handlers operate on. Injectable so tests can pass
 * in-memory fakes instead of touching `~/.crewly/agents/*`.
 */
export interface SelfImprovementServices {
	attention: AttentionService;
	selfModel: SelfModelService;
	predictions: PredictionCalibrationService;
	consolidation: MemoryConsolidationService;
}

/**
 * Build the default (disk-backed) service bundle.
 *
 * @returns Production services
 */
export function createDefaultSelfImprovementServices(): SelfImprovementServices {
	return {
		attention: new AttentionService(),
		selfModel: new SelfModelService(),
		predictions: new PredictionCalibrationService(),
		consolidation: createMemoryConsolidationService(),
	};
}

/**
 * Extract an error message from an unknown thrown value.
 *
 * @param err - Caught value
 * @param fallback - Message when the value is not an Error
 * @returns Human-readable error string
 */
function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

/**
 * Derive the `accurate` flag for a prediction resolution.
 *
 * Prefers an explicit boolean `accurate`; otherwise infers it from a
 * single-word outcome such as "correct" / "wrong" so the skill can be
 * called with just `{ outcome }`. Returns `null` when neither is usable.
 *
 * @param outcome - Free-text outcome
 * @param accurate - Explicit flag from the request body (may be undefined)
 * @returns true/false, or null when it cannot be determined
 */
export function deriveAccurate(outcome: string, accurate: unknown): boolean | null {
	if (typeof accurate === 'boolean') return accurate;
	if (typeof accurate === 'string') {
		if (accurate.toLowerCase() === 'true') return true;
		if (accurate.toLowerCase() === 'false') return false;
	}
	const word = outcome.trim().toLowerCase();
	const { ACCURATE, INACCURATE } = SELF_IMPROVEMENT_CONSTANTS.OUTCOME_KEYWORDS;
	if ((ACCURATE as readonly string[]).includes(word)) return true;
	if ((INACCURATE as readonly string[]).includes(word)) return false;
	return null;
}

/**
 * Create the handler set bound to a service bundle.
 *
 * @param services - Service bundle (defaults to disk-backed services)
 * @returns Express handlers keyed by operation
 */
export function createSelfImprovementHandlers(
	services: SelfImprovementServices = createDefaultSelfImprovementServices()
): {
	getOverview: (req: Request, res: Response) => Promise<void>;
	setFocus: (req: Request, res: Response) => Promise<void>;
	suppress: (req: Request, res: Response) => Promise<void>;
	recordPrediction: (req: Request, res: Response) => Promise<void>;
	resolvePrediction: (req: Request, res: Response) => Promise<void>;
} {
	/**
	 * GET /api/agents/:sessionName/self-improvement
	 *
	 * @param req - Express request with `:sessionName`
	 * @param res - `{ attention, selfModel, calibrationScore, consolidation }`
	 */
	const getOverview = async (req: Request, res: Response): Promise<void> => {
		const { sessionName } = req.params;
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName param is required' });
			return;
		}
		try {
			const [attention, selfModel, calibrationScore, consolidation] = await Promise.all([
				services.attention.getAttention(sessionName),
				services.selfModel.getSelfModel(sessionName),
				services.predictions.getCalibrationScore(sessionName),
				services.consolidation.getReport(sessionName),
			]);
			res.json({ success: true, data: { attention, selfModel, calibrationScore, consolidation } });
		} catch (err) {
			res.status(500).json({ success: false, error: errorMessage(err, 'Failed to load self-improvement data') });
		}
	};

	/**
	 * POST /api/agents/:sessionName/self-improvement/attention/focus
	 *
	 * @param req - Body `{ items: string[] }`
	 * @param res - `{ focus }` after replacement
	 */
	const setFocus = async (req: Request, res: Response): Promise<void> => {
		const { sessionName } = req.params;
		const { items } = (req.body ?? {}) as { items?: unknown };
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName param is required' });
			return;
		}
		if (!Array.isArray(items) || !items.every((i) => typeof i === 'string' && i.trim().length > 0)) {
			res.status(400).json({ success: false, error: 'items must be an array of non-empty strings' });
			return;
		}
		try {
			const cleaned = Array.from(new Set(items.map((i) => i.trim())));
			await services.attention.setFocus(sessionName, cleaned);
			const attention = await services.attention.getAttention(sessionName);
			logger.info('Focus updated', { sessionName, count: cleaned.length });
			res.json({ success: true, data: { focus: attention.focus, suppressed: attention.suppressed } });
		} catch (err) {
			res.status(500).json({ success: false, error: errorMessage(err, 'Failed to set focus') });
		}
	};

	/**
	 * POST /api/agents/:sessionName/self-improvement/attention/suppress
	 *
	 * @param req - Body `{ item: string }`
	 * @param res - `{ suppressed }` after the add
	 */
	const suppress = async (req: Request, res: Response): Promise<void> => {
		const { sessionName } = req.params;
		const { item } = (req.body ?? {}) as { item?: unknown };
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName param is required' });
			return;
		}
		if (typeof item !== 'string' || item.trim().length === 0) {
			res.status(400).json({ success: false, error: 'item must be a non-empty string' });
			return;
		}
		try {
			await services.attention.suppress(sessionName, item.trim());
			const attention = await services.attention.getAttention(sessionName);
			logger.info('Topic suppressed', { sessionName, item: item.trim() });
			res.json({ success: true, data: { focus: attention.focus, suppressed: attention.suppressed } });
		} catch (err) {
			res.status(500).json({ success: false, error: errorMessage(err, 'Failed to suppress item') });
		}
	};

	/**
	 * POST /api/agents/:sessionName/self-improvement/predictions
	 *
	 * @param req - Body `{ statement: string, confidence: number, resolveBy?: string }`
	 * @param res - `{ prediction }` as stored (201)
	 */
	const recordPrediction = async (req: Request, res: Response): Promise<void> => {
		const { sessionName } = req.params;
		const { statement, confidence, resolveBy } = (req.body ?? {}) as {
			statement?: unknown;
			confidence?: unknown;
			resolveBy?: unknown;
		};
		if (!sessionName) {
			res.status(400).json({ success: false, error: 'sessionName param is required' });
			return;
		}
		if (typeof statement !== 'string' || statement.trim().length === 0) {
			res.status(400).json({ success: false, error: 'statement must be a non-empty string' });
			return;
		}
		const conf = typeof confidence === 'string' ? Number(confidence) : confidence;
		if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
			res.status(400).json({ success: false, error: 'confidence must be a number between 0 and 1' });
			return;
		}
		if (resolveBy !== undefined && (typeof resolveBy !== 'string' || Number.isNaN(Date.parse(resolveBy)))) {
			res.status(400).json({ success: false, error: 'resolveBy must be an ISO date string' });
			return;
		}
		try {
			const prediction = await services.predictions.makePrediction(
				sessionName,
				statement.trim(),
				conf,
				resolveBy as string | undefined
			);
			logger.info('Prediction recorded', { sessionName, id: prediction.id, confidence: conf });
			res.status(201).json({ success: true, data: { prediction } });
		} catch (err) {
			res.status(500).json({ success: false, error: errorMessage(err, 'Failed to record prediction') });
		}
	};

	/**
	 * POST /api/agents/:sessionName/self-improvement/predictions/:id/resolve
	 *
	 * @param req - Body `{ outcome: string, accurate?: boolean }`
	 * @param res - `{ prediction, calibrationScore }`
	 */
	const resolvePrediction = async (req: Request, res: Response): Promise<void> => {
		const { sessionName, id } = req.params;
		const { outcome, accurate } = (req.body ?? {}) as { outcome?: unknown; accurate?: unknown };
		if (!sessionName || !id) {
			res.status(400).json({ success: false, error: 'sessionName and id params are required' });
			return;
		}
		if (typeof outcome !== 'string' || outcome.trim().length === 0) {
			res.status(400).json({ success: false, error: 'outcome must be a non-empty string' });
			return;
		}
		const wasAccurate = deriveAccurate(outcome, accurate);
		if (wasAccurate === null) {
			res.status(400).json({
				success: false,
				error: 'accurate (boolean) is required unless outcome is a plain verdict such as "correct" or "wrong"',
			});
			return;
		}
		try {
			const prediction = await services.predictions.resolvePrediction(sessionName, id, outcome.trim(), wasAccurate);
			if (!prediction) {
				res.status(404).json({ success: false, error: `Prediction ${id} not found` });
				return;
			}
			const calibrationScore = await services.predictions.getCalibrationScore(sessionName);
			logger.info('Prediction resolved', { sessionName, id, accurate: wasAccurate, calibrationScore });
			res.json({ success: true, data: { prediction, calibrationScore } });
		} catch (err) {
			res.status(500).json({ success: false, error: errorMessage(err, 'Failed to resolve prediction') });
		}
	};

	return { getOverview, setFocus, suppress, recordPrediction, resolvePrediction };
}

/**
 * Create the router for `/api/agents/:sessionName/self-improvement/*`.
 *
 * @param services - Optional service bundle override (tests)
 * @returns Express router to mount at `/agents`
 */
export function createAgentSelfImprovementRouter(services?: SelfImprovementServices): Router {
	const router = Router();
	const h = createSelfImprovementHandlers(services);
	const base = '/:sessionName/self-improvement';

	router.get(base, h.getOverview);
	router.post(`${base}/attention/focus`, h.setFocus);
	router.post(`${base}/attention/suppress`, h.suppress);
	router.post(`${base}/predictions`, h.recordPrediction);
	router.post(`${base}/predictions/:id/resolve`, h.resolvePrediction);

	return router;
}
