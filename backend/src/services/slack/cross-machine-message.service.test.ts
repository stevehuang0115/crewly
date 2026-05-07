/**
 * Cross-Machine Message Service Tests
 *
 * Tests for the CrossMachineMessageService that enables
 * CloudSync-based cross-machine orchestrator communication.
 *
 * @module services/slack/cross-machine-message.service.test
 */

import { CrossMachineMessageService } from './cross-machine-message.service.js';
import { CloudSyncService } from '../cloud/cloud-sync.service.js';
import {
  CROSS_MACHINE_PREFIX,
  serializeCrossMachineMessage,
  type CrossMachineMessage,
} from '../../types/cross-machine.types.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { DeviceIdentity } from '../cloud/device-identity.service.js';

// Mock dependencies
jest.mock('../cloud/device-identity.service.js', () => ({
  DeviceIdentityService: {
    getInstance: jest.fn(() => mockDeviceIdentity),
  },
}));

jest.mock('../../constants.js', () => ({
  CROSS_MACHINE_CONSTANTS: {
    MAX_TRACKED_MESSAGE_IDS: 10,
  },
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
}));

const localIdentity: DeviceIdentity = {
  deviceId: 'local-device-001',
  deviceName: 'My-MacBook',
  createdAt: '2026-03-22T00:00:00.000Z',
  lastSeenAt: '2026-03-22T12:00:00.000Z',
};

const mockDeviceIdentity = {
  getOrCreateIdentity: jest.fn().mockResolvedValue(localIdentity),
  getDeviceId: jest.fn().mockResolvedValue('local-device-001'),
};

/**
 * Create a mock SlackIncomingMessage for testing.
 */
function createSlackMessage(text: string): SlackIncomingMessage {
  return {
    id: 'msg-slack-1',
    type: 'message',
    text,
    userId: 'U123',
    channelId: 'C-XMACHINE',
    ts: '1111111111.111111',
    teamId: 'T123',
    eventTs: '1111111111.111112',
  };
}

/**
 * Create a CrossMachineMessage for testing.
 */
function createCrossMessage(overrides: Partial<CrossMachineMessage> = {}): CrossMachineMessage {
  return {
    protocol: 'crewly-x-machine',
    version: 1,
    from: 'remote-device-002',
    fromName: 'Office-iMac',
    to: 'local-device-001',
    type: 'delegate-task',
    payload: { task: 'Run tests' },
    timestamp: '2026-03-22T12:00:00.000Z',
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

describe('CrossMachineMessageService', () => {
  let service: CrossMachineMessageService;

  beforeEach(() => {
    jest.clearAllMocks();
    CrossMachineMessageService.resetInstance();
    service = new CrossMachineMessageService(
      mockDeviceIdentity as any
    );
  });

  describe('initialize', () => {
    it('should load device identity on init', async () => {
      await service.initialize();
      expect(mockDeviceIdentity.getOrCreateIdentity).toHaveBeenCalled();
    });

    it('should only initialize once', async () => {
      await service.initialize();
      await service.initialize();
      expect(mockDeviceIdentity.getOrCreateIdentity).toHaveBeenCalledTimes(1);
    });
  });

  describe('isEnabled', () => {
    it('should return false when not initialized', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('should return false when no config', async () => {
      await service.initialize();
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when configured with channelId and enabled', async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-XMACHINE', enabled: true });
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when configured but disabled', async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-XMACHINE', enabled: false });
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when enabled without channelId but CloudSync is started', async () => {
      // Mock CloudSyncService.getInstance().isStarted() to return true.
      //
      // NOTE: Under the prior `nodeRequire` lazy-load, an in-`it`
      // `jest.mock(...)` worked because the require call inside
      // `isEnabled()` resolved at test runtime. The build-fix that
      // succeeded PR #494 switched to a static import (the lazy
      // entry-script-anchored createRequire was breaking relative
      // paths in the 4 sibling files; static import keeps `isEnabled`
      // sync without that anchor mismatch). With a static binding
      // captured at module load, an in-`it` jest.mock is too late.
      // We use `jest.spyOn` instead so the override is scoped to this
      // single test and restored automatically.
      const spy = jest
        .spyOn(CloudSyncService, 'getInstance')
        .mockReturnValue({
          isStarted: () => true,
        } as unknown as ReturnType<typeof CloudSyncService.getInstance>);
      try {
        await service.initialize();
        await service.configure({ channelId: '', enabled: true });
        expect(service.isEnabled()).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('getIdentity', () => {
    it('should return null before init', () => {
      expect(service.getIdentity()).toBeNull();
    });

    it('should return identity after init', async () => {
      await service.initialize();
      const identity = service.getIdentity();
      expect(identity).toEqual(localIdentity);
    });

    it('should return a copy (not reference)', async () => {
      await service.initialize();
      const id1 = service.getIdentity();
      const id2 = service.getIdentity();
      expect(id1).toEqual(id2);
      expect(id1).not.toBe(id2);
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-XMACHINE', enabled: true });
    });

    it('should fail when not enabled', async () => {
      await service.configure({ channelId: 'C-XMACHINE', enabled: false });
      const result = await service.sendMessage('remote', 'ping');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not enabled');
    });

    it('should fail when CloudSync is not started', async () => {
      const result = await service.sendMessage('remote', 'ping');
      // CloudSync is not started in test environment
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail without identity', async () => {
      // Clear identity to simulate uninitialized state
      (service as any).identity = null;
      const result = await service.sendMessage('remote', 'ping');
      expect(result.success).toBe(false);
      expect(result.error).toContain('identity');
    });
  });

  describe('handleIncomingMessage', () => {
    beforeEach(async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-XMACHINE', enabled: true });
    });

    it('should return false for non-cross-machine messages', () => {
      const slackMsg = createSlackMessage('Hello, regular message');
      expect(service.handleIncomingMessage(slackMsg)).toBe(false);
    });

    it('should handle messages addressed to this machine', () => {
      const crossMsg = createCrossMessage({ to: 'local-device-001' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      const handler = jest.fn();
      service.on('message', handler);

      const result = service.handleIncomingMessage(slackMsg);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        from: 'remote-device-002',
        to: 'local-device-001',
        type: 'delegate-task',
      }));
    });

    it('should handle broadcast messages', () => {
      const crossMsg = createCrossMessage({ to: '*' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      const broadcastHandler = jest.fn();
      const messageHandler = jest.fn();
      service.on('broadcast', broadcastHandler);
      service.on('message', messageHandler);

      service.handleIncomingMessage(slackMsg);
      expect(broadcastHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it('should ignore messages from self', () => {
      const crossMsg = createCrossMessage({ from: 'local-device-001' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      const handler = jest.fn();
      service.on('message', handler);

      const result = service.handleIncomingMessage(slackMsg);
      expect(result).toBe(true); // Handled (by ignoring)
      expect(handler).not.toHaveBeenCalled();
    });

    it('should ignore messages addressed to other machines', () => {
      const crossMsg = createCrossMessage({ to: 'other-device-003' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      const handler = jest.fn();
      service.on('message', handler);

      const result = service.handleIncomingMessage(slackMsg);
      expect(result).toBe(true); // Handled (by ignoring)
      expect(handler).not.toHaveBeenCalled();
    });

    it('should deduplicate messages by messageId', () => {
      const crossMsg = createCrossMessage({ messageId: 'dup-msg-1' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      const handler = jest.fn();
      service.on('message', handler);

      service.handleIncomingMessage(slackMsg);
      service.handleIncomingMessage(slackMsg);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should attempt auto-respond to ping with pong via sendMessage', async () => {
      const sendSpy = jest.spyOn(service, 'sendMessage');
      const crossMsg = createCrossMessage({ type: 'ping' });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));

      service.handleIncomingMessage(slackMsg);

      // Pong is sent asynchronously via sendMessage → CloudSync
      // In test env CloudSync is not started, so it'll fail silently
      // but we can verify sendMessage was called with pong type
      await new Promise(r => setTimeout(r, 10));
      expect(sendSpy).toHaveBeenCalledWith('remote-device-002', 'pong', expect.objectContaining({
        inResponseTo: expect.any(String),
      }));
      sendSpy.mockRestore();
    });

    it('should prune tracked message IDs when exceeding max', () => {
      // MAX_TRACKED_MESSAGE_IDS is mocked to 10
      for (let i = 0; i < 15; i++) {
        const crossMsg = createCrossMessage({
          messageId: `msg-${i}`,
          to: 'local-device-001',
        });
        const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));
        service.handleIncomingMessage(slackMsg);
      }

      // Service should still be functional (no crash)
      const handler = jest.fn();
      service.on('message', handler);
      const crossMsg = createCrossMessage({
        messageId: 'msg-new',
        to: 'local-device-001',
      });
      const slackMsg = createSlackMessage(serializeCrossMachineMessage(crossMsg));
      service.handleIncomingMessage(slackMsg);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('configure', () => {
    it('should update config', async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-NEW', enabled: true });
      const config = service.getConfig();
      expect(config).toEqual({ channelId: 'C-NEW', enabled: true });
    });

    it('should return a copy of config', async () => {
      await service.initialize();
      await service.configure({ channelId: 'C-TEST', enabled: true });
      const c1 = service.getConfig();
      const c2 = service.getConfig();
      expect(c1).toEqual(c2);
      expect(c1).not.toBe(c2);
    });
  });
});
