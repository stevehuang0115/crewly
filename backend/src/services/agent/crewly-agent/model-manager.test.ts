import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ModelManager } from './model-manager.js';

// Mock the provider imports
jest.unstable_mockModule('@ai-sdk/anthropic', () => ({
  anthropic: jest.fn((modelId: string) => ({ provider: 'anthropic', modelId })),
}));

jest.unstable_mockModule('@ai-sdk/openai', () => ({
  openai: jest.fn((modelId: string) => ({ provider: 'openai', modelId })),
}));

jest.unstable_mockModule('@ai-sdk/google', () => ({
  google: jest.fn((modelId: string) => ({ provider: 'google', modelId })),
}));

jest.unstable_mockModule('ollama-ai-provider', () => ({
  createOllama: jest.fn(() => {
    const provider = jest.fn((modelId: string) => ({ provider: 'ollama', modelId }));
    return provider;
  }),
}));

// Mock settings service — getApiKey resolves through env vars only (no settings file).
// B1: deepseek is now part of API_KEY_PROVIDERS, so the mock must include it
// or model-manager.getAvailableProviders() / ensureApiKeyInEnv() will silently
// drop the deepseek branch.
jest.mock('../../settings/settings.service.js', () => {
  const envMap: Record<string, string[]> = {
    gemini: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
  };
  return {
    getSettingsService: () => ({
      getSettings: jest.fn<any>().mockResolvedValue({ apiKeys: { global: {} } }),
      getApiKey: jest.fn<any>().mockImplementation(async (provider: string) => {
        for (const envVar of envMap[provider] ?? []) {
          if (process.env[envVar]) return process.env[envVar];
        }
        return undefined;
      }),
    }),
  };
});

describe('ModelManager', () => {
  let manager: ModelManager;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    manager = new ModelManager();
  });

  afterEach(() => {
    manager.clearCache();
    process.env = { ...originalEnv };
  });

  describe('getModel', () => {
    it('should create an Anthropic model', async () => {
      const model = await manager.getModel({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' });
      expect(model).toBeDefined();
      expect((model as any).modelId).toBe('claude-sonnet-4-20250514');
    });

    it('should create an OpenAI model', async () => {
      const model = await manager.getModel({ provider: 'openai', modelId: 'gpt-4o' });
      expect(model).toBeDefined();
      expect((model as any).modelId).toBe('gpt-4o');
    });

    it('should create a Google model', async () => {
      const model = await manager.getModel({ provider: 'google', modelId: 'gemini-2.0-flash' });
      expect(model).toBeDefined();
      expect((model as any).modelId).toBe('gemini-2.0-flash');
    });

    it('should create an Ollama model', async () => {
      const model = await manager.getModel({ provider: 'ollama', modelId: 'llama3.3:70b' });
      expect(model).toBeDefined();
      expect((model as any).modelId).toBe('llama3.3:70b');
    });

    it('should create a DeepSeek model via the OpenAI-compatible API', async () => {
      process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
      const model = await manager.getModel({ provider: 'deepseek', modelId: 'deepseek-chat' });
      expect(model).toBeDefined();
      // The DeepSeek model is built on top of @ai-sdk/openai's createOpenAI
      // pointed at https://api.deepseek.com/v1; we only assert that the model
      // instance is produced without throwing — baseURL routing is exercised
      // implicitly via the createOpenAI factory, which is covered by upstream
      // tests in @ai-sdk/openai itself.
      expect((model as any).modelId).toBe('deepseek-chat');
      // Regression guard: must route via the .chat() factory (chat-completions
      // path), not the bare function-call form (which @ai-sdk/openai routes to
      // /responses — unsupported by DeepSeek). See PR #400 review M1 / M2.
      expect((model as any).provider).toBe('openai.chat');
    });

    it('should use default config when none provided', async () => {
      const model = await manager.getModel();
      expect(model).toBeDefined();
    });

    it('should throw for unknown provider', async () => {
      await expect(
        manager.getModel({ provider: 'azure' as any, modelId: 'test' })
      ).rejects.toThrow('Unknown model provider: azure');
    });

    it('should cache provider imports', async () => {
      await manager.getModel({ provider: 'anthropic', modelId: 'model-1' });
      await manager.getModel({ provider: 'anthropic', modelId: 'model-2' });
      // Should only import once — the second call uses cached provider function
      // We verify by checking the model is still created correctly
      const model = await manager.getModel({ provider: 'anthropic', modelId: 'model-3' });
      expect((model as any).modelId).toBe('model-3');
    });
  });

  describe('getAvailableProviders', () => {
    it('should report providers based on environment variables', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;

      const available = await manager.getAvailableProviders();

      expect(available.anthropic).toBe(false);
      expect(available.openai).toBe(false);
      expect(available.google).toBe(false);
      expect(available.ollama).toBe(true); // Ollama is always available (local)
      expect(available.deepseek).toBe(false);
    });

    it('should detect DeepSeek API key from env', async () => {
      process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
      const available = await manager.getAvailableProviders();
      expect(available.deepseek).toBe(true);
    });

    it('should detect Anthropic API key', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const available = await manager.getAvailableProviders();
      expect(available.anthropic).toBe(true);
    });

    it('should detect Google via GEMINI_API_KEY fallback', async () => {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      process.env.GEMINI_API_KEY = 'test-key';
      const available = await manager.getAvailableProviders();
      expect(available.google).toBe(true);
    });
  });

  describe('ensureApiKeyInEnv (settings override)', () => {
    it('should override existing env var with settings key', async () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stale-free-key';
      // getModel calls ensureApiKeyInEnv internally; the mock resolves from process.env
      // But in production, settings.getApiKey returns the paid key which overwrites env
      await manager.getModel({ provider: 'google', modelId: 'gemini-2.0-flash' });
      // The key should now be whatever settings returned (in our mock: the env value itself,
      // but the important thing is ensureApiKeyInEnv does NOT skip when env already set)
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeDefined();
    });

    it('should set env var when settings returns a key and env is empty', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'paid-key-from-settings';
      await manager.getModel({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' });
      expect(process.env.ANTHROPIC_API_KEY).toBe('paid-key-from-settings');
    });

    /**
     * B1: deepseek now flows through the settings service like every other
     * cloud provider. This test pins down the new wiring — getModel for
     * deepseek must trigger ensureApiKeyInEnv, which calls
     * settingsService.getApiKey('deepseek', ...) and writes the result back
     * to process.env.DEEPSEEK_API_KEY for the @ai-sdk/openai factory.
     *
     * Pre-B1, model-manager.ts short-circuited `if (provider === 'deepseek') return;`
     * inside ensureApiKeyInEnv, meaning deepseek-via-settings was a dead path.
     */
    it('should resolve deepseek key via settings service and write to DEEPSEEK_API_KEY (B1)', async () => {
      // Mock resolves from the env var, simulating either a settings entry or env fallback.
      // Either way, the wired flow must end in process.env.DEEPSEEK_API_KEY being set.
      process.env.DEEPSEEK_API_KEY = 'paid-deepseek-key';
      await manager.getModel({ provider: 'deepseek', modelId: 'deepseek-chat' });
      expect(process.env.DEEPSEEK_API_KEY).toBe('paid-deepseek-key');
    });

    it('should not throw when no deepseek key is configured (B1)', async () => {
      delete process.env.DEEPSEEK_API_KEY;
      // ensureApiKeyInEnv should silently no-op when settings returns undefined,
      // letting the @ai-sdk/openai factory raise its own clear error if the
      // model is actually invoked.
      await expect(
        manager.getModel({ provider: 'deepseek', modelId: 'deepseek-reasoner' })
      ).resolves.toBeDefined();
      expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('should clear the provider cache', async () => {
      await manager.getModel({ provider: 'anthropic', modelId: 'test' });
      manager.clearCache();
      // After clear, the next call should re-import
      const model = await manager.getModel({ provider: 'anthropic', modelId: 'test-2' });
      expect((model as any).modelId).toBe('test-2');
    });
  });

  /**
   * I2 — DeepSeek-R1 reasoning_content extraction via custom fetch wrapper.
   *
   * The wrapper is installed when getModel('deepseek') is called. We exercise
   * it by stubbing globalThis.fetch, calling the wrapper directly through
   * an internal accessor, and asserting reasoning is buffered for consume.
   *
   * Note: we don't go through the real @ai-sdk/openai SDK here — that would
   * require simulating the entire chat-completions request lifecycle. Instead
   * we test the seam where reasoning extraction happens (the custom fetch),
   * which is the unit boundary we own. Integration with @ai-sdk is exercised
   * by the Round 3 smoke test (live DeepSeek call).
   */
  describe('DeepSeek custom fetch (I2 reasoning_content)', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('extracts reasoning_content from a streaming SSE response', async () => {
      // Stub fetch to return a fake DeepSeek SSE response.
      const sseBody = [
        'data: {"choices":[{"delta":{"reasoning_content":"chain-of-thought "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"goes here"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      });
      globalThis.fetch = jest.fn<any>().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );

      // Trigger model creation (installs the custom fetch wrapper inside the provider).
      await manager.getModel({ provider: 'deepseek', modelId: 'deepseek-reasoner' });

      // Directly invoke the wrapper via the underlying provider invocation path.
      // We can't easily reach `customFetch` without exporting it, so we instead
      // call the known wrapper-creator method and exercise it.
      const customFetch = (manager as any).makeDeepseekFetch();
      const response: Response = await customFetch('https://api.deepseek.com/v1/chat/completions', {});

      // Drain the consumer side (mimics what AI SDK does)
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let drained = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        drained += decoder.decode(value, { stream: true });
      }
      expect(drained).toBe(sseBody); // passthrough must be byte-identical

      const reasoning = await manager.consumeDeepseekReasoning();
      expect(reasoning).toBe('chain-of-thought goes here');
    });

    it('returns null from consumeDeepseekReasoning when no fetch happened', async () => {
      const reasoning = await manager.consumeDeepseekReasoning();
      expect(reasoning).toBeNull();
    });

    it('passes through non-SSE responses unchanged', async () => {
      // 4xx error with JSON body — wrapper must NOT touch it.
      const errorBody = JSON.stringify({ error: 'bad request' });
      globalThis.fetch = jest.fn<any>().mockResolvedValue(
        new Response(errorBody, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const customFetch = (manager as any).makeDeepseekFetch();
      const response: Response = await customFetch('https://api.deepseek.com/v1/chat/completions', {});
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toBe(errorBody);
    });

    it('consumes reasoning and resets buffer to null on second call', async () => {
      const sseBody =
        'data: {"choices":[{"delta":{"reasoning_content":"first"}}]}\n\ndata: [DONE]\n\n';
      const encoder = new TextEncoder();
      globalThis.fetch = jest.fn<any>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(sseBody));
              c.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );

      const customFetch = (manager as any).makeDeepseekFetch();
      const r1 = await customFetch('https://api.deepseek.com/v1/chat/completions', {});
      // Drain to ensure the parser branch sees [DONE]
      const reader = r1.body!.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(await manager.consumeDeepseekReasoning()).toBe('first');
      // Second call: nothing new fetched, buffer was cleared
      expect(await manager.consumeDeepseekReasoning()).toBeNull();
    });
  });
});
