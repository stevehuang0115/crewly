/**
 * Device Auto-Discovery Service
 *
 * Polls the Cloud device registry to discover other Crewly instances
 * belonging to the same user account. Enables automatic relay pairing
 * without manual configuration.
 *
 * Flow:
 * 1. On cloud login, register this device with the Cloud device API
 * 2. Poll GET /v1/devices to discover other online devices
 * 3. Auto-initiate relay connection to discovered peers
 * 4. Maintain heartbeat so other devices can discover us
 *
 * Implements exponential backoff on API failures to prevent runaway
 * request storms. After MAX_CONSECUTIVE_FAILURES, polling stops and
 * the service enters an error state.
 *
 * @see https://github.com/stevehuang0115/crewly/issues/relay-auto-discovery
 * @module services/cloud/device-auto-discovery.service
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CLOUD_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A remote device discovered via the cloud registry */
export interface DiscoveredDevice {
	/** Unique device identifier (UUID) */
	deviceId: string;
	/** Human-readable device name (hostname) */
	deviceName: string;
	/** User ID who owns this device */
	userId: string;
	/** Whether the device is currently online */
	online: boolean;
	/** Device role (orchestrator or agent) */
	role: 'orchestrator' | 'agent';
	/** ISO timestamp of last heartbeat */
	lastHeartbeatAt: string;
	/** Relay pairing code for auto-connect */
	pairingCode?: string;
	/** Cloud relay server URL */
	relayUrl?: string;
}

/** Discovery service configuration */
export interface DiscoveryConfig {
	/** Cloud API base URL */
	cloudUrl: string;
	/** Auth token for cloud API calls */
	token: string;
	/** This device's ID */
	deviceId: string;
	/** This device's name */
	deviceName: string;
	/** This device's role */
	role: 'orchestrator' | 'agent';
	/** Polling interval in ms (default: 30s) */
	pollIntervalMs?: number;
	/** Heartbeat interval in ms (default: 30s) */
	heartbeatIntervalMs?: number;
}

/** Auto-discovery service state */
export type DiscoveryState = 'stopped' | 'registering' | 'polling' | 'error';

/** Discovery constants */
export const DISCOVERY_CONSTANTS = {
	/** Default polling interval for device discovery (30 seconds) */
	POLL_INTERVAL_MS: 30_000,
	/** Default heartbeat interval (30 seconds) */
	HEARTBEAT_INTERVAL_MS: 30_000,
	/** Device considered offline after this threshold (5 minutes) */
	OFFLINE_THRESHOLD_MS: 300_000,
	/** Maximum devices per user account */
	MAX_DEVICES_PER_USER: 10,
	/** Cloud device API path */
	DEVICES_PATH: '/v1/devices',
	/** Base delay for exponential backoff (1 second) */
	BACKOFF_BASE_MS: 1_000,
	/** Maximum backoff delay (5 minutes) */
	BACKOFF_MAX_MS: 300_000,
	/** Exponential backoff multiplier */
	BACKOFF_MULTIPLIER: 2,
	/** Stop polling after this many consecutive failures */
	MAX_CONSECUTIVE_POLL_FAILURES: 20,
	/** Stop sending heartbeats after this many consecutive failures */
	MAX_CONSECUTIVE_HEARTBEAT_FAILURES: 10,
	/** HTTP request timeout for device API calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
} as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * DeviceAutoDiscoveryService discovers other Crewly instances via Cloud.
 *
 * Uses self-scheduling setTimeout loops (instead of fixed setInterval) so
 * that polling and heartbeat intervals can be dynamically adjusted when
 * exponential backoff is active.
 *
 * Emits events:
 * - 'deviceFound' — new device discovered
 * - 'deviceLost' — previously online device went offline
 * - 'devicesUpdated' — full device list refreshed
 * - 'backoffActive' — backoff engaged after a failure (payload: { delay, failures })
 * - 'maxRetriesExceeded' — polling stopped due to too many failures
 */
export class DeviceAutoDiscoveryService extends EventEmitter {
	private static instance: DeviceAutoDiscoveryService | null = null;
	private readonly logger: ComponentLogger;
	private state: DiscoveryState = 'stopped';
	private config: DiscoveryConfig | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
	private knownDevices: Map<string, DiscoveredDevice> = new Map();

	/** Number of consecutive poll failures (reset on success) */
	private consecutivePollFailures = 0;
	/** Number of consecutive heartbeat failures (reset on success) */
	private consecutiveHeartbeatFailures = 0;

	private constructor() {
		super();
		this.logger = LoggerService.getInstance().createComponentLogger('DeviceAutoDiscovery');
	}

	static getInstance(): DeviceAutoDiscoveryService {
		if (!DeviceAutoDiscoveryService.instance) {
			DeviceAutoDiscoveryService.instance = new DeviceAutoDiscoveryService();
		}
		return DeviceAutoDiscoveryService.instance;
	}

	static resetInstance(): void {
		if (DeviceAutoDiscoveryService.instance) {
			DeviceAutoDiscoveryService.instance.stop();
		}
		DeviceAutoDiscoveryService.instance = null;
	}

	/**
	 * Get the current discovery state.
	 */
	getState(): DiscoveryState {
		return this.state;
	}

	/**
	 * Get all currently known devices.
	 */
	getDevices(): DiscoveredDevice[] {
		return Array.from(this.knownDevices.values());
	}

	/**
	 * Get only online devices (excluding self).
	 */
	getOnlineDevices(): DiscoveredDevice[] {
		return this.getDevices().filter(
			d => d.online && d.deviceId !== this.config?.deviceId
		);
	}

	/**
	 * Get the number of consecutive poll failures.
	 */
	getConsecutivePollFailures(): number {
		return this.consecutivePollFailures;
	}

	/**
	 * Get the number of consecutive heartbeat failures.
	 */
	getConsecutiveHeartbeatFailures(): number {
		return this.consecutiveHeartbeatFailures;
	}

	/**
	 * Start auto-discovery: register this device, begin polling + heartbeat.
	 *
	 * @param config - Discovery configuration with cloud credentials
	 */
	async start(config: DiscoveryConfig): Promise<void> {
		if (this.state !== 'stopped') {
			this.logger.warn('Discovery already running, stopping first');
			this.stop();
		}

		this.config = config;
		this.state = 'registering';
		this.consecutivePollFailures = 0;
		this.consecutiveHeartbeatFailures = 0;

		try {
			// Step 1: Register this device with the cloud
			await this.registerDevice();

			// Step 2: Do an initial discovery poll
			await this.pollDevices();

			// Step 3: Start self-scheduling poll and heartbeat loops
			this.schedulePoll();
			this.scheduleHeartbeat();

			this.state = 'polling';
			this.logger.info('Auto-discovery started', {
				deviceId: config.deviceId,
				deviceName: config.deviceName,
				role: config.role,
				pollInterval: config.pollIntervalMs || DISCOVERY_CONSTANTS.POLL_INTERVAL_MS,
			});
		} catch (err) {
			this.state = 'error';
			this.logger.error('Failed to start auto-discovery', {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}

	/**
	 * Stop auto-discovery: clear timers and deregister.
	 */
	stop(): void {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.knownDevices.clear();
		this.consecutivePollFailures = 0;
		this.consecutiveHeartbeatFailures = 0;
		this.state = 'stopped';
		this.logger.info('Auto-discovery stopped');
	}

	// ---------------------------------------------------------------------------
	// Backoff helpers
	// ---------------------------------------------------------------------------

	/**
	 * Calculate exponential backoff delay for the given number of consecutive
	 * failures. Uses base × 2^(failures-1), capped at BACKOFF_MAX_MS.
	 *
	 * @param failures - Number of consecutive failures (0 = no backoff)
	 * @returns Delay in ms (0 if no failures)
	 */
	static calculateBackoff(failures: number): number {
		if (failures <= 0) return 0;
		const delay =
			DISCOVERY_CONSTANTS.BACKOFF_BASE_MS *
			Math.pow(DISCOVERY_CONSTANTS.BACKOFF_MULTIPLIER, failures - 1);
		return Math.min(delay, DISCOVERY_CONSTANTS.BACKOFF_MAX_MS);
	}

	// ---------------------------------------------------------------------------
	// Self-scheduling loops
	// ---------------------------------------------------------------------------

	/**
	 * Schedule the next poll. Uses the normal interval on success, or
	 * exponential backoff on consecutive failures.
	 */
	private schedulePoll(): void {
		if (this.state === 'stopped' || this.state === 'error') return;

		const baseInterval = this.config?.pollIntervalMs || DISCOVERY_CONSTANTS.POLL_INTERVAL_MS;
		const backoff = DeviceAutoDiscoveryService.calculateBackoff(this.consecutivePollFailures);
		const delay = backoff > 0 ? backoff : baseInterval;

		this.pollTimer = setTimeout(() => {
			this.pollDevices().finally(() => this.schedulePoll());
		}, delay);
	}

	/**
	 * Schedule the next heartbeat. Uses the normal interval on success, or
	 * exponential backoff on consecutive failures.
	 */
	private scheduleHeartbeat(): void {
		if (this.state === 'stopped' || this.state === 'error') return;

		const baseInterval = this.config?.heartbeatIntervalMs || DISCOVERY_CONSTANTS.HEARTBEAT_INTERVAL_MS;
		const backoff = DeviceAutoDiscoveryService.calculateBackoff(this.consecutiveHeartbeatFailures);
		const delay = backoff > 0 ? backoff : baseInterval;

		this.heartbeatTimer = setTimeout(() => {
			this.sendHeartbeat().finally(() => this.scheduleHeartbeat());
		}, delay);
	}

	// ---------------------------------------------------------------------------
	// API calls
	// ---------------------------------------------------------------------------

	/**
	 * Register this device with the cloud device registry.
	 */
	/**
	 * Register this device with the cloud device registry.
	 *
	 * Uses PUT semantics to ensure upsert behavior — if the device already
	 * exists (same deviceId), the server should update rather than create
	 * a duplicate entry. The deviceId is included both in the body and
	 * as a hint to the server.
	 */
	private async registerDevice(): Promise<void> {
		if (!this.config) throw new Error('Discovery not configured');

		const url = `${this.config.cloudUrl}${DISCOVERY_CONSTANTS.DEVICES_PATH}/register`;

		const response = await fetch(url, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.token}`,
			},
			body: JSON.stringify({
				deviceId: this.config.deviceId,
				deviceName: this.config.deviceName,
				role: this.config.role,
				platform: os.platform(),
				arch: os.arch(),
				hostname: os.hostname(),
			}),
			signal: AbortSignal.timeout(DISCOVERY_CONSTANTS.REQUEST_TIMEOUT_MS),
		});

		// Fall back to POST if PUT returns 405 (server doesn't support PUT yet)
		if (response.status === 405) {
			this.logger.debug('PUT not supported, falling back to POST for device registration');
			const postResponse = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.token}`,
				},
				body: JSON.stringify({
					deviceId: this.config.deviceId,
					deviceName: this.config.deviceName,
					role: this.config.role,
					platform: os.platform(),
					arch: os.arch(),
					hostname: os.hostname(),
				}),
				signal: AbortSignal.timeout(DISCOVERY_CONSTANTS.REQUEST_TIMEOUT_MS),
			});

			if (!postResponse.ok) {
				const body = await postResponse.text().catch(() => '');
				throw new Error(`Device registration failed: ${postResponse.status} ${body.slice(0, 200)}`);
			}
		} else if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`Device registration failed: ${response.status} ${body.slice(0, 200)}`);
		}

		this.logger.info('Device registered with cloud', {
			deviceId: this.config.deviceId,
			deviceName: this.config.deviceName,
		});
	}

	/**
	 * Poll the cloud for other devices belonging to the same user. On failure,
	 * increments the consecutive failure counter and triggers exponential
	 * backoff. After MAX_CONSECUTIVE_POLL_FAILURES, stops polling entirely.
	 */
	private async pollDevices(): Promise<void> {
		if (!this.config) return;

		try {
			const url = `${this.config.cloudUrl}${DISCOVERY_CONSTANTS.DEVICES_PATH}`;

			const response = await fetch(url, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.config.token}`,
				},
				signal: AbortSignal.timeout(DISCOVERY_CONSTANTS.REQUEST_TIMEOUT_MS),
			});

			if (!response.ok) {
				this.handlePollFailure(`HTTP ${response.status}`);
				return;
			}

			const data = (await response.json()) as { devices?: DiscoveredDevice[] };
			const rawDevices = data.devices || [];

			// Deduplicate by deviceId — the server may return the same device
			// multiple times if registration didn't upsert correctly. Keep only
			// the entry with the most recent lastHeartbeatAt for each deviceId.
			const deviceMap = new Map<string, DiscoveredDevice>();
			for (const device of rawDevices) {
				const existing = deviceMap.get(device.deviceId);
				if (!existing || device.lastHeartbeatAt > existing.lastHeartbeatAt) {
					deviceMap.set(device.deviceId, device);
				}
			}
			const devices = Array.from(deviceMap.values());

			if (devices.length !== rawDevices.length) {
				this.logger.warn('Removed duplicate device entries from poll response', {
					raw: rawDevices.length,
					deduped: devices.length,
				});
			}

			// Success — reset failure counter
			if (this.consecutivePollFailures > 0) {
				this.logger.info('Poll recovered after backoff', {
					previousFailures: this.consecutivePollFailures,
				});
			}
			this.consecutivePollFailures = 0;

			// Track changes
			const previousIds = new Set(this.knownDevices.keys());
			const currentIds = new Set<string>();

			for (const device of devices) {
				currentIds.add(device.deviceId);

				if (!previousIds.has(device.deviceId) && device.deviceId !== this.config.deviceId) {
					this.emit('deviceFound', device);
					this.logger.info('New device discovered', {
						deviceId: device.deviceId,
						deviceName: device.deviceName,
						role: device.role,
					});
				}

				this.knownDevices.set(device.deviceId, device);
			}

			// Check for lost devices
			for (const prevId of previousIds) {
				if (!currentIds.has(prevId)) {
					const lost = this.knownDevices.get(prevId);
					this.knownDevices.delete(prevId);
					if (lost) {
						this.emit('deviceLost', lost);
						this.logger.info('Device went offline', {
							deviceId: lost.deviceId,
							deviceName: lost.deviceName,
						});
					}
				}
			}

			this.emit('devicesUpdated', this.getDevices());
		} catch (err) {
			this.handlePollFailure(err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Handle a poll failure: increment counter, log with backoff info, and
	 * stop polling if the max retry limit is exceeded.
	 *
	 * @param reason - Human-readable failure reason
	 */
	private handlePollFailure(reason: string): void {
		this.consecutivePollFailures++;
		const nextDelay = DeviceAutoDiscoveryService.calculateBackoff(this.consecutivePollFailures);

		this.logger.warn('Device poll failed', {
			reason,
			consecutiveFailures: this.consecutivePollFailures,
			nextRetryMs: nextDelay,
		});

		this.emit('backoffActive', {
			type: 'poll',
			delay: nextDelay,
			failures: this.consecutivePollFailures,
		});

		if (this.consecutivePollFailures >= DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_POLL_FAILURES) {
			this.logger.error('Max poll retries exceeded, stopping discovery', {
				failures: this.consecutivePollFailures,
			});
			this.state = 'error';
			this.emit('maxRetriesExceeded', {
				type: 'poll',
				failures: this.consecutivePollFailures,
			});
			// Cancel future polls (heartbeat may still be running)
			if (this.pollTimer) {
				clearTimeout(this.pollTimer);
				this.pollTimer = null;
			}
		}
	}

	/**
	 * Send a heartbeat to the cloud to keep this device marked as online.
	 * On failure, increments heartbeat failure counter and backs off.
	 * After MAX_CONSECUTIVE_HEARTBEAT_FAILURES, stops sending heartbeats.
	 */
	private async sendHeartbeat(): Promise<void> {
		if (!this.config) return;

		try {
			const url = `${this.config.cloudUrl}${DISCOVERY_CONSTANTS.DEVICES_PATH}/heartbeat`;

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.token}`,
				},
				body: JSON.stringify({
					deviceId: this.config.deviceId,
				}),
				signal: AbortSignal.timeout(DISCOVERY_CONSTANTS.REQUEST_TIMEOUT_MS),
			});

			if (!response.ok) {
				this.handleHeartbeatFailure(`HTTP ${response.status}`);
				return;
			}

			// Success — reset failure counter
			this.consecutiveHeartbeatFailures = 0;
		} catch (err) {
			this.handleHeartbeatFailure(err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Handle a heartbeat failure: increment counter and stop heartbeats
	 * if the max retry limit is exceeded.
	 *
	 * @param reason - Human-readable failure reason
	 */
	private handleHeartbeatFailure(reason: string): void {
		this.consecutiveHeartbeatFailures++;
		const nextDelay = DeviceAutoDiscoveryService.calculateBackoff(this.consecutiveHeartbeatFailures);

		this.logger.warn('Heartbeat failed', {
			reason,
			consecutiveFailures: this.consecutiveHeartbeatFailures,
			nextRetryMs: nextDelay,
		});

		if (this.consecutiveHeartbeatFailures >= DISCOVERY_CONSTANTS.MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
			this.logger.error('Max heartbeat retries exceeded, stopping heartbeats', {
				failures: this.consecutiveHeartbeatFailures,
			});
			if (this.heartbeatTimer) {
				clearTimeout(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
		}
	}
}
