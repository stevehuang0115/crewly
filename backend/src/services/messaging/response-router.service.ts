/**
 * Response Router Service
 *
 * Routes orchestrator responses back to the correct source.
 * - Web chat: no-op (existing TerminalGateway -> ChatGateway -> WebSocket pipeline handles it)
 * - Slack: resolves the blocking promise via the slackResolve callback
 *
 * @module services/messaging/response-router
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { formatError } from '../../utils/format-error.js';
import type { QueuedMessage } from '../../types/messaging.types.js';

/**
 * ResponseRouterService routes orchestrator responses to the appropriate
 * destination based on the message source.
 *
 * @example
 * ```typescript
 * const router = new ResponseRouterService();
 * router.routeResponse(completedMessage, 'Here is the response');
 * ```
 */
export class ResponseRouterService {
  private logger: ComponentLogger;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('ResponseRouter');
  }

  /**
   * Route a response to the appropriate destination based on message source.
   *
   * @param message - The completed/failed QueuedMessage
   * @param response - The response content from the orchestrator
   */
  routeResponse(message: QueuedMessage, response: string): void {
    switch (message.source) {
      case 'web_chat':
        this.routeToWebChat(message, response);
        break;
      case 'slack':
        this.routeToSlack(message, response);
        break;
      case 'google_chat':
        this.routeToGoogleChat(message, response);
        break;
      case 'telegram':
        this.routeToTelegram(message, response);
        break;
      case 'system_event':
        this.logger.debug('System event response routed (no-op)', {
          messageId: message.id,
        });
        break;
      default:
        this.logger.warn('Unknown message source for routing', {
          messageId: message.id,
          source: message.source,
        });
    }
  }

  /**
   * Route response to web chat.
   * This is a no-op because the existing TerminalGateway -> ChatGateway ->
   * WebSocket pipeline already broadcasts responses to connected clients.
   *
   * @param message - The completed QueuedMessage
   * @param response - The response content
   */
  private routeToWebChat(message: QueuedMessage, response: string): void {
    this.logger.debug('Web chat response routed (via existing WebSocket pipeline)', {
      messageId: message.id,
      conversationId: message.conversationId,
      responseLength: response.length,
    });
  }

  /**
   * Route response to Slack by calling the slackResolve callback.
   * This unblocks the Slack bridge's promise that is waiting for a response.
   *
   * @param message - The completed QueuedMessage
   * @param response - The response content
   */
  private routeToSlack(message: QueuedMessage, response: string): void {
    this.resolveCallback(message, response, 'slackResolve', 'Slack');
  }

  /**
   * Route response to Google Chat by calling the googleChatResolve callback.
   * This unblocks the promise that sends the reply back to the Chat thread.
   *
   * @param message - The completed QueuedMessage
   * @param response - The response content
   */
  private routeToGoogleChat(message: QueuedMessage, response: string): void {
    this.resolveCallback(message, response, 'googleChatResolve', 'Google Chat');
  }

  /**
   * Route response to Telegram by calling the telegramResolve callback.
   * This unblocks the promise that sends the reply back to the Telegram chat.
   *
   * @param message - The completed QueuedMessage
   * @param response - The response content
   */
  private routeToTelegram(message: QueuedMessage, response: string): void {
    this.resolveCallback(message, response, 'telegramResolve', 'Telegram');
  }

  /**
   * Resolve a source-specific callback stored in the message's sourceMetadata.
   *
   * Shared helper used by routeToSlack, routeToGoogleChat, and routeError
   * to avoid duplicating the resolve-callback pattern.
   *
   * @param message - The QueuedMessage containing the callback in sourceMetadata
   * @param response - The response string to pass to the callback
   * @param callbackKey - The key in sourceMetadata that holds the resolve function
   * @param label - Human-readable label for log messages (e.g. "Slack", "Google Chat")
   */
  private resolveCallback(message: QueuedMessage, response: string, callbackKey: string, label: string): void {
    const resolve = message.sourceMetadata?.[callbackKey];
    if (typeof resolve === 'function') {
      try {
        resolve(response);
        this.logger.debug(`${label} response resolved`, {
          messageId: message.id,
          conversationId: message.conversationId,
          responseLength: response.length,
        });
      } catch (error) {
        this.logger.error(`Failed to resolve ${label} response`, {
          messageId: message.id,
          error: formatError(error),
        });
      }
    } else {
      this.logger.warn(`${label} message has no ${callbackKey} callback`, {
        messageId: message.id,
        conversationId: message.conversationId,
      });
    }
  }

  /**
   * Route an error to the appropriate destination.
   *
   * @param message - The failed QueuedMessage
   * @param error - The error message
   */
  routeError(message: QueuedMessage, error: string): void {
    switch (message.source) {
      case 'web_chat':
        this.logger.debug('Web chat error routed (via existing pipeline)', {
          messageId: message.id,
          error,
        });
        break;
      case 'slack':
        this.resolveCallback(message, `Error: ${error}`, 'slackResolve', 'Slack');
        break;
      case 'google_chat':
        this.resolveCallback(message, `Error: ${error}`, 'googleChatResolve', 'Google Chat');
        break;
      case 'telegram':
        this.resolveCallback(message, `Error: ${error}`, 'telegramResolve', 'Telegram');
        break;
      case 'system_event':
        this.logger.debug('System event error routed (no-op)', {
          messageId: message.id,
          error,
        });
        break;
      default:
        this.logger.warn('Unknown message source for error routing', {
          messageId: message.id,
          source: message.source,
        });
    }
  }
}
