/**
 * Standing Answers Controller — HTTP surface for standing-answer pages (#816).
 *
 * - `GET  /api/standing?projectPath=…&sessionName=…` — page statuses
 *   (question, file, stale?, how many newer memories, current sections, and
 *   sections whose cited sources were retracted).
 * - `PUT  /api/standing/:pageId/section` — section-level edit; backs the
 *   `core/standing-update` agent skill. Body:
 *   `{ projectPath?, sessionName?, heading, body, cites: string[] }`.
 *
 * Validation lives in {@link StandingAnswersService.writeSection}; a
 * {@link StandingAnswersError} maps to 400 with its `code`, anything else to 500.
 *
 * `projectPath` (both routes) must resolve — `path.resolve`, symlinks
 * followed — to a project registered in `projects.json` or to CREWLY_HOME;
 * anything else is 400 `unknown_project` (#822). Without this, a caller could
 * create a `.crewly/wiki/...` tree in any directory the backend can write to.
 *
 * @module controllers/standing/standing.controller
 */

import path from 'path';
import { promises as fs } from 'fs';
import { Router, type Request as ExpressRequest, type Response } from 'express';
import { StorageService } from '../../services/core/storage.service.js';
import { getCrewlyHomePath } from '../../services/core/crewly-home.utils.js';
import {
	StandingAnswersService,
	StandingAnswersError,
	type StandingPageStatus,
	type InvalidatedSection,
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
	/** Sections whose cited entries were deleted or are no longer in force (#914). */
	basisInvalidated: InvalidatedSection[];
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
		basisInvalidated: s.invalidatedSections,
	};
}

/** First string value of a query/body field, or undefined. */
function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Lists the directories a `projectPath` may name: registered projects and CREWLY_HOME. */
export type AllowedProjectPathsSource = () => Promise<string[]>;

/**
 * Default allow-list: every project in `projects.json` plus CREWLY_HOME.
 *
 * @returns Absolute directory paths
 */
async function defaultAllowedProjectPaths(): Promise<string[]> {
	const projects = await StorageService.getInstance().getProjects();
	return [...projects.map((p) => p.path).filter((p): p is string => typeof p === 'string' && p.length > 0), getCrewlyHomePath()];
}

/**
 * Canonical form of a path: absolute, normalized (no `..`), symlinks followed
 * when the path exists.
 *
 * @param p - Path to canonicalize
 * @returns Canonical absolute path
 */
async function canonicalPath(p: string): Promise<string> {
	const resolved = path.resolve(p);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Resolve a caller-supplied `projectPath` against the allow-list (#822).
 *
 * @param projectPath - Path from the request
 * @param allowed - Allowed directories
 * @returns The matching allowed directory (as registered), or null when the
 *   path is not a registered project or CREWLY_HOME
 */
export async function resolveAllowedProjectPath(projectPath: string, allowed: string[]): Promise<string | null> {
	if (!path.isAbsolute(projectPath)) return null;
	const target = await canonicalPath(projectPath);
	for (const candidate of allowed) {
		if ((await canonicalPath(candidate)) === target) return candidate;
	}
	return null;
}

/**
 * Create the standing-answers router.
 *
 * @param service - Page service (injectable for tests)
 * @param allowedProjectPaths - Allow-list source for `projectPath` (injectable for tests)
 * @returns Express router, mounted at `/api/standing`
 */
export function createStandingRouter(
	service: StandingAnswersService = new StandingAnswersService(),
	allowedProjectPaths: AllowedProjectPathsSource = defaultAllowedProjectPaths,
): Router {
	const router = Router();

	/**
	 * Check an optional `projectPath`; answers 400 `unknown_project` and
	 * returns false when it is not allowed.
	 */
	const checkProjectPath = async (
		projectPath: string | undefined,
		res: Response,
	): Promise<{ ok: true; projectPath: string | undefined } | { ok: false }> => {
		if (!projectPath) return { ok: true, projectPath: undefined };
		const match = await resolveAllowedProjectPath(projectPath, await allowedProjectPaths());
		if (!match) {
			res.status(400).json({ success: false, code: 'unknown_project', error: 'projectPath is not a registered project' });
			return { ok: false };
		}
		return { ok: true, projectPath: match };
	};

	/**
	 * GET / — statuses for a project and/or an agent session.
	 */
	router.get('/', async (req: ExpressRequest, res: Response) => {
		const sessionName = str(req.query.sessionName);
		if (!str(req.query.projectPath) && !sessionName) {
			res.status(400).json({ success: false, error: 'projectPath or sessionName is required' });
			return;
		}
		try {
			const checked = await checkProjectPath(str(req.query.projectPath), res);
			if (!checked.ok) return;
			const projectPath = checked.projectPath;
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
			const checked = await checkProjectPath(str(b.projectPath), res);
			if (!checked.ok) return;
			const result = await service.writeSection({
				pageId: req.params.pageId,
				projectPath: checked.projectPath,
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
