/**
 * Telegram Initializer
 *
 * Handles automatic Telegram connection on application startup.
 * Checks for environment variables or saved credentials and initializes
 * the TelegramService + bridge if configured.
 *
 * @module services/telegram/telegram-initializer
 */

import { getTelegramService } from './telegram.service.js';
import { getTelegramOrchestratorBridge } from './telegram-orchestrator-bridge.js';
import { loadTelegramCredentials, TelegramConfig } from './telegram-credentials.service.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TelegramInitializer');

/**
 * Result of initialization attempt.
 */
export interface TelegramInitResult {
	/** Whether initialization was attempted */
	attempted: boolean;
	/** Whether initialization succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Check if Telegram is configured via environment variables.
 *
 * @returns True if TELEGRAM_BOT_TOKEN is set
 */
export function isTelegramConfigured(): boolean {
	return !!process.env.TELEGRAM_BOT_TOKEN;
}

/**
 * Get Telegram configuration from environment variables.
 *
 * @returns TelegramConfig object or null if not configured
 */
export function getTelegramConfigFromEnv(): TelegramConfig | null {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;

	if (!botToken) {
		return null;
	}

	return {
		botToken,
		defaultChatId: process.env.TELEGRAM_DEFAULT_CHAT_ID,
		allowedUserIds: process.env.TELEGRAM_ALLOWED_USERS?.split(',').filter(Boolean),
	};
}

/**
 * Get Telegram configuration from environment variables or saved credentials.
 * Environment variables take priority over saved credentials.
 *
 * @returns TelegramConfig object or null if not configured
 */
export async function getTelegramConfig(): Promise<TelegramConfig | null> {
	// Env vars take priority
	const envConfig = getTelegramConfigFromEnv();
	if (envConfig) {
		return envConfig;
	}

	// Fall back to saved credentials
	try {
		const savedConfig = await loadTelegramCredentials();
		if (savedConfig) {
			logger.info('Loaded Telegram credentials from saved config');
			return savedConfig;
		}
	} catch (error) {
		logger.warn('Failed to load saved Telegram credentials', {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	return null;
}

/**
 * Options for Telegram initialization.
 */
export interface TelegramInitOptions {
	/** Optional MessageQueueService for enqueuing messages to orchestrator */
	messageQueueService?: MessageQueueService;
}

/**
 * Initialize Telegram integration if configured via environment variables
 * or saved credentials.
 *
 * This function is designed to be called during application startup.
 * It safely handles cases where Telegram is not configured.
 *
 * @param options - Optional initialization options
 * @returns Result object indicating success or failure
 *
 * @example
 * ```typescript
 * const result = await initializeTelegramIfConfigured({
 *   messageQueueService: myQueueService,
 * });
 * if (result.success) {
 *   console.log('Telegram connected!');
 * }
 * ```
 */
export async function initializeTelegramIfConfigured(
	options?: TelegramInitOptions
): Promise<TelegramInitResult> {
	const config = await getTelegramConfig();

	if (!config) {
		logger.info('Not configured — skipping initialization');
		return { attempted: false, success: false };
	}

	try {
		const telegramService = getTelegramService();
		await telegramService.initialize(config);

		const bridge = getTelegramOrchestratorBridge();

		// Set the message queue service if provided
		if (options?.messageQueueService) {
			bridge.setMessageQueueService(options.messageQueueService);
		}

		await bridge.initialize();

		// Start polling for incoming messages
		telegramService.startPolling();

		logger.info('Successfully connected and polling started');
		return { attempted: true, success: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		logger.error('Failed to initialize', { error: errorMessage });
		return { attempted: true, success: false, error: errorMessage };
	}
}

/**
 * Gracefully shutdown Telegram integration.
 *
 * Call this during application shutdown to disconnect cleanly.
 */
export async function shutdownTelegram(): Promise<void> {
	try {
		const telegramService = getTelegramService();
		if (telegramService.isConnected()) {
			await telegramService.disconnect();
			logger.info('Disconnected');
		}
	} catch (error) {
		logger.error('Error during shutdown', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
