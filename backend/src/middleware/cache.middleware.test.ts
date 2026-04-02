/**
 * Unit tests for cache middleware
 *
 * Tests cover:
 * - cacheResponse: cache hit returns cached data, cache miss calls through
 * - cacheResponse: only caches 2xx responses
 * - cacheResponse: only applies to GET requests
 * - invalidateCache: invalidates keys on successful mutations
 * - invalidateCache: does not invalidate on error responses
 */

import type { Request, Response, NextFunction } from 'express';
import { cacheResponse, invalidateCache } from './cache.middleware.js';
import { RedisCacheService } from '../services/cache/redis-cache.service.js';
import { REDIS_CONSTANTS } from '../../../config/constants.js';

// Silence logger
jest.mock('../services/core/logger.service', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				debug: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock ioredis
jest.mock('ioredis', () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => {
		throw new Error('Redis not available');
	}),
}));

/**
 * Creates a mock Express request
 */
function mockRequest(method = 'GET'): Request {
	return { method } as unknown as Request;
}

/**
 * Creates a mock Express response with chainable status() and json()
 */
function mockResponse(): Response & { _body: unknown; _statusCode: number; _finishCallbacks: Array<() => void> } {
	const res = {
		_body: undefined as unknown,
		_statusCode: 200,
		_finishCallbacks: [] as Array<() => void>,
		statusCode: 200,
		status(code: number) {
			res._statusCode = code;
			res.statusCode = code;
			return res;
		},
		json(body: unknown) {
			res._body = body;
			return res;
		},
		on(event: string, cb: () => void) {
			if (event === 'finish') {
				res._finishCallbacks.push(cb);
			}
			return res;
		},
	};
	return res as unknown as Response & { _body: unknown; _statusCode: number; _finishCallbacks: Array<() => void> };
}

describe('cache middleware', () => {
	let cache: RedisCacheService;

	beforeEach(async () => {
		RedisCacheService.resetInstance();
		cache = RedisCacheService.getInstance();
		await cache.connect(); // Falls back to memory
	});

	afterEach(() => {
		RedisCacheService.resetInstance();
	});

	describe('cacheResponse', () => {
		const cacheKey = REDIS_CONSTANTS.KEYS.TEAMS_LIST;
		const ttl = REDIS_CONSTANTS.TTL.TEAMS_LIST;

		it('returns cached response on cache hit (skips controller)', async () => {
			// Pre-populate cache
			const cachedData = { statusCode: 200, body: { success: true, data: [{ id: '1' }] } };
			await cache.set(cacheKey, cachedData, ttl);

			const req = mockRequest();
			const res = mockResponse();
			const next = jest.fn();

			const middleware = cacheResponse(cacheKey, ttl);
			await middleware(req, res, next);

			// Should NOT call next (controller skipped)
			expect(next).not.toHaveBeenCalled();
			// Should send cached body
			expect(res._body).toEqual(cachedData.body);
			expect(res._statusCode).toBe(200);
		});

		it('calls next on cache miss and caches the response', async () => {
			const req = mockRequest();
			const res = mockResponse();
			const next = jest.fn();

			const middleware = cacheResponse(cacheKey, ttl);
			await middleware(req, res, next);

			// Should call next (proceed to controller)
			expect(next).toHaveBeenCalled();

			// Simulate controller sending response
			res.statusCode = 200;
			res.json({ success: true, data: [] });

			// Wait for async cache write
			await new Promise(resolve => setTimeout(resolve, 10));

			// Verify response is now cached
			const cached = await cache.get(cacheKey);
			expect(cached).toEqual({ statusCode: 200, body: { success: true, data: [] } });
		});

		it('does not cache non-2xx responses', async () => {
			const req = mockRequest();
			const res = mockResponse();
			const next = jest.fn();

			const middleware = cacheResponse(cacheKey, ttl);
			await middleware(req, res, next);

			// Simulate 500 error response
			res.statusCode = 500;
			res.json({ success: false, error: 'Internal error' });

			await new Promise(resolve => setTimeout(resolve, 10));

			const cached = await cache.get(cacheKey);
			expect(cached).toBeNull();
		});

		it('passes through non-GET requests without caching', async () => {
			const req = mockRequest('POST');
			const res = mockResponse();
			const next = jest.fn();

			const middleware = cacheResponse(cacheKey, ttl);
			await middleware(req, res, next);

			expect(next).toHaveBeenCalled();
			// Verify no cache interaction for POST
			const cached = await cache.get(cacheKey);
			expect(cached).toBeNull();
		});

		it('uses default TTL when not specified', async () => {
			const req = mockRequest();
			const res = mockResponse();
			const next = jest.fn();

			const middleware = cacheResponse(cacheKey);
			await middleware(req, res, next);

			expect(next).toHaveBeenCalled();

			// Simulate response
			res.statusCode = 200;
			res.json({ data: 'test' });

			await new Promise(resolve => setTimeout(resolve, 10));

			const cached = await cache.get(cacheKey);
			expect(cached).not.toBeNull();
		});
	});

	describe('invalidateCache', () => {
		it('invalidates specified cache keys after successful response', async () => {
			// Pre-populate cache
			await cache.set(REDIS_CONSTANTS.KEYS.TEAMS_LIST, { data: 'old' }, 60);
			expect(await cache.get(REDIS_CONSTANTS.KEYS.TEAMS_LIST)).not.toBeNull();

			const req = mockRequest('POST');
			const res = mockResponse();
			const next = jest.fn();

			const middleware = invalidateCache([REDIS_CONSTANTS.KEYS.TEAMS_LIST]);
			middleware(req, res, next);

			expect(next).toHaveBeenCalled();

			// Simulate successful response finish
			res.statusCode = 200;
			for (const cb of res._finishCallbacks) cb();

			await new Promise(resolve => setTimeout(resolve, 10));

			expect(await cache.get(REDIS_CONSTANTS.KEYS.TEAMS_LIST)).toBeNull();
		});

		it('does not invalidate cache on error response', async () => {
			await cache.set(REDIS_CONSTANTS.KEYS.PROJECTS_LIST, { data: 'keep' }, 60);

			const req = mockRequest('POST');
			const res = mockResponse();
			const next = jest.fn();

			const middleware = invalidateCache([REDIS_CONSTANTS.KEYS.PROJECTS_LIST]);
			middleware(req, res, next);

			// Simulate 400 error
			res.statusCode = 400;
			for (const cb of res._finishCallbacks) cb();

			await new Promise(resolve => setTimeout(resolve, 10));

			// Cache should still have the data
			expect(await cache.get(REDIS_CONSTANTS.KEYS.PROJECTS_LIST)).toEqual({ data: 'keep' });
		});

		it('invalidates multiple cache keys at once', async () => {
			await cache.set(REDIS_CONSTANTS.KEYS.TEAMS_LIST, { teams: [] }, 60);
			await cache.set(REDIS_CONSTANTS.KEYS.PROJECTS_LIST, { projects: [] }, 60);

			const req = mockRequest('DELETE');
			const res = mockResponse();
			const next = jest.fn();

			const middleware = invalidateCache([
				REDIS_CONSTANTS.KEYS.TEAMS_LIST,
				REDIS_CONSTANTS.KEYS.PROJECTS_LIST,
			]);
			middleware(req, res, next);

			res.statusCode = 200;
			for (const cb of res._finishCallbacks) cb();

			await new Promise(resolve => setTimeout(resolve, 10));

			expect(await cache.get(REDIS_CONSTANTS.KEYS.TEAMS_LIST)).toBeNull();
			expect(await cache.get(REDIS_CONSTANTS.KEYS.PROJECTS_LIST)).toBeNull();
		});
	});
});
