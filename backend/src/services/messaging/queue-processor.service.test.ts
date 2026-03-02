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
let mockIdleTimeMs = 0;
jest.mock('../agent/pty-activity-tracker.service.js', () => ({
  PtyActivityTrackerService: {
    getInstance: () => ({
      recordActivity: mockRecordActivity,
      getIdleTimeMs: jest.fn().mockImplementation(() => mockIdleTimeMs),
    }),
  },
}));

// Module-level variable to allow per-test override of the system event force-deliver flag.
// Default: true (system events force-deliver). Set to false in tests that exercise the
// requeue/retry code path.
let mockSystemEventForceDeliver = true;

// Mock constants
jest.mock('../../constants.js', () => ({
  MESSAGE_QUEUE_CONSTANTS: {
    MAX_QUEUE_SIZE: 100,
    DEFAULT_MESSAGE_TIMEOUT: 5000,
    MAX_HISTORY_SIZE: 50,
    INTER_MESSAGE_DELAY: 10,
    MAX_REQUEUE_RETRIES: 3,
    ACK_TIMEOUT: 1000,
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

    it('should complete message when response arrives', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Simulate orchestrator response via chat service event
      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Here is the response',
      });

      await flushPromises();
      await flushPromises();

      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(1);
      expect(status.isProcessing).toBe(false);
    });

    it('should timeout if no response arrives', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Test',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Advance past the timeout (5000ms in mock constants)
      jest.advanceTimersByTime(6000);
      await flushPromises();
      await flushPromises();

      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(1);
    });

    it('should route slack response via slackResolve', async () => {
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

      // Simulate response
      mockChatService.emit('message', {
        conversationId: 'conv-slack',
        from: { type: 'orchestrator' },
        content: 'Slack response',
      });

      await flushPromises();
      await flushPromises();

      expect(slackResolve).toHaveBeenCalledWith('Slack response');
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

    it('should process messages sequentially with delay', async () => {
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

      // Process first message
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Response 1',
      });

      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(routeResponseSpy).toHaveBeenCalledTimes(1);

      // Advance past INTER_MESSAGE_DELAY (10ms in mock)
      jest.advanceTimersByTime(20);
      await flushPromises();
      await flushPromises();

      // Second message should now be processing
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

    it('should wait for idle after chat response', async () => {
      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // First call: pre-delivery ready check
      expect(mockAgentRegistrationService.waitForAgentReady).toHaveBeenCalledTimes(1);

      // Simulate orchestrator response
      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Response',
      });

      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Second call: post-completion idle wait
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

    it('should proceed to next message even if post-completion idle wait times out', async () => {
      // First waitForAgentReady (pre-delivery) succeeds, second (post-completion) fails
      mockAgentRegistrationService.waitForAgentReady
        .mockResolvedValueOnce(true)   // pre-delivery: ready
        .mockResolvedValueOnce(false)  // post-completion idle: timed out
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

      // Process first message
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Response 1',
      });

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
      mockOrchestratorStatus = { agentStatus: 'started', runtimeType: 'claude-code' };

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
      mockOrchestratorStatus = { agentStatus: 'started', runtimeType: 'claude-code' };

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
      processor.start();

      queueService.enqueue({
        content: 'Long task',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Keepalive interval is HEARTBEAT_REQUEST_THRESHOLD_MS / 2 = 150000ms
      // Advance past one keepalive tick
      mockRecordActivity.mockClear();
      jest.advanceTimersByTime(150_000);

      expect(mockRecordActivity).toHaveBeenCalledWith('crewly-orc');
      const callCountDuringProcessing = mockRecordActivity.mock.calls.length;
      expect(callCountDuringProcessing).toBeGreaterThanOrEqual(1);

      // Simulate response to complete processing
      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Done',
      });

      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Clear mock and advance another keepalive period — should NOT fire again
      mockRecordActivity.mockClear();
      jest.advanceTimersByTime(150_000);
      expect(mockRecordActivity).not.toHaveBeenCalled();
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
      mockRecordActivity.mockClear();
      jest.advanceTimersByTime(150_000);
      expect(mockRecordActivity).not.toHaveBeenCalled();
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

    it('should resolve early with error when orchestrator has no output within ACK window', async () => {
      // Simulate orchestrator being idle (context exhausted)
      mockIdleTimeMs = 2000; // >= ACK_TIMEOUT (1000ms in mock)

      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // Process message — delivery succeeds
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Advance past ACK_TIMEOUT (1000ms in mock constants)
      jest.advanceTimersByTime(1100);
      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Message should be completed (with the error response)
      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(1);

      // The response should contain the context-exhaustion message
      const history = queueService.getHistory();
      expect(history[0].response).toContain('unresponsive');
      expect(history[0].response).toContain('context may be exhausted');
    });

    it('should NOT resolve early when orchestrator has output within ACK window', async () => {
      // Simulate orchestrator actively producing output
      mockIdleTimeMs = 500; // < ACK_TIMEOUT (1000ms in mock)

      processor.start();

      queueService.enqueue({
        content: 'Hello',
        conversationId: 'conv-1',
        source: 'web_chat',
      });

      // Process message
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // Advance past ACK_TIMEOUT
      jest.advanceTimersByTime(1100);
      await flushPromises();
      await flushPromises();

      // Message should still be processing (waiting for real response)
      const status = queueService.getStatus();
      expect(status.totalProcessed).toBe(0);
      expect(status.isProcessing).toBe(true);

      // Now simulate the real response arriving
      mockChatService.emit('message', {
        conversationId: 'conv-1',
        from: { type: 'orchestrator' },
        content: 'Real response',
      });

      await flushPromises();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      const finalStatus = queueService.getStatus();
      expect(finalStatus.totalProcessed).toBe(1);
      expect(queueService.getHistory()[0].response).toBe('Real response');
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

      // First processing: user message prioritized
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      // The first call should be the user message (prioritized)
      expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledTimes(1);
      const firstContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1];
      expect(firstContent).toContain('[CHAT:conv-1]');
      expect(firstContent).not.toContain('[EVENT:status]');
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

      // Process first batch
      jest.advanceTimersByTime(0);
      await flushPromises();
      await flushPromises();

      const firstContent = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0][1];
      // Should contain exactly 5 events (1 primary + 4 batched)
      const eventCount = (firstContent.match(/\[EVENT:/g) || []).length;
      expect(eventCount).toBe(5);

      // 3 events should remain pending
      expect(queueService.pendingCount).toBe(3);
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
  });
});
