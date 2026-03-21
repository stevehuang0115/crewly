/**
 * Tests for Cloud Sync Type Definitions
 *
 * @module services/cloud/cloud-sync.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  isCloudSyncState,
  isMessageType,
  isSyncDevice,
  isIncomingMessage,
  isCloudSyncConfig,
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
});
