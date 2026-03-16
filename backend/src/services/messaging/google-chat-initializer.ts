/**
 * Google Chat Initializer
 *
 * Handles automatic Google Chat adapter reconnection on backend restart.
 * Loads saved credentials from `~/.crewly/google-chat-credentials.json`
 * and reinitializes the adapter (including Pub/Sub pull loop).
 *
 * Follows the same pattern as `slack-initializer.ts` and
 * `whatsapp-initializer.ts`.
 *
 * @module services/messaging/google-chat-initializer
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CREWLY_CONSTANTS, MESSAGE_SOURCES } from '../../constants.js';
import { MessengerRegistryService } from './messenger-registry.service.js';
import { GoogleChatMessengerAdapter } from './adapters/google-chat-messenger.adapter.js';
import { getGchatThreadStore } from './gchat-thread-store.service.js';
import { LoggerService } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import { cleanGoogleChatResponse } from '../../utils/terminal-output.utils.js';
import type { MessageQueueService } from './message-queue.service.js';
import type { IncomingMessage } from './messenger-adapter.interface.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleChatInitializer');

/**
 * Result of initialization attempt
 */
export interface GoogleChatInitResult {
  /** Whether initialization was attempted */
  attempted: boolean;
  /** Whether initialization succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Options for Google Chat initialization
 */
export interface GoogleChatInitOptions {
  /** Optional MessageQueueService for enqueuing incoming Pub/Sub messages */
  messageQueueService?: MessageQueueService;
}

/**
 * Get the path to the Google Chat credentials file.
 *
 * @returns Absolute path to the credentials JSON file
 */
function getCredentialPath(): string {
  return path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'google-chat-credentials.json');
}

/**
 * Load saved Google Chat credentials from disk.
 *
 * @returns Parsed credentials object or null if not found
 */
async function loadSavedCredentials(): Promise<Record<string, unknown> | null> {
  const credPath = getCredentialPath();
  try {
    const raw = await fs.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Create the incoming message callback for Google Chat Pub/Sub mode.
 *
 * This is the single shared callback used by both `messenger.routes.ts`
 * (manual connect) and the auto-reconnect flow in this module. It enqueues
 * incoming Pub/Sub messages into the MessageQueueService, registers thread
 * mappings in the terminal gateway, and stores conversation history in
 * the thread store.
 *
 * @param queueService - The message queue service to enqueue into
 * @param adapter - The Google Chat adapter for sending replies
 * @returns Callback function for incoming messages
 */
export function createIncomingCallback(
  queueService: MessageQueueService,
  adapter: GoogleChatMessengerAdapter,
): (msg: IncomingMessage) => void {
  return (msg: IncomingMessage) => {
    logger.info('Enqueuing Google Chat message', {
      conversationId: msg.conversationId,
      threadId: msg.threadId,
      textSnippet: msg.text.slice(0, 80),
    });

    const enqueueStartMs = Date.now();

    const replyPromise = new Promise<string>((resolve) => {
      const sourceMetadata: Record<string, unknown> = {
        channelId: msg.channelId,
        userId: msg.userId,
        threadId: msg.threadId,
        googleChatResolve: resolve,
        enqueueStartMs,
      };

      queueService.enqueue({
        content: msg.text,
        conversationId: msg.conversationId,
        source: MESSAGE_SOURCES.GOOGLE_CHAT,
        sourceMetadata,
      });
    });

    // Store user message in thread file for context recovery
    if (msg.channelId && msg.threadId) {
      const threadStore = getGchatThreadStore();
      if (threadStore) {
        threadStore.appendUserMessage(msg.channelId, msg.threadId, msg.userId || 'User', msg.text)
          .catch(() => { /* non-critical */ });
      }
    }

    replyPromise.then(async (response: string) => {
      try {
        const cleaned = cleanGoogleChatResponse(response);
        if (cleaned) {
          await adapter.sendMessage(msg.channelId, cleaned, { threadId: msg.threadId });

          // Store bot reply in thread file
          if (msg.channelId && msg.threadId) {
            const threadStore = getGchatThreadStore();
            if (threadStore) {
              await threadStore.appendBotReply(msg.channelId, msg.threadId, cleaned);
            }
          }
        }
      } catch (err) {
        logger.error('Failed to send reply', { channelId: msg.channelId, error: formatError(err) });
      }
    });
  };
}

/**
 * Initialize Google Chat integration from saved credentials.
 *
 * Designed to be called during backend startup. Checks for a saved
 * credentials file and reinitializes the adapter if found. For Pub/Sub
 * mode, also restarts the pull loop with the incoming message callback.
 *
 * @param options - Optional initialization options
 * @returns Result object indicating success or failure
 */
export async function initializeGoogleChatIfConfigured(
  options?: GoogleChatInitOptions
): Promise<GoogleChatInitResult> {
  const savedConfig = await loadSavedCredentials();

  if (!savedConfig) {
    logger.info('No saved credentials found — skipping initialization');
    return { attempted: false, success: false };
  }

  try {
    logger.info('Found saved Google Chat credentials, attempting auto-reconnect', {
      hasWebhookUrl: Boolean(savedConfig.webhookUrl),
      hasServiceAccountKey: Boolean(savedConfig.serviceAccountKey),
      hasAuthMode: Boolean(savedConfig.authMode),
      hasProjectId: Boolean(savedConfig.projectId),
      hasSubscriptionName: Boolean(savedConfig.subscriptionName),
    });

    const registry = MessengerRegistryService.getInstance();
    let adapter = registry.get('google-chat') as GoogleChatMessengerAdapter | undefined;
    if (!adapter) {
      adapter = new GoogleChatMessengerAdapter();
      registry.register(adapter);
    }

    // Build config from saved credentials
    const config: Record<string, unknown> = { ...savedConfig };

    // For Pub/Sub mode, inject the incoming message callback
    if (config.subscriptionName && config.projectId) {
      if (options?.messageQueueService) {
        config.onIncomingMessage = createIncomingCallback(
          options.messageQueueService,
          adapter,
        );
      } else {
        logger.warn('Pub/Sub config detected but no messageQueueService provided — incoming messages will be dropped');
      }
    }

    await adapter.initialize(config);

    const status = adapter.getStatus();
    logger.info('Google Chat auto-reconnect successful', {
      mode: status.details?.mode,
      authMode: status.details?.authMode,
      pullActive: status.details?.pullActive,
    });

    return { attempted: true, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Google Chat auto-reconnect failed', { error: errorMessage });
    return { attempted: true, success: false, error: errorMessage };
  }
}
