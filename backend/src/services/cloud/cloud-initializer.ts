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
import { LoggerService } from '../core/logger.service.js';
import { CLOUD_CONSTANTS, type CloudTier } from '../../constants.js';

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
 * Attempt to restore Cloud connection from persisted config.
 *
 * Called during backend startup. If ~/.crewly/cloud/config.json exists
 * and contains valid credentials, calls connectLocal() to restore state.
 * Also triggers relay auto-connect for device discovery.
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
		});

		// Use connectLocal — no remote API call needed for restoration.
		// The token was already validated when it was first stored.
		client.connectLocal(
			config.cloudUrl,
			config.token,
			(config.tier as CloudTier) || CLOUD_CONSTANTS.TIERS.FREE,
		);

		// Trigger relay auto-connect (same as in cloud.controller.ts connectToCloud)
		try {
			const { autoConnectRelayFromToken } = await import('../../controllers/cloud/cloud.controller.js');
			autoConnectRelayFromToken(config.token);
		} catch {
			logger.debug('Relay auto-connect not available during startup (non-fatal)');
		}

		logger.info('Cloud connection restored successfully', { tier: config.tier });
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
