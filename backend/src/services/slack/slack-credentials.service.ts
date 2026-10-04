/**
 * Slack Credentials Persistence Service
 *
 * Persists Slack tokens to ~/.crewly/slack-credentials.json so that
 * tokens configured via the /settings UI survive server restarts.
 * The file is written with 0600 permissions to protect secrets.
 *
 * @module services/slack/slack-credentials
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { SlackConfig } from '../../types/slack.types.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService } from '../core/logger.service.js';
import { CredentialVaultLockedError, openSealedJson, sealJsonForWrite } from '../core/credential-vault.js';

const logger = LoggerService.getInstance().createComponentLogger('SlackCredentials');

const CREDENTIALS_FILE = 'slack-credentials.json';

/**
 * Get the path to the Slack credentials file.
 *
 * @returns Absolute path to ~/.crewly/slack-credentials.json
 */
function getCredentialsPath(): string {
	const crewlyHome = path.join(process.env.HOME || '~', '.crewly');
	return path.join(crewlyHome, CREDENTIALS_FILE);
}

/**
 * Shape of the persisted credentials file.
 */
interface PersistedSlackCredentials {
	botToken: string;
	appToken: string;
	signingSecret: string;
	defaultChannelId?: string;
	allowedUserIds?: string[];
}

/**
 * Save Slack credentials to disk with restricted file permissions (0600).
 *
 * @param config - The SlackConfig to persist.
 */
export async function saveSlackCredentials(config: SlackConfig): Promise<void> {
	const filePath = getCredentialsPath();

	const credentials: PersistedSlackCredentials = {
		botToken: config.botToken,
		appToken: config.appToken,
		signingSecret: config.signingSecret,
		defaultChannelId: config.defaultChannelId,
		allowedUserIds: config.allowedUserIds,
	};

	// Tokens sealed with the credential vault key when one is available
	// (specs/2026-10-04-agent-credential-isolation.md); public fields stay in clear.
	await atomicWriteJson(filePath, sealJsonForWrite(credentials, ['defaultChannelId', 'allowedUserIds']));

	// Restrict permissions to owner-only (0600)
	try {
		await fs.chmod(filePath, 0o600);
	} catch (error) {
		logger.warn('Failed to set credentials file permissions', {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	logger.info('Slack credentials saved to disk');
}

/**
 * Load saved Slack credentials from disk.
 *
 * @returns SlackConfig if credentials file exists and is valid, null otherwise.
 */
export async function loadSlackCredentials(): Promise<SlackConfig | null> {
	const filePath = getCredentialsPath();

	let credentials: PersistedSlackCredentials | null;
	try {
		// Sealed by the credential vault or plain — both read the same.
		credentials = openSealedJson(await safeReadJson<PersistedSlackCredentials | null>(
			filePath,
			null,
			logger
		));
	} catch (error) {
		if (!(error instanceof CredentialVaultLockedError)) throw error;
		logger.warn('Slack credentials are sealed and cannot be opened right now (vault key unavailable)', { reason: error.message });
		return null;
	}

	if (!credentials || !credentials.botToken || !credentials.appToken || !credentials.signingSecret) {
		return null;
	}

	return {
		botToken: credentials.botToken,
		appToken: credentials.appToken,
		signingSecret: credentials.signingSecret,
		defaultChannelId: credentials.defaultChannelId,
		allowedUserIds: credentials.allowedUserIds,
		socketMode: true,
	};
}

/**
 * Delete saved Slack credentials from disk.
 */
export async function deleteSlackCredentials(): Promise<void> {
	const filePath = getCredentialsPath();

	try {
		await fs.unlink(filePath);
		logger.info('Slack credentials removed from disk');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn('Failed to delete credentials file', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Check if saved Slack credentials exist on disk.
 *
 * @returns True if the credentials file exists.
 */
export async function hasSavedCredentials(): Promise<boolean> {
	const filePath = getCredentialsPath();

	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
