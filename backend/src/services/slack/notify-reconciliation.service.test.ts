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
import type { ChatMessageDTO } from '../chat-v2/types.js';
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

/**
 * Mock ChatV2Service returned by getChatV2Service(). Since chat-v2 Phase 6.0
 * (#545) reconciliation reads pending messages from the SQLite-backed
 * chat-v2 store synchronously and patches metadata by message id only.
 */
const mockChatV2 = {
	findMessagesWithPendingSlackDelivery: jest.fn<(maxAgeMs: number) => ChatMessageDTO[]>(),
	updateMessageMetadata: jest.fn<
		(messageId: string, patch: Record<string, unknown>) => ChatMessageDTO | null
	>(),
};

jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
	getChatV2Service: jest.fn(() => mockChatV2),
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
 * Build a minimal chat-v2 ChatMessageDTO fixture with Slack delivery metadata.
 *
 * @param overrides - Fields to override on the base fixture
 * @returns A ChatMessageDTO suitable for reconciliation tests
 */
function makePendingMessage(overrides: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
	return {
		id: 'msg-1',
		channelId: 'conv-1',
		seq: 1,
		senderType: 'agent',
		senderId: 'orchestrator',
		content: 'Task completed successfully',
		contentType: 'text',
		createdAt: Date.now(),
		attachments: [],
		mentions: [],
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
		mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([]);
		// Default: updateMessageMetadata returns null (no row)
		mockChatV2.updateMessageMetadata.mockReturnValue(null);
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
			expect(mockChatV2.findMessagesWithPendingSlackDelivery.mock.calls.length).toBeLessThanOrEqual(2);
		});

		it('should schedule first reconciliation after startup delay', () => {
			service.start();

			// Before delay: no calls
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();

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
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();
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

			expect(mockChatV2.findMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();
		});

		it('should skip when already running (concurrent guard)', async () => {
			// The chat-v2 store read is synchronous, so the only await point in a
			// pass is the Slack delivery. Block sendNotification so run1 is still
			// in progress (isRunning=true) when run2 starts.
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([makePendingMessage()]);
			let resolveBlocking!: () => void;
			const blockingPromise = new Promise<void>((resolve) => {
				resolveBlocking = resolve;
			});
			mockBridge.sendNotification.mockReturnValue(blockingPromise);

			// Start first run — it will block inside sendNotification
			const run1 = service.runReconciliation();

			// Second run while first is in progress — should skip
			const run2 = service.runReconciliation();
			await run2;

			// Unblock the first run
			resolveBlocking();
			await run1;

			// findMessagesWithPendingSlackDelivery should only be called once (from run1)
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).toHaveBeenCalledTimes(1);
			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
		});

		it('should do nothing when no pending messages exist', async () => {
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatV2.updateMessageMetadata).not.toHaveBeenCalled();
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
			mockBridge.sendNotification.mockRejectedValue(new Error('Slack API rate limit'));

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);

			// Should update with incremented attempts and error
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
				msg.id,
				expect.objectContaining({
					slackDeliveryAttempts: 2,
					slackDeliveryError: 'Slack API rate limit',
				})
			);
			// Should NOT have been marked as delivered
			expect(mockChatV2.updateMessageMetadata).not.toHaveBeenCalledWith(
				msg.id,
				expect.objectContaining({ slackDeliveryStatus: 'delivered' })
			);
		});

		it('should store stringified error when failure is not an Error instance', async () => {
			const msg = makePendingMessage();
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
			mockBridge.sendNotification.mockRejectedValue('raw string error');

			await service.runReconciliation();

			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);

			await service.runReconciliation();

			// Should NOT attempt to send notification
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();

			// Should mark as failed
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(1);
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
				msg.id,
				expect.objectContaining({
					slackDeliveryStatus: 'delivered',
					slackDeliveryAttempts: 1,
				})
			);
		});

		it('should handle errors in findMessagesWithPendingSlackDelivery gracefully', async () => {
			mockChatV2.findMessagesWithPendingSlackDelivery.mockImplementation(() => {
				throw new Error('Database unavailable');
			});

			// Should not throw
			await expect(service.runReconciliation()).resolves.not.toThrow();

			// No delivery attempts should have been made
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatV2.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should reset isRunning flag after findMessagesWithPendingSlackDelivery throws', async () => {
			mockChatV2.findMessagesWithPendingSlackDelivery.mockImplementation(() => {
				throw new Error('Database unavailable');
			});

			await service.runReconciliation();

			// Should be able to run again (isRunning reset via finally)
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([]);
			await service.runReconciliation();

			// Called twice: once for the error, once for the retry
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).toHaveBeenCalledTimes(2);
		});

		it('should process multiple messages in a single pass', async () => {
			const msg1 = makePendingMessage({ id: 'msg-1', channelId: 'conv-1' });
			const msg2 = makePendingMessage({
				id: 'msg-2',
				channelId: 'conv-2',
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
				channelId: 'conv-3',
				metadata: {
					slackDeliveryStatus: 'pending',
					slackDeliveryAttempts: TEST_CONSTANTS.MAX_DELIVERY_ATTEMPTS,
					slackChannelId: 'C77777',
				},
			});

			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg1, msg2, msg3Failed]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			await service.runReconciliation();

			// msg1 and msg2 should be retried, msg3 should be marked failed
			expect(mockBridge.sendNotification).toHaveBeenCalledTimes(2);
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledTimes(3);

			// msg3 should be marked as failed
			expect(mockChatV2.updateMessageMetadata).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);

			await service.runReconciliation();

			// Should not attempt delivery
			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			// Should not update metadata (it increments the "failed" stat, not the metadata)
			expect(mockChatV2.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should skip messages with no metadata at all', async () => {
			const msg = makePendingMessage({ metadata: undefined });
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);

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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);

			await service.runReconciliation();

			expect(mockBridge.sendNotification).not.toHaveBeenCalled();
			expect(mockChatV2.updateMessageMetadata).not.toHaveBeenCalled();
		});

		it('should pass MAX_MESSAGE_AGE_MS to findMessagesWithPendingSlackDelivery', async () => {
			await service.runReconciliation();

			expect(mockChatV2.findMessagesWithPendingSlackDelivery).toHaveBeenCalledWith(
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
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
			mockChatV2.findMessagesWithPendingSlackDelivery.mockReturnValue([msg]);
			mockBridge.sendNotification.mockResolvedValue(undefined);

			service.start();

			// Advance past the startup delay to trigger the immediate run
			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + 10);

			// Allow microtask queue to flush (runReconciliation is async)
			await flushMicrotasks();

			expect(mockBridge.isInitialized).toHaveBeenCalled();
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).toHaveBeenCalled();
		});

		it('should not leak a startup timer when start is called twice before the delay (regression)', async () => {
			service.start();
			service.start();
			service.stop();

			jest.advanceTimersByTime(TEST_CONSTANTS.STARTUP_DELAY_MS + TEST_CONSTANTS.RECONCILIATION_INTERVAL_MS * 3);
			await flushMicrotasks();

			expect(mockBridge.isInitialized).not.toHaveBeenCalled();
			expect(mockChatV2.findMessagesWithPendingSlackDelivery).not.toHaveBeenCalled();
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
