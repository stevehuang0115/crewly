/**
 * Crewly Agent Model Manager
 *
 * Multi-provider model factory that creates AI SDK model instances
 * from configuration. Supports Anthropic, OpenAI, Google, DeepSeek, and
 * Ollama providers.
 *
 * API keys for cloud providers are resolved through the settings service
 * (skill → runtime → global → env var) and injected into process.env so the
 * provider SDKs can pick them up:
 * - ANTHROPIC_API_KEY
 * - OPENAI_API_KEY
 * - GOOGLE_GENERATIVE_AI_API_KEY
 * - DEEPSEEK_API_KEY (DeepSeek; served via OpenAI-compatible API)
 *
 * Ollama runs locally and does not require an API key.
 * Configure the Ollama base URL via OLLAMA_BASE_URL (default: http://localhost:11434).
 *
 * @module services/agent/crewly-agent/model-manager
 */

import type { LanguageModel } from 'ai';
import { type ModelConfig, type ModelProvider, CREWLY_AGENT_DEFAULTS } from './types.js';
import { getSettingsService } from '../../settings/settings.service.js';
import { ApiKeyProvider } from '../../../types/settings.types.js';

/**
 * Base URL for DeepSeek's OpenAI-compatible chat completions endpoint.
 * DeepSeek implements /chat/completions only — not /responses — so we
 * must route via the `.chat(modelId)` factory of @ai-sdk/openai's
 * createOpenAI() return value. Extracted per CLAUDE.md no-hardcoded-values rule.
 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * Factory for creating AI SDK language model instances from configuration.
 *
 * Uses dynamic imports to avoid loading provider SDKs that aren't needed,
 * keeping the startup cost minimal when only one provider is used.
 *
 * @example
 * ```typescript
 * const manager = new ModelManager();
 * const model = await manager.getModel({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' });
 * ```
 */
export class ModelManager {
  /** Cached provider module references to avoid re-importing */
  private providerCache = new Map<ModelProvider, (modelId: string) => LanguageModel>();

  /**
   * Get an AI SDK language model instance for the given configuration.
   *
   * Resolves API keys from settings (with override chain) and injects them
   * into the environment before creating the model, so provider SDKs can find them.
   *
   * @param config - Model configuration specifying provider and model ID
   * @returns AI SDK LanguageModel instance ready for use with generateText
   * @throws Error if the provider is unknown or the SDK is not installed
   */
  async getModel(config: ModelConfig = CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL): Promise<LanguageModel> {
    // Ensure the provider's API key is in the environment from settings
    await this.ensureApiKeyInEnv(config.provider);

    const providerFn = await this.getProviderFunction(config.provider);
    return providerFn(config.modelId);
  }

  /**
   * Get provider function, using cache for repeated calls.
   *
   * @param provider - Provider name
   * @returns Function that creates a model from a model ID string
   */
  private async getProviderFunction(provider: ModelProvider): Promise<(modelId: string) => LanguageModel> {
    const cached = this.providerCache.get(provider);
    if (cached) return cached;

    let providerFn: (modelId: string) => LanguageModel;

    try {
      switch (provider) {
        case 'anthropic': {
          const { anthropic } = await import('@ai-sdk/anthropic');
          providerFn = (modelId: string) => anthropic(modelId);
          break;
        }
        case 'openai': {
          const { openai } = await import('@ai-sdk/openai');
          providerFn = (modelId: string) => openai(modelId);
          break;
        }
        case 'google': {
          const { google } = await import('@ai-sdk/google');
          providerFn = (modelId: string) => google(modelId);
          break;
        }
        case 'ollama': {
          const { createOllama } = await import('ollama-ai-provider');
          const baseURL = process.env.OLLAMA_BASE_URL || CREWLY_AGENT_DEFAULTS.OLLAMA_BASE_URL;
          const ollamaProvider = createOllama({ baseURL });
          // ollama-ai-provider exports LanguageModelV1 which is compatible but
          // doesn't extend the newer LanguageModel union — safe to cast.
          providerFn = (modelId: string) => ollamaProvider(modelId) as unknown as LanguageModel;
          break;
        }
        case 'deepseek': {
          // DeepSeek API is OpenAI-compatible — reuse the OpenAI SDK with a custom baseURL.
          // IMPORTANT: must call deepseekProvider.chat(modelId), NOT deepseekProvider(modelId).
          // The bare function-call form on @ai-sdk/openai >=3.x routes to /responses, which
          // DeepSeek does not implement — it only exposes /chat/completions. The .chat factory
          // forces the chat-completions path. See PR #400 review for full trace.
          const { createOpenAI } = await import('@ai-sdk/openai');
          const deepseekProvider = createOpenAI({
            baseURL: DEEPSEEK_BASE_URL,
            apiKey: process.env.DEEPSEEK_API_KEY,
          });
          providerFn = (modelId: string) => deepseekProvider.chat(modelId);
          break;
        }
        default:
          throw new Error(`Unknown model provider: ${provider}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown model provider:')) {
        throw error;
      }
      throw new Error(
        `Failed to load provider SDK for '${provider}'. Is the package installed? ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.providerCache.set(provider, providerFn);
    return providerFn;
  }

  /**
   * Check which providers have API keys configured (settings + env vars).
   *
   * @returns Object indicating which providers are available
   */
  async getAvailableProviders(): Promise<Record<ModelProvider, boolean>> {
    const settingsService = getSettingsService();
    const context = { runtime: 'crewly-agent' };

    const [geminiKey, anthropicKey, openaiKey, deepseekKey] = await Promise.all([
      settingsService.getApiKey('gemini', context),
      settingsService.getApiKey('anthropic', context),
      settingsService.getApiKey('openai', context),
      settingsService.getApiKey('deepseek', context),
    ]);

    return {
      anthropic: !!anthropicKey,
      openai: !!openaiKey,
      google: !!geminiKey,
      ollama: true, // Ollama runs locally, always "available" if installed
      deepseek: !!deepseekKey,
    };
  }

  /**
   * Map model provider name to API key provider name.
   * Only applicable for cloud providers wired through the settings service
   * (anthropic, openai, google, deepseek). Ollama runs locally and is
   * excluded.
   *
   * @param provider - Cloud model provider
   * @returns Corresponding ApiKeyProvider name
   */
  private static providerToApiKeyProvider(provider: Exclude<ModelProvider, 'ollama'>): ApiKeyProvider {
    return provider === 'google' ? 'gemini' : provider;
  }

  /**
   * Ensure the API key for a provider is available in process.env
   * by resolving it from settings if not already present.
   *
   * No-op for 'ollama' (runs locally, no key required). All other providers —
   * including 'deepseek' — flow through the settings service so users can
   * configure them from the UI without touching env vars.
   *
   * @param provider - The model provider
   */
  private async ensureApiKeyInEnv(provider: ModelProvider): Promise<void> {
    if (provider === 'ollama') return; // Ollama is local, no API key needed
    const apiKeyProvider = ModelManager.providerToApiKeyProvider(provider);
    const settingsService = getSettingsService();
    const key = await settingsService.getApiKey(apiKeyProvider, { runtime: 'crewly-agent' });

    if (!key) return;

    // Set env vars so the provider SDKs can find them.
    // Always override — settings keys take priority over stale env vars.
    switch (provider) {
      case 'anthropic':
        process.env.ANTHROPIC_API_KEY = key;
        break;
      case 'openai':
        process.env.OPENAI_API_KEY = key;
        break;
      case 'google':
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
        break;
      case 'deepseek':
        process.env.DEEPSEEK_API_KEY = key;
        break;
    }
  }

  /**
   * Clear the provider cache (useful for testing or reconfiguration).
   */
  clearCache(): void {
    this.providerCache.clear();
  }
}
