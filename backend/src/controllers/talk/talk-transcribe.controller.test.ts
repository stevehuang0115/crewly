/**
 * Tests for the Talk transcription API (#1074): owner-only, error codes the
 * phone falls back on, and the setup kick-off.
 */

import express from 'express';
import request from 'supertest';
import { ownerUnlessAgentForTests, relayAuthHeaders } from '../../middleware/caller-identity.testing.js';
import { setTalkTranscribeService, TalkTranscribeError, TalkTranscribeService } from '../../services/talk/talk-transcribe.service.js';
import { createTalkTranscribeRouter } from './talk-transcribe.routes.js';

const app = express();
app.use(ownerUnlessAgentForTests);
app.use(express.json({ limit: '10mb' }));
app.use('/api/talk/transcribe', createTalkTranscribeRouter());

let transcribe: jest.Mock;
let getStatus: jest.Mock;
let startSetup: jest.Mock;

beforeEach(() => {
	transcribe = jest.fn(async () => ({ text: '你好 CE', language: 'zh', durationSec: 2, engine: 'whisper.cpp', deviceName: 'macbookpro', elapsedMs: 900 }));
	getStatus = jest.fn(async () => ({ whisperReady: true, missing: [], deviceName: 'macbookpro', busy: false, queued: 0, maxDurationSec: 90, maxAudioBytes: 655360 }));
	startSetup = jest.fn(async () => ({ state: 'running', jobId: 'job-1' }));
	setTalkTranscribeService({ transcribe, getStatus, startSetup } as unknown as TalkTranscribeService);
});

afterEach(() => setTalkTranscribeService(null));

describe('owner only', () => {
	it('refuses agents on every route', async () => {
		for (const [method, path] of [['get', '/api/talk/transcribe/status'], ['post', '/api/talk/transcribe'], ['post', '/api/talk/transcribe/setup']] as const) {
			const res = await request(app)[method](path).set('X-Agent-Session', 'ella').send({ audio: 'AAAA', mimeType: 'audio/mp4' });
			expect(res.status).toBe(403);
			expect(res.body.code).toBe('owner_only');
		}
		expect(transcribe).not.toHaveBeenCalled();
		expect(startSetup).not.toHaveBeenCalled();
	});

	it('serves the owner and the relay (phone / portal)', async () => {
		expect((await request(app).get('/api/talk/transcribe/status')).body.data.whisperReady).toBe(true);
		const res = await request(app).post('/api/talk/transcribe').set(relayAuthHeaders()).send({ audio: 'AAAA', mimeType: 'audio/mp4', language: 'auto' });
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({ text: '你好 CE', engine: 'whisper.cpp', deviceName: 'macbookpro' });
		expect(transcribe).toHaveBeenCalledWith({ audio: 'AAAA', mimeType: 'audio/mp4', language: 'auto' });
	});
});

describe('errors carry the code the phone falls back on', () => {
	it.each([
		['whisper_unavailable', 503],
		['too_long', 413],
		['timeout', 504],
		['failed', 500],
		['busy', 429],
		['invalid_audio', 400],
	] as const)('%s → %i', async (code, status) => {
		transcribe.mockRejectedValueOnce(new TalkTranscribeError(code, 'nope'));
		const res = await request(app).post('/api/talk/transcribe').send({ audio: 'AAAA', mimeType: 'audio/mp4' });
		expect(res.status).toBe(status);
		expect(res.body).toEqual({ success: false, code, error: 'nope' });
	});

	it('an unexpected error is `failed` without details', async () => {
		transcribe.mockRejectedValueOnce(new Error('secret path /tmp/x'));
		const res = await request(app).post('/api/talk/transcribe').send({});
		expect(res.status).toBe(500);
		expect(res.body).toEqual({ success: false, code: 'failed', error: 'Transcription failed' });
	});
});

describe('POST /setup', () => {
	it('202 while installing, 200 when already ready', async () => {
		const running = await request(app).post('/api/talk/transcribe/setup');
		expect(running.status).toBe(202);
		expect(running.body.data).toEqual({ state: 'running', jobId: 'job-1' });
		startSetup.mockResolvedValueOnce({ state: 'succeeded' });
		expect((await request(app).post('/api/talk/transcribe/setup')).status).toBe(200);
	});
});
