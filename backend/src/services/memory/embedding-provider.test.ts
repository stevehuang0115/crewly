/**
 * Tests for EmbeddingProvider abstraction (#155)
 */

import {
	GeminiEmbeddingProvider,
	OpenAIEmbeddingProvider,
	OllamaEmbeddingProvider,
	createEmbeddingProvider,
} from './embedding-provider.js';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				debug: jest.fn(),
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('EmbeddingProvider (#155)', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		delete process.env.GEMINI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.OLLAMA_HOST;
	});

	describe('GeminiEmbeddingProvider', () => {
		it('should have correct name and dimensions', () => {
			const provider = new GeminiEmbeddingProvider('test-key');
			expect(provider.name).toBe('gemini');
			expect(provider.dimensions).toBe(768);
		});

		it('should return embedding on success', async () => {
			const embedding = [0.1, 0.2, 0.3];
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ embedding: { values: embedding } }),
			});

			const provider = new GeminiEmbeddingProvider('test-key');
			const result = await provider.embed('test text');
			expect(result).toEqual(embedding);
		});

		it('should return null on API failure', async () => {
			mockFetch.mockResolvedValueOnce({ ok: false });

			const provider = new GeminiEmbeddingProvider('test-key');
			const result = await provider.embed('test text');
			expect(result).toBeNull();
		});

		it('should return null on network error', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			const provider = new GeminiEmbeddingProvider('test-key');
			const result = await provider.embed('test text');
			expect(result).toBeNull();
		});
	});

	describe('OpenAIEmbeddingProvider', () => {
		it('should have correct name and dimensions', () => {
			const provider = new OpenAIEmbeddingProvider('test-key');
			expect(provider.name).toBe('openai');
			expect(provider.dimensions).toBe(1536);
		});

		it('should return embedding on success', async () => {
			const embedding = [0.1, 0.2, 0.3];
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ data: [{ embedding }] }),
			});

			const provider = new OpenAIEmbeddingProvider('test-key');
			const result = await provider.embed('test text');
			expect(result).toEqual(embedding);
		});

		it('should return null on failure', async () => {
			mockFetch.mockRejectedValueOnce(new Error('error'));

			const provider = new OpenAIEmbeddingProvider('test-key');
			const result = await provider.embed('test text');
			expect(result).toBeNull();
		});
	});

	describe('OllamaEmbeddingProvider', () => {
		it('should have correct name', () => {
			const provider = new OllamaEmbeddingProvider();
			expect(provider.name).toBe('ollama');
		});

		it('should call local Ollama API', async () => {
			const embedding = [0.1, 0.2, 0.3];
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ embedding }),
			});

			const provider = new OllamaEmbeddingProvider('http://localhost:11434');
			const result = await provider.embed('test text');
			expect(result).toEqual(embedding);
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:11434/api/embeddings',
				expect.objectContaining({ method: 'POST' }),
			);
		});
	});

	describe('createEmbeddingProvider', () => {
		it('should return GeminiProvider when GEMINI_API_KEY set', () => {
			process.env.GEMINI_API_KEY = 'test';
			const provider = createEmbeddingProvider();
			expect(provider?.name).toBe('gemini');
		});

		it('should return OpenAIProvider when OPENAI_API_KEY set', () => {
			process.env.OPENAI_API_KEY = 'test';
			const provider = createEmbeddingProvider();
			expect(provider?.name).toBe('openai');
		});

		it('should return OllamaProvider when OLLAMA_HOST set', () => {
			process.env.OLLAMA_HOST = 'http://localhost:11434';
			const provider = createEmbeddingProvider();
			expect(provider?.name).toBe('ollama');
		});

		it('should return null when no env vars set', () => {
			expect(createEmbeddingProvider()).toBeNull();
		});

		it('should prioritize Gemini over OpenAI', () => {
			process.env.GEMINI_API_KEY = 'gemini';
			process.env.OPENAI_API_KEY = 'openai';
			const provider = createEmbeddingProvider();
			expect(provider?.name).toBe('gemini');
		});
	});
});
