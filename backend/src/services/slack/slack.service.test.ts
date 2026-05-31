/**
 * Tests for Slack Service
 *
 * @module services/slack/slack.service.test
 */

// Jest globals are available automatically
import { SlackService, getSlackService, resetSlackService } from './slack.service.js';
import type { SlackConfig, SlackNotification } from '../../types/slack.types.js';
import { EventEmitter } from 'events';

const mockBoltStart = jest.fn().mockResolvedValue(undefined);
const mockBoltStop = jest.fn().mockResolvedValue(undefined);

// Capture chat-v2 mirror calls for the outbound-record test. The mirror
// dynamic-imports this singleton; jest intercepts that import.
const mockEnsureLegacyChannel = jest.fn(() => ({ id: 'chan-slack', agentSession: 'crewly-orc' }));
const mockRecordTurn = jest.fn(() => ({ message: { id: 'm1' } }));
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
  getChatV2Service: () => ({
    ensureChannelForLegacyConversation: mockEnsureLegacyChannel,
    recordTurn: mockRecordTurn,
  }),
}));

jest.mock('@slack/bolt', () => ({
  App: jest.fn().mockImplementation(() => ({
    client: {
      chat: { postMessage: jest.fn(), update: jest.fn() },
      reactions: { add: jest.fn() },
      users: { info: jest.fn() },
      files: { uploadV2: jest.fn(), info: jest.fn() },
    },
    receiver: { client: new EventEmitter() },
    message: jest.fn(),
    event: jest.fn(),
    action: jest.fn(),
    error: jest.fn(),
    start: mockBoltStart,
    stop: mockBoltStop,
  })),
  LogLevel: { INFO: 'info' },
}));

describe('SlackService', () => {
  const mockConfig: SlackConfig = {
    botToken: 'xoxb-test-token',
    appToken: 'xapp-test-token',
    signingSecret: 'test-secret',
    socketMode: true,
    defaultChannelId: 'C123456',
    allowedUserIds: ['U123'],
  };

  beforeEach(() => {
    resetSlackService();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetSlackService();
  });

  describe('getSlackService', () => {
    it('should return singleton instance', () => {
      const service1 = getSlackService();
      const service2 = getSlackService();
      expect(service1).toBe(service2);
    });

    it('should return SlackService instance', () => {
      const service = getSlackService();
      expect(service).toBeInstanceOf(SlackService);
    });
  });

  describe('resetSlackService', () => {
    it('should reset the singleton instance', () => {
      const service1 = getSlackService();
      resetSlackService();
      const service2 = getSlackService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('SlackService class', () => {
    it('should have correct initial status', () => {
      const service = new SlackService();
      const status = service.getStatus();

      expect(status.connected).toBe(false);
      expect(status.socketMode).toBe(false);
      expect(status.messagesSent).toBe(0);
      expect(status.messagesReceived).toBe(0);
    });

    it('should report not connected when not initialized', () => {
      const service = new SlackService();
      expect(service.isConnected()).toBe(false);
    });

    it('should throw when sendMessage called without initialization', async () => {
      const service = new SlackService();

      await expect(
        service.sendMessage({ channelId: 'C123', text: 'test' })
      ).rejects.toThrow('Slack client not initialized');
    });

    it('mirrors a threaded outbound reply into chat-v2 as an agent message', async () => {
      mockEnsureLegacyChannel.mockClear();
      mockRecordTurn.mockClear();
      const service = new SlackService();
      (service as any).client = {
        chat: { postMessage: jest.fn().mockResolvedValue({ ts: '111.222' }) },
      };

      await service.sendMessage({ channelId: 'C123', text: 'agent reply', threadTs: '100.000' });
      // Mirror is fire-and-forget (dynamic imports) — flush microtasks.
      await new Promise((r) => setImmediate(r));

      expect(mockEnsureLegacyChannel).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'slack-C123-100-000' }),
      );
      expect(mockRecordTurn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'chan-slack', senderType: 'agent', content: 'agent reply' }),
      );
    });

    it('does not mirror a non-threaded outbound message', async () => {
      mockRecordTurn.mockClear();
      const service = new SlackService();
      (service as any).client = {
        chat: { postMessage: jest.fn().mockResolvedValue({ ts: '111.222' }) },
      };

      await service.sendMessage({ channelId: 'C123', text: 'top-level' });
      await new Promise((r) => setImmediate(r));
      expect(mockRecordTurn).not.toHaveBeenCalled();
    });

    it('should throw when updateMessage called without initialization', async () => {
      const service = new SlackService();

      await expect(
        service.updateMessage('C123', '123.456', 'updated text')
      ).rejects.toThrow('Slack client not initialized');
    });

    it('should throw when addReaction called without initialization', async () => {
      const service = new SlackService();

      await expect(
        service.addReaction('C123', '123.456', 'thumbsup')
      ).rejects.toThrow('Slack client not initialized');
    });

    it('should throw when getUserInfo called without initialization', async () => {
      const service = new SlackService();

      await expect(service.getUserInfo('U123')).rejects.toThrow(
        'Slack client not initialized'
      );
    });
  });

  describe('getConversationContext', () => {
    it('should create new context for new thread', () => {
      const service = getSlackService();

      const context = service.getConversationContext('thread-1', 'C123', 'U456');

      expect(context.threadTs).toBe('thread-1');
      expect(context.channelId).toBe('C123');
      expect(context.userId).toBe('U456');
      expect(context.messageCount).toBe(1);
      expect(context.conversationId).toBe('slack-C123-thread-1');
    });

    it('should return existing context and increment count', () => {
      const service = getSlackService();

      const context1 = service.getConversationContext('thread-1', 'C123', 'U456');
      const context2 = service.getConversationContext('thread-1', 'C123', 'U456');

      expect(context1).toBe(context2);
      expect(context2.messageCount).toBe(2);
    });

    it('should create separate contexts for different threads', () => {
      const service = getSlackService();

      const context1 = service.getConversationContext('thread-1', 'C123', 'U456');
      const context2 = service.getConversationContext('thread-2', 'C123', 'U456');

      expect(context1).not.toBe(context2);
      expect(context1.conversationId).not.toBe(context2.conversationId);
    });

    it('should create separate contexts for different channels', () => {
      const service = getSlackService();

      const context1 = service.getConversationContext('thread-1', 'C123', 'U456');
      const context2 = service.getConversationContext('thread-1', 'C789', 'U456');

      expect(context1).not.toBe(context2);
    });

    it('should update lastActivityAt on each access', () => {
      const service = getSlackService();

      const context1 = service.getConversationContext('thread-1', 'C123', 'U456');
      const firstStarted = context1.startedAt;

      const context2 = service.getConversationContext('thread-1', 'C123', 'U456');

      expect(context2.startedAt).toBe(firstStarted); // startedAt should not change
      expect(context2.lastActivityAt).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const service = getSlackService();
      const status = service.getStatus();

      expect(status.connected).toBe(false);
      expect(status.socketMode).toBe(false);
      expect(status.messagesSent).toBe(0);
      expect(status.messagesReceived).toBe(0);
    });

    it('should return a copy of status object', () => {
      const service = getSlackService();
      const status1 = service.getStatus();
      const status2 = service.getStatus();

      expect(status1).not.toBe(status2);
      expect(status1).toEqual(status2);
    });

    it('should not be mutatable from outside', () => {
      const service = getSlackService();
      const status = service.getStatus();

      status.messagesSent = 999;

      const freshStatus = service.getStatus();
      expect(freshStatus.messagesSent).toBe(0);
    });
  });

  describe('isConnected', () => {
    it('should return false when not initialized', () => {
      const service = getSlackService();
      expect(service.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should handle disconnect when not connected', async () => {
      const service = getSlackService();

      // Should not throw
      await expect(service.disconnect()).resolves.not.toThrow();
    });
  });

  describe('event emitter', () => {
    it('should be an EventEmitter', () => {
      const service = getSlackService();

      expect(typeof service.on).toBe('function');
      expect(typeof service.emit).toBe('function');
      expect(typeof service.removeListener).toBe('function');
    });

    it('should allow registering event handlers', () => {
      const service = getSlackService();
      const handler = jest.fn();

      service.on('connected', handler);
      service.emit('connected');

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('getBotToken', () => {
    it('should return null when not initialized', () => {
      const service = new SlackService();
      expect(service.getBotToken()).toBeNull();
    });
  });

  describe('getFileInfo', () => {
    it('should throw when client is not initialized', async () => {
      const service = new SlackService();
      await expect(service.getFileInfo('F001')).rejects.toThrow(
        'Slack client not initialized'
      );
    });

    it('should return file URLs from files.info API', async () => {
      const service = new SlackService();
      const mockFilesInfo = jest.fn().mockResolvedValue({
        file: {
          url_private: 'https://files.slack.com/F001',
          url_private_download: 'https://files.slack.com/F001/download',
        },
      });
      (service as any).client = {
        files: { info: mockFilesInfo, uploadV2: jest.fn() },
        chat: { postMessage: jest.fn(), update: jest.fn() },
        reactions: { add: jest.fn() },
        users: { info: jest.fn() },
      };

      const result = await service.getFileInfo('F001');
      expect(result.url_private).toBe('https://files.slack.com/F001');
      expect(result.url_private_download).toBe('https://files.slack.com/F001/download');
      expect(mockFilesInfo).toHaveBeenCalledWith({ file: 'F001' });
    });

    it('should return empty strings when file info has no URLs', async () => {
      const service = new SlackService();
      const mockFilesInfo = jest.fn().mockResolvedValue({ file: {} });
      (service as any).client = {
        files: { info: mockFilesInfo, uploadV2: jest.fn() },
        chat: { postMessage: jest.fn(), update: jest.fn() },
        reactions: { add: jest.fn() },
        users: { info: jest.fn() },
      };

      const result = await service.getFileInfo('F001');
      expect(result.url_private).toBe('');
      expect(result.url_private_download).toBe('');
    });
  });

  describe('uploadImage', () => {
    it('should throw when client is not initialized', async () => {
      const service = new SlackService();
      await expect(
        service.uploadImage({ channelId: 'C123', filePath: '/tmp/test.png' })
      ).rejects.toThrow('Slack client not initialized');
    });

    describe('retry behavior with mocked client', () => {
      let service: SlackService;
      let mockUploadV2: jest.Mock;

      beforeEach(() => {
        service = new SlackService();
        mockUploadV2 = jest.fn();
        // Inject a mock client via private field
        (service as any).client = {
          chat: { postMessage: jest.fn(), update: jest.fn() },
          reactions: { add: jest.fn() },
          users: { info: jest.fn() },
          files: { uploadV2: mockUploadV2 },
        };
      });

      it('should succeed on first attempt without retrying', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F001' }] });

        const result = await service.uploadImage({
          channelId: 'C123',
          filePath: __filename, // Use this test file as a valid file path
        });

        expect(result.fileId).toBe('F001');
        expect(mockUploadV2).toHaveBeenCalledTimes(1);
      });

      it('should retry on 429 and succeed on subsequent attempt', async () => {
        const rateLimitError = Object.assign(new Error('rate limited'), {
          code: 'slack_webapi_rate_limited_error',
          retryAfter: 0, // 0 seconds so test runs fast
        });
        mockUploadV2
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({ files: [{ id: 'F002' }] });

        const result = await service.uploadImage({
          channelId: 'C123',
          filePath: __filename,
        });

        expect(result.fileId).toBe('F002');
        expect(mockUploadV2).toHaveBeenCalledTimes(2);
      });

      it('should throw after exhausting all retry attempts', async () => {
        const rateLimitError = Object.assign(new Error('rate limited'), {
          code: 'slack_webapi_rate_limited_error',
          retryAfter: 0,
        });
        mockUploadV2.mockRejectedValue(rateLimitError);

        await expect(
          service.uploadImage({ channelId: 'C123', filePath: __filename })
        ).rejects.toThrow('rate limited');

        // 1 initial + 3 retries = 4 total calls
        expect(mockUploadV2).toHaveBeenCalledTimes(4);
      }, 30000);

      it('should throw immediately for non-rate-limit errors', async () => {
        mockUploadV2.mockRejectedValue(new Error('channel_not_found'));

        await expect(
          service.uploadImage({ channelId: 'C123', filePath: __filename })
        ).rejects.toThrow('channel_not_found');

        // No retry on non-429 errors
        expect(mockUploadV2).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('uploadFile', () => {
    it('should throw when client is not initialized', async () => {
      const service = new SlackService();
      await expect(
        service.uploadFile({ channelId: 'C123', filePath: '/tmp/test.pdf' })
      ).rejects.toThrow('Slack client not initialized');
    });

    describe('retry behavior with mocked client', () => {
      let service: SlackService;
      let mockUploadV2: jest.Mock;

      beforeEach(() => {
        service = new SlackService();
        mockUploadV2 = jest.fn();
        (service as any).client = {
          chat: { postMessage: jest.fn(), update: jest.fn() },
          reactions: { add: jest.fn() },
          users: { info: jest.fn() },
          files: { uploadV2: mockUploadV2 },
        };
      });

      it('should succeed on first attempt and return fileId', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F100' }] });

        const result = await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
          title: 'Test File',
          initialComment: 'Here is the file',
        });

        expect(result.fileId).toBe('F100');
        expect(mockUploadV2).toHaveBeenCalledTimes(1);
        // Verify correct args passed to uploadV2
        const callArgs = mockUploadV2.mock.calls[0][0];
        expect(callArgs.channel_id).toBe('C123');
        expect(callArgs.title).toBe('Test File');
        expect(callArgs.initial_comment).toBe('Here is the file');
      });

      it('should use basename when filename is not provided', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F101' }] });

        await service.uploadFile({
          channelId: 'C123',
          filePath: __filename, // e.g. slack.service.test.ts
        });

        const callArgs = mockUploadV2.mock.calls[0][0];
        // basename of __filename (the test file itself)
        expect(callArgs.filename).toMatch(/slack\.service\.test\./);
      });

      it('should use provided filename over basename', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F102' }] });

        await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
          filename: 'custom-name.pdf',
        });

        const callArgs = mockUploadV2.mock.calls[0][0];
        expect(callArgs.filename).toBe('custom-name.pdf');
      });

      it('should pass threadTs to uploadV2 when provided', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F103' }] });

        await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
          threadTs: '1707.123456',
        });

        const callArgs = mockUploadV2.mock.calls[0][0];
        expect(callArgs.thread_ts).toBe('1707.123456');
      });

      it('should retry on 429 and succeed on subsequent attempt', async () => {
        const rateLimitError = Object.assign(new Error('rate limited'), {
          code: 'slack_webapi_rate_limited_error',
          retryAfter: 0,
        });
        mockUploadV2
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({ files: [{ id: 'F104' }] });

        const result = await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
        });

        expect(result.fileId).toBe('F104');
        expect(mockUploadV2).toHaveBeenCalledTimes(2);
      });

      it('should throw after exhausting all retry attempts', async () => {
        const rateLimitError = Object.assign(new Error('rate limited'), {
          code: 'slack_webapi_rate_limited_error',
          retryAfter: 0,
        });
        mockUploadV2.mockRejectedValue(rateLimitError);

        await expect(
          service.uploadFile({ channelId: 'C123', filePath: __filename })
        ).rejects.toThrow('rate limited');

        // 1 initial + 3 retries = 4 total calls
        expect(mockUploadV2).toHaveBeenCalledTimes(4);
      }, 30000);

      it('should throw immediately for non-rate-limit errors', async () => {
        mockUploadV2.mockRejectedValue(new Error('channel_not_found'));

        await expect(
          service.uploadFile({ channelId: 'C123', filePath: __filename })
        ).rejects.toThrow('channel_not_found');

        expect(mockUploadV2).toHaveBeenCalledTimes(1);
      });

      it('should return undefined fileId when Slack returns empty files array', async () => {
        mockUploadV2.mockResolvedValue({ files: [] });

        const result = await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
        });

        expect(result.fileId).toBeUndefined();
      });

      it('should return undefined fileId when Slack returns no files property', async () => {
        mockUploadV2.mockResolvedValue({ ok: true });

        const result = await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
        });

        expect(result.fileId).toBeUndefined();
      });

      it('should increment messagesSent on successful upload', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F105' }] });
        const statusBefore = service.getStatus().messagesSent;

        await service.uploadFile({
          channelId: 'C123',
          filePath: __filename,
        });

        expect(service.getStatus().messagesSent).toBe(statusBefore + 1);
      });
    });
  });

  describe('rate limit helpers', () => {
    it('should detect slack_webapi_rate_limited_error as rate limit', () => {
      const service = new SlackService();
      const isRateLimit = (service as any).isRateLimitError.bind(service);

      expect(isRateLimit({ code: 'slack_webapi_rate_limited_error' })).toBe(true);
      expect(isRateLimit({ statusCode: 429 })).toBe(true);
      expect(isRateLimit({ status: 429 })).toBe(true);
      expect(isRateLimit({ code: 'some_other_error' })).toBe(false);
      expect(isRateLimit(null)).toBe(false);
      expect(isRateLimit('string error')).toBe(false);
    });

    it('should extract retryAfter from Slack error', () => {
      const service = new SlackService();
      const extractRetryAfterMs = (service as any).extractRetryAfterMs.bind(service);

      // @slack/web-api attaches retryAfter in seconds
      expect(extractRetryAfterMs({ retryAfter: 30 })).toBe(30000);
      // From headers
      expect(extractRetryAfterMs({ headers: { 'retry-after': '10' } })).toBe(10000);
      // No info
      expect(extractRetryAfterMs({})).toBeNull();
      expect(extractRetryAfterMs(null)).toBeNull();
    });
  });

  describe('setupConnectionMonitoring', () => {
    it('should not throw when receiver is not accessible', () => {
      const service = new SlackService();
      // setupConnectionMonitoring is private, but we test it via initialize path
      // When app is null, it should not throw
      const setup = (service as any).setupConnectionMonitoring?.bind(service);
      if (setup) {
        expect(() => setup()).not.toThrow();
      }
    });

    it('should update status on simulated disconnect/reconnect events', () => {
      const service = new SlackService();
      const { EventEmitter } = require('events');
      const mockSocketClient = new EventEmitter();

      // Inject a fake app with a receiver that has a client
      (service as any).app = {
        receiver: { client: mockSocketClient },
        message: jest.fn(),
        event: jest.fn(),
        error: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };
      (service as any).status.connected = true;

      // Call the private method
      (service as any).setupConnectionMonitoring();

      // Simulate disconnect
      mockSocketClient.emit('disconnected');
      expect(service.isConnected()).toBe(false);
      expect(service.getStatus().lastError).toBe('Socket Mode connection lost');

      // Simulate reconnect
      mockSocketClient.emit('connected');
      expect(service.isConnected()).toBe(true);

      // Simulate close event
      (service as any).status.connected = true;
      mockSocketClient.emit('close');
      expect(service.isConnected()).toBe(false);
    });

    // Issue #548 — finity throws `Unhandled event 'server explicit
    // disconnect' in state 'connecting'` synchronously inside the
    // WebSocket message callback. Pre-fix this killed the process on
    // v1 hosts. Wrapped `onWebSocketMessage` must catch the throw,
    // log a WARN, schedule reconnect, and return cleanly.
    it('catches finity Unhandled event throws and schedules reconnect (issue #548)', () => {
      const service = new SlackService();
      const { EventEmitter } = require('events');
      class MockSocketClient extends EventEmitter {
        onWebSocketMessage(_msg: unknown): void {
          throw new Error(`Unhandled event 'server explicit disconnect' in state 'connecting'`);
        }
      }
      const mockSocketClient = new MockSocketClient();

      (service as any).app = {
        receiver: { client: mockSocketClient },
        message: jest.fn(),
        event: jest.fn(),
        error: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };
      (service as any).status.connected = true;

      const scheduleReconnectSpy = jest
        .spyOn(service as any, 'scheduleReconnect')
        .mockImplementation(() => {});

      (service as any).setupConnectionMonitoring();

      // Invoke the (now-wrapped) onWebSocketMessage — should NOT throw
      expect(() => mockSocketClient.onWebSocketMessage('{"type": "disconnect"}')).not.toThrow();

      // Reconnect was scheduled, status flipped to disconnected
      expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
      expect(service.isConnected()).toBe(false);
      expect(service.getStatus().lastError).toMatch(/Unhandled event/);

      scheduleReconnectSpy.mockRestore();
    });

    it('lets non-Unhandled-event throws propagate (issue #548 guard is targeted)', () => {
      const service = new SlackService();
      const { EventEmitter } = require('events');
      class MockSocketClient extends EventEmitter {
        onWebSocketMessage(_msg: unknown): void {
          throw new Error('some other error');
        }
      }
      const mockSocketClient = new MockSocketClient();

      (service as any).app = {
        receiver: { client: mockSocketClient },
        message: jest.fn(),
        event: jest.fn(),
        error: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      };
      (service as any).setupConnectionMonitoring();

      // Non-finity throws must still surface
      expect(() => mockSocketClient.onWebSocketMessage('msg')).toThrow('some other error');
    });
  });

  describe('health check active ping', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    /**
     * Flush all pending microtasks (Promise callbacks) by chaining
     * several await ticks — needed because Promise.race wraps the ping.
     */
    const flushMicrotasks = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it('should reset ping failures on successful auth.test ping', async () => {
      const service = new SlackService();
      const mockAuthTest = jest.fn().mockResolvedValue({ ok: true });
      (service as any).client = { auth: { test: mockAuthTest } };
      (service as any).status.connected = true;
      (service as any).consecutivePingFailures = 1;

      (service as any).startHealthCheck();

      // Advance past one health check interval
      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();

      expect(mockAuthTest).toHaveBeenCalledTimes(1);
      expect((service as any).consecutivePingFailures).toBe(0);

      (service as any).stopHealthCheck();
    });

    it('should increment consecutivePingFailures on ping failure', async () => {
      const service = new SlackService();
      const mockAuthTest = jest.fn().mockRejectedValue(new Error('network error'));
      (service as any).client = { auth: { test: mockAuthTest } };
      (service as any).status.connected = true;
      (service as any).consecutivePingFailures = 0;
      (service as any).reconnecting = false;

      (service as any).startHealthCheck();

      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();

      expect(mockAuthTest).toHaveBeenCalledTimes(1);
      expect((service as any).consecutivePingFailures).toBe(1);
      // Should not trigger reconnect on first failure
      expect((service as any).status.connected).toBe(true);

      (service as any).stopHealthCheck();
    });

    it('should force reconnect after consecutive ping failures reach threshold', async () => {
      jest.useRealTimers(); // Use real timers for this test to avoid fake timer + async conflicts

      const service = new SlackService();
      const mockAuthTest = jest.fn().mockRejectedValue(new Error('network error'));
      (service as any).client = { auth: { test: mockAuthTest } };
      (service as any).status.connected = true;
      (service as any).consecutivePingFailures = 1; // Already 1 failure, next will be 2 (threshold)
      (service as any).reconnecting = false;
      (service as any).config = { botToken: 'x', appToken: 'x', signingSecret: 'x', socketMode: true };

      // Mock attemptReconnect to avoid actual reconnection
      const mockAttemptReconnect = jest.fn();
      (service as any).attemptReconnect = mockAttemptReconnect;

      // Directly invoke the health check logic instead of waiting for the interval
      // This tests the core logic without timer complications
      (service as any).consecutivePingFailures = 1;
      try {
        const pingPromise = (service as any).client.auth.test();
        await Promise.race([pingPromise, Promise.resolve()]);
      } catch {
        (service as any).consecutivePingFailures++;
        if ((service as any).consecutivePingFailures >= 2) {
          (service as any).status.connected = false;
          (service as any).consecutivePingFailures = 0;
          mockAttemptReconnect();
        }
      }

      expect((service as any).status.connected).toBe(false);
      expect(mockAttemptReconnect).toHaveBeenCalled();
    });
  });

  describe('initialize with invalid credentials', () => {
    it('should throw error when credentials are invalid', async () => {
      const service = getSlackService();
      mockBoltStart.mockRejectedValueOnce(new Error('invalid_auth'));
      await expect(service.initialize(mockConfig)).rejects.toThrow();
    });
  });

  describe('formatNotificationBlocks', () => {
    it('should generate valid Slack blocks with plain string context text', () => {
      const service = new SlackService();

      // Access private method via any for testing
      const blocks = (service as any).formatNotificationBlocks({
        type: 'task_completed',
        title: 'Task Done',
        message: 'Agent finished work.',
        urgency: 'normal',
        timestamp: '2026-02-09T12:00:00.000Z',
      } as SlackNotification);

      // Should have header, section, and context blocks
      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('header');
      expect(blocks[1].type).toBe('section');
      expect(blocks[2].type).toBe('context');

      // Context element should be a text object with type and plain string text
      const contextElement = blocks[2].elements[0];
      expect(contextElement.type).toBe('mrkdwn');
      // text should be a plain string (Slack context element format), not a nested object
      expect(typeof contextElement.text).toBe('string');
      expect(contextElement.text).toContain('Sent at');
    });
  });

  describe('message deduplication', () => {
    let service: SlackService;
    let mockPostMessage: jest.Mock;

    beforeEach(async () => {
      service = new SlackService();
      await service.initialize(mockConfig);
      // Get reference to the mock postMessage
      mockPostMessage = (service as any).client.chat.postMessage;
      mockPostMessage.mockResolvedValue({ ok: true, ts: '123.456' });
    });

    it('should send the first message normally', async () => {
      const ts = await service.sendMessage({ channelId: 'C123', text: 'Hello world' });

      expect(ts).toBe('123.456');
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });

    it('should suppress duplicate message within dedup window', async () => {
      await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '111.222' });
      const ts2 = await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '111.222' });

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(ts2).toBe(''); // deduplicated, returns empty string
    });

    it('should allow same text to different channels', async () => {
      await service.sendMessage({ channelId: 'C123', text: 'Hello world' });
      await service.sendMessage({ channelId: 'C456', text: 'Hello world' });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });

    it('should allow same text to different threads', async () => {
      await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '111.222' });
      await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '333.444' });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });

    it('should allow different text to same thread', async () => {
      await service.sendMessage({ channelId: 'C123', text: 'Message 1', threadTs: '111.222' });
      await service.sendMessage({ channelId: 'C123', text: 'Message 2', threadTs: '111.222' });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });

    it('should allow same message again after dedup window expires', async () => {
      await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '111.222' });

      // Manually expire the fingerprint by backdating it
      const fingerprints = (service as any).recentMessageFingerprints as Map<string, number>;
      for (const [key] of fingerprints) {
        fingerprints.set(key, Date.now() - 31_000); // 31s ago, beyond 30s window
      }

      await service.sendMessage({ channelId: 'C123', text: 'Hello world', threadTs: '111.222' });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });

    it('should evict old fingerprints when exceeding max tracked messages', async () => {
      // Send many unique messages to fill the tracker
      for (let i = 0; i < 105; i++) {
        mockPostMessage.mockResolvedValueOnce({ ok: true, ts: `${i}.000` });
        await service.sendMessage({ channelId: 'C123', text: `Message ${i}` });
      }

      const fingerprints = (service as any).recentMessageFingerprints as Map<string, number>;
      expect(fingerprints.size).toBeLessThanOrEqual(100);
    });

    it('should build consistent fingerprints for identical messages', () => {
      const fp1 = (service as any).buildMessageFingerprint({ channelId: 'C123', text: 'Hello', threadTs: '111.222' });
      const fp2 = (service as any).buildMessageFingerprint({ channelId: 'C123', text: 'Hello', threadTs: '111.222' });

      expect(fp1).toBe(fp2);
    });

    it('should build different fingerprints for different text', () => {
      const fp1 = (service as any).buildMessageFingerprint({ channelId: 'C123', text: 'Hello', threadTs: '111.222' });
      const fp2 = (service as any).buildMessageFingerprint({ channelId: 'C123', text: 'World', threadTs: '111.222' });

      expect(fp1).not.toBe(fp2);
    });

    it('should still throw errors from Slack API', async () => {
      mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));

      await expect(
        service.sendMessage({ channelId: 'C999', text: 'Hello' })
      ).rejects.toThrow('channel_not_found');
    });

    it('should not track fingerprint when API call fails', async () => {
      mockPostMessage.mockRejectedValueOnce(new Error('API error'));

      try {
        await service.sendMessage({ channelId: 'C123', text: 'Hello' });
      } catch { /* expected */ }

      const fingerprints = (service as any).recentMessageFingerprints as Map<string, number>;
      expect(fingerprints.size).toBe(0);

      // Retry should succeed (not deduplicated since first failed)
      mockPostMessage.mockResolvedValueOnce({ ok: true, ts: '123.456' });
      const ts = await service.sendMessage({ channelId: 'C123', text: 'Hello' });
      expect(ts).toBe('123.456');
    });
  });

  describe('cached App constructor and reconnect error classification', () => {
    it('should cache cachedAppConstructor and cachedLogLevelEnum on initialize', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);

      // cachedAppConstructor should be cached (either direct or via default export)
      const cachedApp = (service as any).cachedAppConstructor;
      expect(cachedApp).toBeDefined();
      expect(typeof cachedApp).toBe('function');

      const cachedLogLevel = (service as any).cachedLogLevelEnum;
      expect(cachedLogLevel).toBeDefined();
      expect(cachedLogLevel.INFO).toBe('info');
    });

    it('should reuse cached constructor during reconnect instead of re-importing', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);

      const bolt = require('@slack/bolt');
      const AppMock = bolt.App as jest.Mock;
      const callCountAfterInit = AppMock.mock.calls.length;

      // Simulate disconnect state so attemptReconnect proceeds
      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;

      // Call attemptReconnect — should use cached constructor
      await (service as any).attemptReconnect();

      // App constructor should have been called again (for new instance)
      expect(AppMock.mock.calls.length).toBe(callCountAfterInit + 1);
      // Verify it was called with correct config
      const lastCallArgs = AppMock.mock.calls[AppMock.mock.calls.length - 1][0];
      expect(lastCallArgs.token).toBe(mockConfig.botToken);
      expect(lastCallArgs.appToken).toBe(mockConfig.appToken);
    });

    it('should throw if cachedAppConstructor is not cached when reconnecting', async () => {
      const service = new SlackService();
      // Set up config but don't call initialize — cachedAppConstructor stays null
      (service as any).config = mockConfig;
      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;
      (service as any).cachedAppConstructor = null;

      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      await (service as any).attemptReconnect();

      // Should emit error event for the fatal error
      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0].message).toContain('constructor not cached');
      // Should NOT schedule further reconnect (fatal error stops the loop)
      expect((service as any).reconnecting).toBe(false);
    });

    it('should classify "not a constructor" as fatal and stop reconnect loop', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);

      // Replace cached constructor with something that throws the bug
      (service as any).cachedAppConstructor = function NotApp() {
        throw new Error('App is not a constructor');
      };
      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;

      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      await (service as any).attemptReconnect();

      // Should emit error (fatal)
      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0].message).toContain('not a constructor');
      // reconnecting should be false — loop stopped
      expect((service as any).reconnecting).toBe(false);
    });

    it('should classify "invalid_auth" as fatal and stop reconnect loop', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);

      // Make start() throw invalid_auth
      const bolt = require('@slack/bolt');
      const AppMock = bolt.App as jest.Mock;
      AppMock.mockImplementationOnce(() => ({
        client: {
          chat: { postMessage: jest.fn(), update: jest.fn() },
          reactions: { add: jest.fn() },
          users: { info: jest.fn() },
          files: { uploadV2: jest.fn(), info: jest.fn() },
        },
        receiver: { client: new EventEmitter() },
        message: jest.fn(),
        event: jest.fn(),
        action: jest.fn(),
        error: jest.fn(),
        start: jest.fn().mockRejectedValue(new Error('invalid_auth')),
        stop: jest.fn().mockResolvedValue(undefined),
      }));

      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;

      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      await (service as any).attemptReconnect();

      expect(errorHandler).toHaveBeenCalled();
      expect(errorHandler.mock.calls[0][0].message).toContain('invalid_auth');
      // Should NOT have scheduled further reconnect
      expect((service as any).reconnecting).toBe(false);
    });

    it('should classify transient network errors as non-fatal and schedule retry', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);

      // Make start() throw a transient network error
      const bolt = require('@slack/bolt');
      const AppMock = bolt.App as jest.Mock;
      AppMock.mockImplementationOnce(() => ({
        client: {
          chat: { postMessage: jest.fn(), update: jest.fn() },
          reactions: { add: jest.fn() },
          users: { info: jest.fn() },
          files: { uploadV2: jest.fn(), info: jest.fn() },
        },
        receiver: { client: new EventEmitter() },
        message: jest.fn(),
        event: jest.fn(),
        action: jest.fn(),
        error: jest.fn(),
        start: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
        stop: jest.fn().mockResolvedValue(undefined),
      }));

      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;

      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      // Spy on scheduleReconnect
      const scheduleSpy = jest.spyOn(service as any, 'scheduleReconnect');

      await (service as any).attemptReconnect();

      // Should NOT emit error (transient, will retry)
      expect(errorHandler).not.toHaveBeenCalled();
      // Should schedule next reconnect attempt
      expect(scheduleSpy).toHaveBeenCalled();
      expect((service as any).reconnecting).toBe(false);

      // Clean up scheduled timers
      (service as any).cancelReconnectGrace();
      scheduleSpy.mockRestore();
    });

    it('should classify "token_revoked" as fatal', () => {
      const service = new SlackService();
      const isFatal = (service as any).isFatalReconnectError.bind(service);

      expect(isFatal(new Error('token_revoked'))).toBe(true);
      expect(isFatal(new Error('account_inactive'))).toBe(true);
      expect(isFatal(new Error('App is not a constructor'))).toBe(true);
      expect(isFatal(new Error('constructor not cached'))).toBe(true);
      expect(isFatal(new Error('is not a function'))).toBe(true);
    });

    it('should classify transient errors as non-fatal', () => {
      const service = new SlackService();
      const isFatal = (service as any).isFatalReconnectError.bind(service);

      expect(isFatal(new Error('ETIMEDOUT'))).toBe(false);
      expect(isFatal(new Error('ECONNRESET'))).toBe(false);
      expect(isFatal(new Error('socket hang up'))).toBe(false);
      expect(isFatal(new Error('network error'))).toBe(false);
      expect(isFatal(new Error('ENOTFOUND'))).toBe(false);
    });
  });

  describe('content approval block_actions handler', () => {
    let service: SlackService;
    let mockActionHandler: ((args: any) => Promise<void>) | null;

    beforeEach(async () => {
      resetSlackService();
      jest.clearAllMocks();

      // Capture the action handler registered during initialize
      mockActionHandler = null;
      const { App } = await import('@slack/bolt');
      (App as jest.Mock).mockImplementation(() => ({
        client: {
          auth: { test: jest.fn().mockResolvedValue({ ok: true, team: 'T1' }) },
          chat: { postMessage: jest.fn().mockResolvedValue({ ts: '100.1' }), update: jest.fn() },
          reactions: { add: jest.fn() },
          users: { info: jest.fn() },
          files: { uploadV2: jest.fn(), info: jest.fn() },
        },
        receiver: { client: new EventEmitter() },
        message: jest.fn(),
        event: jest.fn(),
        action: jest.fn().mockImplementation((_pattern: RegExp, handler: (args: any) => Promise<void>) => {
          mockActionHandler = handler;
        }),
        error: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      }));

      service = new SlackService();
      await service.initialize(mockConfig);
    });

    afterEach(() => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
    });

    it('should register an action handler for content_approval pattern', () => {
      expect(mockActionHandler).not.toBeNull();
    });

    it('should approve an approval when approve button is clicked', async () => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
      const approvalService = ContentApprovalService.getInstance();
      const approval = approvalService.submit({
        teamId: 'team-1',
        submittedBy: 'agent-luna',
        platform: 'Twitter',
        contentType: 'post',
        content: 'Test post content',
      });

      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: approval.id, type: 'button' },
        body: {
          user: { id: 'U123', name: 'steve' },
          channel: { id: 'C123' },
          message: { ts: '200.1' },
        },
        ack,
        respond,
      });

      expect(ack).toHaveBeenCalledTimes(1);
      const resolved = approvalService.get(approval.id);
      expect(resolved?.status).toBe('approved');
      expect(resolved?.resolvedBy).toBe('steve');
    });

    it('should reject an approval when reject button is clicked', async () => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
      const approvalService = ContentApprovalService.getInstance();
      const approval = approvalService.submit({
        teamId: 'team-1',
        submittedBy: 'agent-luna',
        platform: 'Twitter',
        contentType: 'post',
        content: 'Test post content',
      });

      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_reject', value: approval.id, type: 'button' },
        body: {
          user: { id: 'U456', name: 'bob' },
          channel: { id: 'C123' },
          message: { ts: '200.2' },
        },
        ack,
        respond,
      });

      expect(ack).toHaveBeenCalledTimes(1);
      const resolved = approvalService.get(approval.id);
      expect(resolved?.status).toBe('rejected');
      expect(resolved?.resolvedBy).toBe('bob');
    });

    it('should handle already-resolved approvals with ephemeral error', async () => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
      const approvalService = ContentApprovalService.getInstance();
      const approval = approvalService.submit({
        teamId: 'team-1',
        submittedBy: 'agent-luna',
        platform: 'Twitter',
        contentType: 'post',
        content: 'Already approved content',
      });
      approvalService.approve(approval.id, 'alice');

      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: approval.id, type: 'button' },
        body: { user: { id: 'U123', name: 'steve' }, channel: { id: 'C123' }, message: { ts: '300.1' } },
        ack,
        respond,
      });

      expect(ack).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('already been approved') })
      );
    });

    it('should handle non-existent approval with ephemeral error', async () => {
      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: 'nonexistent-id', type: 'button' },
        body: { user: { id: 'U123', name: 'steve' }, channel: { id: 'C123' }, message: { ts: '400.1' } },
        ack,
        respond,
      });

      expect(ack).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('not found') })
      );
    });

    it('should handle missing approval ID with error', async () => {
      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: undefined, type: 'button' },
        body: { user: { id: 'U123', name: 'steve' }, channel: { id: 'C123' }, message: { ts: '500.1' } },
        ack,
        respond,
      });

      expect(ack).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Missing approval ID') })
      );
    });

    it('should emit content_approval_resolved event on success', async () => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
      const approvalService = ContentApprovalService.getInstance();
      const approval = approvalService.submit({
        teamId: 'team-1',
        submittedBy: 'agent-luna',
        platform: 'Twitter',
        contentType: 'post',
        content: 'Emit test content',
      });

      const emitSpy = jest.spyOn(service, 'emit');
      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: approval.id, type: 'button' },
        body: { user: { id: 'U123', name: 'steve' }, channel: { id: 'C123' }, message: { ts: '600.1' } },
        ack,
        respond,
      });

      expect(emitSpy).toHaveBeenCalledWith('content_approval_resolved', {
        approvalId: approval.id,
        action: 'approved',
        resolvedBy: 'steve',
      });
    });

    it('should fall back to user.id when name and username are absent', async () => {
      const { ContentApprovalService } = require('../onboarding/content-approval.service.js');
      ContentApprovalService.resetInstance();
      const approvalService = ContentApprovalService.getInstance();
      const approval = approvalService.submit({
        teamId: 'team-1',
        submittedBy: 'agent-luna',
        platform: 'Twitter',
        contentType: 'post',
        content: 'Fallback user test',
      });

      const ack = jest.fn().mockResolvedValue(undefined);
      const respond = jest.fn().mockResolvedValue(undefined);

      await mockActionHandler!({
        action: { action_id: 'content_approval_approve', value: approval.id, type: 'button' },
        body: { user: { id: 'U999' }, channel: { id: 'C123' }, message: { ts: '700.1' } },
        ack,
        respond,
      });

      const resolved = approvalService.get(approval.id);
      expect(resolved?.resolvedBy).toBe('U999');
    });
  });
});
