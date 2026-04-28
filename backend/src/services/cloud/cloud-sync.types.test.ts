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
  isEventMessagePayload,
  CLOUD_SYNC_STATES,
  MESSAGE_TYPES,
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

    // autonomy_v1.f1 — new 'event' MessageType for cross-machine event fan-out
    it("should include the new 'event' MessageType (autonomy_v1.f1)", () => {
      expect(isMessageType('event')).toBe(true);
      expect(MESSAGE_TYPES).toContain('event');
    });

    it("preserves the prior-art 'cross-machine' MessageType (M1 parallel-types regression guard)", () => {
      // Per Arch verdict 2026-04-28 M1: 'cross-machine' (free-text orchestrator
      // messages) and 'event' (typed AgentEvent objects) are kept parallel.
      // If anyone later collapses one into the other, this assertion fails.
      expect(isMessageType('cross-machine')).toBe(true);
      expect(isMessageType('event')).toBe(true);
      expect(MESSAGE_TYPES).toContain('cross-machine');
      expect(MESSAGE_TYPES).toContain('event');
    });

    it('should return false for invalid values', () => {
      expect(isMessageType('chat')).toBe(false);
      expect(isMessageType('')).toBe(false);
      expect(isMessageType(null)).toBe(false);
      expect(isMessageType(123)).toBe(false);
    });
  });

  // autonomy_v1.f1 — EventMessagePayload guard
  describe('isEventMessagePayload', () => {
    const validPayload = {
      event: {
        id: 'evt-uuid-1',
        type: 'xhs:scrape:done',
        sessionName: 'iriss-air-marketing',
        timestamp: '2026-04-28T01:44:12.345Z',
      },
      originDeviceId: 'device-A',
      originDeviceName: 'iriss-air',
    };

    it('accepts a well-formed payload', () => {
      expect(isEventMessagePayload(validPayload)).toBe(true);
    });

    it('accepts payload with extra event fields (forward-compatible)', () => {
      expect(isEventMessagePayload({
        ...validPayload,
        event: { ...validPayload.event, payload: { items: 42 } },
      })).toBe(true);
    });

    it('rejects null / non-object', () => {
      expect(isEventMessagePayload(null)).toBe(false);
      expect(isEventMessagePayload(undefined)).toBe(false);
      expect(isEventMessagePayload('string')).toBe(false);
      expect(isEventMessagePayload(42)).toBe(false);
    });

    it('rejects missing originDeviceId', () => {
      const { originDeviceId: _drop, ...bad } = validPayload;
      expect(isEventMessagePayload(bad)).toBe(false);
    });

    it('rejects empty originDeviceId', () => {
      expect(isEventMessagePayload({ ...validPayload, originDeviceId: '' })).toBe(false);
    });

    it('rejects missing event', () => {
      expect(isEventMessagePayload({ originDeviceId: 'device-A' })).toBe(false);
    });

    it('rejects event without id / type / sessionName / timestamp', () => {
      expect(isEventMessagePayload({
        ...validPayload,
        event: { ...validPayload.event, id: '' },
      })).toBe(false);
      expect(isEventMessagePayload({
        ...validPayload,
        event: { ...validPayload.event, type: '' },
      })).toBe(false);
      expect(isEventMessagePayload({
        ...validPayload,
        event: { ...validPayload.event, sessionName: 42 as unknown as string },
      })).toBe(false);
      expect(isEventMessagePayload({
        ...validPayload,
        event: { ...validPayload.event, timestamp: undefined as unknown as string },
      })).toBe(false);
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
});
