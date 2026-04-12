/**
 * Unit tests for RedisCacheService
 *
 * Tests cover:
 * - Singleton pattern
 * - In-memory fallback when Redis is unavailable
 * - Cache get/set/invalidate operations
 * - TTL expiration
 * - Pattern-based invalidation
 * - Graceful degradation
 * - Cache stats reporting
 */

import { RedisCacheService } from './redis-cache.service.js';
import { REDIS_CONSTANTS } from '../../../../config/constants.js';

// Silence logger output during tests
jest.mock('../core/logger.service', () => ({
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

// Mock ioredis to prevent real connections
jest.mock('ioredis', () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => {
		throw new Error('Redis not available in test');
	}),
}));

describe('RedisCacheService', () => {
	beforeEach(() => {
		RedisCacheService.resetInstance();
	});

	afterEach(() => {
		RedisCacheService.resetInstance();
	});

	describe('singleton pattern', () => {
		it('returns the same instance on repeated calls', () => {
			const a = RedisCacheService.getInstance();
			const b = RedisCacheService.getInstance();
			expect(a).toBe(b);
		});

		it('creates a new instance after resetInstance()', () => {
			const a = RedisCacheService.getInstance();
			RedisCacheService.resetInstance();
			const b = RedisCacheService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('connect (graceful fallback)', () => {
		it('returns false when Redis is unavailable and falls back to memory', async () => {
			const cache = RedisCacheService.getInstance();
			const result = await cache.connect();
			expect(result).toBe(false);
			expect(cache.isConnected()).toBe(false);
		});

		it('reports memory backend in stats when Redis is down', async () => {
			const cache = RedisCacheService.getInstance();
			await cache.connect();
			const stats = cache.getStats();
			expect(stats.backend).toBe('memory');
			expect(stats.connected).toBe(false);
		});
	});

	describe('in-memory cache operations', () => {
		let cache: RedisCacheService;

		beforeEach(async () => {
			cache = RedisCacheService.getInstance();
			await cache.connect(); // Falls back to memory
		});

		it('returns null for a cache miss', async () => {
			const result = await cache.get('nonexistent');
			expect(result).toBeNull();
		});

		it('stores and retrieves a value (cache hit)', async () => {
			const data = { teams: [{ id: '1', name: 'Alpha' }] };
			await cache.set('test:key', data, 60);
			const result = await cache.get('test:key');
			expect(result).toEqual(data);
		});

		it('stores and retrieves complex nested objects', async () => {
			const data = {
				success: true,
				data: [
					{ id: 'p1', name: 'Project A', teams: ['t1', 't2'] },
					{ id: 'p2', name: 'Project B', teams: [] },
				],
			};
			await cache.set(REDIS_CONSTANTS.KEYS.PROJECTS_LIST, data, 60);
			const result = await cache.get(REDIS_CONSTANTS.KEYS.PROJECTS_LIST);
			expect(result).toEqual(data);
		});

		it('invalidates a specific key', async () => {
			await cache.set('teams', { data: 'value' }, 60);
			expect(await cache.get('teams')).not.toBeNull();

			await cache.invalidate('teams');
			expect(await cache.get('teams')).toBeNull();
		});

		it('respects TTL expiration', async () => {
			// Set with 1-second TTL
			await cache.set('expiring', 'data', 1);
			expect(await cache.get('expiring')).toBe('data');

			// Advance time past TTL
			jest.useFakeTimers();
			jest.advanceTimersByTime(1100);
			expect(await cache.get('expiring')).toBeNull();
			jest.useRealTimers();
		});

		it('uses default TTL when none specified', async () => {
			await cache.set('default-ttl', 'value');
			expect(await cache.get('default-ttl')).toBe('value');
		});

		it('invalidates by pattern (prefix match)', async () => {
			await cache.set('api:teams', { teams: [] }, 60);
			await cache.set('api:teams:detail', { team: {} }, 60);
			await cache.set('api:projects', { projects: [] }, 60);

			await cache.invalidateByPattern('api:teams*');

			expect(await cache.get('api:teams')).toBeNull();
			expect(await cache.get('api:teams:detail')).toBeNull();
			// Projects should NOT be invalidated
			expect(await cache.get('api:projects')).toEqual({ projects: [] });
		});

		it('overwrites existing key with new value', async () => {
			await cache.set('key', 'old', 60);
			await cache.set('key', 'new', 60);
			expect(await cache.get('key')).toBe('new');
		});

		it('evicts oldest entry when memory cache is full', async () => {
			// The maxMemoryCacheSize is 500. Fill it up + 1.
			for (let i = 0; i < 501; i++) {
				await cache.set(`fill:${i}`, i, 3600);
			}
			// First entry should have been evicted
			expect(await cache.get('fill:0')).toBeNull();
			// Last entry should still exist
			expect(await cache.get('fill:500')).toBe(500);
		});

		it('reports correct memory cache size in stats', async () => {
			await cache.set('a', 1, 60);
			await cache.set('b', 2, 60);
			const stats = cache.getStats();
			expect(stats.memoryCacheSize).toBe(2);
		});
	});

	describe('disconnect', () => {
		it('clears memory cache on disconnect', async () => {
			const cache = RedisCacheService.getInstance();
			await cache.connect();
			await cache.set('key', 'value', 60);
			expect(cache.getStats().memoryCacheSize).toBe(1);

			cache.disconnect();
			expect(cache.getStats().memoryCacheSize).toBe(0);
			expect(cache.isConnected()).toBe(false);
		});
	});

	describe('error resilience', () => {
		it('get returns null on internal error without throwing', async () => {
			const cache = RedisCacheService.getInstance();
			// Don't connect — no memory entries either
			const result = await cache.get('anything');
			expect(result).toBeNull();
		});

		it('set does not throw on error', async () => {
			const cache = RedisCacheService.getInstance();
			await expect(cache.set('key', 'val')).resolves.toBeUndefined();
		});

		it('invalidate does not throw on error', async () => {
			const cache = RedisCacheService.getInstance();
			await expect(cache.invalidate('key')).resolves.toBeUndefined();
		});

		it('invalidateByPattern does not throw on error', async () => {
			const cache = RedisCacheService.getInstance();
			await expect(cache.invalidateByPattern('prefix*')).resolves.toBeUndefined();
		});
	});
});
