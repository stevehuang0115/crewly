/**
 * Tests for Cloud Sync Type Definitions
 *
 * @module services/cloud/cloud-sync.types.test
 */

import {
  isCloudSyncState,
  isMessageType,
  isSyncDevice,
  isIncomingMessage,
  isCloudSyncConfig,
  isAgentMessagePayload,
  isChatRequestPayload,
  isChatResponsePayload,
  isChatEventPayload,
  CLOUD_SYNC_STATES,
  MESSAGE_TYPES,
  CHAT_RPC_METHODS,
} from './cloud-sync.types.js';

describe('cloud-sync.types', () => {
  describe('isCloudSyncState', () => {
    it('should return true for valid states', () => {
      for (const state of CLOUD_SYNC_STATES) {
        expect(isCloudSyncState(state)).toBe(true);
      }
    });

    it('should return false for invalid values', () => {
      expect(isCloudSyncState('running')).toBe(false);
      expect(isCloudSyncState('')).toBe(false);
      expect(isCloudSyncState(null)).toBe(false);
      expect(isCloudSyncState(42)).toBe(false);
      expect(isCloudSyncState(undefined)).toBe(false);
    });
  });

  describe('isMessageType', () => {
    it('should return true for all valid message types', () => {
      for (const type of MESSAGE_TYPES) {
        expect(isMessageType(type)).toBe(true);
      }
    });

    it('should include expected types', () => {
      expect(isMessageType('command')).toBe(true);
      expect(isMessageType('sync_teams')).toBe(true);
      expect(isMessageType('notification')).toBe(true);
      expect(isMessageType('relay')).toBe(true);
      expect(isMessageType('ping')).toBe(true);
      expect(isMessageType('task_update')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isMessageType('chat')).toBe(false);
      expect(isMessageType('')).toBe(false);
      expect(isMessageType(null)).toBe(false);
      expect(isMessageType(123)).toBe(false);
    });
  });

  describe('isSyncDevice', () => {
    const validDevice = {
      deviceId: 'dev-123',
      deviceName: 'MacBook.local',
      status: 'online',
      lastHeartbeatAt: '2026-03-20T14:00:00Z',
    };

    it('should return true for valid SyncDevice', () => {
      expect(isSyncDevice(validDevice)).toBe(true);
    });

    it('should return true with optional fields', () => {
      expect(isSyncDevice({
        ...validDevice,
        version: '1.4.47',
        capabilities: ['orchestrator'],
        teams: [],
        isLocal: true,
      })).toBe(true);
    });

    it('should return true for offline devices', () => {
      expect(isSyncDevice({ ...validDevice, status: 'offline' })).toBe(true);
    });

    it('should return false for missing required fields', () => {
      expect(isSyncDevice({ deviceId: 'x' })).toBe(false);
      expect(isSyncDevice({ ...validDevice, deviceId: undefined })).toBe(false);
      expect(isSyncDevice({ ...validDevice, status: 'unknown' })).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isSyncDevice(null)).toBe(false);
      expect(isSyncDevice('string')).toBe(false);
      expect(isSyncDevice(42)).toBe(false);
    });
  });

  describe('isIncomingMessage', () => {
    const validMessage = {
      id: 'msg-1',
      from: 'dev-456',
      fromDeviceName: 'iMac.local',
      type: 'command',
      payload: { action: 'test' },
      encrypted: false,
      sentAt: '2026-03-20T14:00:00Z',
    };

    it('should return true for valid IncomingMessage', () => {
      expect(isIncomingMessage(validMessage)).toBe(true);
    });

    it('should return true for all message types', () => {
      for (const type of MESSAGE_TYPES) {
        expect(isIncomingMessage({ ...validMessage, type })).toBe(true);
      }
    });

    it('should return false for invalid message type', () => {
      expect(isIncomingMessage({ ...validMessage, type: 'invalid' })).toBe(false);
    });

    it('should return false for missing fields', () => {
      expect(isIncomingMessage({ id: 'x' })).toBe(false);
      expect(isIncomingMessage({ ...validMessage, encrypted: 'yes' })).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isIncomingMessage(null)).toBe(false);
      expect(isIncomingMessage(undefined)).toBe(false);
    });
  });

  describe('isCloudSyncConfig', () => {
    const validConfig = {
      cloudUrl: 'https://api.crewlyai.com',
      token: 'jwt-token',
      deviceId: 'dev-123',
      deviceName: 'MacBook.local',
    };

    it('should return true for valid config', () => {
      expect(isCloudSyncConfig(validConfig)).toBe(true);
    });

    it('should return false for missing fields', () => {
      expect(isCloudSyncConfig({ cloudUrl: 'x', token: 'y' })).toBe(false);
      expect(isCloudSyncConfig({})).toBe(false);
    });

    it('should return false for non-string fields', () => {
      expect(isCloudSyncConfig({ ...validConfig, token: 123 })).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isCloudSyncConfig(null)).toBe(false);
      expect(isCloudSyncConfig('string')).toBe(false);
    });
  });

  describe('isAgentMessagePayload', () => {
    const validPayload = {
      targetSession: 'crewly-product-leo-member-n',
      message: 'Hello Leo, build feature X',
      fromDevice: 'device-123',
      fromDeviceName: 'MacBook.local',
    };

    it('should return true for valid payload', () => {
      expect(isAgentMessagePayload(validPayload)).toBe(true);
    });

    it('should return true with optional fields', () => {
      expect(isAgentMessagePayload({
        ...validPayload,
        priority: 'high',
        correlationId: 'corr-1',
      })).toBe(true);
    });

    it('should return false for missing required fields', () => {
      expect(isAgentMessagePayload({ targetSession: 'x' })).toBe(false);
      expect(isAgentMessagePayload({ ...validPayload, message: undefined })).toBe(false);
      expect(isAgentMessagePayload({ ...validPayload, fromDevice: undefined })).toBe(false);
      expect(isAgentMessagePayload({ ...validPayload, fromDeviceName: undefined })).toBe(false);
    });

    it('should return false for non-string fields', () => {
      expect(isAgentMessagePayload({ ...validPayload, targetSession: 123 })).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isAgentMessagePayload(null)).toBe(false);
      expect(isAgentMessagePayload(undefined)).toBe(false);
      expect(isAgentMessagePayload('string')).toBe(false);
    });
  });

  describe('agent_message type', () => {
    it('should be a valid MessageType', () => {
      expect(isMessageType('agent_message')).toBe(true);
    });

    it('should be included in MESSAGE_TYPES', () => {
      expect(MESSAGE_TYPES).toContain('agent_message');
    });
  });

  // ---------------------------------------------------------------------------
  // chat-v2 RPC over relay (Cloud Portal ↔ user-local OSS)
  // ---------------------------------------------------------------------------

  describe('chat_request / chat_response / chat_event message types', () => {
    it('all three are valid MessageTypes', () => {
      expect(isMessageType('chat_request')).toBe(true);
      expect(isMessageType('chat_response')).toBe(true);
      expect(isMessageType('chat_event')).toBe(true);
    });

    it('all three are included in MESSAGE_TYPES', () => {
      expect(MESSAGE_TYPES).toContain('chat_request');
      expect(MESSAGE_TYPES).toContain('chat_response');
      expect(MESSAGE_TYPES).toContain('chat_event');
    });
  });

  describe('CHAT_RPC_METHODS', () => {
    it('lists the closed set of RPC methods', () => {
      // Locked set — if you add a new ChatRpcMethod, update both the
      // type union AND this expectation so the OSS adapter is forced
      // to grow a matching dispatch handler.
      expect([...CHAT_RPC_METHODS]).toEqual([
        'listAgents',
        'getAgentPresence',
        'listChannels',
        'ensureDmChannel',
        'createChannel',
        'listMessages',
        'sendMessage',
      ]);
    });
  });

  describe('isChatRequestPayload', () => {
    it('accepts a minimal valid request', () => {
      expect(
        isChatRequestPayload({ id: 'r-1', method: 'listChannels' }),
      ).toBe(true);
    });

    it('accepts a request with params', () => {
      expect(
        isChatRequestPayload({
          id: 'r-2',
          method: 'sendMessage',
          params: { channelId: 'c-1', content: 'hi' },
        }),
      ).toBe(true);
    });

    it('accepts an unknown method string (rejected later by the adapter)', () => {
      // Intentionally not gating on CHAT_RPC_METHODS at the guard level
      // so the adapter can return a structured `unsupported_method` error
      // back to Portal instead of dropping the message silently.
      expect(
        isChatRequestPayload({ id: 'r-3', method: 'deleteEverything' }),
      ).toBe(true);
    });

    it('rejects missing id / method', () => {
      expect(isChatRequestPayload({ method: 'listChannels' })).toBe(false);
      expect(isChatRequestPayload({ id: 'r-4' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isChatRequestPayload(null)).toBe(false);
      expect(isChatRequestPayload(undefined)).toBe(false);
      expect(isChatRequestPayload('string')).toBe(false);
    });
  });

  describe('isChatResponsePayload', () => {
    it('accepts a success response', () => {
      expect(isChatResponsePayload({ id: 'r-1', result: { ok: true } })).toBe(true);
    });

    it('accepts an error response', () => {
      expect(
        isChatResponsePayload({
          id: 'r-2',
          error: { code: 'validation_error', message: 'bad' },
        }),
      ).toBe(true);
    });

    it('accepts a response with neither result nor error (shape contract is just id)', () => {
      // The wire shape only mandates the correlation id; semantic
      // "exactly one of result|error" is enforced by the dispatcher,
      // not by the type guard.
      expect(isChatResponsePayload({ id: 'r-3' })).toBe(true);
    });

    it('rejects responses without an id', () => {
      expect(isChatResponsePayload({ result: 'oops' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isChatResponsePayload(null)).toBe(false);
      expect(isChatResponsePayload(42)).toBe(false);
    });
  });

  describe('isChatEventPayload', () => {
    it('accepts a message event', () => {
      expect(
        isChatEventPayload({
          channelId: 'c-1',
          event: { type: 'message', payload: { channelId: 'c-1', message: {} } },
        }),
      ).toBe(true);
    });

    it('rejects missing channelId', () => {
      expect(isChatEventPayload({ event: { type: 'message' } })).toBe(false);
    });

    it('rejects missing event', () => {
      expect(isChatEventPayload({ channelId: 'c-1' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isChatEventPayload(null)).toBe(false);
      expect(isChatEventPayload([])).toBe(false);
    });
  });
});
