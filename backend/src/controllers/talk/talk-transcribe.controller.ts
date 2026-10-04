/**
 * Talk transcription endpoints (specs/2026-10-04-talk-whisper-transcribe.md, #1074),
 * mounted at `/api/talk/transcribe` and reached from the portal over the relay.
 *
 * - `GET  /status` — whether Whisper is ready on this machine, what is missing, queue
 * - `POST /`       — `{ audio: base64, mimeType, language? }` → `{ text, language, durationSec, engine, deviceName }`
 * - `POST /setup`  — install ffmpeg + whisper-cli + model (transcribe-audio skill setup), in the background
 *
 * Owner only: an agent gets 403 and a caller without an owner credential
 * 401. The transcript goes back to the phone, never to an agent. Audio and
 * transcript are never logged.
 *
 * @module controllers/talk/talk-transcribe.controller
 */

import type { Request, Response } from 'express';
import { TALK_TRANSCRIBE_CONSTANTS } from '../../constants.js';
import { rejectNonOwner } from '../../middleware/caller-identity.middleware.js';
import { getTalkTranscribeService, TalkTranscribeError } from '../../services/talk/talk-transcribe.service.js';

const C = TALK_TRANSCRIBE_CONSTANTS;

/**
 * Refuse callers that are not the owner.
 *
 * @param req - Request
 * @param res - Response
 * @returns True when refused (response written)
 */
function refuseNonOwner(req: Request, res: Response): boolean {
	return rejectNonOwner(req, res, {
		success: false,
		code: C.CODES.OWNER_ONLY,
		error: 'Only the owner can use voice transcription.',
	});
}

/**
 * Answer an error: a {@link TalkTranscribeError} with its code, anything else as `failed`.
 *
 * @param res - Response
 * @param error - What was thrown
 */
function sendError(res: Response, error: unknown): void {
	if (error instanceof TalkTranscribeError) {
		res.status(error.httpStatus).json({ success: false, code: error.code, error: error.message });
		return;
	}
	res.status(500).json({ success: false, code: C.CODES.FAILED, error: 'Transcription failed' });
}

/**
 * GET /api/talk/transcribe/status
 *
 * @param req - Request
 * @param res - Response
 */
export async function getTranscribeStatus(req: Request, res: Response): Promise<void> {
	if (refuseNonOwner(req, res)) return;
	try {
		res.json({ success: true, data: await getTalkTranscribeService().getStatus() });
	} catch (error) {
		sendError(res, error);
	}
}

/**
 * POST /api/talk/transcribe — transcribe one clip.
 *
 * @param req - Request (`{ audio, mimeType, language? }`)
 * @param res - Response
 */
export async function transcribeClip(req: Request, res: Response): Promise<void> {
	if (refuseNonOwner(req, res)) return;
	const body = (req.body ?? {}) as { audio?: unknown; mimeType?: unknown; language?: unknown };
	try {
		const result = await getTalkTranscribeService().transcribe({ audio: body.audio, mimeType: body.mimeType, language: body.language });
		res.json({ success: true, data: result });
	} catch (error) {
		sendError(res, error);
	}
}

/**
 * POST /api/talk/transcribe/setup — start the Whisper install in the background.
 *
 * @param req - Request
 * @param res - Response
 */
export async function startTranscribeSetup(req: Request, res: Response): Promise<void> {
	if (refuseNonOwner(req, res)) return;
	try {
		const setup = await getTalkTranscribeService().startSetup();
		res.status(setup.state === 'running' ? 202 : 200).json({ success: true, data: setup });
	} catch (error) {
		sendError(res, error);
	}
}
