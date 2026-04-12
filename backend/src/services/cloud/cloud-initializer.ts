/**
 * Cloud Initializer
 *
 * Handles automatic Cloud connection restoration on application startup.
 * Reads persisted credentials from ~/.crewly/cloud/config.json and
 * calls CloudClientService.connectLocal() to restore the connection.
 *
 * Non-blocking: failures are logged but do not prevent startup.
 *
 * @module services/cloud/cloud-initializer
 */

import { CloudClientService } from './cloud-client.service.js';
import { CloudSyncService } from './cloud-sync.service.js';
import { DeviceIdentityService } from './device-identity.service.js';
import { LoggerService } from '../core/logger.service.js';
import { CLOUD_CONSTANTS, type CloudTier } from '../../constants.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';

const logger = LoggerService.getInstance().createComponentLogger('CloudInitializer');

/**
 * Result of the cloud initialization attempt.
 */
export interface CloudInitResult {
	/** Whether initialization was attempted (config file exists) */
	attempted: boolean;
	/** Whether initialization succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Start the MessageRouterService for cross-device agent communication.
 *
 * Sets up the local delivery handler (which writes to the agent's PTY
 * session via the terminal write endpoint) and begins listening for
 * incoming `agent_message` events from CloudSyncService.
 *
 * Non-blocking: failures are logged but do not affect Cloud connectivity.
 */
export function startMessageRouter(): void {
	try {
		// Dynamic import to avoid circular dependency
		import('../messaging/message-router.service.js').then(async ({ MessageRouterService }) => {
			const router = MessageRouterService.getInstance();

			// Set up the local delivery handler — writes to agent PTY sessions
			router.setLocalDeliveryHandler(async (sessionName, message) => {
				try {
					const { getSessionBackendSync } = await import('../session/index.js');
					const backend = getSessionBackendSync();
					const session = backend?.getSession(sessionName);

					if (!session) {
						return { success: false, error: `Local session '${sessionName}' not found` };
					}

					// Two-step write pattern for TUI runtimes
					session.write(message);
					const enterDelay = Math.min(1000 + Math.ceil(message.length / 10), 5000);
					await new Promise(resolve => setTimeout(resolve, enterDelay));
					session.write('\r');
					await new Promise(resolve => setTimeout(resolve, 500));
					session.write('\r'); // backup Enter

					return { success: true };
				} catch (err) {
					return {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					};
				}
			});

			// Set up the message enqueue handler for cross-machine messages.
			// This routes incoming remote messages through the standard queue
			// pipeline so the orchestrator gets them with proper source metadata.
			try {
				const { getMessageQueueInstance } = await import('../messaging/index.js');
				const queue = getMessageQueueInstance();
				if (queue) {
					router.setMessageEnqueueHandler((input) => {
						queue.enqueue(input as EnqueueMessageInput);
					});
					logger.info('MessageRouterService: message enqueue handler configured');
				}
			} catch {
				logger.debug('Message enqueue handler not available (non-fatal)');
			}

			router.startListening();
			logger.info('MessageRouterService started for cross-device agent communication');
		}).catch((err) => {
			logger.warn('Failed to start MessageRouterService (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	} catch (err) {
		logger.warn('Failed to start MessageRouterService (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Start the BrowserRelayAdapter auto-discovery to listen for Chrome Extension
 * devices coming online via CloudSync. When a device with role 'browser' is
 * detected, the adapter automatically sets its device ID as the relay target.
 *
 * Non-blocking: failures are logged but do not affect other services.
 */
export function startBrowserRelayAutoDiscovery(): void {
	try {
		import('../browser/browser-relay-adapter.service.js').then(({ BrowserRelayAdapter }) => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.startAutoDiscovery();
			logger.info('BrowserRelayAdapter auto-discovery started for extension device detection');
		}).catch((err) => {
			logger.warn('Failed to start BrowserRelayAdapter auto-discovery (non-fatal)', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	} catch (err) {
		logger.warn('Failed to start BrowserRelayAdapter auto-discovery (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Attempt to restore Cloud connection from persisted config.
 *
 * Called during backend startup. If ~/.crewly/cloud/config.json exists
 * and contains valid credentials, calls connectLocal() to restore state.
 *
 * @returns Result indicating whether connection was restored
 */
export async function initializeCloudIfConfigured(): Promise<CloudInitResult> {
	const client = CloudClientService.getInstance();

	// Skip if already connected (e.g. test environment)
	if (client.isConnected()) {
		logger.debug('Cloud already connected, skipping initialization');
		return { attempted: false, success: true };
	}

	// Load persisted config
	const config = await client.loadPersistedConfig();
	if (!config) {
		logger.debug('No persisted cloud config found, skipping');
		return { attempted: false, success: false };
	}

	try {
		logger.info('Restoring cloud connection from persisted config', {
			cloudUrl: config.cloudUrl,
			tier: config.tier,
			hasRefreshToken: !!config.refreshToken,
		});

		// Check if the stored access token is expired and needs refresh.
		//
		// IMPORTANT: We must NOT call connectLocal() with an expired token before
		// tryRefreshToken(), because connectLocal() triggers scheduleTokenRefresh()
		// which fire-and-forgets its own tryRefreshToken(). This creates a race
		// condition where: (1) the background refresh sets refreshInProgress=true,
		// (2) our explicit tryRefreshToken() returns false due to the guard,
		// (3) a second connectLocal() overwrites the refreshed token with the
		// expired one. Instead, we set the refresh token directly, refresh first,
		// then connectLocal() once with the valid token.
		let activeToken = config.token;
		let tokenWasRefreshed = false;

		try {
			const { verifyJwt } = await import('../../controllers/cloud/cloud-google-auth.controller.js');
			const payload = verifyJwt(config.token);

			if (!payload) {
				// Access token expired — try to refresh without triggering connectLocal first
				if (config.refreshToken) {
					logger.info('Stored access token expired, attempting auto-refresh');

					// Set refresh token directly (avoid connectLocal which triggers
					// scheduleTokenRefresh and causes a race condition)
					client.setRefreshToken(config.refreshToken);

					const refreshed = await client.tryRefreshToken();
					if (refreshed) {
						activeToken = client.getToken() || config.token;
						tokenWasRefreshed = true;
						logger.info('Access token auto-refreshed on startup');
					} else {
						logger.warn('Token auto-refresh failed on startup — connection may be in token_expired state');
					}
				} else {
					logger.warn('Stored access token expired and no refresh token available — user must re-login');
				}
			}
		} catch {
			logger.debug('Token verification not available during startup (non-fatal)');
		}

		// Connect with the active token (either original valid token or refreshed one).
		// Only one connectLocal() call — avoids double-persist and token overwrite race.
		client.connectLocal(
			config.cloudUrl,
			activeToken,
			(config.tier as CloudTier) || CLOUD_CONSTANTS.TIERS.FREE,
			config.refreshToken,
		);

		// Start Cloud Sync for device discovery and message polling
		try {
			const identity = await DeviceIdentityService.getInstance().getOrCreateIdentity();
			CloudSyncService.getInstance().start({
				cloudUrl: config.cloudUrl,
				token: activeToken,
				deviceId: identity.deviceId,
				deviceName: identity.deviceName,
			});
			logger.info('CloudSyncService started during initialization', {
				deviceId: identity.deviceId,
			});

			// Start MessageRouterService to enable cross-device agent communication
			startMessageRouter();

			// Start browser extension auto-discovery via CloudSync device events
			startBrowserRelayAutoDiscovery();
		} catch (syncError) {
			logger.warn('CloudSyncService start failed during initialization (non-fatal)', {
				error: syncError instanceof Error ? syncError.message : String(syncError),
			});
		}

		logger.info('Cloud connection restored successfully', {
			tier: config.tier,
			tokenRefreshed: tokenWasRefreshed,
		});
		return { attempted: true, success: true };
	} catch (error) {
		logger.warn('Failed to restore cloud connection (non-fatal)', {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			attempted: true,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
