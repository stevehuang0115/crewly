/**
 * Standing Answers Controller — HTTP surface for standing-answer pages (#816).
 *
 * - `GET  /api/standing?projectPath=…&sessionName=…` — page statuses
 *   (question, file, stale?, how many newer memories, current sections).
 * - `PUT  /api/standing/:pageId/section` — section-level edit; backs the
 *   `core/standing-update` agent skill. Body:
 *   `{ projectPath?, sessionName?, heading, body, cites: string[] }`.
 *
 * Validation lives in {@link StandingAnswersService.writeSection}; a
 * {@link StandingAnswersError} maps to 400 with its `code`, anything else to 500.
 *
 * @module controllers/standing/standing.controller
 */

import { Router, type Request as ExpressRequest, type Response } from 'express';
import {
	StandingAnswersService,
	StandingAnswersError,
	type StandingPageStatus,
} from '../../services/memory/standing-answers.service.js';

/** JSON shape of one page status. */
export interface StandingPageStatusDto {
	pageId: string;
	scope: string;
	question: string;
	filePath: string;
	exists: boolean;
	stale: boolean;
	entriesInScope: number;
	newerEntries: number;
	watermark: string | null;
	currentWatermark: string | null;
	lastRefreshed: string | null;
	sections: Array<{ heading: string; cites: string[] }>;
}

/**
 * Convert a status to its JSON shape (section bodies are omitted — read the file).
 *
 * @param s - Page status
 * @returns DTO
 */
export function toStatusDto(s: StandingPageStatus): StandingPageStatusDto {
	return {
		pageId: s.def.id,
		scope: s.def.scope,
		question: s.def.question,
		filePath: s.filePath,
		exists: Boolean(s.page),
		stale: s.stale,
		entriesInScope: s.entriesInScope,
		newerEntries: s.newerEntries,
		watermark: s.page?.watermark ?? null,
		currentWatermark: s.currentWatermark,
		lastRefreshed: s.page?.lastRefreshed ?? null,
		sections: (s.page?.sections ?? []).map((x) => ({ heading: x.heading, cites: x.cites })),
	};
}

/** First string value of a query/body field, or undefined. */
function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Create the standing-answers router.
 *
 * @param service - Page service (injectable for tests)
 * @returns Express router, mounted at `/api/standing`
 */
export function createStandingRouter(service: StandingAnswersService = new StandingAnswersService()): Router {
	const router = Router();

	/**
	 * GET / — statuses for a project and/or an agent session.
	 */
	router.get('/', async (req: ExpressRequest, res: Response) => {
		const projectPath = str(req.query.projectPath);
		const sessionName = str(req.query.sessionName);
		if (!projectPath && !sessionName) {
			res.status(400).json({ success: false, error: 'projectPath or sessionName is required' });
			return;
		}
		try {
			const statuses = await service.listPageStatuses({ projectPath, sessionName });
			res.json({ success: true, data: { pagesExamined: statuses.length, pages: statuses.map(toStatusDto) } });
		} catch (error) {
			res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	/**
	 * PUT /:pageId/section — write, replace or (empty body) remove one section.
	 */
	router.put('/:pageId/section', async (req: ExpressRequest, res: Response) => {
		const b = (req.body ?? {}) as Record<string, unknown>;
		if (typeof b.heading !== 'string' || typeof b.body !== 'string') {
			res.status(400).json({ success: false, code: 'invalid_input', error: 'heading and body (strings) are required' });
			return;
		}
		const cites = Array.isArray(b.cites) ? b.cites.filter((c): c is string => typeof c === 'string') : typeof b.cites === 'string' ? b.cites.split(',') : [];
		try {
			const result = await service.writeSection({
				pageId: req.params.pageId,
				projectPath: str(b.projectPath),
				sessionName: str(b.sessionName),
				heading: b.heading,
				body: b.body,
				cites,
			});
			res.json({ success: true, data: result });
		} catch (error) {
			if (error instanceof StandingAnswersError) {
				res.status(400).json({ success: false, code: error.code, error: error.message });
				return;
			}
			res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	return router;
}
