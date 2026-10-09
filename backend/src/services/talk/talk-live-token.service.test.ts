/**
 * Tests for Gemini Live ephemeral tokens (Google mocked): the request is
 * locked to the briefer's setup, the key goes only in the header to Google,
 * nothing secret is logged, and failures map to codes.
 */

import {
  driveSystemInstruction,
  driveToolDeclarations,
  parseLiveLanguage,
  setupFieldMask,
  TalkLiveTokenService,
} from './talk-live-token.service.js';

const KEY = 'AIzaTEST-not-a-real-key';
const NOW = new Date('2026-10-08T10:00:00.000Z');

/** A logger that records everything it was given. */
function recordingLogger() {
  const lines: unknown[] = [];
  const rec = (...args: unknown[]) => lines.push(args);
  return { lines, logger: { info: rec, warn: rec, error: rec, debug: rec } as never };
}

/** A fetch that answers once. */
function fakeFetch(status: number, body: unknown) {
  return jest.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('mint', () => {
  it('asks Google for a one-use token locked to the briefer setup', async () => {
    const fetchImpl = fakeFetch(200, { name: 'auth_tokens/abc123' });
    const { lines, logger } = recordingLogger();
    const service = new TalkLiveTokenService({ getApiKey: () => KEY, fetchImpl: fetchImpl as unknown as typeof fetch, env: {}, now: () => NOW, logger });
    const out = await service.mint('zh');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      uses: 1,
      expireTime: '2026-10-08T10:30:00.000Z',
      newSessionExpireTime: '2026-10-08T10:01:00.000Z',
      bidiGenerateContentSetup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } },
    });
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations.map((f: { name: string }) => f.name)).toEqual([
      'list_targets',
      'send_to',
      'check_replies',
      'recall',
      'get_waiting_item',
      'answer_item',
      'skip_item',
      'later_item',
      'end_session',
    ]);
    // Voice activity detection is locked too: small sounds must not cut the voice off.
    expect(body.bidiGenerateContentSetup.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        prefixPaddingMs: 300,
        silenceDurationMs: 800,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    });
    const mask = body.fieldMask.split(',');
    expect(mask).toEqual(
      expect.arrayContaining(['model', 'generationConfig.responseModalities', 'generationConfig.speechConfig', 'systemInstruction.parts', 'tools', 'realtimeInputConfig']),
    );
    expect(mask.filter((f: string) => /^tools\.|^realtimeInputConfig\./.test(f))).toEqual([]);
    for (const key of Object.keys(body.bidiGenerateContentSetup)) expect(mask.some((f: string) => f === key || f.startsWith(`${key}.`))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);

    expect(out).toMatchObject({ token: 'auth_tokens/abc123', model: 'gemini-3.8-live', apiVersion: 'v1alpha', language: 'zh' });
    expect(out.wsUrl).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc123',
    );
    expect(out.setup.systemInstruction.parts[0].text).toContain('Mandarin Chinese');
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(JSON.stringify(lines)).not.toContain('abc123');
  });

  it('model and API version can be overridden', async () => {
    const fetchImpl = fakeFetch(200, { name: 'auth_tokens/x' });
    const service = new TalkLiveTokenService({
      getApiKey: () => KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { CREWLY_GEMINI_LIVE_MODEL: 'gemini-3.8-live-extended-thinking', CREWLY_GEMINI_LIVE_API_VERSION: 'v1beta' },
      logger: recordingLogger().logger,
    });
    const out = await service.mint('en');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(out).toMatchObject({ model: 'gemini-3.8-live-extended-thinking', apiVersion: 'v1beta' });
  });

  it('no key: no_gemini_key, nothing sent', async () => {
    const fetchImpl = fakeFetch(200, {});
    const service = new TalkLiveTokenService({ getApiKey: () => null, fetchImpl: fetchImpl as unknown as typeof fetch, logger: recordingLogger().logger });
    await expect(service.mint('zh')).rejects.toMatchObject({ status: 409, code: 'no_gemini_key', message: expect.stringContaining('Add a Gemini API key in Settings') });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.hasKey()).toBe(false);
  });

  it('Google refuses: google_rejected with the status word only', async () => {
    const fetchImpl = fakeFetch(403, { error: { status: 'PERMISSION_DENIED', message: `key ${KEY} invalid` } });
    const { lines, logger } = recordingLogger();
    const service = new TalkLiveTokenService({ getApiKey: () => KEY, fetchImpl: fetchImpl as unknown as typeof fetch, logger });
    const err = await service.mint('zh').catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'google_rejected' });
    expect(err.message).toContain('PERMISSION_DENIED');
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it('network failure: unreachable', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const service = new TalkLiveTokenService({ getApiKey: () => KEY, fetchImpl: fetchImpl as unknown as typeof fetch, logger: recordingLogger().logger });
    await expect(service.mint('zh')).rejects.toMatchObject({ status: 502, code: 'unreachable' });
  });

  it('falls back to GEMINI_API_KEY in the environment', () => {
    const service = new TalkLiveTokenService({ env: { GEMINI_API_KEY: ' k ' }, logger: recordingLogger().logger });
    // The stored Antigravity key (if any) wins; with none, the env key counts.
    expect(service.hasKey()).toBe(true);
  });
});

describe('setup pieces', () => {
  it('field mask follows the SDK: top-level keys and one level down', () => {
    expect(setupFieldMask({ model: 'm', generationConfig: { a: 1, b: 2 }, inputAudioTranscription: {} })).toBe('model,generationConfig.a,generationConfig.b,inputAudioTranscription');
  });

  it('field mask: tools and realtimeInputConfig by their top-level key', () => {
    expect(setupFieldMask({ tools: [{ x: 1 }], realtimeInputConfig: { automaticActivityDetection: { a: 1 }, activityHandling: 'x' } })).toBe('tools,realtimeInputConfig');
  });

  it('every tool that names an item requires item_id; send_to needs a target and words', () => {
    for (const f of driveToolDeclarations()) {
      if (f.parameters?.properties.item_id) expect(f.parameters.required).toContain('item_id');
    }
    expect(driveToolDeclarations().find((f) => f.name === 'send_to')?.parameters?.required).toEqual(['target', 'text']);
  });

  it('the instruction: voice orchestrator, routes words, relays replies faithfully, cards only on request', () => {
    const text = driveSystemInstruction('zh');
    expect(text).toMatch(/voice orchestrator/);
    expect(text).toMatch(/never paraphrase/);
    expect(text).toMatch(/never invent/);
    expect(text).toMatch(/Only when the owner asks/);
    expect(text).toMatch(/Never read URLs, ids/);
    expect(text).toMatch(/确认吗/);
    expect(driveSystemInstruction('es')).toContain('Spanish');
  });

  it('parses the language', () => {
    expect(parseLiveLanguage('en-US')).toBe('en');
    expect(parseLiveLanguage('es')).toBe('es');
    expect(parseLiveLanguage('fr')).toBe('zh');
    expect(parseLiveLanguage(undefined)).toBe('zh');
  });
});
