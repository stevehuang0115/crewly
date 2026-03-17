/**
 * Telegram Credentials Persistence Service
 *
 * Persists Telegram bot token to ~/.crewly/telegram-credentials.json so that
 * tokens configured via the /settings UI survive server restarts.
 * The file is written with 0600 permissions to protect secrets.
 *
 * @module services/telegram/telegram-credentials
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService } from '../core/logger.service.js';
import { TELEGRAM_CONSTANTS } from '../../constants.js';

const logger = LoggerService.getInstance().createComponentLogger('TelegramCredentials');

/**
 * Shape of the persisted Telegram credentials file.
 */
export interface PersistedTelegramCredentials {
	/** Telegram Bot API token */
	botToken: string;
	/** Default chat ID to send messages to (optional) */
	defaultChatId?: string;
	/** Allowed user IDs that can interact with the bot (optional) */
	allowedUserIds?: string[];
}

/**
 * Telegram configuration used by TelegramService.
 */
export interface TelegramConfig {
	/** Telegram Bot API token */
	botToken: string;
	/** Default chat ID */
	defaultChatId?: string;
	/** Allowed user IDs */
	allowedUserIds?: string[];
}

/**
 * Get the path to the Telegram credentials file.
 *
 * @returns Absolute path to ~/.crewly/telegram-credentials.json
 */
function getCredentialsPath(): string {
	const crewlyHome = path.join(process.env.HOME || '~', '.crewly');
	return path.join(crewlyHome, TELEGRAM_CONSTANTS.CREDENTIALS_FILE);
}

/**
 * Save Telegram credentials to disk with restricted file permissions (0600).
 *
 * @param config - The TelegramConfig to persist
 */
export async function saveTelegramCredentials(config: TelegramConfig): Promise<void> {
	const filePath = getCredentialsPath();

	const credentials: PersistedTelegramCredentials = {
		botToken: config.botToken,
		defaultChatId: config.defaultChatId,
		allowedUserIds: config.allowedUserIds,
	};

	await atomicWriteJson(filePath, credentials);

	// Restrict permissions to owner-only (0600)
	try {
		await fs.chmod(filePath, 0o600);
	} catch (error) {
		logger.warn('Failed to set credentials file permissions', {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	logger.info('Telegram credentials saved to disk');
}

/**
 * Load saved Telegram credentials from disk.
 *
 * @returns TelegramConfig if credentials file exists and is valid, null otherwise
 */
export async function loadTelegramCredentials(): Promise<TelegramConfig | null> {
	const filePath = getCredentialsPath();

	const credentials = await safeReadJson<PersistedTelegramCredentials | null>(
		filePath,
		null,
		logger
	);

	if (!credentials || !credentials.botToken) {
		return null;
	}

	return {
		botToken: credentials.botToken,
		defaultChatId: credentials.defaultChatId,
		allowedUserIds: credentials.allowedUserIds,
	};
}

/**
 * Delete saved Telegram credentials from disk.
 */
export async function deleteTelegramCredentials(): Promise<void> {
	const filePath = getCredentialsPath();

	try {
		await fs.unlink(filePath);
		logger.info('Telegram credentials removed from disk');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn('Failed to delete credentials file', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Check if saved Telegram credentials exist on disk.
 *
 * @returns True if the credentials file exists
 */
export async function hasSavedTelegramCredentials(): Promise<boolean> {
	const filePath = getCredentialsPath();

	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
