/**
 * GoogleChatMessengerAdapter Tests
 *
 * Tests for the Google Chat messenger adapter including initialization,
 * message sending, Pub/Sub pull loop, thread tracking, status reporting,
 * and disconnect behaviour.
 *
 * @module google-chat-messenger-adapter.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { GoogleChatMessengerAdapter } from './google-chat-messenger.adapter.js';

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

/** Valid service account key for tests */
const VALID_SA_KEY = JSON.stringify({
  client_email: 'bot@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
});

describe('GoogleChatMessengerAdapter', () => {
  let adapter: GoogleChatMessengerAdapter;

  beforeEach(() => {
    adapter = new GoogleChatMessengerAdapter();
    mockFetch.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should have platform set to google-chat', () => {
    expect(adapter.platform).toBe('google-chat');
  });

  // ===========================================================================
  // initialize
  // ===========================================================================

  describe('initialize', () => {
    it('should throw when neither webhookUrl nor serviceAccountKey is provided', async () => {
      await expect(adapter.initialize({})).rejects.toThrow(
        'Google Chat requires either a webhookUrl, serviceAccountKey, or authMode: adc'
      );
    });

    it('should throw when webhookUrl has invalid domain', async () => {
      await expect(
        adapter.initialize({ webhookUrl: 'https://example.com/webhook' })
      ).rejects.toThrow('Invalid Google Chat webhook URL');
    });

    it('should initialize with valid webhook URL', async () => {
      await adapter.initialize({
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=xxx&token=yyy',
      });
      expect(adapter.getStatus().connected).toBe(true);
      expect(adapter.getStatus().details?.mode).toBe('webhook');
    });

    it('should throw when serviceAccountKey is not valid JSON', async () => {
      await expect(
        adapter.initialize({ serviceAccountKey: 'not-json' })
      ).rejects.toThrow('Service account key must be valid JSON');
    });

    it('should throw when serviceAccountKey is missing required fields', async () => {
      await expect(
        adapter.initialize({ serviceAccountKey: JSON.stringify({ foo: 'bar' }) })
      ).rejects.toThrow('Service account key must contain client_email and private_key');
    });

    it('should initialize with valid service account key (service-account mode)', async () => {
      await adapter.initialize({ serviceAccountKey: VALID_SA_KEY });
      expect(adapter.getStatus().connected).toBe(true);
      expect(adapter.getStatus().details?.mode).toBe('service-account');
    });

    it('should initialize in pubsub mode with projectId + subscriptionName + serviceAccountKey', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-events-sub',
      });
      const status = adapter.getStatus();
      expect(status.connected).toBe(true);
      expect(status.details?.mode).toBe('pubsub');
      expect(status.details?.subscriptionName).toBe('projects/my-project/subscriptions/chat-events-sub');
      expect(status.details?.projectId).toBe('my-project');
      expect(status.details?.pullActive).toBe(true);
      expect(status.details?.pullPaused).toBe(false);
    });

    it('should fall back to service-account mode if projectId is missing', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        subscriptionName: 'chat-events-sub',
      });
      expect(adapter.getStatus().details?.mode).toBe('service-account');
    });

    it('should fall back to service-account mode if subscriptionName is missing', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
      });
      expect(adapter.getStatus().details?.mode).toBe('service-account');
    });
  });

  // ===========================================================================
  // ADC (Application Default Credentials) mode
  // ===========================================================================

  describe('initialize (ADC mode)', () => {
    const VALID_ADC = JSON.stringify({
      client_id: '123.apps.googleusercontent.com',
      client_secret: 'secret',
      refresh_token: 'refresh-tok',
      type: 'authorized_user',
    });

    it('should initialize in service-account mode with ADC auth', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({ authMode: 'adc' });
      const status = adapter.getStatus();
      expect(status.connected).toBe(true);
      expect(status.details?.mode).toBe('service-account');
      expect(status.details?.authMode).toBe('adc');
    });

    it('should initialize in pubsub mode with ADC auth', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      const status = adapter.getStatus();
      expect(status.connected).toBe(true);
      expect(status.details?.mode).toBe('pubsub');
      expect(status.details?.authMode).toBe('adc');
      expect(status.details?.projectId).toBe('my-project');
    });

    it('should throw when ADC file is not found', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockRejectedValue(
        new Error('ADC credentials file not found')
      );

      await expect(adapter.initialize({ authMode: 'adc' })).rejects.toThrow(
        'ADC credentials file not found'
      );
    });

    it('should send message via API in ADC mode', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({ authMode: 'adc' });

      // Mock token refresh via ADC
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('adc-test-token');
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.sendMessage('spaces/AAAA', 'hello from ADC');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('chat.googleapis.com/v1/spaces/AAAA/messages');
      expect(options?.headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer adc-test-token',
      }));
    });

    it('should include x-goog-user-project header in ADC pubsub mode', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({
        authMode: 'adc',
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });

      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('adc-pubsub-token');
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.sendMessage('spaces/AAAA', 'hello with quota project');

      const [, options] = mockFetch.mock.calls[0];
      const headers = options?.headers as Record<string, string>;
      expect(headers['x-goog-user-project']).toBe('my-project');
      expect(headers['Authorization']).toBe('Bearer adc-pubsub-token');
    });

    it('should NOT include x-goog-user-project header in service account mode', async () => {
      await adapter.initialize({ serviceAccountKey: VALID_SA_KEY });
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('sa-token');
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.sendMessage('spaces/AAAA', 'hello');

      const [, options] = mockFetch.mock.calls[0];
      const headers = options?.headers as Record<string, string>;
      expect(headers['x-goog-user-project']).toBeUndefined();
    });

    it('should refresh token via ADC refresh_token flow', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({ authMode: 'adc' });
      mockFetch.mockReset();

      // Mock token endpoint response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-adc-token', expires_in: 3600 }),
      } as Response);

      const token = await adapter.getAccessToken();
      expect(token).toBe('new-adc-token');

      // Verify it called the token endpoint with refresh_token grant
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = options?.body as string;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('client_id=123.apps.googleusercontent.com');
      expect(body).toContain('refresh_token=refresh-tok');
    });

    it('should throw when ADC token refresh fails', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({ authMode: 'adc' });
      mockFetch.mockReset();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Token has been revoked',
      } as Response);

      await expect(adapter.getAccessToken()).rejects.toThrow(
        'ADC token refresh failed (401): Token has been revoked'
      );
    });

    it('should cache ADC token and reuse on subsequent calls', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({ authMode: 'adc' });
      mockFetch.mockReset();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'cached-token', expires_in: 3600 }),
      } as Response);

      const token1 = await adapter.getAccessToken();
      const token2 = await adapter.getAccessToken();

      expect(token1).toBe('cached-token');
      expect(token2).toBe('cached-token');
      // Only 1 fetch — second call uses cache
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should reset ADC state on disconnect', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });
      await adapter.initialize({ authMode: 'adc' });
      expect(adapter.getStatus().connected).toBe(true);

      await adapter.disconnect();
      expect(adapter.getStatus().connected).toBe(false);
      expect(adapter.getStatus().details?.authMode).toBe('service_account');
    });

    it('should store serviceAccountEmail and show it in status', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        serviceAccountEmail: 'chatbot@proj.iam.gserviceaccount.com',
      });

      const status = adapter.getStatus();
      expect(status.details?.serviceAccountEmail).toBe('chatbot@proj.iam.gserviceaccount.com');
    });

    it('should NOT show serviceAccountEmail in status when not set', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({ authMode: 'adc' });

      const status = adapter.getStatus();
      expect(status.details?.serviceAccountEmail).toBeUndefined();
    });

    it('should impersonate SA when serviceAccountEmail is set', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
        serviceAccountEmail: 'chatbot@proj.iam.gserviceaccount.com',
      });
      mockFetch.mockReset();

      // First call: ADC token refresh
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'user-adc-token', expires_in: 3600 }),
      } as Response);

      // Second call: SA impersonation via IAM Credentials API
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'impersonated-sa-token',
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        }),
      } as Response);

      const token = await adapter.getAccessToken();
      expect(token).toBe('impersonated-sa-token');

      // Verify impersonation call
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [impUrl, impOptions] = mockFetch.mock.calls[1];
      expect(String(impUrl)).toContain('iamcredentials.googleapis.com');
      expect(String(impUrl)).toContain('chatbot@proj.iam.gserviceaccount.com');

      const impHeaders = impOptions?.headers as Record<string, string>;
      expect(impHeaders['Authorization']).toBe('Bearer user-adc-token');
      expect(impHeaders['x-goog-user-project']).toBe('my-project');

      const impBody = JSON.parse(impOptions?.body as string);
      expect(impBody.scope).toContain('https://www.googleapis.com/auth/chat.bot');
      expect(impBody.lifetime).toBe('3600s');
    });

    it('should cache impersonated SA token', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        serviceAccountEmail: 'chatbot@proj.iam.gserviceaccount.com',
      });
      mockFetch.mockReset();

      // ADC refresh + SA impersonation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'user-token', expires_in: 3600 }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'cached-sa-token',
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        }),
      } as Response);

      const token1 = await adapter.getAccessToken();
      const token2 = await adapter.getAccessToken();

      expect(token1).toBe('cached-sa-token');
      expect(token2).toBe('cached-sa-token');
      // Only 2 fetches for first call; second call uses cached SA token + cached ADC token
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw when SA impersonation fails', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        serviceAccountEmail: 'chatbot@proj.iam.gserviceaccount.com',
      });
      mockFetch.mockReset();

      // ADC refresh succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'user-token', expires_in: 3600 }),
      } as Response);

      // SA impersonation fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Permission denied on resource',
      } as Response);

      await expect(adapter.getAccessToken()).rejects.toThrow(
        'SA impersonation failed (403): Permission denied on resource'
      );
    });

    it('should fall back to direct ADC token when serviceAccountEmail is not set', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({ authMode: 'adc' });
      mockFetch.mockReset();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'direct-adc-token', expires_in: 3600 }),
      } as Response);

      const token = await adapter.getAccessToken();
      expect(token).toBe('direct-adc-token');
      // Only 1 fetch — no impersonation call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should clear serviceAccountEmail on disconnect', async () => {
      jest.spyOn(adapter, 'loadAdcCredentials').mockResolvedValue({
        client_id: '123.apps.googleusercontent.com',
        client_secret: 'secret',
        refresh_token: 'refresh-tok',
        type: 'authorized_user',
      });

      await adapter.initialize({
        authMode: 'adc',
        serviceAccountEmail: 'chatbot@proj.iam.gserviceaccount.com',
      });
      expect(adapter.getStatus().details?.serviceAccountEmail).toBe('chatbot@proj.iam.gserviceaccount.com');

      await adapter.disconnect();
      expect(adapter.getStatus().details?.serviceAccountEmail).toBeUndefined();
    });
  });

  // ===========================================================================
  // sendMessage (webhook mode)
  // ===========================================================================

  describe('sendMessage (webhook mode)', () => {
    beforeEach(async () => {
      await adapter.initialize({
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=xxx',
      });
    });

    it('should send message via webhook', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await adapter.sendMessage('ignored-in-webhook-mode', 'hello');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('chat.googleapis.com');
      const body = JSON.parse(options?.body as string);
      expect(body.text).toBe('hello');
    });

    it('should throw when webhook send fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      } as Response);

      await expect(adapter.sendMessage('ch', 'msg')).rejects.toThrow(
        'Google Chat webhook send failed (403): Forbidden'
      );
    });

    it('should include thread info when threadId is provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await adapter.sendMessage('ch', 'reply', { threadId: 'thread-123' });

      const [url, options] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('messageReplyOption');
      const body = JSON.parse(options?.body as string);
      expect(body.thread.threadKey).toBe('thread-123');
    });
  });

  // ===========================================================================
  // sendMessage (service-account / pubsub mode)
  // ===========================================================================

  describe('sendMessage (service-account mode)', () => {
    beforeEach(async () => {
      await adapter.initialize({ serviceAccountKey: VALID_SA_KEY });
      // Mock getAccessToken to skip real JWT signing
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('test-token');
      mockFetch.mockReset();
    });

    it('should throw for invalid space name', async () => {
      await expect(adapter.sendMessage('invalid', 'hello')).rejects.toThrow(
        'Invalid Google Chat space name'
      );
    });

    it('should send message via API', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await adapter.sendMessage('spaces/AAAA', 'hello');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('chat.googleapis.com/v1/spaces/AAAA/messages');
      const body = JSON.parse(options?.body as string);
      expect(body.text).toBe('hello');
    });

    it('should include thread name and messageReplyOption when threadId is provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await adapter.sendMessage('spaces/AAAA', 'reply', { threadId: 'spaces/AAAA/threads/BBB' });

      const [url, options] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
      const body = JSON.parse(options?.body as string);
      expect(body.thread.name).toBe('spaces/AAAA/threads/BBB');
    });
  });

  // ===========================================================================
  // sendMessage (not initialized)
  // ===========================================================================

  describe('sendMessage (not initialized)', () => {
    it('should throw when not initialized', async () => {
      await expect(adapter.sendMessage('ch', 'hi')).rejects.toThrow(
        'Google Chat adapter is not initialized'
      );
    });
  });

  // ===========================================================================
  // Pub/Sub pull
  // ===========================================================================

  describe('pullMessages', () => {
    const mockCallback = jest.fn();

    beforeEach(async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
        onIncomingMessage: mockCallback,
      });
      // Mock getAccessToken to skip real JWT signing with dummy key
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('test-token');
      mockCallback.mockReset();
      mockFetch.mockReset();
    });

    it('should include returnImmediately in pull request body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      await adapter.pullMessages();

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);
      expect(body.returnImmediately).toBe(true);
      expect(body.maxMessages).toBe(10);
    });

    it('should pull and process MESSAGE events', async () => {
      const chatEvent = {
        type: 'MESSAGE',
        eventTime: '2026-03-11T10:00:00Z',
        space: { name: 'spaces/AAAA', displayName: 'General' },
        message: {
          name: 'spaces/AAAA/messages/123',
          text: 'Hello from Google Chat',
          thread: { name: 'spaces/AAAA/threads/THREAD1' },
          sender: { name: 'users/12345', displayName: 'Alice' },
          createTime: '2026-03-11T10:00:00Z',
        },
      };

      // Pull response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          receivedMessages: [{
            ackId: 'ack-1',
            message: {
              data: Buffer.from(JSON.stringify(chatEvent)).toString('base64'),
              messageId: 'msg-1',
            },
          }],
        }),
      } as Response);
      // Acknowledge
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.pullMessages();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      const msg = mockCallback.mock.calls[0][0] as Record<string, unknown>;
      expect(msg.platform).toBe('google-chat');
      expect(msg.conversationId).toBe('spaces/AAAA');
      expect(msg.channelId).toBe('spaces/AAAA');
      expect(msg.text).toBe('Hello from Google Chat');
      expect(msg.threadId).toBe('spaces/AAAA/threads/THREAD1');
      expect(msg.userId).toBe('Alice');
    });

    it('should pull and process v2 format MESSAGE events', async () => {
      const v2ChatEvent = {
        commonEventObject: {
          userLocale: 'en',
          hostApp: 'CHAT',
          platform: 'WEB',
          timeZone: { id: 'America/New_York', offset: -14400000 },
        },
        chat: {
          messagePayload: {
            message: {
              name: 'spaces/BBBB/messages/456',
              text: 'Hello from v2 format',
              thread: { name: 'spaces/BBBB/threads/THREAD2' },
              sender: { name: 'users/67890', displayName: 'Bob' },
              createTime: '2026-03-11T12:00:00Z',
            },
            space: { name: 'spaces/BBBB', displayName: 'Engineering' },
          },
        },
      };

      // Pull response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          receivedMessages: [{
            ackId: 'ack-v2',
            message: {
              data: Buffer.from(JSON.stringify(v2ChatEvent)).toString('base64'),
              messageId: 'msg-v2',
            },
          }],
        }),
      } as Response);
      // Acknowledge
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.pullMessages();

      expect(mockCallback).toHaveBeenCalledTimes(1);
      const msg = mockCallback.mock.calls[0][0] as Record<string, unknown>;
      expect(msg.platform).toBe('google-chat');
      expect(msg.conversationId).toBe('spaces/BBBB');
      expect(msg.channelId).toBe('spaces/BBBB');
      expect(msg.text).toBe('Hello from v2 format');
      expect(msg.threadId).toBe('spaces/BBBB/threads/THREAD2');
      expect(msg.userId).toBe('Bob');
    });

    it('should skip v2 events without messagePayload text', async () => {
      const v2NonMessageEvent = {
        commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
        chat: {
          // No messagePayload — e.g. ADDED_TO_SPACE in v2
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          receivedMessages: [{
            ackId: 'ack-v2-skip',
            message: {
              data: Buffer.from(JSON.stringify(v2NonMessageEvent)).toString('base64'),
              messageId: 'msg-v2-skip',
            },
          }],
        }),
      } as Response);
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.pullMessages();

      expect(mockCallback).not.toHaveBeenCalled();
      // Should still acknowledge
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should skip non-MESSAGE events but still acknowledge them', async () => {
      const addedToSpaceEvent = {
        type: 'ADDED_TO_SPACE',
        space: { name: 'spaces/AAAA' },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          receivedMessages: [{
            ackId: 'ack-2',
            message: {
              data: Buffer.from(JSON.stringify(addedToSpaceEvent)).toString('base64'),
            },
          }],
        }),
      } as Response);
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      await adapter.pullMessages();

      // Callback should NOT be invoked for ADDED_TO_SPACE
      expect(mockCallback).not.toHaveBeenCalled();

      // Acknowledge should still be called
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [ackUrl, ackOptions] = mockFetch.mock.calls[1];
      expect(String(ackUrl)).toContain(':acknowledge');
      const ackBody = JSON.parse(ackOptions?.body as string);
      expect(ackBody.ackIds).toEqual(['ack-2']);
    });

    it('should handle empty pull response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response);

      await adapter.pullMessages();

      expect(mockCallback).not.toHaveBeenCalled();
      // Only 1 call: pull (no ack needed)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle malformed message data gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          receivedMessages: [{
            ackId: 'ack-bad',
            message: { data: Buffer.from('not-valid-json').toString('base64') },
          }],
        }),
      } as Response);
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      // Should not throw
      await adapter.pullMessages();
      expect(mockCallback).not.toHaveBeenCalled();
      // Should still acknowledge
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw when pull API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Permission denied',
      } as Response);

      await expect(adapter.pullMessages()).rejects.toThrow(
        'Pub/Sub pull failed (403): Permission denied'
      );
    });
  });

  // ===========================================================================
  // Pull loop pause/resume on consecutive failures
  // ===========================================================================

  describe('pull loop failure handling', () => {
    it('should NOT increment consecutiveFailures on timeout (AbortError)', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('test-token');
      mockFetch.mockReset();

      // Simulate AbortSignal.timeout() throwing DOMException with name "TimeoutError"
      const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      for (let i = 0; i < 6; i++) {
        mockFetch.mockRejectedValueOnce(timeoutError);
      }

      // Advance timers to trigger 6 pull intervals
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      // Should NOT be paused — timeouts are not real failures
      const status = adapter.getStatus();
      expect(status.details?.pullPaused).toBe(false);
      expect(status.details?.consecutiveFailures).toBe(0);
    });

    it('should NOT increment consecutiveFailures on AbortError', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('test-token');
      mockFetch.mockReset();

      const abortError = new DOMException('The operation was aborted', 'AbortError');
      for (let i = 0; i < 6; i++) {
        mockFetch.mockRejectedValueOnce(abortError);
      }

      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      const status = adapter.getStatus();
      expect(status.details?.pullPaused).toBe(false);
      expect(status.details?.consecutiveFailures).toBe(0);
    });

    it('should pause pull after max consecutive failures', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      // Mock getAccessToken to return a valid token
      jest.spyOn(adapter, 'getAccessToken').mockResolvedValue('test-token');
      mockFetch.mockReset();

      // Each pull will fail with a server error
      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Server error',
        } as Response);
      }

      // Advance timers to trigger pull intervals
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(5_000);
        // Allow async pull to complete
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      const status = adapter.getStatus();
      expect(status.details?.pullPaused).toBe(true);
    });
  });

  // ===========================================================================
  // getStatus
  // ===========================================================================

  describe('getStatus', () => {
    it('should report not connected before init', () => {
      expect(adapter.getStatus()).toEqual({
        connected: false,
        platform: 'google-chat',
        details: { mode: 'none', authMode: 'service_account' },
      });
    });

    it('should report webhook mode after webhook init', async () => {
      await adapter.initialize({
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=xxx',
      });
      expect(adapter.getStatus().details?.mode).toBe('webhook');
    });

    it('should report pubsub mode with subscription details', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      const status = adapter.getStatus();
      expect(status.details?.mode).toBe('pubsub');
      expect(status.details?.subscriptionName).toBe('projects/my-project/subscriptions/chat-sub');
    });
  });

  // ===========================================================================
  // disconnect
  // ===========================================================================

  describe('disconnect', () => {
    it('should clear credentials', async () => {
      await adapter.initialize({
        webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=xxx',
      });
      expect(adapter.getStatus().connected).toBe(true);

      await adapter.disconnect();
      expect(adapter.getStatus().connected).toBe(false);
    });

    it('should stop the pull loop on disconnect', async () => {
      await adapter.initialize({
        serviceAccountKey: VALID_SA_KEY,
        projectId: 'my-project',
        subscriptionName: 'chat-sub',
      });
      expect(adapter.getStatus().details?.pullActive).toBe(true);

      await adapter.disconnect();
      expect(adapter.getStatus().connected).toBe(false);
      expect(adapter.getStatus().details?.mode).toBe('none');
    });
  });

  // ===========================================================================
  // splitMessage
  // ===========================================================================

  describe('splitMessage', () => {
    it('should return single-element array for short messages', () => {
      const result = GoogleChatMessengerAdapter.splitMessage('Hello', 4000);
      expect(result).toEqual(['Hello']);
    });

    it('should split on double-newline boundaries', () => {
      const paragraph1 = 'A'.repeat(2000);
      const paragraph2 = 'B'.repeat(2000);
      const text = `${paragraph1}\n\n${paragraph2}`;
      const result = GoogleChatMessengerAdapter.splitMessage(text, 3000);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(paragraph1);
      expect(result[1]).toBe(paragraph2);
    });

    it('should fall back to single-newline split when no double-newline fits', () => {
      const line1 = 'A'.repeat(2000);
      const line2 = 'B'.repeat(2000);
      const text = `${line1}\n${line2}`;
      const result = GoogleChatMessengerAdapter.splitMessage(text, 3000);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(line1);
      expect(result[1]).toBe(line2);
    });

    it('should hard-cut when no newline is found within limit', () => {
      const text = 'X'.repeat(8000);
      const result = GoogleChatMessengerAdapter.splitMessage(text, 3000);
      expect(result.length).toBeGreaterThanOrEqual(3);
      result.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(3000);
      });
      expect(result.join('')).toBe(text);
    });

    it('should handle exact boundary length', () => {
      const text = 'A'.repeat(4000);
      const result = GoogleChatMessengerAdapter.splitMessage(text, 4000);
      expect(result).toEqual([text]);
    });

    it('should strip leading newlines from subsequent chunks', () => {
      const part1 = 'A'.repeat(100);
      const part2 = 'B'.repeat(100);
      const text = `${part1}\n\n\n\n${part2}`;
      const result = GoogleChatMessengerAdapter.splitMessage(text, 150);
      expect(result[1]).toBe(part2);
      expect(result[1].startsWith('\n')).toBe(false);
    });

    it('should produce chunks that together contain all original content', () => {
      const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${'W'.repeat(500)}`);
      const text = paragraphs.join('\n\n');
      const result = GoogleChatMessengerAdapter.splitMessage(text, 2000);
      expect(result.length).toBeGreaterThan(1);
      // All content should be present (newline separators may be stripped)
      const joined = result.join('\n\n');
      for (const p of paragraphs) {
        expect(joined).toContain(p);
      }
    });
  });

  // ===========================================================================
  // sendMessage deduplication
  // ===========================================================================

  describe('sendMessage deduplication', () => {
    it('should skip duplicate sends within dedup window', async () => {
      // Initialize in webhook mode for simplicity
      await adapter.initialize({ webhookUrl: 'https://chat.googleapis.com/webhook' });
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      // First send — should go through
      await adapter.sendMessage('spaces/AAA', 'Hello', { threadId: 'spaces/AAA/threads/BBB' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second send with same params within window — should be skipped
      await adapter.sendMessage('spaces/AAA', 'Hello', { threadId: 'spaces/AAA/threads/BBB' });
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2

      // Different message content — should go through
      await adapter.sendMessage('spaces/AAA', 'Different message', { threadId: 'spaces/AAA/threads/BBB' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should allow same message after dedup window expires', async () => {
      await adapter.initialize({ webhookUrl: 'https://chat.googleapis.com/webhook' });
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await adapter.sendMessage('spaces/AAA', 'Hello');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past dedup window (10s)
      jest.advanceTimersByTime(11_000);

      await adapter.sendMessage('spaces/AAA', 'Hello');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // getAccessToken
  // ===========================================================================

  describe('getAccessToken', () => {
    it('should throw when service account key is not set', async () => {
      await expect(adapter.getAccessToken()).rejects.toThrow(
        'Service account key not configured'
      );
    });
  });
});
