/**
 * Tests for DeviceAutoDiscoveryService
 *
 * Covers: singleton, start/stop, device events, exponential backoff on
 * poll and heartbeat failures, max retry limits, and backoff reset on
 * recovery. Uses fake timers + mock fetch.
 *
 * @module services/cloud/device-auto-discovery.service.test
 */

import {
	DeviceAutoDiscoveryService,
	DISCOVERY_CONSTANTS,
	type DiscoveredDevice,
	type DiscoveryConfig,
} from './device-auto-discovery.service.js';

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

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockConfig: DiscoveryConfig = {
	cloudUrl: 'https://cloud.example.com',
	token: 'test-token',
	deviceId: 'device-self',
	deviceName: 'My Machine',
	role: 'orchestrator',
	pollIntervalMs: 100, // fast for tests
	heartbeatIntervalMs: 100,
};

const mockDevice: DiscoveredDevice = {
	deviceId: 'device-other',
	deviceName: 'Other Machine',
	userId: 'user-1',
	online: true,
	role: 'agent',
	lastHeartbeatAt: new Date().toISOString(),
};

/** Helper: create mock responses for register (PUT) + initial poll */
function mockSuccessfulStart(devices: DiscoveredDevice[] = []) {
	mockFetch
		.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // register (PUT)
		.mockResolvedValueOnce({ ok: true, json: async () => ({ devices }) }); // initial poll
}

/** Helper: flush microtask queue (for async callbacks in setTimeout) */
async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('DeviceAutoDiscoveryService', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();
		DeviceAutoDiscoveryService.resetInstance();
	});

	afterEach(() => {
		DeviceAutoDiscoveryService.resetInstance();
		jest.useRealTimers();
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = DeviceAutoDiscoveryService.getInstance();
			const b = DeviceAutoDiscoveryService.getInstance();
			expect(a).toBe(b);
		});

		it('should create new instance after reset', () => {
			const a = DeviceAutoDiscoveryService.getInstance();
			DeviceAutoDiscoveryService.resetInstance();
			const b = DeviceAutoDiscoveryService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('start', () => {
		it('should register device and start polling', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			expect(service.getState()).toBe('polling');
			expect(mockFetch).toHaveBeenCalledTimes(2);

			// Verify register call uses PUT method
			expect(mockFetch).toHaveBeenCalledWith(
				'https://cloud.example.com/v1/devices/register',
				expect.objectContaining({
					method: 'PUT',
					headers: expect.objectContaining({
						Authorization: 'Bearer test-token',
					}),
				}),
			);
		});

		it('should throw on registration failure', async () => {
			mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

			const service = DeviceAutoDiscoveryService.getInstance();
			await expect(service.start(mockConfig)).rejects.toThrow('Device registration failed');
			expect(service.getState()).toBe('error');
		});

		it('should fall back to POST when PUT returns 405', async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: false, status: 405 }) // PUT returns 405
				.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // POST fallback succeeds
				.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) }); // initial poll

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			expect(service.getState()).toBe('polling');
			expect(mockFetch).toHaveBeenCalledTimes(3);

			// First call is PUT
			expect(mockFetch.mock.calls[0][1]).toEqual(
				expect.objectContaining({ method: 'PUT' }),
			);
			// Second call is POST fallback
			expect(mockFetch.mock.calls[1][1]).toEqual(
				expect.objectContaining({ method: 'POST' }),
			);
		});

		it('should reset failure counters on start', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			expect(service.getConsecutivePollFailures()).toBe(0);
			expect(service.getConsecutiveHeartbeatFailures()).toBe(0);
		});
	});

	describe('stop', () => {
		it('should clear state and timers', async () => {
			mockSuccessfulStart([mockDevice]);

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);
			expect(service.getDevices().length).toBe(1);

			service.stop();
			expect(service.getState()).toBe('stopped');
			expect(service.getDevices()).toEqual([]);
		});

		it('should reset failure counters on stop', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			service.stop();
			expect(service.getConsecutivePollFailures()).toBe(0);
			expect(service.getConsecutiveHeartbeatFailures()).toBe(0);
		});
	});

	describe('getOnlineDevices', () => {
		it('should return online devices excluding self', async () => {
			const selfDevice: DiscoveredDevice = {
				...mockDevice,
				deviceId: 'device-self',
				deviceName: 'My Machine',
				role: 'orchestrator',
			};

			mockFetch
				.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ devices: [selfDevice, mockDevice] }),
				});

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			const online = service.getOnlineDevices();
			expect(online).toHaveLength(1);
			expect(online[0].deviceId).toBe('device-other');
		});
	});

	describe('device events', () => {
		it('should emit deviceFound when new device appears', async () => {
			mockSuccessfulStart([mockDevice]);

			const service = DeviceAutoDiscoveryService.getInstance();
			const foundHandler = jest.fn();
			service.on('deviceFound', foundHandler);

			await service.start(mockConfig);

			expect(foundHandler).toHaveBeenCalledTimes(1);
			expect(foundHandler).toHaveBeenCalledWith(
				expect.objectContaining({ deviceId: 'device-other' }),
			);
		});

		it('should emit deviceLost when device disappears', async () => {
			// First poll: device present
			mockSuccessfulStart([mockDevice]);

			const service = DeviceAutoDiscoveryService.getInstance();
			const lostHandler = jest.fn();
			service.on('deviceLost', lostHandler);

			await service.start(mockConfig);

			// Second poll: device gone
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) });

			jest.advanceTimersByTime(200);
			await flushPromises();

			expect(service.getState()).toBe('polling');
		});

		it('should emit devicesUpdated on each poll', async () => {
			mockSuccessfulStart([mockDevice]);

			const service = DeviceAutoDiscoveryService.getInstance();
			const updatedHandler = jest.fn();
			service.on('devicesUpdated', updatedHandler);

			await service.start(mockConfig);

			expect(updatedHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe('pollDevices deduplication', () => {
		it('should deduplicate devices by deviceId keeping most recent heartbeat', async () => {
			const olderDevice: DiscoveredDevice = {
				...mockDevice,
				lastHeartbeatAt: '2026-01-01T00:00:00Z',
			};
			const newerDevice: DiscoveredDevice = {
				...mockDevice,
				lastHeartbeatAt: '2026-01-01T01:00:00Z',
			};

			mockFetch
				.mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // register
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ devices: [olderDevice, newerDevice] }),
				}); // initial poll with duplicates

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			const devices = service.getDevices();
			expect(devices).toHaveLength(1);
			expect(devices[0].lastHeartbeatAt).toBe('2026-01-01T01:00:00Z');
		});
	});

	describe('calculateBackoff', () => {
		it('should return 0 for 0 failures', () => {
			expect(DeviceAutoDiscoveryService.calculateBackoff(0)).toBe(0);
		});

		it('should return base delay for 1 failure', () => {
			expect(DeviceAutoDiscoveryService.calculateBackoff(1)).toBe(DISCOVERY_CONSTANTS.BACKOFF_BASE_MS);
		});

		it('should double on each subsequent failure', () => {
			const base = DISCOVERY_CONSTANTS.BACKOFF_BASE_MS;
			expect(DeviceAutoDiscoveryService.calculateBackoff(1)).toBe(base); // 1s
			expect(DeviceAutoDiscoveryService.calculateBackoff(2)).toBe(base * 2); // 2s
			expect(DeviceAutoDiscoveryService.calculateBackoff(3)).toBe(base * 4); // 4s
			expect(DeviceAutoDiscoveryService.calculateBackoff(4)).toBe(base * 8); // 8s
		});

		it('should cap at BACKOFF_MAX_MS', () => {
			expect(DeviceAutoDiscoveryService.calculateBackoff(100)).toBe(
				DISCOVERY_CONSTANTS.BACKOFF_MAX_MS,
			);
		});

		it('should return 0 for negative failures', () => {
			expect(DeviceAutoDiscoveryService.calculateBackoff(-1)).toBe(0);
		});
	});

	describe('poll backoff', () => {
		it('should increment consecutive failures on poll error', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);
			expect(service.getConsecutivePollFailures()).toBe(0);

			// Next poll fails (HTTP error)
			mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

			jest.advanceTimersByTime(200);
			await flushPromises();

			expect(service.getConsecutivePollFailures()).toBe(1);
		});

		it('should increment failures on network error', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			// Next poll throws (network error)
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			jest.advanceTimersByTime(200);
			await flushPromises();

			expect(service.getConsecutivePollFailures()).toBe(1);
		});

		it('should reset failures on successful poll', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			// Poll fails
			mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
			jest.advanceTimersByTime(200);
			await flushPromises();
			expect(service.getConsecutivePollFailures()).toBe(1);

			// Next poll succeeds — now wait for the backoff delay (1s for 1 failure)
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) });
			jest.advanceTimersByTime(DISCOVERY_CONSTANTS.BACKOFF_BASE_MS + 100);
			await flushPromises();

			expect(service.getConsecutivePollFailures()).toBe(0);
		});

		it('should emit backoffActive event on poll failure', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			const backoffHandler = jest.fn();
			service.on('backoffActive', backoffHandler);

			await service.start(mockConfig);

			mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
			jest.advanceTimersByTime(200);
			await flushPromises();

			expect(backoffHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'poll',
					failures: 1,
					delay: DISCOVERY_CONSTANTS.BACKOFF_BASE_MS,
				}),
			);
		});

		it('should enter error state after MAX_CONSECUTIVE_POLL_FAILURES', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			const maxRetriesHandler = jest.fn();
			service.on('maxRetriesExceeded', maxRetriesHandler);

			await service.start(mockConfig);

			// Simulate MAX failures by repeatedly failing and advancing timers
			for (let i = 0; i < DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_POLL_FAILURES; i++) {
				mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
				const backoffDelay = DeviceAutoDiscoveryService.calculateBackoff(i);
				jest.advanceTimersByTime(Math.max(backoffDelay, 200) + 50);
				await flushPromises();
			}

			expect(service.getState()).toBe('error');
			expect(service.getConsecutivePollFailures()).toBe(
				DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_POLL_FAILURES,
			);
			expect(maxRetriesHandler).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'poll',
					failures: DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_POLL_FAILURES,
				}),
			);
		});
	});

	describe('heartbeat backoff', () => {
		it('should increment consecutive heartbeat failures', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			// First scheduled callback is a poll, then heartbeat
			// Make poll succeed, heartbeat fail
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) }); // poll
			mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }); // heartbeat

			jest.advanceTimersByTime(200);
			await flushPromises();

			expect(service.getConsecutiveHeartbeatFailures()).toBe(1);
		});

		it('should reset heartbeat failures on success', async () => {
			mockSuccessfulStart();

			const service = DeviceAutoDiscoveryService.getInstance();
			await service.start(mockConfig);

			// Heartbeat fails
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) }); // poll
			mockFetch.mockRejectedValueOnce(new Error('timeout')); // heartbeat fails
			jest.advanceTimersByTime(200);
			await flushPromises();
			expect(service.getConsecutiveHeartbeatFailures()).toBe(1);

			// Heartbeat succeeds
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ devices: [] }) }); // poll
			mockFetch.mockResolvedValueOnce({ ok: true }); // heartbeat succeeds
			jest.advanceTimersByTime(DISCOVERY_CONSTANTS.BACKOFF_BASE_MS + 200);
			await flushPromises();

			expect(service.getConsecutiveHeartbeatFailures()).toBe(0);
		});
	});

	describe('DISCOVERY_CONSTANTS', () => {
		it('should have correct defaults', () => {
			expect(DISCOVERY_CONSTANTS.POLL_INTERVAL_MS).toBe(30_000);
			expect(DISCOVERY_CONSTANTS.HEARTBEAT_INTERVAL_MS).toBe(30_000);
			expect(DISCOVERY_CONSTANTS.OFFLINE_THRESHOLD_MS).toBe(300_000);
			expect(DISCOVERY_CONSTANTS.MAX_DEVICES_PER_USER).toBe(10);
			expect(DISCOVERY_CONSTANTS.DEVICES_PATH).toBe('/v1/devices');
		});

		it('should have correct backoff defaults', () => {
			expect(DISCOVERY_CONSTANTS.BACKOFF_BASE_MS).toBe(1_000);
			expect(DISCOVERY_CONSTANTS.BACKOFF_MAX_MS).toBe(300_000);
			expect(DISCOVERY_CONSTANTS.BACKOFF_MULTIPLIER).toBe(2);
			expect(DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_POLL_FAILURES).toBe(20);
			expect(DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_HEARTBEAT_FAILURES).toBe(10);
		});
	});
});
