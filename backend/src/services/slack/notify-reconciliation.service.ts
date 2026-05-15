/**
 * NOTIFY Slack Delivery Reconciliation Service
 *
 * Detects chat messages with pending Slack delivery and retries them.
 * Uses persisted chat messages as the source of truth — when the orchestrator
 * outputs a [NOTIFY] with both conversationId and channelId, the chat message
 * stores Slack routing metadata and delivery status. This service periodically
 * scans for `slackDeliveryStatus === 'pending'` messages and retries delivery.
 *
 * @module services/slack/notify-reconciliation
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { v2MessageToLegacy } from '../chat-v2/legacy-dto.utils.js';
import { getSlackOrchestratorBridge } from './slack-orchestrator-bridge.js';
import { NOTIFY_RECONCILIATION_CONSTANTS } from '../../constants.js';
import type { SlackNotification, SlackNotificationType } from '../../types/slack.types.js';
import type { ChatMessage } from '../../types/chat.types.js';

/**
 * Service that periodically reconciles pending Slack deliveries.
 *
 * Lifecycle:
 * 1. `start()` — schedules first run after startup delay, then at regular intervals
 * 2. `runReconciliation()` — scans for pending messages, retries Slack delivery
 * 3. `stop()` — clears interval and startup timer
 *
 * @example
 * ```typescript
 * const reconciler = new NotifyReconciliationService();
 * reconciler.start();
 * // ... later during shutdown
 * reconciler.stop();
 * ```
 */
export class NotifyReconciliationService {
	private logger: ComponentLogger;
	private intervalHandle: ReturnType<typeof setInterval> | null = null;
	private startupTimerHandle: ReturnType<typeof setTimeout> | null = null;
	private isRunning = false;

	constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('NotifyReconciliation');
	}

	/**
	 * Start the reconciliation scheduler.
	 *
	 * Schedules the first run after a startup delay (to allow the Slack bridge
	 * to initialize), then runs at a regular interval.
	 */
	start(): void {
		if (this.intervalHandle) {
			this.logger.debug('Reconciliation already started');
			return;
		}

		this.logger.info('Starting NOTIFY reconciliation service', {
			startupDelayMs: NOTIFY_RECONCILIATION_CONSTANTS.STARTUP_DELAY_MS,
			intervalMs: NOTIFY_RECONCILIATION_CONSTANTS.RECONCILIATION_INTERVAL_MS,
		});

		this.startupTimerHandle = setTimeout(() => {
			this.startupTimerHandle = null;

			// Run immediately on first tick
			void this.runReconciliation();

			// Then schedule periodic runs
			this.intervalHandle = setInterval(() => {
				void this.runReconciliation();
			}, NOTIFY_RECONCILIATION_CONSTANTS.RECONCILIATION_INTERVAL_MS);
		}, NOTIFY_RECONCILIATION_CONSTANTS.STARTUP_DELAY_MS);
	}

	/**
	 * Stop the reconciliation scheduler and clear all timers.
	 */
	stop(): void {
		if (this.startupTimerHandle) {
			clearTimeout(this.startupTimerHandle);
			this.startupTimerHandle = null;
		}
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		this.logger.info('NOTIFY reconciliation service stopped');
	}

	/**
	 * Run a single reconciliation pass.
	 *
	 * Scans all chat messages for pending Slack deliveries within the age cutoff,
	 * rebuilds SlackNotification payloads from stored metadata, and retries delivery.
	 * Messages that exceed the max attempt count are marked as `'failed'`.
	 *
	 * Guards against concurrent runs with the `isRunning` flag.
	 */
	async runReconciliation(): Promise<void> {
		if (this.isRunning) {
			this.logger.debug('Reconciliation already in progress, skipping');
			return;
		}

		const bridge = getSlackOrchestratorBridge();
		if (!bridge.isInitialized()) {
			this.logger.debug('Slack bridge not initialized, skipping reconciliation');
			return;
		}

		this.isRunning = true;
		const stats = { total: 0, retried: 0, succeeded: 0, failed: 0, markedFailed: 0 };

		try {
			const chatV2 = getChatV2Service();
			const pendingMessages = chatV2
				.findMessagesWithPendingSlackDelivery(NOTIFY_RECONCILIATION_CONSTANTS.MAX_MESSAGE_AGE_MS)
				.map(v2MessageToLegacy);

			stats.total = pendingMessages.length;
			if (stats.total === 0) {
				return;
			}

			this.logger.info('Running NOTIFY reconciliation', { pendingCount: stats.total });

			for (const msg of pendingMessages) {
				const deliveryStatus = msg.metadata?.slackDeliveryStatus as string | undefined;

				// Skip messages already handled by the reply-slack skill or
				// that no longer have 'pending' status. The NOTIFY handler no
				// longer sets 'pending' — Slack delivery is exclusively
				// skill-handled. Only explicitly 'pending' messages (from
				// legacy code paths or manual metadata) should be retried.
				if (deliveryStatus !== 'pending') {
					this.logger.debug('Skipping non-pending message in reconciliation', {
						messageId: msg.id,
						deliveryStatus,
					});
					continue;
				}

				const attempts = (msg.metadata?.slackDeliveryAttempts as number) || 0;

				// Max attempts exceeded — mark as failed
				if (attempts >= NOTIFY_RECONCILIATION_CONSTANTS.MAX_DELIVERY_ATTEMPTS) {
					chatV2.updateMessageMetadata(msg.id, {
						slackDeliveryStatus: 'failed',
						slackDeliveryError: `Exceeded max delivery attempts (${NOTIFY_RECONCILIATION_CONSTANTS.MAX_DELIVERY_ATTEMPTS})`,
					});
					stats.markedFailed++;
					continue;
				}

				// Rebuild SlackNotification from stored metadata
				const notification = this.buildNotificationFromMessage(msg);
				if (!notification) {
					stats.failed++;
					continue;
				}

				try {
					stats.retried++;
					await bridge.sendNotification(notification);

					// Mark as delivered
					chatV2.updateMessageMetadata(msg.id, {
						slackDeliveryStatus: 'delivered',
						slackDeliveryAttemptedAt: new Date().toISOString(),
						slackDeliveryAttempts: attempts + 1,
						slackDeliveryError: undefined,
					});
					stats.succeeded++;
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);

					// Record the failure
					chatV2.updateMessageMetadata(msg.id, {
						slackDeliveryAttemptedAt: new Date().toISOString(),
						slackDeliveryAttempts: attempts + 1,
						slackDeliveryError: errorMsg,
					});
					stats.failed++;
				}
			}
		} catch (error) {
			this.logger.error('Error during NOTIFY reconciliation', {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.isRunning = false;
			if (stats.total > 0) {
				this.logger.info('NOTIFY reconciliation complete', stats);
			}
		}
	}

	/**
	 * Build a SlackNotification from stored chat message metadata.
	 *
	 * @param msg - The chat message with Slack delivery metadata
	 * @returns SlackNotification or null if required fields are missing
	 */
	private buildNotificationFromMessage(msg: ChatMessage): SlackNotification | null {
		const meta = msg.metadata;
		if (!meta?.slackChannelId) return null;

		return {
			type: ((meta.notifyType as string) || 'alert') as SlackNotificationType,
			title: (meta.notifyTitle as string) || (meta.notifyType as string) || 'Notification',
			message: msg.content,
			urgency: ((meta.notifyUrgency as string) || 'normal') as SlackNotification['urgency'],
			timestamp: new Date().toISOString(),
			channelId: meta.slackChannelId as string,
			threadTs: meta.slackThreadTs as string | undefined,
		};
	}
}
