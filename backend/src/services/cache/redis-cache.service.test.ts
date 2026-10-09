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

describe('RedisCacheService per-instance namespacing (CREW-369)', () => {
	/** Minimal in-process stand-in for one Redis server shared by both caches. */
	function makeSharedStore() {
		const data = new Map<string, string>();
		const toRegex = (glob: string) =>
			new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
		const client = {
			get: jest.fn(async (k: string) => data.get(k) ?? null),
			setex: jest.fn(async (k: string, _ttl: number, v: string) => {
				data.set(k, v);
				return 'OK';
			}),
			del: jest.fn(async (k: string) => (data.delete(k) ? 1 : 0)),
			disconnect: jest.fn(),
			scanStream: jest.fn(({ match }: { match: string }) => {
				const keys = [...data.keys()].filter((k) => toRegex(match).test(k));
				const handlers: Record<string, (arg?: unknown) => void> = {};
				setImmediate(() => {
					handlers.data?.(keys);
					handlers.end?.();
				});
				return { on: (ev: string, cb: (arg?: unknown) => void) => { handlers[ev] = cb; } };
			}),
			pipeline: jest.fn(() => {
				const dels: string[] = [];
				const p = {
					del: (k: string) => { dels.push(k); return p; },
					exec: async () => { dels.forEach((k) => data.delete(k)); return []; },
				};
				return p;
			}),
		};
		return { data, client };
	}

	const HOME_A = '/tmp/crewly-home-a';
	const HOME_B = '/tmp/crewly-home-b';
	const KEY = REDIS_CONSTANTS.KEYS.TEAMS_LIST;

	it('stores keys under crewly:<homeId>:, not the bare crewly: prefix', async () => {
		const { data, client } = makeSharedStore();
		const a = RedisCacheService.createForHome(HOME_A, client as never);
		await a.set(KEY, ['a-team'], 60);
		const keys = [...data.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toBe(`${RedisCacheService.buildKeyPrefix(HOME_A)}${KEY}`);
		expect(keys[0]).not.toBe(`crewly:${KEY}`);
		expect(RedisCacheService.buildKeyPrefix(HOME_A)).not.toBe(RedisCacheService.buildKeyPrefix(HOME_B));
	});

	it('two homes over one store cannot read each other\'s keys', async () => {
		const { client } = makeSharedStore();
		const a = RedisCacheService.createForHome(HOME_A, client as never);
		const b = RedisCacheService.createForHome(HOME_B, client as never);
		await a.set(KEY, ['real-team'], 60);
		expect(await b.get(KEY)).toBeNull();
		await b.set(KEY, ['demo-team'], 60);
		expect(await a.get(KEY)).toEqual(['real-team']);
		expect(await b.get(KEY)).toEqual(['demo-team']);
	});

	it('invalidate on one home leaves the other home\'s key', async () => {
		const { client } = makeSharedStore();
		const a = RedisCacheService.createForHome(HOME_A, client as never);
		const b = RedisCacheService.createForHome(HOME_B, client as never);
		await a.set(KEY, ['a'], 60);
		await b.set(KEY, ['b'], 60);
		await a.invalidate(KEY);
		expect(await a.get(KEY)).toBeNull();
		expect(await b.get(KEY)).toEqual(['b']);
	});

	it('invalidateByPattern on one home leaves the other home alone', async () => {
		const { data, client } = makeSharedStore();
		const a = RedisCacheService.createForHome(HOME_A, client as never);
		const b = RedisCacheService.createForHome(HOME_B, client as never);
		await a.set(KEY, ['a'], 60);
		await b.set(KEY, ['b'], 60);
		expect(data.size).toBe(2);
		await a.invalidateByPattern('api:*');
		expect(await a.get(KEY)).toBeNull();
		expect(await b.get(KEY)).toEqual(['b']);
		expect(data.size).toBe(1);
	});

	it('same home shares keys (two processes of one instance still agree)', async () => {
		const { client } = makeSharedStore();
		const a1 = RedisCacheService.createForHome(HOME_A, client as never);
		const a2 = RedisCacheService.createForHome(HOME_A, client as never);
		await a1.set(KEY, ['x'], 60);
		expect(await a2.get(KEY)).toEqual(['x']);
	});

	it('in-memory fallback is namespaced too (prefix is part of the memory key)', async () => {
		const a = RedisCacheService.createForHome(HOME_A);
		await a.set(KEY, ['m'], 60);
		const mem = (a as unknown as { memoryCache: Map<string, unknown> }).memoryCache;
		expect([...mem.keys()]).toEqual([`${RedisCacheService.buildKeyPrefix(HOME_A)}${KEY}`]);
	});

	it('connect(home) re-binds the prefix to the backend\'s home', async () => {
		const c = RedisCacheService.getInstance();
		await c.connect(HOME_B);
		await c.set(KEY, ['z'], 60);
		const mem = (c as unknown as { memoryCache: Map<string, unknown> }).memoryCache;
		expect([...mem.keys()][0]).toBe(`${RedisCacheService.buildKeyPrefix(HOME_B)}${KEY}`);
	});
});
