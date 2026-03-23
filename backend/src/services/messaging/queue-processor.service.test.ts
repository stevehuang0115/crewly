/**
 * Tests for QueueProcessorService
 *
 * @module services/messaging/queue-processor.test
 */

import { EventEmitter } from 'events';
import { QueueProcessorService } from './queue-processor.service.js';
import { MessageQueueService } from './message-queue.service.js';
import { ResponseRouterService } from './response-router.service.js';

// Mock PtyActivityTrackerService
const mockRecordActivity = jest.fn();
const mockRecordApiActivity = jest.fn();
let mockIdleTimeMs = 0;
jest.mock('../agent/pty-activity-tracker.service.js', () => ({
  PtyActivityTrackerService: {
    getInstance: () => ({
      recordActivity: mockRecordActivity,
      recordApiActivity: mockRecordApiActivity,
      getIdleTimeMs: jest.fn().mockImplementation(() => mockIdleTimeMs),
    }),
  },
}));

// Module-level variable to allow per-test override of the system event force-deliver flag.
// Default: true (system events force-deliver). Set to false in tests that exercise the
// requeue/retry code path.
let mockSystemEventForceDeliver = true;

// Module-level variable to allow per-test override of the pending-ack TTL.
// Default: 10_000 (10s for faster testing). Override in TTL-specific tests.
let mockPendingAckTtlMs = 10_000;

// Mock constants
jest.mock('../../constants.js', () => ({
  MESSAGE_QUEUE_CONSTANTS: {
    MAX_QUEUE_SIZE: 100,
    DEFAULT_MESSAGE_TIMEOUT: 5000,
    MAX_HISTORY_SIZE: 50,
    INTER_MESSAGE_DELAY: 10,
    MAX_REQUEUE_RETRIES: 3,
    MAX_SYSTEM_EVENT_BATCH: 5,
    PERSISTENCE_FILE: 'message-queue.json',
    PERSISTENCE_DIR: 'queue',
    SOCKET_EVENTS: {
      MESSAGE_ENQUEUED: 'queue:message_enqueued',
      MESSAGE_PROCESSING: 'queue:message_processing',
      MESSAGE_COMPLETED: 'queue:message_completed',
      MESSAGE_FAILED: 'queue:message_failed',
      MESSAGE_CANCELLED: 'queue:message_cancelled',
      STATUS_UPDATE: 'queue:status_update',
    },
  },
  ORCHESTRATOR_SESSION_NAME: 'crewly-orc',
  CHAT_ROUTING_CONSTANTS: {
    MESSAGE_PREFIX: 'CHAT',
    GOOGLE_CHAT_PREFIX: 'GCHAT',
  },
  EVENT_DELIVERY_CONSTANTS: {
    AGENT_READY_TIMEOUT: 5000,
    AGENT_READY_POLL_INTERVAL: 500,
    PROMPT_DETECTION_TIMEOUT: 5000,
    TOTAL_DELIVERY_TIMEOUT: 10000,
    USER_MESSAGE_TIMEOUT: 2000,
    USER_MESSAGE_FORCE_DELIVER: true,
    SYSTEM_EVENT_TIMEOUT: 3000,
    get SYSTEM_EVENT_FORCE_DELIVER() { return mockSystemEventForceDeliver; },
    PENDING_ACK_SCAN_LINES: 300,
    PENDING_ACK_MAX_RETRIES: 3,
    get PENDING_ACK_TTL_MS() { return mockPendingAckTtlMs; },
  },
  RUNTIME_TYPES: {
    CLAUDE_CODE: 'claude-code',
    GEMINI_CLI: 'gemini-cli',
    CODEX_CLI: 'codex-cli',
  },
  ORCHESTRATOR_HEARTBEAT_CONSTANTS: {
    CHECK_INTERVAL_MS: 30_000,
    HEARTBEAT_REQUEST_THRESHOLD_MS: 300_000,
    RESTART_THRESHOLD_MS: 60_000,
    HEARTBEAT_REQUEST_MESSAGE: 'heartbeat',
    STARTUP_GRACE_PERIOD_MS: 30_000,
  },
  MESSAGE_SOURCES: {
    SLACK: 'slack',
    WHATSAPP: 'whatsapp',
    WEB_CHAT: 'web_chat',
    GOOGLE_CHAT: 'google_chat',
    SYSTEM_EVENT: 'system_event',
  },
}));

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// Create a mock chat service that extends EventEmitter
const mockChatService = new EventEmitter();
(mockChatService as any).addSystemMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('../chat/chat.service.js', () => ({
  getChatService: () => mockChatService,
}));

// Mock terminal gateway
const mockSetActiveConversationId = jest.fn();
jest.mock('../../websocket/terminal.gateway.js', () => ({
  getTerminalGateway: () => ({
    setActiveConversationId: mockSetActiveConversationId,
  }),
}));

// Mock StorageService for orchestrator status and runtime type lookup.
// Must include agentStatus: 'active' to pass the init guard in processNext().
// Use a module-level variable so tests can override the return value.
let mockOrchestratorStatus: any = {
  agentStatus: 'active',
  runtimeType: 'claude-code',
};
jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({
      getOrchestratorStatus: jest.fn().mockImplementation(() =>
        Promise.resolve(mockOrchestratorStatus)
      ),
    }),
  },
}));

/** Flush all pending microtasks (Promises) so async chains in processNext() settle. */
const flushPromises = () => new Promise<void>((r) => jest.requireActual<typeof import('timers')>('timers').setImmediate(r));

describe('QueueProcessorService', () => {
  let queueService: MessageQueueService;
  let responseRouter: ResponseRouterService;
  let mockAgentRegistrationService: any;
  let processor: QueueProcessorService;

  beforeEach(() => {
    jest.useFakeTimers();
    queueService = new MessageQueueService();
    responseRouter = new ResponseRouterService();
    mockAgentRegistrationService = {
      sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
      waitForAgentReady: jest.fn().mockResolvedValue(true),
      captureAgentOutput: jest.fn().mockResolvedValue(''),
    };

    // Reset orchestrator status to default (active) for each test
    mockOrchestratorStatus = {
      agentStatus: 'active',
      runtimeType: 'claude-code',
    };

    // Default: orchestrator has recent activity (not idle)
    mockIdleTimeMs = 0;

    // Default: system events force-deliver (override per-test for requeue tests)
    mockSystemEventForceDeliver = true;
    // Default: 10s TTL for pending-ack (fast enough for tests)
    mockPendingAckTtlMs = 10_000;

    processor = new QueueProcessorService(
      queueService,
      responseRouter,
      mockAgentRegistrationService
    );

    jest.clearAllMocks();
    mockChatService.removeAllListeners();
  });

  afterEach(() => {
    processor.stop();
    jest.useRealTimers();
  });

  describe('start/stop', () => {
    it('should start the processor', () => {
      processor.start();
      expect(processor.isRunning()).toBe(true);
    });

    it('should be idempotent on start', () => {
      processor.start();
      processor.start();
      expect(processor.isRunning()).toBe(true);
    });

    it('should stop the processor', () => {
      processor.start();
      processor.stop();
      expect(processor.isRunning()).toBe(false);
    });

    it('should be idempotent on stop', () => {
      processor.stop();
      expect(processor.isRunning()).toBe(false);
    });
  });

  describe('isProcessingMessage', () => {
    it('should return false when idle', () => {
      expect(processor.isProcessingMessage()).toBe(false);
    });
  });

  describe('message processing', () => {
    it('should process enqueued messages', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // Advance timers to trigger processNext
      jest.advanceTimersByTime(0);
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-1] Hello',
        'claude-code'
      );
    });

    it('should set active conversation ID before delivering', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-42',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();

      expect(mockSetActiveConversationId).toHaveBeenCalledWith('conv-42');
    });

    it('should handle delivery failure', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });

      const routeErrorSpy = jest.spyOn(responseRouter, 'routeError');

      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      // Need extra microtask flushing for the async chain
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(routeErrorSpy).toHaveBeenCalled();
    });

    it('should complete message immediately after delivery (fire-and-forget)', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(1);
      expect(status.isProcessing).toBe(false);
    });

    it('should resolve slackResolve with empty string (fire-and-forget)', async () => {
      const slackResolve = jest.fn();

      processor.start();

      queueService.enqueue({
        content: 'Slack message',
        conversationId: 'conv-slack',
        source: 'slack',
        sourceMetadata: { slackResolve },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Fire-and-forget: slackResolve called with empty string to unblock callers.
      // Actual reply comes via reply-slack skill.
      expect(slackResolve).toHaveBeenCalledWith('');
    });

    it('should not process when stopped', async () => {
      processor.start();
      processor.stop();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(100);
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should process all pending messages in one cycle (#253)', async () => {
      const routeResponseSpy = jest.spyOn(responseRouter, 'routeResponse');

      processor.start();

      queueService.enqueue({
        content: 'First',
        conversationId: 'conv-1',
        source: 'web_chat',
      });
      queueService.enqueue({
        content: 'Second',
        conversationId: 'conv-2',
        source: 'web_chat',
      });

      // #253: Both messages should be processed in a single cycle
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Both messages delivered without needing INTER_MESSAGE_DELAY
      expect(routeResponseSpy).toHaveBeenCalledTimes(2);
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
    });

    it('should handle sendMessageToAgent throwing', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockRejectedValue(
        new Error('Network error')
      );

      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(queueService.getStatus().totalFailed).toBe(1);
    });

    it('should process existing pending messages on start', async () => {
      // Enqueue before starting
      queueService.enqueue({
        content: 'Existing',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      processor.start();

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalled();
    });

    it('should wait for idle after delivery (fire-and-forget)', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Two calls: pre-delivery ready check + post-delivery idle wait
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledTimes(2);
    });

    it('should skip post-delivery idle wait for system events', async () => {
      processor.start();

      queueService.enqueue({
        content: 'event payload',
        conversationId: 'conv-sys',
        source: 'system_event',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Only one call: pre-delivery ready check. No post-completion idle wait
      // for system events (fire-and-forget) to avoid blocking user messages.
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledTimes(1);
    });

    it('should NOT wait for idle after delivery failure', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });

      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Only one call: pre-delivery ready check. No post-completion idle wait.
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledTimes(1);
    });

    it('should proceed to next message even if post-delivery idle wait times out', async () => {
      // First waitForAgentReady (pre-delivery) succeeds, second (post-delivery idle) fails
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(true)   // pre-delivery: ready
        .mockResolvedValueOnce(false)  // post-delivery idle: timed out
        .mockResolvedValueOnce(true);  // next message pre-delivery: ready

      processor.start();

      queueService.enqueue({
        content: 'First',
        conversationId: 'conv-1',
        source: 'web_chat',
      });
      queueService.enqueue({
        content: 'Second',
        conversationId: 'conv-2',
        source: 'web_chat',
      });

      // Process first message (fire-and-forget: completes immediately)
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Advance past INTER_MESSAGE_DELAY
      jest.advanceTimersByTime(20);
      await flushPromises();
      await flushPromises();

      // Second message should still be delivered despite idle wait returning false
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-2] Second',
        'claude-code'
      );
    });

    it('should re-queue message when agent is not ready and force-deliver is off', async () => {
      // Disable force-deliver for system events to exercise the requeue path.
      // In production, both user messages and system events force-deliver by default.
      mockSystemEventForceDeliver = false;
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'system_event',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should NOT have attempted delivery
      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
      // Message should still be pending in the queue
      expect(queueService.hasPending()).toBe(true);
    });

    it('should retry after re-queue when agent becomes ready', async () => {
      // Disable force-deliver to exercise the requeue path
      mockSystemEventForceDeliver = false;
      // First attempt: not ready; second attempt: ready
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      processor.start();

      queueService.enqueue({
        content: 'Retry me',
        conversationId: 'conv-1',
        source: 'system_event',
      });

      // First attempt
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();

      // Advance past the retry delay (AGENT_READY_POLL_INTERVAL = 500ms in mock)
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();

      // Second attempt should succeed (system events use raw content, no prefix)
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        'Retry me',
        'claude-code'
      );
    });

    it('should defer message delivery when orchestrator is not active', async () => {
      mockOrchestratorStatus = { agentStatus: 'inactive', runtimeType: 'claude-code' };

      processor.start();

      queueService.enqueue({
        content: 'During init',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // Process triggers but init guard should block
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Should NOT have attempted delivery
      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
      expect(mockAgentRegistrationService.waitForAgentReady).not.toHaveBeenCalled();
      // Message should still be pending in the queue
      expect(queueService.hasPending()).toBe(true);
    });

    it('should deliver deferred message after orchestrator becomes active', async () => {
      // Start with orchestrator not active
      mockOrchestratorStatus = { agentStatus: 'inactive', runtimeType: 'claude-code' };

      processor.start();

      queueService.enqueue({
        content: 'Queued during init',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // First poll: deferred
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();

      // Now orchestrator becomes active
      mockOrchestratorStatus = { agentStatus: 'active', runtimeType: 'claude-code' };

      // Advance past AGENT_READY_POLL_INTERVAL (500ms in mock)
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();

      // Should now have attempted delivery
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-1] Queued during init',
        'claude-code'
      );
    });

    it('should pass runtimeType to waitForAgentReady', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // waitForAgentReady should receive the runtimeType with USER_MESSAGE_TIMEOUT
      // for web_chat source (shorter timeout for user messages)
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-orc',
        2000,
        'claude-code'
      );
    });

    it('should permanently fail message after exceeding max requeue retries', async () => {
      // Disable force-deliver to exercise the requeue/max-retry path
      mockSystemEventForceDeliver = false;
      // Agent never becomes ready
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      const routeErrorSpy = jest.spyOn(responseRouter, 'routeError');

      processor.start();

      queueService.enqueue({
        content: 'Will fail eventually',
        conversationId: 'conv-1',
        source: 'system_event',
      });

      // Simulate retry loop: MAX_REQUEUE_RETRIES is 3 in mock constants
      // Each cycle: processNext (immediate) -> waitForAgentReady -> requeue -> scheduleProcessNext(500ms)
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(600);
        await flushPromises();
        await flushPromises();
        await flushPromises();
      }

      // After 3 requeues, the next attempt should see retryCount >= 3 and fail permanently
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Message should be permanently failed
      expect(routeErrorSpy).toHaveBeenCalled();
      const errorArg = routeErrorSpy.mock.calls[0][1];
      expect(errorArg).toContain('not available after');
      expect(errorArg).toContain('retries');

      // Queue should be empty (not still re-queuing)
      expect(queueService.hasPending()).toBe(false);
      expect(queueService.getStatus().totalFailed).toBe(1);
    });

    it('should keep heartbeat alive while processing and clear on completion', async () => {
      // Make waitForAgentReady take some time so we can observe keepalive during processing
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(true)   // pre-delivery
        .mockResolvedValueOnce(true);  // post-delivery idle

      processor.start();

      queueService.enqueue({
        content: 'Long task',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Processing completes immediately in fire-and-forget mode.
      // Verify keepalive is cleared after completion.
      mockRecordApiActivity.mockClear();
      jest.advanceTimersByTime(150_000);
      expect(mockRecordApiActivity).not.toHaveBeenCalled();
    });

    it('should clear keepalive interval even on processing error', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockRejectedValue(
        new Error('Crash')
      );

      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Processing should be done (error path). Verify keepalive is cleared.
      mockRecordApiActivity.mockClear();
      jest.advanceTimersByTime(150_000);
      expect(mockRecordApiActivity).not.toHaveBeenCalled();
    });

    it('should increment retryCount on each requeue', async () => {
      // Disable force-deliver to exercise the requeue path
      mockSystemEventForceDeliver = false;
      // Agent not ready for first 2 attempts, then ready
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      processor.start();

      queueService.enqueue({
        content: 'Retry test',
        conversationId: 'conv-1',
        source: 'system_event',
      });

      // First attempt: retryCount 0 -> requeue sets to 1
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Check that message was re-queued with retryCount = 1
      const pending1 = queueService.getStatus();
      expect(pending1.pendingCount).toBe(1);

      // Second attempt: retryCount 1 -> requeue sets to 2
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Third attempt: retryCount 2, agent is ready -> delivers
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();

      // system_event uses raw content (no prefix)
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        'Retry test',
        'claude-code'
      );
    });

    it('should complete message immediately without waiting for response (fire-and-forget)', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // Process message — delivery succeeds, completes immediately
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Message should be completed immediately (no waiting for chat response)
      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(1);
      expect(status.isProcessing).toBe(false);
    });

    it('should force-deliver web_chat messages when agent is not ready', async () => {
      // Agent never becomes ready
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Urgent user message',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // web_chat messages should force-deliver even when agent is not ready
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-1] Urgent user message',
        'claude-code'
      );
      // Should NOT be re-queued
      expect(queueService.hasPending()).toBe(false);
    });

    it('should force-deliver slack messages when agent is not ready', async () => {
      // Agent never becomes ready
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Slack message',
        conversationId: 'conv-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // slack messages should force-deliver even when agent is not ready
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-1] Slack message',
        'claude-code'
      );
      // Should NOT be re-queued
      expect(queueService.hasPending()).toBe(false);
    });

    it('should use USER_MESSAGE_TIMEOUT for slack source', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello from Slack',
        conversationId: 'conv-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // waitForAgentReady should use USER_MESSAGE_TIMEOUT (2000ms in mock) for slack
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-orc',
        2000,
        'claude-code'
      );
    });

    it('should use SYSTEM_EVENT_TIMEOUT for system_event source', async () => {
      processor.start();

      queueService.enqueue({
        content: 'System event',
        conversationId: 'conv-1',
        source: 'system_event',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // waitForAgentReady should use SYSTEM_EVENT_TIMEOUT (3000ms in mock) for system events
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-orc',
        3000,
        'claude-code'
      );
    });
  });

  describe('system event batching', () => {
    it('should batch multiple system events into one delivery', async () => {
      processor.start();

      // Enqueue multiple system events
      queueService.enqueue({
        content: '[EVENT:agent_status] Agent Sam started',
        conversationId: 'sys-1',
        source: 'system_event',
      });
      queueService.enqueue({
        content: '[EVENT:agent_status] Agent Mia active',
        conversationId: 'sys-2',
        source: 'system_event',
      });
      queueService.enqueue({
        content: '[EVENT:agent_status] Agent Sam active',
        conversationId: 'sys-3',
        source: 'system_event',
      });

      // Trigger processing
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Should only send ONE combined message
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
      const deliveredContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1];
      expect(deliveredContent).toContain('Agent Sam started');
      expect(deliveredContent).toContain('Agent Mia active');
      expect(deliveredContent).toContain('Agent Sam active');

      // All 3 messages should be completed
      const status = queueService.getStatus();
      expect(status.pendingCount).toBe(0);
    });

    it('should not batch user messages with system events', async () => {
      processor.start();

      // Enqueue a user message and system events
      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });
      queueService.enqueue({
        content: '[EVENT:status] Agent started',
        conversationId: 'sys-1',
        source: 'system_event',
      });

      // #253: Both messages processed in one drain cycle
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Both should be delivered — user message first (prioritized), system event second
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
      const firstContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1];
      expect(firstContent).toContain('[CHAT:conv-1]');
      expect(firstContent).not.toContain('[EVENT:status]');
      // System event delivered separately (not batched with user message)
      const secondContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[1][1];
      expect(secondContent).toContain('[EVENT:status]');
    });

    it('should respect MAX_SYSTEM_EVENT_BATCH limit', async () => {
      processor.start();

      // Enqueue more than MAX_SYSTEM_EVENT_BATCH system events (limit is 5)
      for (let i = 0; i < 8; i++) {
        queueService.enqueue({
          content: `[EVENT:${i}] event ${i}`,
          conversationId: `sys-${i}`,
          source: 'system_event',
        });
      }

      // #253: Drain loop processes all batches in one cycle
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      const firstContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1];
      // Should contain exactly 5 events (1 primary + 4 batched)
      const eventCount = (firstContent.match(/\[EVENT:/g) || []).length;
      expect(eventCount).toBe(5);

      // Second delivery should contain the remaining 3
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
      const secondContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[1][1];
      const secondEventCount = (secondContent.match(/\[EVENT:/g) || []).length;
      expect(secondEventCount).toBe(3);

      // All events processed
      expect(queueService.pendingCount).toBe(0);
    });
  });

  describe('agent busy retry', () => {
    it('should re-queue message when agent is busy', async () => {
      const requeueSpy = jest.spyOn(queueService, 'requeue');
      const markFailedSpy = jest.spyOn(queueService, 'markFailed');

      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: '[AGENT_BUSY] Failed to deliver message — agent is actively processing',
      });

      processor.start();

      queueService.enqueue({
        content: 'Hello from Slack',
        conversationId: 'conv-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(requeueSpy).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' })
      );
      expect(markFailedSpy).not.toHaveBeenCalled();
    });

    it('should use USER_MESSAGE_TIMEOUT for whatsapp source', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Hello from WhatsApp',
        conversationId: 'conv-wa',
        source: 'whatsapp',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-orc',
        2000,
        'claude-code'
      );
    });

    it('should use USER_MESSAGE_TIMEOUT for google_chat source', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Hello from Google Chat',
        conversationId: 'conv-gchat',
        source: 'google_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-orc',
        2000,
        'claude-code'
      );
    });

    it('should force-deliver google_chat messages when agent is not ready', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });
      const requeueSpy = jest.spyOn(queueService, 'requeue');

      processor.start();

      queueService.enqueue({
        content: 'Urgent Google Chat message',
        conversationId: 'conv-gchat',
        source: 'google_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // google_chat messages should force-deliver even when agent is not ready
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[GCHAT:conv-gchat] Urgent Google Chat message',
        'claude-code'
      );
      expect(requeueSpy).not.toHaveBeenCalled();
    });

    it('should include thread ID in GCHAT prefix when sourceMetadata has threadId', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Hello from Chat',
        conversationId: 'conv-gchat-hint',
        source: 'google_chat',
        sourceMetadata: {
          channelId: 'spaces/AAAA123',
          threadId: 'spaces/AAAA123/threads/BBB456',
          userId: 'users/111',
        },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[GCHAT:conv-gchat-hint thread=spaces/AAAA123/threads/BBB456] Hello from Chat',
        'claude-code'
      );
    });

    it('should resolve googleChatResolve with empty string (fire-and-forget)', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      const googleChatResolve = jest.fn();

      processor.start();

      queueService.enqueue({
        content: 'Hello from Chat',
        conversationId: 'spaces/jycUeSAAAAE',
        source: 'google_chat',
        sourceMetadata: {
          channelId: 'spaces/jycUeSAAAAE',
          threadId: 'spaces/jycUeSAAAAE/threads/NqhNzlr_WgY',
          googleChatResolve,
        },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Fire-and-forget: googleChatResolve called with empty string to unblock.
      // Actual reply comes via reply-gchat skill.
      expect(googleChatResolve).toHaveBeenCalledWith('');
    });

    it('should requeue google_chat messages when agent is busy', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: '[AGENT_BUSY] Agent is actively processing',
      });
      const requeueSpy = jest.spyOn(queueService, 'requeue');

      processor.start();

      queueService.enqueue({
        content: 'Hello GCHAT',
        conversationId: 'conv-gchat-requeue',
        source: 'google_chat',
        sourceMetadata: { channelId: 'spaces/AAA', userId: 'users/1' },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // google_chat messages follow standard user message path: requeue on AGENT_BUSY
      expect(requeueSpy).toHaveBeenCalled();
    });

    it('should fail google_chat messages on non-AGENT_BUSY delivery failure', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Failed to deliver message after multiple attempts',
      });
      const routeErrorSpy = jest.spyOn(responseRouter, 'routeError');

      processor.start();

      queueService.enqueue({
        content: 'Hello from GCHAT',
        conversationId: 'conv-gchat-fail',
        source: 'google_chat',
        sourceMetadata: { channelId: 'spaces/BBB', userId: 'users/2' },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // google_chat follows standard user message path: markFailed + routeError on non-AGENT_BUSY
      expect(routeErrorSpy).toHaveBeenCalled();
    });

    it('should force-deliver system events when agent not ready', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      const requeueSpy = jest.spyOn(queueService, 'requeue');

      processor.start();

      queueService.enqueue({
        content: '[EVENT:agent_status] Agent Sam started',
        conversationId: 'conv-sys',
        source: 'system_event',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // system_event should force-deliver even when agent is not ready
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[EVENT:agent_status] Agent Sam started',
        'claude-code'
      );
      expect(requeueSpy).not.toHaveBeenCalled();
    });

    it('should deliver system events to targetSession when specified', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      // Enqueue a system event with a custom target session
      queueService.enqueue({
        content: '[EVENT:agent_idle] Agent Leo idle',
        conversationId: 'system',
        source: 'system_event',
        targetSession: 'crewly-assistant',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should deliver to the target session, not orchestrator
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-assistant',
        '[EVENT:agent_idle] Agent Leo idle',
        expect.any(String)
      );
      // waitForAgentReady should also target the subscriber
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
        'crewly-assistant',
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should default to orchestrator when no targetSession', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: '[EVENT:agent_idle] Agent idle',
        conversationId: 'system',
        source: 'system_event',
        // No targetSession specified
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should default to orchestrator
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        expect.any(String),
        'claude-code'
      );
    });
  });

  describe('Slack metadata marker injection', () => {
    it('should append [SLACK:channelId:threadTs] marker for Slack messages with full metadata', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello from Slack',
        conversationId: 'slack-C123-ts456',
        source: 'slack',
        sourceMetadata: {
          slackResolve: jest.fn(),
          channelId: 'C123',
          threadTs: '1234567890.123456',
        },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:slack-C123-ts456] Hello from Slack [SLACK:C123:1234567890.123456]',
        'claude-code'
      );
    });

    it('should append [SLACK:channelId] marker when threadTs is missing', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello from Slack DM',
        conversationId: 'slack-D999-ts111',
        source: 'slack',
        sourceMetadata: {
          slackResolve: jest.fn(),
          channelId: 'D999',
        },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:slack-D999-ts111] Hello from Slack DM [SLACK:D999]',
        'claude-code'
      );
    });

    it('should NOT append SLACK marker for web_chat messages', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello from web',
        conversationId: 'conv-web',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc',
        '[CHAT:conv-web] Hello from web',
        'claude-code'
      );
    });

    it('should NOT append SLACK marker for Slack messages without channelId', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Slack no channel',
        conversationId: 'conv-slack',
        source: 'slack',
        sourceMetadata: { slackResolve: jest.fn() },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      const deliveredContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1] as string;
      expect(deliveredContent).not.toContain('[SLACK:');
    });
  });

  describe('message deduplication', () => {
    it('should track delivered message IDs after successful delivery', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Deliver once',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
      expect(processor.getDeliveredMessageCount()).toBe(1);
    });

    it('should skip delivery when AGENT_BUSY requeued message is retried', async () => {
      // First delivery returns AGENT_BUSY (message was received but agent is processing)
      mockAgentRegistrationService.sendMessageToAgent
        .mockResolvedValueOnce({ success: false, error: '[AGENT_BUSY] Agent is processing' })
        .mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Busy message',
        conversationId: 'conv-busy',
        source: 'slack',
        sourceMetadata: { slackResolve: jest.fn() },
      });

      // First attempt: AGENT_BUSY → requeued with dedup marker
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
      expect(processor.getDeliveredMessageCount()).toBe(1);

      // Retry after AGENT_READY_POLL_INTERVAL — should be skipped by dedup
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // sendMessageToAgent should NOT have been called again
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
    });

    it('should still deliver genuinely failed messages on retry', async () => {
      // First delivery fails with a non-AGENT_BUSY error
      mockAgentRegistrationService.sendMessageToAgent
        .mockResolvedValueOnce({ success: false, error: 'Network error' });

      processor.start();

      queueService.enqueue({
        content: 'Will fail',
        conversationId: 'conv-fail',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Delivery failed (not AGENT_BUSY), so message ID is NOT in dedup set
      expect(processor.getDeliveredMessageCount()).toBe(0);
    });

    it('should clean up dedup entries on stop', async () => {
      mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({ success: true });

      processor.start();

      queueService.enqueue({
        content: 'Track me',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getDeliveredMessageCount()).toBe(1);

      processor.stop();
      expect(processor.getDeliveredMessageCount()).toBe(0);
    });
  });

  describe('#239 pending-ack for force-delivered messages', () => {
    it('should add force-delivered user message to pending-ack list', async () => {
      // Agent never ready -> triggers force-delivery for user messages
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Force me',
        conversationId: 'conv-force-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Message should be in pending-ack list, not immediately completed
      expect(processor.getPendingAckCount()).toBe(1);
      // Message was sent to agent
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalled();
    });

    it('should NOT add force-delivered system events to pending-ack list', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'System event',
        conversationId: 'sys-1',
        source: 'system_event',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // System events use normal markCompleted, not pending-ack
      expect(processor.getPendingAckCount()).toBe(0);
      expect(queueService.getStatus().totalProcessed).toBe(1);
    });

    it('should NOT add normally-delivered messages to pending-ack list', async () => {
      // Agent IS ready -> normal delivery path, no force-deliver
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);

      processor.start();

      queueService.enqueue({
        content: 'Normal delivery',
        conversationId: 'conv-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(0);
      expect(queueService.getStatus().totalProcessed).toBe(1);
    });

    it('should mark pending-ack message as completed when conversationId found in PTY output', async () => {
      // Force-deliver (agent not ready), then drain loop flushes pending-ack inline (#253)
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // pre-delivery: not ready -> force-deliver
        .mockResolvedValueOnce(false)   // post-delivery idle wait: not ready
        .mockResolvedValueOnce(true);   // drain-loop pending-ack poll: ready

      // PTY output contains the conversationId -> message was processed
      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValue('[CHAT:conv-slack-1] Force me [SLACK:C123]');

      processor.start();

      queueService.enqueue({
        content: 'Force me',
        conversationId: 'conv-slack-1',
        source: 'slack',
      });

      // #253: Drain loop processes message AND flushes pending-acks inline
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Pending-ack should be flushed (message found in PTY output) within same cycle
      expect(processor.getPendingAckCount()).toBe(0);
    });

    it('should redeliver pending-ack message when conversationId NOT found in PTY output', async () => {
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // pre-delivery: not ready -> force-deliver
        .mockResolvedValueOnce(false)   // post-delivery idle wait
        .mockResolvedValueOnce(true);   // pending-ack poll: ready

      // PTY output does NOT contain the conversationId -> message was swallowed
      mockAgentRegistrationService.captureAgentOutput.mockResolvedValue('Some unrelated output');

      processor.start();

      queueService.enqueue({
        content: 'Lost message',
        conversationId: 'conv-lost',
        source: 'web_chat',
      });

      // Process: force-deliver, add to pending-ack
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);
      const initialSendCount = mockAgentRegistrationService.sendMessageToAgent.mock.calls.length;

      // Trigger pending-ack flush
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should have attempted redelivery
      expect(mockAgentRegistrationService.sendMessageToAgent.mock.calls.length).toBeGreaterThan(initialSendCount);
      // Message still in pending-ack (waiting for next verification)
      expect(processor.getPendingAckCount()).toBe(1);
    });

    it('should mark failed after max pending-ack retries', async () => {
      // Always ready for flush, always empty PTY output
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);
      mockAgentRegistrationService.captureAgentOutput.mockResolvedValue('');
      const markFailedSpy = jest.spyOn(queueService, 'markFailed');

      processor.start();

      queueService.enqueue({
        content: 'Will fail',
        conversationId: 'conv-fail',
        source: 'slack',
      });

      // Force-deliver
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);

      // Now make agent ready for flush attempts
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(true);

      // Flush 3 times (max retries = 3) + 1 final check
      for (let i = 0; i < 4; i++) {
        jest.advanceTimersByTime(600);
        await flushPromises();
        await flushPromises();
        await flushPromises();
        await flushPromises();
      }

      // After 3 retries, message should be marked as failed
      expect(markFailedSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('not processed by the agent')
      );
      expect(processor.getPendingAckCount()).toBe(0);
    });

    it('should resolve slackResolve immediately for force-delivered messages', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);
      const slackResolve = jest.fn();

      processor.start();

      queueService.enqueue({
        content: 'Slack force',
        conversationId: 'conv-slack-resolve',
        source: 'slack',
        sourceMetadata: { slackResolve },
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // slackResolve should be called immediately (unblock Slack bridge)
      // even though message is in pending-ack
      expect(slackResolve).toHaveBeenCalledWith('');
      expect(processor.getPendingAckCount()).toBe(1);
    });

    it('should clear pending-ack entries on stop', async () => {
      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Pending',
        conversationId: 'conv-pending',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);

      processor.stop();
      expect(processor.getPendingAckCount()).toBe(0);
    });

    it('should perform dedup check before redelivery', async () => {
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // pre-delivery: force
        .mockResolvedValueOnce(false)   // post-delivery idle
        .mockResolvedValueOnce(true);   // flush poll: ready

      // First captureAgentOutput: empty (triggers redeliver path)
      // Second captureAgentOutput (dedup re-check): contains conversationId
      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('[CHAT:conv-dedup] message content');

      processor.start();

      queueService.enqueue({
        content: 'Dedup test',
        conversationId: 'conv-dedup',
        source: 'web_chat',
      });

      // Force-deliver
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      const sendCountBefore = mockAgentRegistrationService.sendMessageToAgent.mock.calls.length;

      // Trigger flush
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should NOT have redelivered (dedup re-check found the conversationId)
      expect(mockAgentRegistrationService.sendMessageToAgent.mock.calls.length).toBe(sendCountBefore);
      // Message marked completed via dedup path
      expect(processor.getPendingAckCount()).toBe(0);
    });

    it('should require [CHAT:id] prefix match, not bare conversationId', async () => {
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // pre-delivery: force
        .mockResolvedValueOnce(false)   // post-delivery idle
        .mockResolvedValueOnce(true);   // flush poll: ready

      // PTY output contains the bare conversationId but NOT the [CHAT:id] prefix
      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValue('Some log mentioning conv-bare-id in passing');

      processor.start();

      queueService.enqueue({
        content: 'Prefix test',
        conversationId: 'conv-bare-id',
        source: 'slack',
      });

      // Force-deliver
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);
      const sendCountBefore = mockAgentRegistrationService.sendMessageToAgent.mock.calls.length;

      // Trigger flush — bare ID present but no [CHAT:conv-bare-id] prefix
      jest.advanceTimersByTime(600);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should have redelivered because prefix match failed
      expect(mockAgentRegistrationService.sendMessageToAgent.mock.calls.length).toBeGreaterThan(sendCountBefore);
      expect(processor.getPendingAckCount()).toBe(1);
    });

    it('should match [GCHAT:id] prefix for google_chat messages', async () => {
      // #253: drain loop processes message and flushes pending-acks inline
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // pre-delivery: force
        .mockResolvedValueOnce(false)   // post-delivery idle
        .mockResolvedValueOnce(true);   // drain-loop pending-ack poll: ready

      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValue('[GCHAT:conv-gchat-1] Hello from Chat');

      processor.start();

      queueService.enqueue({
        content: 'GChat test',
        conversationId: 'conv-gchat-1',
        source: 'google_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should be flushed inline — [GCHAT:id] prefix matched
      expect(processor.getPendingAckCount()).toBe(0);
    });
  });

  describe('#239 pending-ack TTL cleanup timer', () => {
    it('should purge expired entries via cleanup timer when agent crashes', async () => {
      // Use a short TTL so we can trigger the cleanup timer
      mockPendingAckTtlMs = 2000;
      // Recreate processor with new TTL
      processor.stop();
      processor = new QueueProcessorService(queueService, responseRouter, mockAgentRegistrationService);

      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);
      const markFailedSpy = jest.spyOn(queueService, 'markFailed');
      const routeErrorSpy = jest.spyOn(responseRouter, 'routeError');

      processor.start();

      queueService.enqueue({
        content: 'Will expire',
        conversationId: 'conv-expire',
        source: 'slack',
      });

      // Force-deliver
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);

      // Advance past TTL×2 to guarantee the cleanup timer fires with entries beyond TTL.
      // The timer interval equals TTL, and the check is strict greater-than.
      jest.advanceTimersByTime(4500);
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(0);
      expect(markFailedSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('TTL cleanup')
      );
      expect(routeErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-expire' }),
        expect.stringContaining('did not process your message in time')
      );
    });

    it('should not purge entries within TTL', async () => {
      mockPendingAckTtlMs = 5000;
      processor.stop();
      processor = new QueueProcessorService(queueService, responseRouter, mockAgentRegistrationService);

      mockAgentRegistrationService.waitForAgentReady.mockResolvedValue(false);

      processor.start();

      queueService.enqueue({
        content: 'Still fresh',
        conversationId: 'conv-fresh',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(1);

      // Advance less than TTL
      jest.advanceTimersByTime(3000);
      await flushPromises();
      await flushPromises();

      // Entry should still be there
      expect(processor.getPendingAckCount()).toBe(1);
    });
  });

  describe('#239 multiple concurrent pending-ack messages', () => {
    it('should track and flush multiple pending-ack messages independently', async () => {
      // #253: drain loop flushes pending-acks inline after processing
      // Pre-delivery: not ready for both, then ready for inline flush
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // msg1 pre-delivery
        .mockResolvedValueOnce(false)   // msg1 post-delivery idle
        .mockResolvedValueOnce(false)   // msg2 pre-delivery
        .mockResolvedValueOnce(false)   // msg2 post-delivery idle
        .mockResolvedValue(true);       // inline flush after drain: ready

      // PTY output contains msg1 but NOT msg2
      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValue('[CHAT:conv-multi-1] First message');

      processor.start();

      queueService.enqueue({
        content: 'First',
        conversationId: 'conv-multi-1',
        source: 'slack',
      });

      // Process first message
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      queueService.enqueue({
        content: 'Second',
        conversationId: 'conv-multi-2',
        source: 'web_chat',
      });

      // Process second message + inline flush
      jest.advanceTimersByTime(10);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // msg1 flushed (found in PTY), msg2 redelivered (not found) → still pending
      expect(processor.getPendingAckCount()).toBe(1);
    });

    it('should handle all messages completing on flush', async () => {
      // #253: drain loop flushes pending-acks inline after processing
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(false)   // msg1 pre-delivery
        .mockResolvedValueOnce(false)   // msg1 post-delivery
        .mockResolvedValueOnce(false)   // msg2 pre-delivery
        .mockResolvedValueOnce(false)   // msg2 post-delivery
        .mockResolvedValue(true);       // inline flush: ready

      // PTY output contains both messages
      mockAgentRegistrationService.captureAgentOutput
        .mockResolvedValue('[CHAT:conv-both-1] msg1\n[CHAT:conv-both-2] msg2');

      processor.start();

      queueService.enqueue({
        content: 'First',
        conversationId: 'conv-both-1',
        source: 'slack',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      queueService.enqueue({
        content: 'Second',
        conversationId: 'conv-both-2',
        source: 'web_chat',
      });

      // Process second + inline flush (both found in PTY output)
      jest.advanceTimersByTime(10);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(processor.getPendingAckCount()).toBe(0);
    });
  });

  describe('drain all pending messages per cycle (#253)', () => {
    it('should process all pending messages in one cycle without inter-message setTimeout', async () => {
      processor.start();

      // Enqueue 3 messages at once
      queueService.enqueue({ content: 'Msg 1', conversationId: 'c1', source: 'web_chat' });
      queueService.enqueue({ content: 'Msg 2', conversationId: 'c2', source: 'web_chat' });
      queueService.enqueue({ content: 'Msg 3', conversationId: 'c3', source: 'web_chat' });

      // Single timer advance + promise flush should drain all 3
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(3);
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc', expect.stringContaining('Msg 1'), 'claude-code'
      );
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc', expect.stringContaining('Msg 2'), 'claude-code'
      );
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
        'crewly-orc', expect.stringContaining('Msg 3'), 'claude-code'
      );
    });

    it('should stop draining when orchestrator becomes unavailable', async () => {
      let callCount = 0;
      mockAgentRegistrationService.sendMessageToAgent.mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          // After 2 deliveries, orchestrator goes inactive
          mockOrchestratorStatus = { agentStatus: 'inactive', runtimeType: 'claude-code' };
        }
        return Promise.resolve({ success: true });
      });

      processor.start();

      queueService.enqueue({ content: 'A', conversationId: 'c1', source: 'web_chat' });
      queueService.enqueue({ content: 'B', conversationId: 'c2', source: 'web_chat' });
      queueService.enqueue({ content: 'C', conversationId: 'c3', source: 'web_chat' });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Should have delivered 2 then stopped (3rd deferred because orchestrator inactive)
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(2);
    });
  });
});
