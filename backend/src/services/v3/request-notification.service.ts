/**
 * Request Notification Service — Proactive user feedback for V3 Requests
 *
 * Listens for V3 Request status changes and provides immediate feedback to
 * the user via the original communication platform (e.g., Slack reactions).
 *
 * This service is the "proactive" layer of the Session-less architecture.
 *
 * @module services/v3/request-notification.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { EventBusService } from '../event-bus/index.js';
import { RequestService } from './request.service.js';
import { ThreadStatusQueueService } from '../messaging/thread-status-queue.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { RequestStatus } from '../../types/v2/request.types.js';

/**
 * Service that handles proactive notifications for Request status changes.
 */
export class RequestNotificationService {
  private logger: ComponentLogger;
  private projectPath: string;

  constructor(
    private eventBus: EventBusService,
    private threadStatusQueue: ThreadStatusQueueService,
    projectPath: string
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('RequestNotification');
    this.projectPath = projectPath;
  }

  /**
   * Initialize the service by subscribing to events.
   */
  public initialize(): void {
    this.eventBus.on('v3:request_updated', this.onRequestUpdated.bind(this));
    this.logger.info('RequestNotificationService initialized and listening for v3:request_updated');
  }

  /**
   * Clean up event listeners.
   */
  public destroy(): void {
    this.eventBus.removeAllListeners('v3:request_updated');
  }

  /**
   * Handles v3:request_updated event.
   *
   * @param event - Request updated event payload
   */
  private async onRequestUpdated(event: {
    requestId: string;
    status: RequestStatus;
    previousStatus?: RequestStatus;
  }): Promise<void> {
    try {
      const { requestId, status, previousStatus } = event;

      // Only act on specific status transitions that provide high user value
      if (status === previousStatus) return;

      // Case 1: Request completed (Done)
      if (status === 'done') {
        await this.handleRequestCompleted(requestId);
      } 
      // Case 2: Request blocked
      else if (status === 'blocked') {
        await this.handleRequestBlocked(requestId);
      }
      // Case 3: Request running (optional, maybe a 'eyes' reaction)
      else if (status === 'running' && previousStatus === 'ready') {
        await this.handleRequestStarted(requestId);
      }
    } catch (err) {
      this.logger.error('Failed to handle request update notification', {
        requestId: event.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles request completion (done).
   * Adds a checkmark reaction to the original Slack message if applicable.
   */
  private async handleRequestCompleted(requestId: string): Promise<void> {
    const request = await RequestService.getInstance(this.projectPath).getById(requestId);
    if (!request) return;

    const queueMessageId = request.sourceConversationItemId;
    const threadEntry = this.threadStatusQueue.getByQueueMessageId(queueMessageId);

    if (threadEntry && threadEntry.source === 'slack') {
      const metadata = threadEntry.sourceMetadata as any;
      const channelId = metadata?.channelId;
      // Use threadTs as the fallback for ts if specific ts is not recorded
      const ts = metadata?.ts || metadata?.threadTs;

      if (channelId && ts) {
        try {
          const slack = getSlackService();
          await slack.addReaction(channelId, ts, 'white_check_mark');
          this.logger.info('Added white_check_mark reaction to Slack message', { requestId, channelId, ts });
        } catch (err) {
          this.logger.debug('Failed to add Slack reaction (non-fatal)', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Handles request blocked.
   * Adds a warning reaction to the original Slack message if applicable.
   */
  private async handleRequestBlocked(requestId: string): Promise<void> {
    const request = await RequestService.getInstance(this.projectPath).getById(requestId);
    if (!request) return;

    const queueMessageId = request.sourceConversationItemId;
    const threadEntry = this.threadStatusQueue.getByQueueMessageId(queueMessageId);

    if (threadEntry && threadEntry.source === 'slack') {
      const metadata = threadEntry.sourceMetadata as any;
      const channelId = metadata?.channelId;
      const ts = metadata?.ts || metadata?.threadTs;

      if (channelId && ts) {
        try {
          const slack = getSlackService();
          await slack.addReaction(channelId, ts, 'warning');
          this.logger.info('Added warning reaction to Slack message', { requestId, channelId, ts });
        } catch (err) {
          this.logger.debug('Failed to add Slack reaction (non-fatal)', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Handles request started (running).
   * Adds a 'eyes' reaction to the original Slack message if applicable.
   */
  private async handleRequestStarted(requestId: string): Promise<void> {
    const request = await RequestService.getInstance(this.projectPath).getById(requestId);
    if (!request) return;

    const queueMessageId = request.sourceConversationItemId;
    const threadEntry = this.threadStatusQueue.getByQueueMessageId(queueMessageId);

    if (threadEntry && threadEntry.source === 'slack') {
      const metadata = threadEntry.sourceMetadata as any;
      const channelId = metadata?.channelId;
      const ts = metadata?.ts || metadata?.threadTs;

      if (channelId && ts) {
        try {
          const slack = getSlackService();
          await slack.addReaction(channelId, ts, 'eyes');
          this.logger.info('Added eyes reaction to Slack message', { requestId, channelId, ts });
        } catch (err) {
          this.logger.debug('Failed to add Slack reaction (non-fatal)', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
