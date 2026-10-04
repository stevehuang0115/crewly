/**
 * Routes for Talk transcription (#1074), mounted at `/api/talk/transcribe`.
 *
 * @module controllers/talk/talk-transcribe.routes
 */

import { Router } from 'express';
import { getTranscribeStatus, startTranscribeSetup, transcribeClip } from './talk-transcribe.controller.js';

/**
 * Create the Talk transcription router.
 *
 * Routes (all owner only):
 * - GET  /status — Whisper ready?, missing pieces, queue, setup state
 * - POST /       — transcribe one clip
 * - POST /setup  — install the engine in the background
 *
 * @returns Express router
 */
export function createTalkTranscribeRouter(): Router {
	const router = Router();
	router.get('/status', getTranscribeStatus);
	router.post('/setup', startTranscribeSetup);
	router.post('/', transcribeClip);
	return router;
}
