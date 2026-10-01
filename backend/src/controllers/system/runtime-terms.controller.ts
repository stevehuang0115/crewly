/**
 * Runtime Terms consent endpoints (Settings → Runtimes).
 *
 * - `GET  /api/system/runtime-terms` — every runtime with a Terms flow and its state
 * - `POST /api/system/runtime-terms/:runtime/request` — "Accept terms…": post the
 *   Slack card (or return the open one)
 * - `POST /api/system/runtime-terms/:runtime/probe` — launch it in a dedicated
 *   session, read the first screen (nothing is pressed); a Terms screen posts the card
 * - `POST /api/system/runtime-terms/:runtime/answer { choice }` — answer inline
 *   (`agree_no_data` | `agree_share_data` | `decline`); goes through the card
 *   when one is open, so it updates too
 *
 * Owner only: a request from an agent session gets 403 — agents never accept
 * Terms. specs/2026-10-01-runtime-terms-consent.md
 *
 * @module controllers/system/runtime-terms.controller
 */

import type { Request, Response, Router } from 'express';
import { ensureOwnerCaller } from './system-control.controller.js';
import {
	getRuntimeTermsConsentService,
	TERMS_CHOICE_LABELS,
	type RuntimeTermsConsentService,
	type TermsChoice,
} from '../../services/runtime-terms/runtime-terms-consent.service.js';

/** Dependencies (tests inject fakes). */
export interface RuntimeTermsControllerDeps {
	terms: () => Pick<RuntimeTermsConsentService, 'list' | 'requestConsent' | 'answer' | 'supports' | 'probe'> | null;
}

const NOT_READY = 'Runtime Terms consent is not ready yet — Crewly is still starting.';

/**
 * Register the routes.
 *
 * @param router - The /api router
 * @param deps - Dependencies (default: the backend's)
 */
export function registerRuntimeTermsRoutes(router: Router, deps: RuntimeTermsControllerDeps = { terms: getRuntimeTermsConsentService }): void {
	router.get('/system/runtime-terms', (_req: Request, res: Response) => {
		const terms = deps.terms();
		if (!terms) {
			res.status(503).json({ success: false, error: NOT_READY });
			return;
		}
		res.json({ success: true, data: terms.list() });
	});

	router.post('/system/runtime-terms/:runtime/request', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'runtime-terms request')) return;
		const terms = deps.terms();
		if (!terms) {
			res.status(503).json({ success: false, error: NOT_READY });
			return;
		}
		if (!terms.supports(req.params.runtime)) {
			res.status(404).json({ success: false, error: `Crewly has no Terms flow for ${req.params.runtime}` });
			return;
		}
		try {
			res.json({ success: true, data: await terms.requestConsent(req.params.runtime) });
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.post('/system/runtime-terms/:runtime/probe', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'runtime-terms probe')) return;
		const terms = deps.terms();
		if (!terms) {
			res.status(503).json({ success: false, error: NOT_READY });
			return;
		}
		if (!terms.supports(req.params.runtime)) {
			res.status(404).json({ success: false, error: `Crewly has no Terms flow for ${req.params.runtime}` });
			return;
		}
		try {
			res.json({ success: true, data: await terms.probe(req.params.runtime) });
		} catch (err) {
			res.status(409).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.post('/system/runtime-terms/:runtime/answer', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'runtime-terms answer')) return;
		const terms = deps.terms();
		if (!terms) {
			res.status(503).json({ success: false, error: NOT_READY });
			return;
		}
		const choice = req.body?.choice as TermsChoice;
		if (!Object.prototype.hasOwnProperty.call(TERMS_CHOICE_LABELS, choice)) {
			res.status(400).json({ success: false, error: `choice must be one of ${Object.keys(TERMS_CHOICE_LABELS).join(' | ')}` });
			return;
		}
		if (!terms.supports(req.params.runtime)) {
			res.status(404).json({ success: false, error: `Crewly has no Terms flow for ${req.params.runtime}` });
			return;
		}
		try {
			res.json({ success: true, data: await terms.answer(req.params.runtime, choice) });
		} catch (err) {
			res.status(409).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});
}
