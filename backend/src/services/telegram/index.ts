/**
 * Telegram Services Barrel Export
 *
 * @module services/telegram
 */

export { TelegramService, getTelegramService, resetTelegramService } from './telegram.service.js';
export type { TelegramUpdate, TelegramMessage, TelegramIncomingMessage } from './telegram.service.js';

export {
	TelegramOrchestratorBridge,
	getTelegramOrchestratorBridge,
	resetTelegramOrchestratorBridge,
} from './telegram-orchestrator-bridge.js';

export {
	initializeTelegramIfConfigured,
	shutdownTelegram,
	isTelegramConfigured,
	getTelegramConfig,
	getTelegramConfigFromEnv,
} from './telegram-initializer.js';
export type { TelegramInitResult, TelegramInitOptions } from './telegram-initializer.js';

export {
	saveTelegramCredentials,
	loadTelegramCredentials,
	deleteTelegramCredentials,
	hasSavedTelegramCredentials,
} from './telegram-credentials.service.js';
export type { TelegramConfig, PersistedTelegramCredentials } from './telegram-credentials.service.js';

export {
	TelegramThreadStoreService,
	getTelegramThreadStore,
	setTelegramThreadStore,
	resetTelegramThreadStore,
} from './telegram-thread-store.service.js';
