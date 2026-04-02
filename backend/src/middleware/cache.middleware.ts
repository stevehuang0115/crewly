/**
 * Cache Middleware
 *
 * Express middleware for caching GET responses and invalidating on mutations.
 * Works with RedisCacheService — automatically falls back to in-memory cache
 * when Redis is unavailable.
 *
 * @module cache.middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { RedisCacheService } from '../services/cache/redis-cache.service.js';
import { REDIS_CONSTANTS } from '../../../config/constants.js';
import { LoggerService } from '../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('CacheMiddleware');

/**
 * Cached response structure stored in Redis / memory
 */
interface CachedResponse {
	/** HTTP status code */
	statusCode: number;
	/** Response body (JSON-serialised) */
	body: unknown;
}

/**
 * Creates Express middleware that caches GET responses for a given cache key.
 *
 * On cache hit: sends the cached response immediately (skips controller).
 * On cache miss: intercepts `res.json()` to capture and store the response.
 *
 * @param cacheKey - Fixed cache key (from REDIS_CONSTANTS.KEYS)
 * @param ttlSeconds - Time-to-live in seconds (defaults to REDIS_CONSTANTS.TTL.DEFAULT)
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * router.get('/', cacheResponse(REDIS_CONSTANTS.KEYS.TEAMS_LIST, REDIS_CONSTANTS.TTL.TEAMS_LIST), getTeams);
 * ```
 */
export function cacheResponse(cacheKey: string, ttlSeconds?: number) {
	const ttl = ttlSeconds ?? REDIS_CONSTANTS.TTL.DEFAULT;

	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		// Only cache GET requests
		if (req.method !== 'GET') {
			next();
			return;
		}

		const cache = RedisCacheService.getInstance();

		try {
			// Check cache
			const cached = await cache.get<CachedResponse>(cacheKey);
			if (cached) {
				logger.debug('Cache hit', { key: cacheKey });
				res.status(cached.statusCode).json(cached.body);
				return;
			}
		} catch {
			// Cache read failed — continue to controller
		}

		// Cache miss — intercept res.json to capture the response
		logger.debug('Cache miss', { key: cacheKey });
		const originalJson = res.json.bind(res);

		res.json = function (body: unknown): Response {
			// Only cache successful responses (2xx)
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const entry: CachedResponse = { statusCode: res.statusCode, body };
				cache.set(cacheKey, entry, ttl).catch((err) => {
					logger.debug('Failed to write cache', {
						key: cacheKey,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
			return originalJson(body);
		};

		next();
	};
}

/**
 * Creates Express middleware that invalidates one or more cache keys
 * after a mutating request (POST, PUT, PATCH, DELETE) completes successfully.
 *
 * Attaches to the `finish` event on the response so invalidation happens
 * only after the response is sent.
 *
 * @param cacheKeys - Array of cache keys to invalidate
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * router.post('/', invalidateCache([REDIS_CONSTANTS.KEYS.TEAMS_LIST]), createTeam);
 * ```
 */
export function invalidateCache(cacheKeys: string[]) {
	return (_req: Request, res: Response, next: NextFunction): void => {
		res.on('finish', () => {
			// Only invalidate on successful mutations
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const cache = RedisCacheService.getInstance();
				for (const key of cacheKeys) {
					cache.invalidate(key).catch((err) => {
						logger.debug('Cache invalidation failed', {
							key,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			}
		});
		next();
	};
}
