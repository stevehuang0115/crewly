/**
 * WhatsApp Initializer
 *
 * Handles automatic WhatsApp connection on application startup.
 * Connects when `WHATSAPP_ENABLED=true`, or when the owner connected from the
 * dashboard earlier (persisted `~/.crewly/whatsapp/connection.json` with
 * auto-connect on). The orchestrator bridge (auto-replies) is started only in
 * `assistant` mode — never in `inbox` mode.
 *
 * @module services/whatsapp/initializer
 */

import { getWhatsAppService } from './whatsapp.service.js';
import { getWhatsAppOrchestratorBridge } from './whatsapp-orchestrator-bridge.js';
import { isWhatsAppMode, type WhatsAppConfig, type WhatsAppMode } from '../../types/whatsapp.types.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import { LoggerService } from '../core/logger.service.js';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import { loadWhatsAppConnection, toWhatsAppConfig } from './whatsapp-connection-config.js';

const logger = LoggerService.getInstance().createComponentLogger('WhatsAppInitializer');

/**
 * Result of initialization attempt
 */
export interface WhatsAppInitResult {
  /** Whether initialization was attempted */
  attempted: boolean;
  /** Whether initialization succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Options for WhatsApp initialization
 */
export interface WhatsAppInitOptions {
  /** Optional MessageQueueService for enqueuing messages to orchestrator */
  messageQueueService?: MessageQueueService;
}

/**
 * Check if WhatsApp is configured via environment variables.
 *
 * @returns True if WHATSAPP_ENABLED is set to 'true'
 */
export function isWhatsAppConfigured(): boolean {
  return process.env.WHATSAPP_ENABLED === 'true';
}

/**
 * Get WhatsApp configuration from environment variables.
 *
 * @returns WhatsAppConfig object or null if not configured
 */
export function getWhatsAppConfigFromEnv(): WhatsAppConfig | null {
  if (!isWhatsAppConfigured()) {
    return null;
  }

  return {
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER,
    authStatePath: process.env.WHATSAPP_AUTH_PATH,
    allowedContacts: process.env.WHATSAPP_ALLOWED_CONTACTS?.split(',').filter(Boolean),
    mode: getWhatsAppModeFromEnv(),
  };
}

/**
 * Read `WHATSAPP_MODE` (`assistant` | `inbox`).
 *
 * @returns The mode, or undefined when unset or invalid
 */
export function getWhatsAppModeFromEnv(): WhatsAppMode | undefined {
  const raw = process.env.WHATSAPP_MODE?.trim().toLowerCase();
  return isWhatsAppMode(raw) ? raw : undefined;
}

/**
 * Work out what to connect with at startup, if anything.
 *
 * - `WHATSAPP_ENABLED=true`: env config; mode from `WHATSAPP_MODE`, else the
 *   persisted mode, else `assistant` (what the env path always meant).
 * - Otherwise: the persisted dashboard connection, when auto-connect is on.
 *
 * @returns Config to initialize with, or null to stay disconnected
 */
export async function resolveStartupWhatsAppConfig(): Promise<WhatsAppConfig | null> {
  const persisted = await loadWhatsAppConnection();
  const envConfig = getWhatsAppConfigFromEnv();
  if (envConfig) {
    return {
      ...envConfig,
      mode: envConfig.mode ?? persisted?.mode ?? WHATSAPP_CONSTANTS.LEGACY_ENV_MODE,
    };
  }
  if (persisted?.autoConnect) return toWhatsAppConfig(persisted);
  return null;
}

/**
 * Start or stop the orchestrator bridge to match a connection mode.
 *
 * `assistant` starts it (routes messages to the orchestrator and replies).
 * `inbox` tears down any bridge left from an earlier assistant connection
 * so nothing can auto-reply.
 *
 * @param mode - Connection mode
 * @param messageQueueService - Queue for orchestrator delivery (assistant only)
 */
export async function applyBridgeForMode(
  mode: WhatsAppMode,
  messageQueueService?: MessageQueueService,
): Promise<void> {
  const bridge = getWhatsAppOrchestratorBridge();
  if (mode !== WHATSAPP_CONSTANTS.MODES.ASSISTANT) {
    bridge.cleanup();
    return;
  }
  if (messageQueueService) {
    bridge.setMessageQueueService(messageQueueService);
  }
  await bridge.initialize();
}

/**
 * Initialize WhatsApp integration if configured via environment variables.
 *
 * This function is designed to be called during application startup.
 * It safely handles cases where WhatsApp is not configured.
 *
 * @param options - Optional initialization options
 * @returns Result object indicating success or failure
 *
 * @example
 * ```typescript
 * const result = await initializeWhatsAppIfConfigured({
 *   messageQueueService: myService,
 * });
 * if (result.success) {
 *   console.log('WhatsApp connected!');
 * }
 * ```
 */
export async function initializeWhatsAppIfConfigured(
  options?: WhatsAppInitOptions,
): Promise<WhatsAppInitResult> {
  const config = await resolveStartupWhatsAppConfig();

  if (!config) {
    logger.info('Not configured — skipping initialization');
    return { attempted: false, success: false };
  }

  try {
    const mode = config.mode ?? WHATSAPP_CONSTANTS.LEGACY_ENV_MODE;
    const whatsappService = getWhatsAppService();
    await whatsappService.initialize({ ...config, mode });
    await applyBridgeForMode(mode, options?.messageQueueService);

    logger.info('Successfully initialized', { mode });
    return { attempted: true, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to initialize', { error: errorMessage });
    return { attempted: true, success: false, error: errorMessage };
  }
}

/**
 * Gracefully shutdown WhatsApp integration.
 * Call this during application shutdown to disconnect cleanly.
 */
export async function shutdownWhatsApp(): Promise<void> {
  try {
    const whatsappService = getWhatsAppService();
    if (whatsappService.isConnected()) {
      await whatsappService.disconnect();
      logger.info('Disconnected');
    }
  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
