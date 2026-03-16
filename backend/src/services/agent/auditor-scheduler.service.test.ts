import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AuditorSchedulerService } from './auditor-scheduler.service.js';
import { AUDITOR_SCHEDULER_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';

describe('AuditorSchedulerService', () => {
  let scheduler: AuditorSchedulerService;
  let mockAgentRegService: Record<string, jest.Mock<any>>;
  let mockEventBus: Record<string, jest.Mock<any>>;

  beforeEach(() => {
    jest.useFakeTimers();
    AuditorSchedulerService.resetInstance();
    scheduler = AuditorSchedulerService.getInstance();

    mockAgentRegService = {
      createAgentSession: jest.fn<any>().mockResolvedValue({ success: true, sessionName: 'crewly-auditor' }),
      sendMessageToAgent: jest.fn<any>().mockResolvedValue({ success: true, message: 'Delivered' }),
      terminateAgentSession: jest.fn<any>().mockResolvedValue({ success: true }),
    };

    mockEventBus = {
      on: jest.fn<any>(),
      removeAllListeners: jest.fn<any>(),
    };

    scheduler.setAgentRegistrationService(mockAgentRegService as any);
    scheduler.setEventBusService(mockEventBus as any);
  });

  afterEach(() => {
    scheduler.stop();
    AuditorSchedulerService.resetInstance();
    jest.useRealTimers();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = AuditorSchedulerService.getInstance();
      const b = AuditorSchedulerService.getInstance();
      expect(a).toBe(b);
    });

    it('should create a new instance after resetInstance', () => {
      const a = AuditorSchedulerService.getInstance();
      AuditorSchedulerService.resetInstance();
      const b = AuditorSchedulerService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('start/stop', () => {
    it('should set status to idle on start', () => {
      scheduler.start();
      expect(scheduler.getStatus().status).toBe('idle');
    });

    it('should set status to stopped on stop', () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.getStatus().status).toBe('stopped');
    });

    it('should not double-start', () => {
      scheduler.start();
      scheduler.start();
      expect(scheduler.getStatus().status).toBe('idle');
    });

    it('should enable periodic timer on start', () => {
      scheduler.start();
      expect(scheduler.getStatus().periodicEnabled).toBe(true);
    });

    it('should disable periodic timer on stop', () => {
      scheduler.start();
      scheduler.stop();
      expect(scheduler.getStatus().periodicEnabled).toBe(false);
    });

    it('should bind EventBus listener on start', () => {
      scheduler.start();
      expect(mockEventBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));
      expect(scheduler.getStatus().eventListenerBound).toBe(true);
    });

    it('should create PTY session on start (always-active)', async () => {
      scheduler.start();
      // Allow async session creation to run
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAgentRegService.createAgentSession).toHaveBeenCalledWith({
        sessionName: AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        role: 'auditor',
        runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
        forceRecreate: true,
      });
    });

    it('should terminate PTY session only on stop', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      scheduler.stop();
      expect(mockAgentRegService.terminateAgentSession).toHaveBeenCalledWith(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
      );
    });

    it('should not terminate session on stop if session was never ready', () => {
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: false, error: 'Failed' });
      scheduler.start();
      scheduler.stop();
      expect(mockAgentRegService.terminateAgentSession).not.toHaveBeenCalled();
    });
  });

  describe('trigger (L3 API)', () => {
    beforeEach(async () => {
      scheduler.start();
      // Let the async ensureAuditorSession() from start() complete
      await jest.advanceTimersByTimeAsync(0);
      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockClear();
    });

    it('should send audit command via PTY when session is ready', async () => {
      const result = await scheduler.trigger('api');
      expect(result.triggered).toBe(true);
      expect(result.source).toBe('api');
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalledWith(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        AUDITOR_SCHEDULER_CONSTANTS.AUDIT_COMMAND,
        RUNTIME_TYPES.CLAUDE_CODE,
      );
    });

    it('should NOT terminate session after successful audit (always-active)', async () => {
      await scheduler.trigger('api');
      mockAgentRegService.terminateAgentSession.mockClear();
      await scheduler.trigger('api');
      expect(mockAgentRegService.terminateAgentSession).not.toHaveBeenCalled();
    });

    it('should NOT terminate session on audit error (always-active)', async () => {
      mockAgentRegService.sendMessageToAgent.mockRejectedValue(new Error('PTY timeout'));
      mockAgentRegService.terminateAgentSession.mockClear();
      const result = await scheduler.trigger('api');
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('PTY timeout');
      expect(scheduler.getStatus().status).toBe('idle');
      expect(mockAgentRegService.terminateAgentSession).not.toHaveBeenCalled();
    });

    it('should handle send failure gracefully', async () => {
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });
      const result = await scheduler.trigger('api');
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('Session not found');
      expect(scheduler.getStatus().status).toBe('idle');
    });

    it('should recreate session on next trigger after send failure', async () => {
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });
      await scheduler.trigger('api');
      // sessionReady should now be false, so next trigger recreates
      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({ success: true });
      await scheduler.trigger('api');
      expect(mockAgentRegService.createAgentSession).toHaveBeenCalled();
    });

    it('should not allow concurrent audits', async () => {
      mockAgentRegService.sendMessageToAgent.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      const p1 = scheduler.trigger('api');
      const p2Result = await scheduler.trigger('api');
      expect(p2Result.triggered).toBe(false);
      expect(p2Result.reason).toContain('already in progress');

      jest.advanceTimersByTime(5000);
      await p1;
    });

    it('should return error when scheduler is stopped', async () => {
      scheduler.stop();
      const result = await scheduler.trigger('api');
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('stopped');
    });

    it('should return error when no registration service configured', async () => {
      AuditorSchedulerService.resetInstance();
      const fresh = AuditorSchedulerService.getInstance();
      fresh.start();
      const result = await fresh.trigger('api');
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('No agent registration service');
      fresh.stop();
    });

    it('should increment auditCount', async () => {
      expect(scheduler.getStatus().auditCount).toBe(0);
      await scheduler.trigger('api');
      expect(scheduler.getStatus().auditCount).toBe(1);
      await scheduler.trigger('api');
      expect(scheduler.getStatus().auditCount).toBe(2);
    });

    it('should return early when session is not ready after ensureAuditorSession', async () => {
      // Exhaust retries so ensureAuditorSession cannot create session
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: false, error: 'PTY failed' });
      AuditorSchedulerService.resetInstance();
      scheduler = AuditorSchedulerService.getInstance();
      scheduler.setAgentRegistrationService(mockAgentRegService as any);
      scheduler.setEventBusService(mockEventBus as any);
      scheduler.start();
      // Let initial session creation fail (retry 0)
      await jest.advanceTimersByTimeAsync(0);
      // Trigger to increment retry count (retry 1, 10s backoff)
      const t1 = scheduler.trigger('api');
      await jest.advanceTimersByTimeAsync(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS);
      await t1;
      // Trigger again (retry 2, 20s backoff)
      const t2 = scheduler.trigger('api');
      await jest.advanceTimersByTimeAsync(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS * 2);
      await t2;
      // retryCount=3 → cooldown. Next trigger: session not ready, should not send.
      mockAgentRegService.sendMessageToAgent.mockClear();
      const result = await scheduler.trigger('api');
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('Auditor session not ready');
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();
    });
  });

  describe('handleUserMessage (Slack)', () => {
    beforeEach(async () => {
      scheduler.start();
      // Let the async ensureAuditorSession() from start() complete
      await jest.advanceTimersByTimeAsync(0);
      // Clear mock call counts from initialization
      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockClear();
    });

    it('should send message with SLACK_CONTEXT prefix via PTY', async () => {
      const result = await scheduler.handleUserMessage('show recent findings', {
        channelId: 'C12345',
        threadTs: '1234567890.123456',
      });
      expect(result.triggered).toBe(true);
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalledWith(
        AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME,
        '[SLACK_CONTEXT:channelId=C12345,threadTs=1234567890.123456]\nshow recent findings',
        RUNTIME_TYPES.CLAUDE_CODE,
      );
    });

    it('should return error when no registration service', async () => {
      AuditorSchedulerService.resetInstance();
      const fresh = AuditorSchedulerService.getInstance();
      const result = await fresh.handleUserMessage('test', { channelId: 'C1', threadTs: 't1' });
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('No agent registration service');
    });

    it('should initialize session if not ready', async () => {
      // Simulate session not ready (e.g., after a previous failure)
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });
      await scheduler.trigger('api'); // This will mark sessionReady = false

      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({ success: true });

      await scheduler.handleUserMessage('test', { channelId: 'C1', threadTs: 't1' });
      expect(mockAgentRegService.createAgentSession).toHaveBeenCalled();
    });

    it('should handle send failure gracefully', async () => {
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'PTY error',
      });
      const result = await scheduler.handleUserMessage('test', { channelId: 'C1', threadTs: 't1' });
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('PTY error');
    });

    it('should handle errors gracefully', async () => {
      mockAgentRegService.sendMessageToAgent.mockRejectedValue(new Error('Runtime error'));
      const result = await scheduler.handleUserMessage('test', { channelId: 'C1', threadTs: 't1' });
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('Runtime error');
    });
  });

  describe('L1 periodic trigger', () => {
    it('should trigger audit after interval', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0); // let session init
      mockAgentRegService.sendMessageToAgent.mockClear();
      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.AUDIT_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalled();
    });
  });

  describe('L2 event-driven trigger', () => {
    it('should trigger audit on qualifying event after debounce', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0); // let session init
      mockAgentRegService.sendMessageToAgent.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      expect(listenerCall).toBeDefined();
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      listener({ eventType: 'agent:inactive', sessionName: 'some-other-agent' });
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.EVENT_DEBOUNCE_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalled();
    });

    it('should not immediately trigger on auditor own inactive event', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      mockAgentRegService.sendMessageToAgent.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      listener({ eventType: 'agent:inactive', sessionName: AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME });
      // Should NOT trigger instantly (prevents self-loop); recovery is delayed
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should schedule recovery trigger after auditor own inactive event (#185)', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      mockAgentRegService.sendMessageToAgent.mockClear();
      mockAgentRegService.createAgentSession.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      // Auditor goes inactive
      listener({ eventType: 'agent:inactive', sessionName: AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME });

      // After SESSION_RECOVERY_DELAY_MS, should trigger session recreation + audit
      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RECOVERY_DELAY_MS);
      await jest.advanceTimersByTimeAsync(0);

      // Session should be recreated (sessionReady was set to false)
      expect(mockAgentRegService.createAgentSession).toHaveBeenCalled();
      // And audit command should be sent
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalled();
    });

    it('should reset retry state on auditor inactive event (#185)', async () => {
      // Start with failed session creation to increment retry count
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: false, error: 'PTY failed' });
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);

      // Trigger to increment retry count
      const t1 = scheduler.trigger('api');
      await jest.advanceTimersByTimeAsync(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS);
      await t1;

      // Now fix session creation and simulate auditor going inactive
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: true, sessionName: 'crewly-auditor' });
      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      // Auditor goes inactive — should reset retry state (#185)
      listener({ eventType: 'agent:inactive', sessionName: AUDITOR_SCHEDULER_CONSTANTS.AUDITOR_SESSION_NAME });

      // After recovery delay, session should be recreated (retry state was reset)
      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RECOVERY_DELAY_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(mockAgentRegService.createAgentSession).toHaveBeenCalled();
    });

    it('should debounce multiple rapid events', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0); // let session init
      mockAgentRegService.sendMessageToAgent.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      listener({ eventType: 'task:failed' });
      jest.advanceTimersByTime(10_000);
      listener({ eventType: 'agent:inactive', sessionName: 'some-agent' });
      jest.advanceTimersByTime(10_000);
      listener({ eventType: 'task:failed' });

      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.EVENT_DEBOUNCE_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalledTimes(1);
    });

    it('should ignore non-qualifying events', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      mockAgentRegService.sendMessageToAgent.mockClear();

      const listenerCall = mockEventBus.on.mock.calls.find(
        (c: any[]) => c[0] === 'event_published',
      );
      const listener = listenerCall![1] as (payload: { eventType: string; sessionName?: string }) => void;

      listener({ eventType: 'agent:idle' });
      jest.advanceTimersByTime(AUDITOR_SCHEDULER_CONSTANTS.EVENT_DEBOUNCE_MS + 1000);
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();
    });
  });

  describe('session retry and cooldown', () => {
    it('should not attempt session creation when in cooldown', async () => {
      // Directly test via multiple failed triggers: after start() fails,
      // trigger() calls ensureAuditorSession which increments retryCount
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: false, error: 'PTY failed' });
      scheduler.start();
      // Let initial ensureAuditorSession complete (retry 0, no backoff)
      await jest.advanceTimersByTimeAsync(0);
      // retryCount is now 1

      // Trigger will call ensureAuditorSession again (retry 1 = 10s backoff)
      const triggerP1 = scheduler.trigger('api');
      await jest.advanceTimersByTimeAsync(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS);
      await triggerP1;
      // retryCount is now 2

      // Trigger will call ensureAuditorSession again (retry 2 = 20s backoff)
      const triggerP2 = scheduler.trigger('api');
      await jest.advanceTimersByTimeAsync(AUDITOR_SCHEDULER_CONSTANTS.SESSION_RETRY_INITIAL_BACKOFF_MS * 2);
      await triggerP2;
      // retryCount is now 3 = MAX_SESSION_RETRIES, cooldown entered

      // Next trigger should NOT call createAgentSession (cooldown active)
      const callCountBefore = mockAgentRegService.createAgentSession.mock.calls.length;
      await scheduler.trigger('api');
      expect(mockAgentRegService.createAgentSession.mock.calls.length).toBe(callCountBefore);
    });

    it('should reset retry state on stop', async () => {
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: false, error: 'PTY failed' });
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);

      scheduler.stop();

      // Restart should work from clean state
      mockAgentRegService.createAgentSession.mockResolvedValue({ success: true, sessionName: 'crewly-auditor' });
      scheduler.setAgentRegistrationService(mockAgentRegService as any);
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(scheduler.getStatus().runtimeReady).toBe(true);
    });
  });

  describe('catchUpMissedChecks', () => {
    beforeEach(async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      mockAgentRegService.createAgentSession.mockClear();
      mockAgentRegService.sendMessageToAgent.mockClear();
    });

    it('should fire overdue scheduled items on catch-up', async () => {
      // Add items scheduled in the past (overdue)
      const pastTime = Date.now() - 60_000;
      scheduler.addScheduledItem(pastTime, 'periodic');
      scheduler.addScheduledItem(pastTime - 30_000, 'event');

      const caught = await scheduler.catchUpMissedChecks();

      expect(caught).toBe(2);
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalledTimes(2);
    });

    it('should not fire already-fired items', async () => {
      const pastTime = Date.now() - 60_000;
      const item = scheduler.addScheduledItem(pastTime, 'periodic');
      item.fired = true;

      const caught = await scheduler.catchUpMissedChecks();

      expect(caught).toBe(0);
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should not fire future-scheduled items', async () => {
      const futureTime = Date.now() + 600_000;
      scheduler.addScheduledItem(futureTime, 'periodic');

      const caught = await scheduler.catchUpMissedChecks();

      expect(caught).toBe(0);
      expect(mockAgentRegService.sendMessageToAgent).not.toHaveBeenCalled();
    });

    it('should return 0 when no scheduled items exist', async () => {
      const caught = await scheduler.catchUpMissedChecks();
      expect(caught).toBe(0);
    });

    it('should mark items as fired after catch-up', async () => {
      const pastTime = Date.now() - 60_000;
      scheduler.addScheduledItem(pastTime, 'api');

      await scheduler.catchUpMissedChecks();

      const items = scheduler.getScheduledItems();
      expect(items.every((i) => i.fired)).toBe(true);
    });

    it('should handle trigger failures gracefully during catch-up', async () => {
      mockAgentRegService.sendMessageToAgent.mockResolvedValue({
        success: false,
        error: 'Session not found',
      });

      const pastTime = Date.now() - 60_000;
      scheduler.addScheduledItem(pastTime, 'periodic');

      // Should not throw
      const caught = await scheduler.catchUpMissedChecks();
      // Item was fired (trigger attempted) but trigger returned false
      expect(caught).toBe(0);
      const items = scheduler.getScheduledItems();
      expect(items[0].fired).toBe(true);
    });

    it('should be called on start()', async () => {
      // Reset and set up with overdue item
      scheduler.stop();
      AuditorSchedulerService.resetInstance();
      scheduler = AuditorSchedulerService.getInstance();
      scheduler.setAgentRegistrationService(mockAgentRegService as any);
      scheduler.setEventBusService(mockEventBus as any);

      // Manually add an overdue item before starting
      const pastTime = Date.now() - 60_000;
      scheduler.addScheduledItem(pastTime, 'periodic');

      mockAgentRegService.sendMessageToAgent.mockClear();
      scheduler.start();
      // Let async catch-up and session init complete
      await jest.advanceTimersByTimeAsync(0);

      // Should have sent messages: one for session init (ensureAuditorSession doesn't send),
      // and one for the caught-up item
      expect(mockAgentRegService.sendMessageToAgent).toHaveBeenCalled();
    });

    it('should clear scheduled items on stop', async () => {
      scheduler.addScheduledItem(Date.now() + 60_000, 'periodic');
      expect(scheduler.getScheduledItems().length).toBe(1);

      scheduler.stop();
      // After reset, new instance should have empty items
      AuditorSchedulerService.resetInstance();
      const freshScheduler = AuditorSchedulerService.getInstance();
      expect(freshScheduler.getScheduledItems().length).toBe(0);
    });
  });

  describe('addScheduledItem', () => {
    it('should add an item with correct properties', () => {
      const time = Date.now() + 60_000;
      const item = scheduler.addScheduledItem(time, 'event');

      expect(item.id).toBeDefined();
      expect(item.scheduledTime).toBe(time);
      expect(item.source).toBe('event');
      expect(item.fired).toBe(false);
    });

    it('should add multiple items', () => {
      scheduler.addScheduledItem(Date.now() + 60_000, 'periodic');
      scheduler.addScheduledItem(Date.now() + 120_000, 'api');

      expect(scheduler.getScheduledItems().length).toBe(2);
    });
  });

  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const status = scheduler.getStatus();
      expect(status.status).toBe('stopped');
      expect(status.auditCount).toBe(0);
      expect(status.lastAuditStart).toBeNull();
      expect(status.periodicEnabled).toBe(false);
      expect(status.eventListenerBound).toBe(false);
      expect(status.runtimeReady).toBe(false);
    });

    it('should reflect runtimeReady state after session creation', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(scheduler.getStatus().runtimeReady).toBe(true);
    });

    it('should reflect running state during audit', async () => {
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);

      let resolveMessage!: (value: any) => void;
      mockAgentRegService.sendMessageToAgent.mockImplementation(
        () => new Promise((resolve) => { resolveMessage = resolve; }),
      );

      const triggerPromise = scheduler.trigger('api');
      await Promise.resolve();
      await Promise.resolve();

      expect(scheduler.getStatus().status).toBe('running_audit');
      expect(scheduler.getStatus().lastAuditStart).not.toBeNull();

      resolveMessage({ success: true });
      await triggerPromise;
      expect(scheduler.getStatus().status).toBe('idle');
    });
  });
});
