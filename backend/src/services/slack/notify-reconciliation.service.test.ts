/**
 * Tests for NOTIFY Slack Delivery Reconciliation Service
 *
 * Validates the NotifyReconciliationService lifecycle (start/stop),
 * reconciliation logic (retry, max-attempts marking, error handling),
 * and the private buildNotificationFromMessage helper (tested indirectly).
 *
 * @module services/slack/notify-reconciliation.service.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { ChatMessage } from '../../types/chat.types.js';
import type { SlackNotification } from '../../types/slack.types.js';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that reference them
// ---------------------------------------------------------------------------

/** Mock logger */
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(() => ({
			createComponentLogger: jest.fn(() => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			})),
		})),
	},
}));

/** Mock constants with small values suitable for testing */
const TEST_CONSTANTS = {
	RECONCILIATION_INTERVAL_MS: 500,
	MAX_MESSAGE_AGE_MS: 60_000,
	MAX_DELIVERY_ATTEMPTS: 5,
	STARTUP_DELAY_MS: 100,
};

jest.mock('../../constants.js', () => ({
	NOTIFY_RECONCILIATION_CONSTANTS: {
		RECONCILIATION_INTERVAL_MS: 500,
		MAX_MESSAGE_AGE_MS: 60_000,
		MAX_DELIVERY_ATTEMPTS: 5,
		STARTUP_DELAY_MS: 100,
	},
}));

/** Mock ChatService returned by getChatService() */
const mockChatService = {
	getMessagesWithPendingSlackDelivery: jest.fn<(maxAge: number) => Promise<ChatMessage[]>>(),
	updateMessageMetadata: jest.fn<
		(convId: string, msgId: string, patch: Record<string, unknown>) => Promise<ChatMessage | null>
	>(),
};

jest.mock('../chat/chat.service.js', () => ({
	getChatService: jest.fn(() => mockChatService),
}));

/** Mock SlackOrchestratorBridge returned by getSlackOrchestratorBridge() */
const mockBridge = {
	isInitialized: jest.fn<() => boolean>(),
	sendNotification: jest.fn<(n: SlackNotification) => Promise<void>>(),
};

jest.mock('./slack-orchestrator-bridge.js', () => ({
	getSlackOrchestratorBridge: jest.fn(() => mockBridge),
}));

// ---------------------------------------------------------------------------
// Import under test — AFTER mocks are wired
// ---------------------------------------------------------------------------
import { NotifyReconciliationService } from './notify-reconciliation.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ChatMessage fixture with Slack delivery metadata.
 *
 * @param overrides - Fields to override on the base fixture
 * @returns A ChatMessage suitable for reconciliation tests
 */
function makePendingMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: 'msg-1',
		conversationId: 'conv-1',
		from: { type: 'orchestrator', name: 'Orchestrator' },
		content: 'Task completed successfully',
		contentType: 'text',
		status: 'sent',
		timestamp: new Date().toISOString(),
		metadata: {
			slackDeliveryStatus: 'pending',
			slackDeliveryAttempts: 1,
			slackChannelId: 'C12345',
			notifyType: 'task_completed',
			notifyTitle: 'Task Done',
			notifyUrgency: 'normal',
		},
		...overrides,
	};
}

/**
 * Flush microtask queue to allow async operations (like the void-returned
 * runReconciliation promises) to settle between fake timer advancements.
 */
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('NotifyReconciliationService', () => {
	let service: NotifyReconciliationService;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();

		service = new NotifyReconciliationService();

		// Default: bridge is initialized
		mockBridge.isInitialized.mockReturnValue(true);
		// Default: no pending messages
		mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([]);
		// Default: updateMessageMetadata resolves successfully
		mockChatService.updateMessageMetadata.mockResolvedValue(null);
		// Default: sendNotification resolves
		mockBridge.sendNotification.mockResolvedValue(undefined);
	});

	afterEach(() => {
		service.stop();
		jest.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// start()
	// -----------------------------------------------------------------------

	describe('start()', () => {
		it('should not throw when called', () => {
			expect(() => service.start()).not.toThrow();
		});

		it('should be idempotent — calling start twice does not create duplicate intervals', async () => {
			service.start();
			service.start();

			// Advance past startup delay + one interval tick
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + TEST_CONSTANTS.RECONCILIATION_INTERVAL_MS + 50);
			await flushMicrotasks();

			// runReconciliation should only have been invoked from one schedule chain.
			// The first call is the immediate run after startup delay, the second from the interval.
			// If duplicates existed we would see 4+ calls.
			expect(mockChatService.getMessagesWithPendingSlackDelivery.mock.calls.length).toBeLessThanOrEqual(2);
		});

		it('should schedule first reconciliation after startup delay', () => {
			service.start();

			// Before delay: no calls
			expect(mockChatService.getMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();

			// After startup delay
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);

			// The immediate run should have been invoked
			expect(mockBridge.isInitialized).toHaveBeenCalled();
		});

		it('should schedule periodic runs after startup delay', async () => {
			service.start();

			// Advance past startup delay (triggers immediate run)
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);
			// Flush microtasks so the async runReconciliation completes and resets isRunning
			await flushMicrotasks();

			const callsAfterStartup = mockBridge.isInitialized.mock.calls.length;

			// Advance by one interval
			jest.advanceTimersByTime(TEST_CONSTANTS.RECONCILIATION_INTERVAL_MS + 10);
			await flushMicrotasks();

			expect(mockBridge.isInitialized.mock.calls.length).toBeGreaterThan(callsAfterStartup);
		});
	});

	// -----------------------------------------------------------------------
	// stop()
	// -----------------------------------------------------------------------

	describe('stop()', () => {
		it('should not throw when called without prior start', () => {
			expect(() => service.stop()).not.toThrow();
		});

		it('should clear the startup timer when called before startup delay fires', () => {
			service.start();

			// Stop before the startup delay fires
			service.stop();

			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + TEST_CONSTANTS.RECONCILIATION_INTERVAL_MS + 100);

			// No reconciliation should have run
			expect(mockChatService.getMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();
		});

		it('should clear the interval when called after startup delay fires', async () => {
			service.start();

			// Let startup delay fire (triggers immediate run)
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);
			await flushMicrotasks();

			const callsBeforeStop = mockBridge.isInitialized.mock.calls.length;

			service.stop();

			// Advance several intervals — no further calls should occur
			jest.advanceTimersByTime(TEST_CONSTANTS.RECONCILIATION_INTERVAL_MS * 5);
			await flushMicrotasks();

			expect(mockBridge.isInitialized.mock.calls.length).toBe(callsBeforeStop);
		});

		it('should be safe to call stop multiple times', () => {
			service.start();
			expect(() => {
				service.stop();
				service.stop();
				service.stop();
			}).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// runReconciliation()
	// -----------------------------------------------------------------------

	describe('runReconciliation()', () => {
		it('should skip when bridge is not initialized', async () => {
			mockBridge.isInitialized.mockReturnValue(false);

			await service.runReconciliation();

			expect(mockChatService.getMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();
		});

		it('should skip when already running (concurrent guard)', async () => {
			// Make getMessagesWithPendingSlackDelivery block until we resolve it
			let resolveBlocking!: () => void;
			const blockingPromise = new Promise<ChatMessage[]>((resolve) => {
				resolveBlocking = () => resolve([]);
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockReturnValue(blockingPromise);

			// Start first run — it will block inside getMessagesWithPendingSlackDelivery
			const run1 = service.runReconciliation();

			// Second run while first is in progress — should skip
			const run2 = service.runReconciliation();

			// Unblock the first run
			resolveBlocking();
			await run1;
			await run2;

			// getMessagesWithPendingSlackDelivery should only be called once (from run1)
			expect(mockChatService.getMessagesWithPendingSlackDelivery).toHaveBeenCalledTimes(1);
		});

		it('should do nothing when no pending messages exist', async () => {
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatService.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should retry pending messages and mark as delivered on success', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 2,
					slackChannelId: 'C99999',
					notifyType: 'project_update',
					notifyTitle: 'Project Update',
					notifyUrgency: 'high',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			// Should have called sendNotification with a rebuilt notification
			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
			const sentNotification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(sentNotification.channelId).toBe('C99999');
			expect(sentNotification.type).toBe('project_update');
			expect(sentNotification.title).toBe('Project Update');
			expect(sentNotification.message).toBe(msg.content);
			expect(sentNotification.urgency).toBe('high');

			// Should mark as delivered
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryStatus: 'delivered',
					slackDeliveryAttempts: 3,
				})
			);
		});

		it('should increment attempts and store error on delivery failure', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 1,
					slackChannelId: 'C12345',
					notifyType: 'alert',
					notifyTitle: 'Alert',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockRejectedValue(new Error('Slack API rate limit'));

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);

			// Should update with incremented attempts and error
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryAttempts: 2,
					slackDeliveryError: 'Slack API rate limit',
				})
			);
			// Should NOT have been marked as delivered
			expect(mockChatService.updateMessageMetadata).not.toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({ slackDeliveryStatus: 'delivered' })
			);
		});

		it('should store stringified error when failure is not an Error instance', async () => {
			const msg = makePendingMessage();
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockRejectedValue('raw string error');

			await service.runReconciliation();

			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryError: 'raw string error',
				})
			);
		});

		it('should mark messages as failed when max attempts exceeded', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: TEST_CONSTANTS.MAX_DELIVERY_ATTEMPTS, // already at max
					slackChannelId: 'C12345',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);

			await service.runReconciliation();

			// Should NOT attempt to send notification
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();

			// Should mark as failed
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryStatus: 'failed',
					slackDeliveryError: expect.stringContaining(`Exceeded max delivery attempts (${TEST_CONSTANTS.MAX_DELIVERY_ATTEMPTS})`),
				})
			);
		});

		it('should mark as failed when attempts exceed max (greater than, not just equal)', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: TEST_CONSTANTS.MAX_DELIVERY_ATTEMPTS + 3,
					slackChannelId: 'C12345',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({ slackDeliveryStatus: 'failed' })
			);
		});

		it('should handle messages with zero prior attempts', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					notifyType: 'alert',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryStatus: 'delivered',
					slackDeliveryAttempts: 1,
				})
			);
		});

		it('should handle messages with undefined slackDeliveryAttempts (treated as 0)', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackChannelId: 'C12345',
					// no slackDeliveryAttempts field
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				msg.conversationId,
				msg.id,
				expect.objectContaining({
					slackDeliveryStatus: 'delivered',
					slackDeliveryAttempts: 1,
				})
			);
		});

		it('should handle errors in getMessagesWithPendingSlackDelivery gracefully', async () => {
			mockChatService.getMessagesWithPendingSlackDelivery.mockRejectedValue(
				new Error('Database unavailable')
			);

			// Should not throw
			await expect(service.runReconciliation()).resolves.not.toThrow();

			// No delivery attempts should have been made
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatService.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should reset isRunning flag after getMessagesWithPendingSlackDelivery throws', async () => {
			mockChatService.getMessagesWithPendingSlackDelivery.mockRejectedValue(
				new Error('Database unavailable')
			);

			await service.runReconciliation();

			// Should be able to run again (isRunning reset via finally)
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([]);
			await service.runReconciliation();

			// Called twice: once for the error, once for the retry
			expect(mockChatService.getMessagesWithPendingSlackDelivery).toHaveBeenCalledTimes(2);
		});

		it('should process multiple messages in a single pass', async () => {
			const msg1 = makePendingMessage({ id: 'msg-1', conversationId: 'conv-1' });
			const msg2 = makePendingMessage({
				id: 'msg-2',
				conversationId: 'conv-2',
				content: 'Agent error detected',
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C99999',
					notifyType: 'agent_error',
					notifyTitle: 'Agent Error',
					notifyUrgency: 'critical',
				},
			});
			const msg3Failed = makePendingMessage({
				id: 'msg-3',
				conversationId: 'conv-3',
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: TEST_CONSTANTS.MAX_DELIVERY_ATTEMPTS,
					slackChannelId: 'C77777',
				},
			});

			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg1, msg2, msg3Failed]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			// msg1 and msg2 should be retried, msg3 should be marked failed
			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(2);
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledTimes(3);

			// msg3 should be marked as failed
			expect(mockChatService.updateMessageMetadata).toHaveBeenCalledWith(
				'conv-3',
				'msg-3',
				expect.objectContaining({ slackDeliveryStatus: 'failed' })
			);
		});

		it('should skip messages where buildNotificationFromMessage returns null (missing channelId)', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 1,
					// slackChannelId is missing — buildNotificationFromMessage returns null
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);

			await service.runReconciliation();

			// Should not attempt delivery
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			// Should not update metadata (it increments the "failed" stat, not the metadata)
			expect(mockChatService.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should skip messages with no metadata at all', async () => {
			const msg = makePendingMessage({ metadata: undefined });
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
		});

		it('should skip messages with delivered status', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'delivered',
					slackChannelId: 'C12345',
					slackDeliveryAttempts: 1,
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatService.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should pass MAX_MESSAGE_AGE_MS to getMessagesWithPendingSlackDelivery', async () => {
			await service.runReconciliation();

			expect(mockChatService.getMessagesWithPendingSlackDelivery).toHaveBeenCalledWith(
				TEST_CONSTANTS.MAX_MESSAGE_AGE_MS
			);
		});
	});

	// -----------------------------------------------------------------------
	// buildNotificationFromMessage (tested indirectly)
	// -----------------------------------------------------------------------

	describe('buildNotificationFromMessage (indirect)', () => {
		it('should build notification with all metadata fields', async () => {
			const msg = makePendingMessage({
				content: 'Deployment finished',
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C-DEPLOY',
					slackThreadTs: '1234567890.123456',
					notifyType: 'task_completed',
					notifyTitle: 'Deployment Complete',
					notifyUrgency: 'high',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification).toEqual(
				expect.objectContaining({
					type: 'task_completed',
					title: 'Deployment Complete',
					message: 'Deployment finished',
					urgency: 'high',
					channelId: 'C-DEPLOY',
					threadTs: '1234567890.123456',
				})
			);
			expect(notification.timestamp).toBeDefined();
		});

		it('should default type to "alert" when notifyType is missing', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					// no notifyType
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.type).toBe('alert');
		});

		it('should default urgency to "normal" when notifyUrgency is missing', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					// no notifyUrgency
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.urgency).toBe('normal');
		});

		it('should use notifyType as title fallback when notifyTitle is missing', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					notifyType: 'agent_error',
					// no notifyTitle
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.title).toBe('agent_error');
		});

		it('should fall back to "Notification" title when both notifyTitle and notifyType are missing', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					// no notifyTitle, no notifyType
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.title).toBe('Notification');
		});

		it('should use message content as notification message body', async () => {
			const msg = makePendingMessage({
				content: 'Custom notification body text',
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.message).toBe('Custom notification body text');
		});

		it('should not include threadTs when slackThreadTs is absent', async () => {
			const msg = makePendingMessage({
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: 0,
					slackChannelId: 'C12345',
					// no slackThreadTs
				},
			});
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			const notification = mockBridge.sendNotification.mock.calls[0][0] as SlackNotification;
			expect(notification.threadTs).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Integration: start -> reconciliation -> stop
	// -----------------------------------------------------------------------

	describe('lifecycle integration', () => {
		it('should run reconciliation via the scheduled timer after start', async () => {
			const msg = makePendingMessage();
			mockChatService.getMessagesWithPendingSlackDelivery.mockResolvedValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			service.start();

			// Advance past the startup delay to trigger the immediate run
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);

			// Allow microtask queue to flush (runReconciliation is async)
			await flushMicrotasks();

			expect(mockBridge.isInitialized).toHaveBeenCalled();
			expect(mockChatService.getMessagesWithPendingSlackDelivery).toHaveBeenCalled();
		});

		it('should allow restart after stop', async () => {
			service.start();
			service.stop();

			// Starting again should work
			expect(() => service.start()).not.toThrow();

			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);
			await flushMicrotasks();

			expect(mockBridge.isInitialized).toHaveBeenCalled();
		});
	});
});
