/**
 * Redis Cache Service
 *
 * Provides a caching layer backed by Redis with automatic graceful fallback
 * to an in-memory LRU-style Map when Redis is unavailable. This ensures the
 * application continues to function even without a Redis instance.
 *
 * Features:
 * - Singleton pattern for shared cache across the application
 * - Configurable TTL per cache entry
 * - Pattern-based cache invalidation
 * - Graceful degradation to in-memory cache
 * - Connection health monitoring
 *
 * @module redis-cache.service
 */

import { REDIS_CONSTANTS } from '../../../../config/constants.js';
import { LoggerService } from '../core/logger.service.js';

// Dynamic import to avoid crash when ioredis is not installed.
// Redis is optional — the service falls back to in-memory cache.
type Redis = import('ioredis').default;
type RedisOptions = import('ioredis').RedisOptions;

const logger = LoggerService.getInstance().createComponentLogger('RedisCacheService');

/**
 * Represents a cached item stored in the in-memory fallback Map
 */
interface MemoryCacheEntry {
	/** Serialized JSON value */
	value: string;
	/** Unix timestamp (ms) when this entry expires */
	expiresAt: number;
}

/**
 * Redis-backed cache service with in-memory fallback.
 *
 * Usage:
 * ```typescript
 * const cache = RedisCacheService.getInstance();
 * await cache.set('key', data, 60);   // store for 60s
 * const hit = await cache.get<MyType>('key');
 * await cache.invalidate('key');
 * await cache.invalidateByPattern('api:teams*');
 * ```
 */
export class RedisCacheService {
	private static instance: RedisCacheService | null = null;

	private client: Redis | null = null;
	private connected = false;
	private memoryCache: Map<string, MemoryCacheEntry> = new Map();
	private readonly keyPrefix: string;
	private readonly maxMemoryCacheSize = 500;

	private constructor() {
		this.keyPrefix = REDIS_CONSTANTS.CONNECTION.KEY_PREFIX;
	}

	/**
	 * Returns the singleton RedisCacheService instance.
	 * Creates one on first call.
	 *
	 * @returns The shared RedisCacheService instance
	 */
	static getInstance(): RedisCacheService {
		if (!RedisCacheService.instance) {
			RedisCacheService.instance = new RedisCacheService();
		}
		return RedisCacheService.instance;
	}

	/**
	 * Resets the singleton instance. Used only in tests.
	 */
	static resetInstance(): void {
		if (RedisCacheService.instance) {
			RedisCacheService.instance.disconnect();
		}
		RedisCacheService.instance = null;
	}

	/**
	 * Connects to Redis. If connection fails, the service gracefully
	 * falls back to in-memory caching without throwing.
	 *
	 * @returns true if Redis connection succeeded, false if using fallback
	 */
	async connect(): Promise<boolean> {
		try {
			// Dynamic import so the app doesn't crash when ioredis isn't installed
			let RedisConstructor: typeof import('ioredis').default;
			try {
				const mod = await import('ioredis');
				RedisConstructor = mod.default;
			} catch {
				logger.info('ioredis package not installed, using in-memory cache fallback');
				this.connected = false;
				return false;
			}

			const redisUrl = process.env[REDIS_CONSTANTS.ENV.REDIS_URL];
			const host = process.env[REDIS_CONSTANTS.ENV.REDIS_HOST] || REDIS_CONSTANTS.CONNECTION.HOST;
			const port = parseInt(
				process.env[REDIS_CONSTANTS.ENV.REDIS_PORT] || String(REDIS_CONSTANTS.CONNECTION.PORT),
				10
			);
			const password = process.env[REDIS_CONSTANTS.ENV.REDIS_PASSWORD] || undefined;

			const options: RedisOptions = {
				connectTimeout: REDIS_CONSTANTS.CONNECTION.CONNECT_TIMEOUT,
				maxRetriesPerRequest: REDIS_CONSTANTS.CONNECTION.MAX_RETRIES,
				retryStrategy: (times: number) => {
					if (times > REDIS_CONSTANTS.CONNECTION.MAX_RETRIES) {
						logger.warn('Redis max retries exceeded, falling back to memory cache');
						return null; // stop retrying
					}
					return REDIS_CONSTANTS.CONNECTION.RETRY_DELAY;
				},
				lazyConnect: true,
			};

			if (redisUrl) {
				this.client = new RedisConstructor(redisUrl, options) as unknown as Redis;
			} else {
				this.client = new RedisConstructor({
					...options,
					host,
					port,
					password,
				}) as unknown as Redis;
			}

			this.client.on('error', (err: Error) => {
				if (this.connected) {
					logger.warn('Redis connection lost, falling back to memory cache', {
						error: err.message,
					});
					this.connected = false;
				}
			});

			this.client.on('connect', () => {
				logger.info('Redis connected successfully');
				this.connected = true;
			});

			await this.client.connect();
			this.connected = true;
			return true;
		} catch {
			logger.info('Redis not available, using in-memory cache fallback');
			this.connected = false;
			return false;
		}
	}

	/**
	 * Disconnects from Redis and clears the in-memory cache.
	 */
	disconnect(): void {
		if (this.client) {
			this.client.disconnect();
			this.client = null;
		}
		this.connected = false;
		this.memoryCache.clear();
	}

	/**
	 * Whether the service is currently connected to Redis.
	 *
	 * @returns true if Redis is connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Retrieves a cached value by key.
	 *
	 * @typeParam T - Expected type of the cached value
	 * @param key - Cache key (without prefix)
	 * @returns The cached value or null on miss/error
	 */
	async get<T>(key: string): Promise<T | null> {
		const prefixedKey = this.keyPrefix + key;

		try {
			if (this.connected && this.client) {
				const raw = await this.client.get(prefixedKey);
				if (raw === null) {
					return null;
				}
				return JSON.parse(raw) as T;
			}

			// Fallback to memory cache
			return this.memoryGet<T>(prefixedKey);
		} catch (err) {
			logger.debug('Cache get error, returning null', {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/**
	 * Stores a value in the cache with a given TTL.
	 *
	 * @param key - Cache key (without prefix)
	 * @param value - Value to cache (must be JSON-serialisable)
	 * @param ttlSeconds - Time-to-live in seconds (defaults to REDIS_CONSTANTS.TTL.DEFAULT)
	 */
	async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
		const prefixedKey = this.keyPrefix + key;
		const ttl = ttlSeconds ?? REDIS_CONSTANTS.TTL.DEFAULT;

		try {
			const serialized = JSON.stringify(value);

			if (this.connected && this.client) {
				await this.client.setex(prefixedKey, ttl, serialized);
			} else {
				this.memorySet(prefixedKey, serialized, ttl);
			}
		} catch (err) {
			logger.debug('Cache set error', {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Removes a specific key from the cache.
	 *
	 * @param key - Cache key (without prefix)
	 */
	async invalidate(key: string): Promise<void> {
		const prefixedKey = this.keyPrefix + key;

		try {
			if (this.connected && this.client) {
				await this.client.del(prefixedKey);
			}
			this.memoryCache.delete(prefixedKey);
		} catch (err) {
			logger.debug('Cache invalidate error', {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Removes all keys matching a glob-style pattern.
	 * In Redis, uses SCAN for safe iteration. In memory, does a prefix match.
	 *
	 * @param pattern - Glob pattern (e.g. "api:teams*")
	 */
	async invalidateByPattern(pattern: string): Promise<void> {
		const prefixedPattern = this.keyPrefix + pattern;

		try {
			if (this.connected && this.client) {
				const stream = this.client.scanStream({ match: prefixedPattern, count: 100 });
				const pipeline = this.client.pipeline();
				let count = 0;

				await new Promise<void>((resolve, reject) => {
					stream.on('data', (keys: string[]) => {
						for (const key of keys) {
							pipeline.del(key);
							count++;
						}
					});
					stream.on('end', () => {
						if (count > 0) {
							pipeline.exec().then(() => resolve()).catch(reject);
						} else {
							resolve();
						}
					});
					stream.on('error', reject);
				});
			}

			// Also clear matching entries from memory cache
			const prefix = this.keyPrefix + pattern.replace(/\*/g, '');
			for (const key of this.memoryCache.keys()) {
				if (key.startsWith(prefix)) {
					this.memoryCache.delete(key);
				}
			}
		} catch (err) {
			logger.debug('Cache invalidateByPattern error', {
				pattern,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Returns basic cache statistics for monitoring.
	 *
	 * @returns Object with backend type, connected flag, and memory cache size
	 */
	getStats(): { backend: 'redis' | 'memory'; connected: boolean; memoryCacheSize: number } {
		return {
			backend: this.connected ? 'redis' : 'memory',
			connected: this.connected,
			memoryCacheSize: this.memoryCache.size,
		};
	}

	// ---- In-memory fallback helpers ----

	/**
	 * Retrieves a value from the in-memory fallback cache.
	 * Automatically evicts expired entries.
	 */
	private memoryGet<T>(prefixedKey: string): T | null {
		const entry = this.memoryCache.get(prefixedKey);
		if (!entry) {
			return null;
		}
		if (Date.now() > entry.expiresAt) {
			this.memoryCache.delete(prefixedKey);
			return null;
		}
		return JSON.parse(entry.value) as T;
	}

	/**
	 * Stores a value in the in-memory fallback cache.
	 * Evicts the oldest entry when the maximum size is reached.
	 */
	private memorySet(prefixedKey: string, serialized: string, ttlSeconds: number): void {
		// Evict oldest if at capacity
		if (this.memoryCache.size >= this.maxMemoryCacheSize && !this.memoryCache.has(prefixedKey)) {
			const firstKey = this.memoryCache.keys().next().value;
			if (firstKey !== undefined) {
				this.memoryCache.delete(firstKey);
			}
		}
		this.memoryCache.set(prefixedKey, {
			value: serialized,
			expiresAt: Date.now() + ttlSeconds * 1000,
		});
	}
}
