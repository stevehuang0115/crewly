/**
 * Google Chat Initializer Tests
 *
 * Tests for automatic Google Chat reconnection on backend startup.
 * Covers credential loading, incoming message callback creation,
 * and the main initialization flow with various saved configs.
 *
 * @module google-chat-initializer.test
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import path from 'path';
import os from 'os';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockReadFile = jest.fn<any>();

jest.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
  },
}));

// Mock MessengerRegistryService
const mockRegistryGet = jest.fn<any>();
const mockRegistryRegister = jest.fn<any>();
jest.mock('./messenger-registry.service.js', () => ({
  MessengerRegistryService: {
    getInstance: () => ({
      get: mockRegistryGet,
      register: mockRegistryRegister,
    }),
  },
}));

// Mock GoogleChatMessengerAdapter
const mockAdapterInitialize = jest.fn<any>();
const mockAdapterGetStatus = jest.fn<any>().mockReturnValue({
  details: { mode: 'pubsub', authMode: 'service_account', pullActive: true },
});
const mockAdapterSendMessage = jest.fn<any>();
const mockAdapterAddReaction = jest.fn<any>().mockResolvedValue(undefined);

jest.mock('./adapters/google-chat-messenger.adapter.js', () => ({
  GoogleChatMessengerAdapter: jest.fn().mockImplementation(() => ({
    initialize: mockAdapterInitialize,
    getStatus: mockAdapterGetStatus,
    sendMessage: mockAdapterSendMessage,
    addReaction: mockAdapterAddReaction,
  })),
}));

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
      }),
    }),
  },
}));

// Mock formatError
jest.mock('../../utils/format-error.js', () => ({
  formatError: (e: any) => String(e),
}));

import { initializeGoogleChatIfConfigured } from './google-chat-initializer.js';
import { GoogleChatMessengerAdapter } from './adapters/google-chat-messenger.adapter.js';
import { CREWLY_CONSTANTS, MESSAGE_SOURCES } from '../../constants.js';

describe('GoogleChatInitializer', () => {
  const credPath = path.join(
    os.homedir(),
    CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
    'google-chat-credentials.json',
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegistryGet.mockReturnValue(undefined);
    mockAdapterInitialize.mockResolvedValue(undefined);
  });

  // =========================================================================
  // loadSavedCredentials (tested through initializeGoogleChatIfConfigured)
  // =========================================================================

  describe('when no saved credentials exist', () => {
    it('should return attempted:false when credential file is missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({ attempted: false, success: false });
      expect(mockReadFile).toHaveBeenCalledWith(credPath, 'utf-8');
      expect(mockAdapterInitialize).not.toHaveBeenCalled();
    });

    it('should return attempted:false when credential file contains invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not-json');

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({ attempted: false, success: false });
    });

    it('should return attempted:false when credential file contains null', async () => {
      mockReadFile.mockResolvedValue('null');

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({ attempted: false, success: false });
    });

    it('should return attempted:false when credential file contains a non-object', async () => {
      mockReadFile.mockResolvedValue('"just a string"');

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({ attempted: false, success: false });
    });
  });

  // =========================================================================
  // Successful initialization
  // =========================================================================

  describe('when saved credentials exist', () => {
    const savedConfig = {
      webhookUrl: 'https://chat.googleapis.com/v1/spaces/xxx/messages?key=abc',
    };

    beforeEach(() => {
      mockReadFile.mockResolvedValue(JSON.stringify(savedConfig));
    });

    it('should initialize adapter with saved webhook config', async () => {
      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({ attempted: true, success: true });
      expect(mockAdapterInitialize).toHaveBeenCalledWith(
        expect.objectContaining({ webhookUrl: savedConfig.webhookUrl }),
      );
    });

    it('should create and register a new adapter when none exists in registry', async () => {
      mockRegistryGet.mockReturnValue(undefined);

      await initializeGoogleChatIfConfigured();

      expect(GoogleChatMessengerAdapter).toHaveBeenCalled();
      expect(mockRegistryRegister).toHaveBeenCalled();
    });

    it('should reuse existing adapter from registry', async () => {
      const existingAdapter = {
        initialize: mockAdapterInitialize,
        getStatus: mockAdapterGetStatus,
      };
      mockRegistryGet.mockReturnValue(existingAdapter);

      await initializeGoogleChatIfConfigured();

      expect(GoogleChatMessengerAdapter).not.toHaveBeenCalled();
      expect(mockRegistryRegister).not.toHaveBeenCalled();
      expect(mockAdapterInitialize).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Pub/Sub mode with incoming callback
  // =========================================================================

  describe('Pub/Sub mode with messageQueueService', () => {
    const pubsubConfig = {
      projectId: 'my-project',
      subscriptionName: 'my-sub',
      serviceAccountKey: '{"client_email":"a@b.com","private_key":"key"}',
    };

    const mockEnqueue = jest.fn<any>();
    const mockQueueService = { enqueue: mockEnqueue } as any;

    beforeEach(() => {
      mockReadFile.mockResolvedValue(JSON.stringify(pubsubConfig));
    });

    it('should inject onIncomingMessage callback when queueService is provided', async () => {
      const result = await initializeGoogleChatIfConfigured({
        messageQueueService: mockQueueService,
      });

      expect(result).toEqual({ attempted: true, success: true });
      expect(mockAdapterInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'my-project',
          subscriptionName: 'my-sub',
          onIncomingMessage: expect.any(Function),
        }),
      );
    });

    it('should NOT inject callback when queueService is not provided', async () => {
      await initializeGoogleChatIfConfigured();

      const initArg = mockAdapterInitialize.mock.calls[0][0] as any;
      expect(initArg.onIncomingMessage).toBeUndefined();
    });

    it('callback should enqueue incoming messages with google-chat source', async () => {
      await initializeGoogleChatIfConfigured({
        messageQueueService: mockQueueService,
      });

      const initArg = mockAdapterInitialize.mock.calls[0][0] as any;
      const callback = initArg.onIncomingMessage;

      callback({
        text: 'Hello',
        channelId: 'spaces/abc',
        userId: 'users/123',
        threadId: 'threads/456',
        conversationId: 'conv-1',
        source: 'google-chat',
      });

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello',
          conversationId: 'conv-1',
          source: MESSAGE_SOURCES.GOOGLE_CHAT,
          sourceMetadata: expect.objectContaining({
            channelId: 'spaces/abc',
            userId: 'users/123',
            threadId: 'threads/456',
          }),
        }),
      );
    });

    it('callback should add 👀 reaction when messageName is present', async () => {
      mockAdapterAddReaction.mockClear();

      await initializeGoogleChatIfConfigured({
        messageQueueService: mockQueueService,
      });

      const initArg = mockAdapterInitialize.mock.calls[0][0] as any;
      const callback = initArg.onIncomingMessage;

      callback({
        text: 'Hello',
        channelId: 'spaces/abc',
        userId: 'users/123',
        threadId: 'threads/456',
        conversationId: 'conv-1',
        messageName: 'spaces/abc/messages/xyz',
        source: 'google-chat',
      });

      // addReaction should have been called with 👀 via the adapter in the closure
      expect(mockAdapterAddReaction).toHaveBeenCalledWith('spaces/abc/messages/xyz', '👀');

      // Also verify messageName in sourceMetadata for deferred ✅
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMetadata: expect.objectContaining({
            messageName: 'spaces/abc/messages/xyz',
          }),
        }),
      );
    });

    it('callback should include messageName in sourceMetadata for deferred ✅', async () => {
      await initializeGoogleChatIfConfigured({
        messageQueueService: mockQueueService,
      });

      const initArg = mockAdapterInitialize.mock.calls[0][0] as any;
      const callback = initArg.onIncomingMessage;

      callback({
        text: 'Test',
        channelId: 'spaces/abc',
        conversationId: 'conv-2',
        messageName: 'spaces/abc/messages/msg123',
        source: 'google-chat',
      });

      const enqueueArg = mockEnqueue.mock.calls[0][0] as any;
      expect(enqueueArg.sourceMetadata.messageName).toBe('spaces/abc/messages/msg123');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('should return error when adapter.initialize throws', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ webhookUrl: 'https://x.com' }));
      mockAdapterInitialize.mockRejectedValue(new Error('Connection timeout'));

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({
        attempted: true,
        success: false,
        error: 'Connection timeout',
      });
    });

    it('should handle non-Error throws gracefully', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ webhookUrl: 'https://x.com' }));
      mockAdapterInitialize.mockRejectedValue('string error');

      const result = await initializeGoogleChatIfConfigured();

      expect(result).toEqual({
        attempted: true,
        success: false,
        error: 'Unknown error',
      });
    });
  });

  // =========================================================================
  // ADC mode
  // =========================================================================

  describe('ADC auth mode', () => {
    it('should pass authMode through to adapter', async () => {
      const adcConfig = {
        authMode: 'adc',
        projectId: 'my-project',
        subscriptionName: 'my-sub',
      };
      mockReadFile.mockResolvedValue(JSON.stringify(adcConfig));

      await initializeGoogleChatIfConfigured();

      expect(mockAdapterInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          authMode: 'adc',
          projectId: 'my-project',
          subscriptionName: 'my-sub',
        }),
      );
    });
  });
});
