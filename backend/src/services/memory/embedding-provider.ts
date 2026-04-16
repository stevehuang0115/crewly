/**
 * Embedding Provider Abstraction (#155)
 *
 * Decouples embedding logic from specific APIs. Supports:
 * - Cloud: Gemini (default), OpenAI, Voyage
 * - Local: Ollama (for air-gapped/high-security environments)
 *
 * Provider selection via environment variables:
 * - GEMINI_API_KEY → GeminiEmbeddingProvider
 * - OPENAI_API_KEY → OpenAIEmbeddingProvider
 * - OLLAMA_HOST → OllamaEmbeddingProvider
 *
 * @see https://github.com/stevehuang0115/crewly/issues/155
 * @module services/memory/embedding-provider
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { EMBEDDING_CONSTANTS } from '../../constants.js';

/**
 * Abstract interface for embedding providers.
 * All providers must implement the embed() method.
 */
export interface EmbeddingProvider {
	/** Provider name for logging */
	readonly name: string;
	/** Embedding vector dimensions */
	readonly dimensions: number;

	/**
	 * Generate an embedding vector for the given text.
	 *
	 * @param text - Text to embed
	 * @returns Embedding vector, or null on failure
	 */
	embed(text: string): Promise<number[] | null>;
}

/**
 * Gemini embedding provider (default cloud provider).
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'gemini';
	readonly dimensions = 768;
	private readonly apiKey: string;
	private readonly logger: ComponentLogger;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
		this.logger = LoggerService.getInstance().createComponentLogger('GeminiEmbedding');
	}

	async embed(text: string): Promise<number[] | null> {
		try {
			const url = `${EMBEDDING_CONSTANTS.GEMINI_ENDPOINT}/${EMBEDDING_CONSTANTS.GEMINI_MODEL}:embedContent?key=${this.apiKey}`;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), EMBEDDING_CONSTANTS.TIMEOUT_MS);

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: `models/${EMBEDDING_CONSTANTS.GEMINI_MODEL}`,
						content: { parts: [{ text }] },
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					// #214: Log specific guidance for common error codes
					const hint = response.status === 404
						? 'Model may be deprecated — check Gemini embedding model availability'
						: response.status === 401 || response.status === 403
							? 'Check your GEMINI_API_KEY — it may be invalid or lack permissions'
							: '';
					this.logger.warn('Gemini embedding API error, falling back to keyword search', {
						status: response.status,
						model: EMBEDDING_CONSTANTS.GEMINI_MODEL,
						hint,
					});
					return null;
				}
				const data = (await response.json()) as { embedding?: { values?: number[] } };
				return data.embedding?.values ?? null;
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			this.logger.warn('Gemini embedding API call failed, falling back to keyword search', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}

/**
 * OpenAI embedding provider.
 * Uses the text-embedding-3-small model by default.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'openai';
	readonly dimensions = 1536;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly logger: ComponentLogger;

	constructor(apiKey: string, model = 'text-embedding-3-small') {
		this.apiKey = apiKey;
		this.model = model;
		this.logger = LoggerService.getInstance().createComponentLogger('OpenAIEmbedding');
	}

	async embed(text: string): Promise<number[] | null> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30000);

			try {
				const response = await fetch('https://api.openai.com/v1/embeddings', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify({ input: text, model: this.model }),
					signal: controller.signal,
				});

				if (!response.ok) return null;
				const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
				return data.data?.[0]?.embedding ?? null;
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			this.logger.warn('Embedding request failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}
}

/**
 * Ollama local embedding provider.
 * Runs entirely on-device for air-gapped environments.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'ollama';
	readonly dimensions = 768; // depends on model
	private readonly host: string;
	private readonly model: string;
	private readonly logger: ComponentLogger;

	constructor(host = 'http://localhost:11434', model = 'nomic-embed-text') {
		this.host = host;
		this.model = model;
		this.logger = LoggerService.getInstance().createComponentLogger('OllamaEmbedding');
	}

	async embed(text: string): Promise<number[] | null> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30000);

			try {
				const response = await fetch(`${this.host}/api/embeddings`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: this.model, prompt: text }),
					signal: controller.signal,
				});

				if (!response.ok) return null;
				const data = (await response.json()) as { embedding?: number[] };
				return data.embedding ?? null;
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			this.logger.warn('Embedding request failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}
}

/**
 * Create the best available embedding provider based on environment config.
 *
 * Priority: GEMINI_API_KEY > OPENAI_API_KEY > OLLAMA_HOST > null
 *
 * @returns EmbeddingProvider instance, or null if none configured
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
	const geminiKey = process.env.GEMINI_API_KEY;
	if (geminiKey) {
		return new GeminiEmbeddingProvider(geminiKey);
	}

	const openaiKey = process.env.OPENAI_API_KEY;
	if (openaiKey) {
		return new OpenAIEmbeddingProvider(openaiKey);
	}

	const ollamaHost = process.env.OLLAMA_HOST;
	if (ollamaHost) {
		return new OllamaEmbeddingProvider(ollamaHost);
	}

	return null;
}
