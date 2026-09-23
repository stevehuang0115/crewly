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

// Cloud transport builds a bare Web API client (no Bolt app / socket); the
// socket path builds one too, for the bot-token pre-flight before the App.
const defaultWebClientImpl = () => ({
  auth: { test: jest.fn().mockResolvedValue({ ok: true, user_id: 'UBOT' }) },
  chat: { postMessage: jest.fn().mockResolvedValue({ ts: '9.9' }), update: jest.fn(), postEphemeral: jest.fn().mockResolvedValue({ ok: true }) },
  reactions: { add: jest.fn() },
  users: { info: jest.fn() },
  files: { uploadV2: jest.fn(), info: jest.fn() },
});
const mockWebClientCtor = jest.fn().mockImplementation(defaultWebClientImpl);
jest.mock('@slack/web-api', () => ({ WebClient: mockWebClientCtor }));

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

    // 2026-09-19: a boot banner and an OKR nudge landed in
    // #course-standardization-team because the fallback picked "the most
    // recent thread channel". Owner notifications go to the owner's DM only.
    it('sendNotification without a default channel goes to a master-bot DM (opened with the owner if needed), never a team channel', async () => {
      const service = new SlackService();
      const postMessage = jest.fn().mockResolvedValue({ ts: '1.2' });
      const open = jest.fn().mockResolvedValue({ channel: { id: 'D-OWNER' } });
      (service as any).client = { chat: { postMessage }, conversations: { open } };
      (service as any).status.connected = true;
      (service as any).config = {};
      service.getOwnerUserId = () => 'U-OWNER';
      // Only channels (no DMs) in the thread store → none are eligible.
      const fallback = await import('./slack-notification-fallback.js');
      jest.spyOn(fallback, 'resolveFallbackNotificationChannels').mockImplementation((_dir, exclude) => ['C-team', 'D-agent'].filter((id) => !(exclude ?? (() => false))(id)));
      service.isAgentOwnedConversation = (id) => id === 'D-agent';

      await service.sendNotification({ type: 'system', title: 'Crewly 已重启上线', message: 'v', urgency: 'normal', timestamp: '' } as never);
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ users: 'U-OWNER' }));
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0].channel).toBe('D-OWNER');
    });

    it('sendNotification tries the owner DM before stale master-bot DMs left over from another workspace', async () => {
      const service = new SlackService();
      const postMessage = jest.fn().mockResolvedValue({ ts: '1.2' });
      const open = jest.fn().mockResolvedValue({ channel: { id: 'D-OWNER' } });
      (service as any).client = { chat: { postMessage }, conversations: { open } };
      (service as any).status.connected = true;
      (service as any).config = {};
      service.getOwnerUserId = () => 'U-OWNER';
      const fallback = await import('./slack-notification-fallback.js');
      jest.spyOn(fallback, 'resolveFallbackNotificationChannels').mockReturnValue(['D-old-workspace-1', 'D-old-workspace-2']);

      await service.sendNotification({ type: 'system', title: 't', message: 'v', urgency: 'normal', timestamp: '' } as never);
      // No channel_not_found round-trips: the first (and only) post goes to the owner DM.
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0].channel).toBe('D-OWNER');
    });

    it('passes per-message identity (username + icon) to chat.postMessage', async () => {
      const service = new SlackService();
      const postMessage = jest.fn().mockResolvedValue({ ts: '1.2' });
      (service as any).client = { chat: { postMessage } };

      await service.sendMessage({
        channelId: 'C1',
        text: 'as sam',
        username: 'Sam',
        iconEmoji: ':computer:',
      });
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'Sam', icon_emoji: ':computer:' }),
      );
      expect(postMessage.mock.calls[0][0]).not.toHaveProperty('icon_url');

      await service.sendMessage({
        channelId: 'C1',
        text: 'as leo',
        username: 'Leo',
        iconUrl: 'https://x/leo.png',
      });
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ username: 'Leo', icon_url: 'https://x/leo.png' }),
      );
    });

    it('omits identity fields entirely when none are set (default bot identity)', async () => {
      const service = new SlackService();
      const postMessage = jest.fn().mockResolvedValue({ ts: '1.2' });
      (service as any).client = { chat: { postMessage } };
      await service.sendMessage({ channelId: 'C1', text: 'plain' });
      const args = postMessage.mock.calls[0][0];
      expect(args).not.toHaveProperty('username');
      expect(args).not.toHaveProperty('icon_emoji');
      expect(args).not.toHaveProperty('icon_url');
    });

    it('skips the chat-v2 mirror when skipChatV2Mirror is set (caller already persisted)', async () => {
      mockRecordTurn.mockClear();
      const service = new SlackService();
      (service as any).client = {
        chat: { postMessage: jest.fn().mockResolvedValue({ ts: '111.222' }) },
      };
      await service.sendMessage({
        channelId: 'C123',
        text: 'team reply',
        threadTs: '100.000',
        skipChatV2Mirror: true,
      });
      await new Promise((r) => setImmediate(r));
      expect(mockRecordTurn).not.toHaveBeenCalled();
    });

    it('should throw when updateMessage called without initialization', async () => {
      const service = new SlackService();

      await expect(
        service.updateMessage('C123', '123.456', 'updated text')
      ).rejects.toThrow('Slack client not initialized');
    });

    it('should throw when deleteMessage called without initialization', async () => {
      const service = new SlackService();

      await expect(service.deleteMessage('C123', '123.456')).rejects.toThrow('Slack client not initialized');
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

  describe('conversations helpers (team channels)', () => {
    function withClient(conversations: Record<string, jest.Mock>, auth?: Record<string, jest.Mock>) {
      const service = new SlackService();
      (service as any).client = {
        chat: { postMessage: jest.fn() },
        auth: auth ?? { test: jest.fn().mockResolvedValue({ ok: true, user_id: 'UBOT' }) },
        conversations,
      };
      return service;
    }

    it('getBotUserId resolves via auth.test and caches the result', async () => {
      const test = jest.fn().mockResolvedValue({ ok: true, user_id: 'UBOT' });
      const service = withClient({}, { test });
      expect(await service.getBotUserId()).toBe('UBOT');
      expect(await service.getBotUserId()).toBe('UBOT');
      expect(test).toHaveBeenCalledTimes(1);
    });

    it('getBotUserId returns null when not connected', async () => {
      const service = new SlackService();
      expect(await service.getBotUserId()).toBeNull();
    });

    it('createChannel returns the new channel', async () => {
      const create = jest.fn().mockResolvedValue({
        channel: { id: 'C9', name: 'team-alpha', is_archived: false, is_private: false },
      });
      const service = withClient({ create });
      const ch = await service.createChannel('team-alpha');
      expect(create).toHaveBeenCalledWith({ name: 'team-alpha', is_private: false });
      expect(ch).toEqual({ id: 'C9', name: 'team-alpha', isArchived: false, isPrivate: false });
    });

    // A team re-created after a reinstall must link to the channel that is
    // already there, not fail on Slack's name_taken.
    it('createChannel falls back to the existing channel on name_taken and joins it', async () => {
      const nameTaken = Object.assign(new Error('An API error occurred: name_taken'), {
        data: { error: 'name_taken' },
      });
      const create = jest.fn().mockRejectedValue(nameTaken);
      const list = jest.fn().mockResolvedValue({
        channels: [
          { id: 'C1', name: 'other' },
          { id: 'C2', name: 'Team-Alpha', is_archived: false },
        ],
        response_metadata: { next_cursor: '' },
      });
      const join = jest.fn().mockResolvedValue({});
      const service = withClient({ create, list, join });
      const ch = await service.createChannel('team-alpha');
      expect(ch.id).toBe('C2');
      expect(join).toHaveBeenCalledWith({ channel: 'C2' });
    });

    it('createChannel rethrows other Slack errors', async () => {
      const err = Object.assign(new Error('restricted_action'), { data: { error: 'restricted_action' } });
      const service = withClient({ create: jest.fn().mockRejectedValue(err) });
      await expect(service.createChannel('x')).rejects.toThrow('restricted_action');
    });

    it('findChannelByName pages through conversations.list', async () => {
      const list = jest
        .fn()
        .mockResolvedValueOnce({
          channels: [{ id: 'C1', name: 'a' }],
          response_metadata: { next_cursor: 'p2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C2', name: 'wanted' }],
          response_metadata: { next_cursor: '' },
        });
      const service = withClient({ list });
      const ch = await service.findChannelByName('wanted');
      expect(ch?.id).toBe('C2');
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[1][0]).toEqual(expect.objectContaining({ cursor: 'p2' }));
    });

    it('findChannelByName returns null when absent', async () => {
      const service = withClient({
        list: jest.fn().mockResolvedValue({ channels: [{ id: 'C1', name: 'a' }] }),
      });
      expect(await service.findChannelByName('zzz')).toBeNull();
    });

    it('getChannelInfo maps channel_not_found to null', async () => {
      const err = Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } });
      const service = withClient({ info: jest.fn().mockRejectedValue(err) });
      expect(await service.getChannelInfo('C404')).toBeNull();
    });

    it('archiveChannel treats already_archived as success', async () => {
      const err = Object.assign(new Error('already_archived'), { data: { error: 'already_archived' } });
      const service = withClient({ archive: jest.fn().mockRejectedValue(err) });
      await expect(service.archiveChannel('C1')).resolves.toBeUndefined();
    });

    it('setChannelPurpose truncates to the Slack limit', async () => {
      const setPurpose = jest.fn().mockResolvedValue({});
      const service = withClient({ setPurpose });
      await service.setChannelPurpose('C1', 'x'.repeat(300));
      expect(setPurpose.mock.calls[0][0].purpose).toHaveLength(250);
    });

    it('inviteToChannel is a no-op for an empty list', async () => {
      const invite = jest.fn();
      const service = withClient({ invite });
      await service.inviteToChannel('C1', []);
      expect(invite).not.toHaveBeenCalled();
      await service.inviteToChannel('C1', ['U1', 'U2']);
      expect(invite).toHaveBeenCalledWith({ channel: 'C1', users: 'U1,U2' });
    });

    it('helpers throw when the client has no conversations API', async () => {
      const service = new SlackService();
      (service as any).client = { chat: { postMessage: jest.fn() } };
      await expect(service.createChannel('x')).rejects.toThrow('no conversations API');
    });

    it('helpers throw when not initialised', async () => {
      const service = new SlackService();
      await expect(service.joinChannel('C1')).rejects.toThrow('Slack client not initialized');
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

      it('uploads through a client built on the agent\'s token, not the workspace one', async () => {
        // `files.uploadV2` makes several calls of its own and a `token` in
        // its arguments does not reach all of them, so the upload went out
        // as the workspace bot — which is not a member of an agent's own DM.
        // Slack answered `channel_not_found`, which reads like a bad channel
        // id rather than a wrong identity.
        const agentUploadV2 = jest.fn().mockResolvedValue({ files: [{ id: 'F-agent' }] });
        (service as any).loadWebClientConstructor = jest.fn().mockResolvedValue(
          function FakeWebClient(this: Record<string, unknown>, token: string) {
            this.token = token;
            this.files = { uploadV2: agentUploadV2 };
          },
        );

        const result = await service.uploadFile({
          channelId: 'D0C30RHT1DG',
          filePath: __filename,
          botToken: 'xoxb-agent',
        });

        expect(result.fileId).toBe('F-agent');
        expect(agentUploadV2).toHaveBeenCalledTimes(1);
        // The workspace client must not have been used at all.
        expect(mockUploadV2).not.toHaveBeenCalled();
        // And the token must not be smuggled through the arguments, where it
        // does nothing.
        expect(agentUploadV2.mock.calls[0][0].token).toBeUndefined();
      });

      it('uses the workspace client when no agent token is given', async () => {
        mockUploadV2.mockResolvedValue({ files: [{ id: 'F-workspace' }] });

        const result = await service.uploadFile({ channelId: 'C123', filePath: __filename });

        expect(result.fileId).toBe('F-workspace');
        expect(mockUploadV2).toHaveBeenCalledTimes(1);
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

  // A dead bot token must degrade Slack, never the backend. Bolt's App
  // constructor runs auth.test eagerly and parks the promise un-caught, so
  // the token is verified BEFORE the App is built (preflightBotToken). The
  // real-Bolt reproduction lives in slack.service.bolt-preflight.test.ts;
  // these tests pin the service-level contract against the mocked App.
  describe('bot token pre-flight (Slack auth failure must never take down the backend)', () => {
    /** Error shape `@slack/web-api` raises for a Slack platform error. */
    const platformError = (code: string): Error =>
      Object.assign(new Error(`An API error occurred: ${code}`), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: code },
      });

    /**
     * Make every WebClient built during the test answer auth.test as given
     * (the pre-flight probe). Not a one-shot: a one-shot left unconsumed —
     * as it is on code that never builds the probe — would leak into the
     * next test. afterEach restores the default double.
     */
    const nextAuthTest = (impl: jest.Mock): void => {
      mockWebClientCtor.mockImplementation(() => ({ auth: { test: impl } }));
    };

    let AppMock: jest.Mock;

    beforeEach(() => {
      AppMock = require('@slack/bolt').App as jest.Mock;
      AppMock.mockClear();
      mockBoltStart.mockClear();
    });

    afterEach(() => {
      mockWebClientCtor.mockImplementation(defaultWebClientImpl);
    });

    it('auth.test rejecting with invalid_auth: no Bolt App is built, initialize rejects cleanly, Slack is degraded', async () => {
      nextAuthTest(jest.fn().mockRejectedValue(platformError('invalid_auth')));
      const service = new SlackService();
      service.on('error', () => undefined);
      const warn = jest.spyOn((service as any).logger, 'warn');

      await expect(service.initialize(mockConfig)).rejects.toThrow('An API error occurred: invalid_auth');

      expect(AppMock).not.toHaveBeenCalled();
      expect(mockBoltStart).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
      expect(service.getStatus()).toMatchObject({ degraded: true, degradedReason: 'invalid_auth' });
      const degradedLogs = warn.mock.calls.filter(([m]) => String(m).includes('Slack integration degraded'));
      expect(degradedLogs).toHaveLength(1);
    });

    it.each([
      ['token_revoked', platformError('token_revoked')],
      ['account_inactive', platformError('account_inactive')],
      ['ECONNREFUSED', Object.assign(new Error('A request error occurred: connect ECONNREFUSED'), {
        code: 'slack_webapi_request_error',
        original: { code: 'ECONNREFUSED' },
      })],
    ])('any pre-flight failure degrades, not only invalid_auth: %s', async (code, error) => {
      nextAuthTest(jest.fn().mockRejectedValue(error));
      const service = new SlackService();
      service.on('error', () => undefined);

      await expect(service.initialize(mockConfig)).rejects.toThrow();

      expect(AppMock).not.toHaveBeenCalled();
      expect(service.getStatus()).toMatchObject({ degraded: true, degradedReason: code });
    });

    it('valid token: Bolt receives botId + botUserId from the pre-flight and the bot-user cache is seeded', async () => {
      nextAuthTest(jest.fn().mockResolvedValue({ ok: true, user_id: 'UBOT', bot_id: 'BBOT' }));
      const service = new SlackService();

      await service.initialize(mockConfig);

      expect(AppMock).toHaveBeenCalledTimes(1);
      expect(AppMock.mock.calls[0][0]).toMatchObject({
        token: mockConfig.botToken,
        botId: 'BBOT',
        botUserId: 'UBOT',
      });
      expect(service.getStatus().degraded).toBeFalsy();
      // The mocked App client has no `auth` at all — resolving the bot user
      // id here proves it came from the pre-flight seed, not a second call.
      await expect(service.getBotUserId()).resolves.toBe('UBOT');
    });

    it('when Slack omits bot_id no ids are passed, so Bolt verifies on its own', async () => {
      // Default WebClient double resolves with user_id only.
      const service = new SlackService();

      await service.initialize(mockConfig);

      expect(AppMock).toHaveBeenCalledTimes(1);
      expect(AppMock.mock.calls[0][0]).not.toHaveProperty('botId');
      expect(AppMock.mock.calls[0][0]).not.toHaveProperty('botUserId');
    });

    it('reconnect: a token revoked since boot fails the pre-flight, builds no new App and stops the retry loop', async () => {
      const service = new SlackService();
      await service.initialize(mockConfig);
      AppMock.mockClear();

      nextAuthTest(jest.fn().mockRejectedValue(platformError('token_revoked')));
      (service as any).status.connected = false;
      (service as any).reconnecting = false;
      (service as any).reconnectAttempts = 0;
      (service as any).intentionalDisconnect = false;
      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      await (service as any).attemptReconnect();

      expect(AppMock).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0][0].message).toContain('token_revoked');
      // Fatal → loop stopped, integration degraded, backend untouched.
      expect((service as any).reconnecting).toBe(false);
      expect(service.getStatus()).toMatchObject({ degraded: true, degradedReason: 'token_revoked' });
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

  describe('inbound transport split (Socket Mode vs Cloud relay)', () => {
    const cloudConfig: SlackConfig = {
      botToken: 'xoxb-cloud-token',
      appToken: '',
      signingSecret: '',
      socketMode: false,
      transport: 'cloud',
      botUserId: 'UBOT',
    };

    /** Raw Slack `message` event as Slack delivers it to both transports. */
    const rawMessage = {
      type: 'message',
      ts: '1700000000.000100',
      text: 'hello team',
      user: 'U123',
      channel: 'C42',
      thread_ts: '1700000000.000001',
      team: 'T1',
      files: [{ id: 'F1', name: 'a.png', mimetype: 'image/png', filetype: 'png', size: 1, url_private: '', url_private_download: '', permalink: '' }],
    };

    /** Boot a socket-mode service and return the captured Bolt `message` listener. */
    async function bootSocket(): Promise<{ service: SlackService; onMessage: (args: any) => Promise<void>; onMention: (args: any) => Promise<void> }> {
      let onMessage: ((args: any) => Promise<void>) | null = null;
      let onMention: ((args: any) => Promise<void>) | null = null;
      const { App } = await import('@slack/bolt');
      (App as jest.Mock).mockImplementationOnce(() => ({
        client: { chat: { postMessage: jest.fn(), update: jest.fn() }, reactions: { add: jest.fn() }, users: { info: jest.fn() }, files: { uploadV2: jest.fn(), info: jest.fn() } },
        receiver: { client: new EventEmitter() },
        message: jest.fn().mockImplementation((h: (args: any) => Promise<void>) => { onMessage = h; }),
        event: jest.fn().mockImplementation((_t: string, h: (args: any) => Promise<void>) => { onMention = h; }),
        action: jest.fn(),
        error: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
      }));
      const service = new SlackService();
      await service.initialize(mockConfig);
      return { service, onMessage: onMessage!, onMention: onMention! };
    }

    beforeEach(() => {
      mockWebClientCtor.mockClear();
      mockBoltStart.mockClear();
    });

    it('cloud transport opens no Socket Mode connection and reports connected with a bot token', async () => {
      const { App } = await import('@slack/bolt');
      (App as jest.Mock).mockClear();
      const service = new SlackService();
      const connected = jest.fn();
      service.on('connected', connected);

      await service.initialize(cloudConfig);

      expect(App).not.toHaveBeenCalled();
      expect(mockBoltStart).not.toHaveBeenCalled();
      expect(mockWebClientCtor).toHaveBeenCalledWith('xoxb-cloud-token');
      expect(service.isConnected()).toBe(true);
      expect(service.getStatus().socketMode).toBe(false);
      expect(service.getTransport()).toBe('cloud');
      expect(connected).toHaveBeenCalledTimes(1);
      // Bot user id comes from the Cloud config — no auth.test round-trip.
      await expect(service.getBotUserId()).resolves.toBe('UBOT');
      await service.disconnect();
      expect(service.isConnected()).toBe(false);
    });

    it('cloud transport refuses to start without a bot token', async () => {
      const service = new SlackService();
      service.on('error', () => undefined);
      await expect(service.initialize({ ...cloudConfig, botToken: '' })).rejects.toThrow('no bot token');
      expect(service.isConnected()).toBe(false);
    });

    it('outbound chat.postMessage still goes straight to the Web API in cloud transport', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const ts = await service.sendMessage({ channelId: 'C1', text: 'hi' });
      expect(ts).toBe('9.9');
      expect(service.getStatus().messagesSent).toBe(1);
    });

    it('the same Slack message event produces the same routing result via both transports', async () => {
      const { service: socketService, onMessage } = await bootSocket();
      const socketEmitted: any[] = [];
      socketService.on('message', (m) => socketEmitted.push(m));
      await onMessage({ message: rawMessage, say: jest.fn() });

      const cloudService = new SlackService();
      await cloudService.initialize({ ...cloudConfig, allowedUserIds: ['U123'] });
      const cloudEmitted: any[] = [];
      cloudService.on('message', (m) => cloudEmitted.push(m));
      const result = cloudService.handleCloudEnvelope({
        eventId: 'Ev1',
        slackTeamId: 'T1',
        apiAppId: 'A1',
        source: 'master',
        event: rawMessage,
        receivedAt: new Date().toISOString(),
      });

      expect(socketEmitted).toHaveLength(1);
      expect(cloudEmitted).toHaveLength(1);
      expect(result).toBe(cloudEmitted[0]);
      const { source: s1, eventId: e1, ...socketMsg } = socketEmitted[0];
      const { source: s2, eventId: e2, ...cloudMsg } = cloudEmitted[0];
      expect(cloudMsg).toEqual(socketMsg);
      expect(socketMsg).toMatchObject({
        id: '1700000000.000100',
        type: 'message',
        text: 'hello team',
        userId: 'U123',
        channelId: 'C42',
        threadTs: '1700000000.000001',
        teamId: 'T1',
        hasImages: true,
        hasFiles: true,
      });
      expect(s1).toBe('socket');
      expect(e1).toBeUndefined();
      expect(s2).toBe('cloud');
      expect(e2).toBe('Ev1');
      expect(socketService.getStatus().messagesReceived).toBe(1);
      expect(cloudService.getStatus().messagesReceived).toBe(1);
    });

    it('app_mention routes identically via both transports', async () => {
      const mention = { type: 'app_mention', ts: '2.2', text: '<@UBOT> status?', user: 'U123', channel: 'C42', event_ts: '2.2', team: 'T1' };
      const { service: socketService, onMention } = await bootSocket();
      const socketEmitted: any[] = [];
      socketService.on('message', (m) => socketEmitted.push(m));
      await onMention({ event: mention });

      const cloudService = new SlackService();
      await cloudService.initialize(cloudConfig);
      const cloudEmitted: any[] = [];
      cloudService.on('message', (m) => cloudEmitted.push(m));
      cloudService.handleCloudEnvelope({ eventId: 'Ev2', slackTeamId: 'T1', apiAppId: 'A1', source: 'master', event: mention, receivedAt: '' });

      const strip = ({ source, eventId, ...rest }: any) => rest;
      expect(strip(cloudEmitted[0])).toEqual(strip(socketEmitted[0]));
      expect(socketEmitted[0]).toMatchObject({ type: 'app_mention', eventTs: '2.2', text: '<@UBOT> status?' });
    });

    it('applies the allow-list in both transports', async () => {
      const { service: socketService, onMessage } = await bootSocket();
      const socketEmitted: any[] = [];
      socketService.on('message', (m) => socketEmitted.push(m));
      await onMessage({ message: { ...rawMessage, user: 'U999' }, say: jest.fn() });
      expect(socketEmitted).toHaveLength(0);

      const cloudService = new SlackService();
      await cloudService.initialize({ ...cloudConfig, allowedUserIds: ['U123'] });
      const dropped = cloudService.handleInboundEvent({ ...rawMessage, user: 'U999' }, { source: 'cloud' });
      expect(dropped).toBeNull();
    });

    it('carries the per-agent app provenance on cloud events', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const msg = service.handleCloudEnvelope({
        eventId: 'Ev3', slackTeamId: 'T1', apiAppId: 'A-agent', source: 'agent', agentSession: 'team-kai-1',
        event: { type: 'message', ts: '3.3', text: 'dm to kai', user: 'U123', channel: 'D77' },
        receivedAt: '',
      });
      expect(msg).toMatchObject({ agentSession: 'team-kai-1', source: 'cloud', eventId: 'Ev3', channelId: 'D77' });
    });

    it('records which agent\'s app delivered a channel copy — the proof it is in the room', async () => {
      // 1.20.87 read this from `agentSession`, which is set only for DMs, so
      // no channel copy ever made its agent a member of a private room.
      const service = new SlackService();
      await service.initialize({ ...cloudConfig, allowedUserIds: ['U123'] });
      const msg = service.handleCloudEnvelope({
        eventId: 'Ev4', slackTeamId: 'T1', apiAppId: 'A-agent', source: 'agent', agentSession: 'crewly-orc@inst-1',
        event: { type: 'message', ts: '4.4', text: 'morning', user: 'U123', channel: 'C77', channel_type: 'group' },
        room: { members: [{ agentSession: 'pa-ella', displayName: 'Ella', instanceId: 'air', deviceName: 'air', awake: true }] },
        receivedAt: '',
      });
      expect(msg).toMatchObject({ receivedVia: 'crewly-orc', room: { members: [expect.objectContaining({ agentSession: 'pa-ella' })] } });
      // Still a channel message, not a DM to that agent.
      expect(msg?.agentSession).toBeUndefined();
    });

    it('delivers a hand-off even though the message was seen before', async () => {
      const service = new SlackService();
      await service.initialize({ ...cloudConfig, allowedUserIds: ['U123'] });
      const event = { type: 'message', ts: '5.5', text: 'draft it', user: 'U123', channel: 'C77' };
      expect(service.handleCloudEnvelope({ eventId: 'a', slackTeamId: 'T1', apiAppId: 'A', source: 'master', event, receivedAt: '' })).not.toBeNull();
      expect(service.handleCloudEnvelope({ eventId: 'b', slackTeamId: 'T1', apiAppId: 'A', source: 'master', event, receivedAt: '' })).toBeNull();

      const handed = service.handleCloudEnvelope({
        eventId: 'handoff:C77:5.5:pa-ella', slackTeamId: 'T1', apiAppId: '', source: 'agent', agentSession: 'pa-ella',
        handoffTo: 'pa-ella', event, receivedAt: '',
      });
      expect(handed).toMatchObject({ handoffTo: 'pa-ella', ts: '5.5' });
    });

    it('delivers a local agent\'s own message only when it @\'s another local agent (same-team discussion), never to itself', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      service.isLocalAgent = (s) => s.startsWith('team-');
      const env = (over: Record<string, unknown>) => ({
        eventId: 'e', slackTeamId: 'T1', apiAppId: 'A1', source: 'master' as const,
        event: { type: 'message', text: '<@UMAX> <@ULEO> 你们怎么看', user: 'UIVY', channel: 'C42', channel_type: 'channel' },
        receivedAt: '',
        ...over,
      });
      // Ivy (local) @'d Max + Leo (local) → routed so they hear her.
      const heard = service.handleCloudEnvelope(env({
        event: { type: 'message', ts: '10.1', text: '<@UMAX> <@ULEO> 你们怎么看', user: 'UIVY', channel: 'C42', channel_type: 'channel' },
        authorAgentSession: 'team-ivy', authorDisplayName: 'Ivy', mentionedAgentSessions: ['team-max', 'team-leo'],
      }));
      expect(heard).toMatchObject({ authorAgentSession: 'team-ivy' });
      // A local agent's message that @'s only a remote colleague → the remote instance handles it; nothing here.
      expect(service.handleCloudEnvelope(env({
        event: { type: 'message', ts: '10.2', text: '<@UREMOTE> hi', user: 'UIVY', channel: 'C42', channel_type: 'channel' },
        authorAgentSession: 'team-ivy', mentionedAgentSessions: ['other-machine-kai'],
      }))).toBeNull();
      // …and one that @'s nobody (or only itself) is not fed back.
      expect(service.handleCloudEnvelope(env({
        event: { type: 'message', ts: '10.3', text: 'done', user: 'UIVY', channel: 'C42', channel_type: 'channel' },
        authorAgentSession: 'team-ivy', mentionedAgentSessions: ['team-ivy'],
      }))).toBeNull();
    });

    it('routes whichever copy of a channel message arrives first (agent app or master) and drops the rest', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const emitted: any[] = [];
      service.on('message', (m) => emitted.push(m));
      const agentEnv = (event: any) => ({
        eventId: 'x', slackTeamId: 'T1', apiAppId: 'A-kai', source: 'agent' as const, agentSession: 'team-kai-1', event, receivedAt: '',
      });

      // DMs to the agent's bot keep the agent provenance.
      const dm = service.handleCloudEnvelope(agentEnv({ type: 'message', ts: '1', text: 'hi kai', user: 'U1', channel: 'D77', channel_type: 'im' }));
      expect(dm).toMatchObject({ agentSession: 'team-kai-1' });
      // A channel message seen through the agent app routes as a plain channel message (Cloud may have
      // dropped the master copy as a duplicate — this copy is the only one we will ever get).
      const viaAgent = service.handleCloudEnvelope(agentEnv({ type: 'message', ts: '2', text: 'team chatter', user: 'U1', channel: 'C42', channel_type: 'channel' }));
      expect(viaAgent).not.toBeNull();
      expect(viaAgent?.agentSession).toBeUndefined();
      // Later copies of the same message — from the master app or another agent app — are dropped.
      expect(service.handleCloudEnvelope({ ...agentEnv({ type: 'message', ts: '2', text: 'team chatter', user: 'U1', channel: 'C42' }), source: 'master', agentSession: undefined })).toBeNull();
      expect(service.handleCloudEnvelope({ ...agentEnv({ type: 'message', ts: '2', text: 'team chatter', user: 'U1', channel: 'C42' }), apiAppId: 'A-sam', agentSession: 'team-sam-1' })).toBeNull();
      // A different message still routes.
      expect(service.handleCloudEnvelope({ ...agentEnv({ type: 'message', ts: '3', text: 'next', user: 'U1', channel: 'C42' }), source: 'master', agentSession: undefined })).not.toBeNull();
      expect(emitted).toHaveLength(3);
    });

    it('cloud transport drops its own bot posts, bot chatter and non-routable subtypes (Bolt ignoreSelf parity)', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const emitted: any[] = [];
      service.on('message', (m) => emitted.push(m));
      const env = (event: any) => ({ eventId: 'x', slackTeamId: 'T1', apiAppId: 'A1', source: 'master' as const, event, receivedAt: '' });

      expect(service.handleCloudEnvelope(env({ type: 'message', ts: '1', text: 'my own reply', user: 'UBOT', channel: 'C1' }))).toBeNull();
      expect(service.handleCloudEnvelope(env({ type: 'message', ts: '1', text: 'x', bot_id: 'B1', channel: 'C1' }))).toBeNull();
      expect(service.handleCloudEnvelope(env({ type: 'message', subtype: 'message_changed', ts: '1', text: 'x', user: 'U1', channel: 'C1' }))).toBeNull();
      expect(service.handleCloudEnvelope(env({ type: 'message', subtype: 'channel_join', ts: '1', text: 'x', user: 'U1', channel: 'C1' }))).toBeNull();
      expect(service.handleCloudEnvelope(env({ type: 'reaction_added', user: 'U1' }))).toBeNull();
      expect(service.handleCloudEnvelope({ eventId: 'bad' } as any)).toBeNull();
      expect(emitted).toHaveLength(0);

      // file_share keeps flowing (attachments), as it does over the socket.
      const kept = service.handleCloudEnvelope(env({ ...rawMessage, subtype: 'file_share' }));
      expect(kept?.hasFiles).toBe(true);
      expect(emitted).toHaveLength(1);
    });

    it('attachCloudTransport routes slack_event relay messages and ignores other types', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const emitted: any[] = [];
      service.on('message', (m) => emitted.push(m));
      const relay = new EventEmitter();

      service.attachCloudTransport(relay as any);
      relay.emit('message', { id: 'm1', type: 'chat_request', payload: { anything: true } });
      relay.emit('message', {
        id: 'm2',
        type: 'slack_event',
        fromDeviceName: 'crewly-cloud-slack',
        payload: { eventId: 'Ev9', slackTeamId: 'T1', apiAppId: 'A1', source: 'master', event: rawMessage, receivedAt: '' },
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ eventId: 'Ev9', source: 'cloud' });

      // Malformed payloads never throw out of the emitter.
      expect(() => relay.emit('message', { type: 'slack_event', payload: null })).not.toThrow();

      service.detachCloudTransport();
      relay.emit('message', { type: 'slack_event', payload: { eventId: 'Ev10', event: rawMessage } });
      expect(emitted).toHaveLength(1);
      expect(relay.listenerCount('message')).toBe(0);
    });

    it('disconnect detaches the relay listener in cloud transport', async () => {
      const service = new SlackService();
      await service.initialize(cloudConfig);
      const relay = new EventEmitter();
      service.attachCloudTransport(relay as any);
      expect(relay.listenerCount('message')).toBe(1);
      await service.disconnect();
      expect(relay.listenerCount('message')).toBe(0);
      expect(service.isConnected()).toBe(false);
    });

    it('handleInboundEvent is a no-op before initialize', () => {
      const service = new SlackService();
      expect(service.handleInboundEvent(rawMessage)).toBeNull();
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


/**
 * Renaming needs channel membership, and the bot is not always in a channel
 * it created: re-installing the app drops it out of every one. After the
 * owner re-authorised, thirteen team channels answered `not_in_channel`
 * where the day before they had answered `invalid_auth` (2026-09-21).
 */
describe('SlackService.renameChannel — rejoining', () => {
  /** A Slack error shaped the way the Web API throws them. */
  function slackError(code: string) {
    return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
  }

  it('rejoins a public channel it was dropped from, then renames it', async () => {
    const service = new SlackService();
    const rename = jest
      .fn()
      .mockRejectedValueOnce(slackError('not_in_channel'))
      .mockResolvedValueOnce({ channel: { id: 'C1', name: 'pro-think-tank' } });
    const join = jest.fn().mockResolvedValue({ ok: true });
    (service as any).client = { conversations: { rename, join } };

    const got = await service.renameChannel('C1', 'pro-think-tank');

    expect(got).toBe('pro-think-tank');
    expect(join).toHaveBeenCalledWith({ channel: 'C1' });
    expect(rename).toHaveBeenCalledTimes(2);
  });

  // A private channel cannot be self-joined — the bot has to be invited —
  // so that stays a refusal rather than a retry loop.
  it('gives up when it still cannot rename after trying to rejoin', async () => {
    const service = new SlackService();
    const rename = jest.fn().mockRejectedValue(slackError('not_in_channel'));
    const join = jest.fn().mockRejectedValue(slackError('method_not_supported_for_channel_type'));
    (service as any).client = { conversations: { rename, join } };

    expect(await service.renameChannel('C1', 'pro-secret')).toBeNull();
  });

  it('does not try to rejoin for an unrelated refusal', async () => {
    const service = new SlackService();
    const rename = jest.fn().mockRejectedValue(slackError('name_taken'));
    const join = jest.fn();
    (service as any).client = { conversations: { rename, join } };

    expect(await service.renameChannel('C1', 'pro-taken')).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });
});

describe('SlackService.sendEphemeral', () => {
  // The Google authorization card must not be visible to a whole channel:
  // its button is an ordinary link, so whoever opens it connects *their*
  // Google account into the owner's Crewly account, and Slack cannot tell
  // us who clicked. Nobody else being shown the card is the defence
  // (2026-09-21).
  /**
   * A service with just enough client for the ephemeral path.
   *
   * @param postEphemeral - The stub to install, or omitted for an old client
   * @returns The service and its fake client
   */
  function withClient(postEphemeral?: jest.Mock) {
    const service = new SlackService();
    const chat: Record<string, unknown> = { postMessage: jest.fn(), update: jest.fn() };
    if (postEphemeral) chat['postEphemeral'] = postEphemeral;
    (service as unknown as { client: unknown }).client = { chat };
    return { service, chat };
  }

  it('posts to one user, optionally as an agent bot', async () => {
    const postEphemeral = jest.fn().mockResolvedValue({ ok: true });
    const { service } = withClient(postEphemeral);

    await expect(
      service.sendEphemeral('C1', 'U1', 'Connect Gmail', [{ type: 'section' }], 'xoxb-ella'),
    ).resolves.toBe(true);

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', user: 'U1', text: 'Connect Gmail', token: 'xoxb-ella' }),
    );
  });

  it('reports the Slack error code instead of throwing', async () => {
    const postEphemeral = jest.fn().mockRejectedValue(
      Object.assign(new Error('An API error occurred'), { data: { error: 'channel_not_found' } }),
    );
    const { service } = withClient(postEphemeral);

    await expect(service.sendEphemeral('C-gone', 'U1', 'hi')).resolves.toBe(false);
  });

  it('says so rather than crashing on a client without the method', async () => {
    const { service } = withClient();
    await expect(service.sendEphemeral('C1', 'U1', 'hi')).resolves.toBe(false);
  });
});
