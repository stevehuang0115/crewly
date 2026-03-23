/**
 * Tests for CloudSyncService
 *
 * Covers lifecycle, heartbeat, device polling, message polling, sending,
 * error handling, and device online/offline event detection.
 *
 * @module services/cloud/cloud-sync.service.test
 */

import { CloudSyncService } from './cloud-sync.service.js';
import { CLOUD_SYNC_CONSTANTS } from '../../constants.js';
import type { CloudSyncConfig, SyncDevice, IncomingMessage } from './cloud-sync.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// Mock StorageService for team summaries in heartbeat
jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({
      getTeams: jest.fn().mockResolvedValue([
        { id: 't1', name: 'Team Alpha', members: [{ agentStatus: 'active' }, { agentStatus: 'inactive' }] },
      ]),
    }),
  },
}));

const mockFetch = jest.fn<typeof global.fetch>();
global.fetch = mockFetch as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLOUD_URL = 'https://api.crewlyai.com';
const TOKEN = 'test-jwt-token';
const DEVICE_ID = 'dev-local-123';
const DEVICE_NAME = 'MacBook.local';

const testConfig: CloudSyncConfig = {
  cloudUrl: CLOUD_URL,
  token: TOKEN,
  deviceId: DEVICE_ID,
  deviceName: DEVICE_NAME,
};

/** Create a mock Response. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

/** Flush all pending microtasks (compatible with vi.useFakeTimers). */
const flushPromises = () => new Promise(process.nextTick);

/** Make a valid SyncDevice. */
function makeDevice(overrides: Partial<SyncDevice> = {}): SyncDevice {
  return {
    deviceId: 'dev-remote-456',
    deviceName: 'iMac.local',
    status: 'online',
    lastHeartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudSyncService', () => {
  let service: CloudSyncService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    CloudSyncService.resetInstance();
    service = CloudSyncService.getInstance();
    // Default: all fetch calls succeed with empty success
    mockFetch.mockResolvedValue(mockResponse({ success: true }));
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  // ----- Singleton ----------------------------------------------------------

  describe('singleton', () => {
    it('should return same instance on subsequent calls', () => {
      expect(CloudSyncService.getInstance()).toBe(service);
    });

    it('should return new instance after resetInstance', () => {
      CloudSyncService.resetInstance();
      expect(CloudSyncService.getInstance()).not.toBe(service);
    });
  });

  // ----- Lifecycle ----------------------------------------------------------

  describe('start/stop', () => {
    it('should transition to syncing state on start', () => {
      service.start(testConfig);
      expect(service.getState()).toBe('syncing');
      expect(service.isStarted()).toBe(true);
    });

    it('should be idempotent on double start', () => {
      service.start(testConfig);
      service.start(testConfig); // should not throw
      expect(service.getState()).toBe('syncing');
    });

    it('should transition to stopped state on stop', () => {
      service.start(testConfig);
      service.stop();
      expect(service.getState()).toBe('stopped');
      expect(service.isStarted()).toBe(false);
    });

    it('should be idempotent on stop when already stopped', () => {
      service.stop(); // should not throw
      expect(service.getState()).toBe('stopped');
    });

    it('should clear devices on stop', () => {
      service.start(testConfig);
      // Manually inject a device
      (service as any).devices = [makeDevice()];
      expect(service.getDevices()).toHaveLength(1);

      service.stop();
      expect(service.getDevices()).toHaveLength(0);
    });

    it('should fire immediate heartbeat and device poll on start', async () => {
      service.start(testConfig);
      await flushPromises();

      // 2 fetch calls: single heartbeat (handshake) + one device poll
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ----- Heartbeat ----------------------------------------------------------

  describe('sendHeartbeat', () => {
    it('should POST to heartbeat endpoint with correct payload', async () => {
      service.start(testConfig);
      await flushPromises();

      const heartbeatCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/relay/handshake')
      );

      expect(heartbeatCall).toBeDefined();
      const [url, opts] = heartbeatCall!;
      expect(url).toBe(`${CLOUD_URL}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT}`);
      expect(opts!.method).toBe('POST');

      const body = JSON.parse(opts!.body as string);
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.deviceName).toBe(DEVICE_NAME);
      expect(body.status).toBe('online');
      expect(body.capabilities).toContain('orchestrator');
      expect(body.teams).toHaveLength(1);
      expect(body.teams[0].name).toBe('Team Alpha');
      expect(body.teams[0].memberCount).toBe(2);
      expect(body.teams[0].activeAgents).toBe(1);
    });

    it('should include Authorization header', async () => {
      service.start(testConfig);
      await flushPromises();

      const heartbeatCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/relay/handshake')
      );
      expect(heartbeatCall![1]!.headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${TOKEN}` })
      );
    });

    it('should handle heartbeat failure gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))
               .mockResolvedValue(mockResponse({ success: true }));

      service.start(testConfig);
      await flushPromises();

      // Should not crash, state should still be syncing
      expect(service.getState()).toBe('syncing');
    });

    it('should fire periodically on heartbeat interval', async () => {
      service.start(testConfig);
      await flushPromises();

      const initialCalls = mockFetch.mock.calls.length;

      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
      await flushPromises();

      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  // ----- Device Polling -----------------------------------------------------

  describe('pollDevices', () => {
    it('should fetch devices from correct endpoint', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice()] })
      );

      service.start(testConfig);
      await flushPromises();

      const deviceCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/api/v1/relay/devices')
      );
      expect(deviceCall).toBeDefined();
      expect(deviceCall![0]).toBe(`${CLOUD_URL}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.DEVICES}`);
    });

    it('should update cached devices after poll', async () => {
      const remoteDevice = makeDevice({ deviceId: 'dev-remote-1', deviceName: 'Remote.local' });
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [remoteDevice] })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceName).toBe('Remote.local');
    });

    it('should normalize Cloud relay format (sessionId → deviceId)', async () => {
      // Cloud server returns devices with sessionId instead of deviceId
      const cloudDevice = {
        sessionId: 'cloud-dev-789',
        name: 'CloudMachine.local',
        state: 'paired',
        registeredAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      };
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [cloudDevice] })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe('cloud-dev-789');
      expect(devices[0].deviceName).toBe('CloudMachine.local');
      expect(devices[0].status).toBe('online'); // 'paired' state → online
    });

    it('should mark local device with isLocal flag', async () => {
      const localDevice = makeDevice({ deviceId: DEVICE_ID, deviceName: DEVICE_NAME });
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [localDevice] })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices[0].isLocal).toBe(true);
    });

    it('should mark device offline when heartbeat is stale', async () => {
      const staleDevice = makeDevice({
        lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
        status: undefined as any, // no status field — rely on heartbeat freshness
        state: undefined as any,
      });
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [staleDevice] })
      );

      service.start(testConfig);
      await flushPromises();

      expect(service.getDevices()[0].status).toBe('offline');
    });

    it('should emit devices_updated event', async () => {
      const listener = jest.fn();
      service.on('devices_updated', listener);

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice()] })
      );

      service.start(testConfig);
      await flushPromises();

      expect(listener).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ deviceId: 'dev-remote-456' }),
      ]));
    });

    it('should emit device_online when new device appears', async () => {
      const listener = jest.fn();
      service.on('device_online', listener);

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice({ deviceId: 'dev-new' })] })
      );

      service.start(testConfig);
      await flushPromises();

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-new' }));
    });

    it('should emit device_offline when device disappears', async () => {
      const listener = jest.fn();
      service.on('device_offline', listener);

      // First poll: device exists
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice({ deviceId: 'dev-gone' })] })
      );
      service.start(testConfig);
      await flushPromises();

      // Second poll: device gone
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [] })
      );
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.DEVICE_POLL_INTERVAL_MS + 100);
      await flushPromises();

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'dev-gone',
        status: 'offline',
      }));
    });

    it('should deduplicate devices with the same deviceId', async () => {
      const now = new Date();
      const olderTime = new Date(now.getTime() - 10_000).toISOString();
      const newerTime = now.toISOString();

      // Cloud API returns two records for the same device (e.g., from relay
      // handshake and device heartbeat endpoints)
      const duplicateDevices = [
        {
          deviceId: 'dev-same-device',
          deviceName: 'MacBook-Pro-3.local',
          status: 'online',
          lastSeenAt: olderTime,
        },
        {
          deviceId: 'dev-same-device',
          deviceName: 'MacBook-Pro-3.local',
          status: 'online',
          lastSeenAt: newerTime,
        },
      ];

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: duplicateDevices })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe('dev-same-device');
      // Should keep the entry with the newer heartbeat
      expect(devices[0].lastHeartbeatAt).toBe(newerTime);
    });

    it('should keep online device over offline duplicate', async () => {
      const sameTime = new Date().toISOString();

      const duplicateDevices = [
        {
          deviceId: 'dev-dup',
          deviceName: 'MacBook-Pro-3.local',
          lastSeenAt: sameTime,
          status: 'offline',
        },
        {
          deviceId: 'dev-dup',
          deviceName: 'MacBook-Pro-3.local',
          lastSeenAt: sameTime,
          status: 'online',
        },
      ];

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: duplicateDevices })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].status).toBe('online');
    });

    it('should not deduplicate devices with different deviceIds', async () => {
      const devices = [
        makeDevice({ deviceId: 'dev-a', deviceName: 'MacBook-A.local' }),
        makeDevice({ deviceId: 'dev-b', deviceName: 'MacBook-B.local' }),
      ];

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices })
      );

      service.start(testConfig);
      await flushPromises();

      expect(service.getDevices()).toHaveLength(2);
    });

    it('getOnlineDevices should exclude local and offline devices', async () => {
      const stale = new Date(Date.now() - 120_000).toISOString();
      const fresh = new Date().toISOString();

      mockFetch.mockResolvedValue(
        mockResponse({
          success: true,
          devices: [
            makeDevice({ deviceId: DEVICE_ID, lastHeartbeatAt: fresh }),
            makeDevice({ deviceId: 'dev-online', lastHeartbeatAt: fresh }),
            makeDevice({ deviceId: 'dev-offline', lastHeartbeatAt: stale, status: undefined as any, state: undefined as any }),
          ],
        })
      );

      service.start(testConfig);
      await flushPromises();

      const online = service.getOnlineDevices();
      expect(online).toHaveLength(1);
      expect(online[0].deviceId).toBe('dev-online');
    });
  });

  // ----- Message Polling ----------------------------------------------------

  describe('pollMessages', () => {
    it('should fetch messages from correct endpoint with deviceId', async () => {
      mockFetch.mockResolvedValue(mockResponse({ success: true, messages: [] }));

      service.start(testConfig);
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS + 100);
      await flushPromises();

      const msgCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/relay/queue/poll') && url.includes('queueId=')
      );
      expect(msgCall).toBeDefined();
      expect(msgCall![0]).toContain(`queueId=${encodeURIComponent(DEVICE_ID)}`);
    });

    it('should emit message event for each received message', async () => {
      const listener = jest.fn();
      service.on('message', listener);

      const msg = {
        id: 'msg-1',
        fromDeviceId: 'dev-456',
        payload: JSON.stringify({ action: 'test' }),
        createdAt: new Date().toISOString(),
      };

      mockFetch
        .mockResolvedValueOnce(mockResponse({ success: true })) // heartbeat (handshake)
        .mockResolvedValueOnce(mockResponse({ success: true, devices: [] })) // device poll
        .mockResolvedValueOnce(mockResponse({ success: true, messages: [msg] })) // message poll
        .mockResolvedValue(mockResponse({ success: true }));

      service.start(testConfig);
      await flushPromises();

      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS + 100);
      await flushPromises();
      await flushPromises();

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
    });

    it('should acknowledge messages after processing', async () => {
      const msg = {
        id: 'msg-ack-1',
        fromDeviceId: 'dev-456',
        payload: '{}',
        createdAt: new Date().toISOString(),
      };

      mockFetch
        .mockResolvedValueOnce(mockResponse({ success: true })) // heartbeat (handshake)
        .mockResolvedValueOnce(mockResponse({ success: true, devices: [] })) // device poll
        .mockResolvedValueOnce(mockResponse({ success: true, messages: [msg] })) // message poll
        .mockResolvedValue(mockResponse({ success: true }));

      service.start(testConfig);
      await flushPromises();

      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS + 100);
      await flushPromises();
      await flushPromises();

      const ackCall = mockFetch.mock.calls.find(
        ([url, opts]) =>
          typeof url === 'string' && url.includes('/api/v1/relay/queue/ack') && opts?.method === 'POST'
      );
      expect(ackCall).toBeDefined();
      const ackBody = JSON.parse(ackCall![1]!.body as string);
      expect(ackBody.queueId).toBe(DEVICE_ID);
      expect(ackBody.messageIds).toContain('msg-ack-1');
    });

    it('should handle empty message response gracefully', async () => {
      mockFetch.mockResolvedValue(mockResponse({ success: true, messages: [] }));

      service.start(testConfig);
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS + 100);
      await flushPromises();

      const ackCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/relay/queue/ack')
      );
      expect(ackCalls).toHaveLength(0);
    });
  });

  // ----- sendMessage --------------------------------------------------------

  describe('sendMessage', () => {
    it('should POST to send endpoint with correct body', async () => {
      service.start(testConfig);
      await flushPromises();
      mockFetch.mockClear();
      mockFetch.mockResolvedValue(mockResponse({ success: true, messageId: 'msg-new' }));

      await service.sendMessage('dev-target', 'command', { action: 'deploy' });

      expect(mockFetch).toHaveBeenCalledWith(
        `${CLOUD_URL}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES}`,
        expect.objectContaining({ method: 'POST' })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.toDeviceId).toBe('dev-target');
      // type, data, encrypted are wrapped inside the payload string
      const wrappedPayload = JSON.parse(body.payload);
      expect(wrappedPayload.type).toBe('command');
      expect(wrappedPayload.data).toEqual({ action: 'deploy' });
      expect(wrappedPayload.encrypted).toBe(false);
    });

    it('should throw when not started', async () => {
      await expect(service.sendMessage('dev-1', 'ping', {})).rejects.toThrow(
        /not started/
      );
    });

    it('should throw on API error', async () => {
      service.start(testConfig);
      await flushPromises();
      mockFetch.mockClear();
      mockFetch.mockResolvedValue(mockResponse('Server Error', 500));

      await expect(service.sendMessage('dev-1', 'ping', {})).rejects.toThrow(
        /Failed to send message: 500/
      );
    });
  });

  // ----- Error Handling -----------------------------------------------------

  describe('error handling', () => {
    it('should enter error state after MAX_CONSECUTIVE_FAILURES heartbeat failures', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));

      service.start(testConfig);
      await flushPromises();

      for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
        jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
        await flushPromises();
      }

      expect(service.getState()).toBe('error');
    });

    it('should reset failure count on successful heartbeat', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fail'))
               .mockResolvedValue(mockResponse({ success: true }));

      service.start(testConfig);
      await flushPromises();

      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
      await flushPromises();

      expect(service.getState()).toBe('syncing');
    });

    it('should handle 401/403 in device poll without crashing', async () => {
      mockFetch.mockResolvedValue(mockResponse({}, 403));

      service.start(testConfig);
      await flushPromises();

      expect(service.getState()).toBe('syncing');
    });

    it('should not emit device_online for local device', async () => {
      const listener = jest.fn();
      service.on('device_online', listener);

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice({ deviceId: DEVICE_ID })] })
      );

      service.start(testConfig);
      await flushPromises();

      // device_online should NOT fire for local device
      expect(listener).not.toHaveBeenCalled();
    });

    it('should schedule error recovery after entering error state', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));

      service.start(testConfig);
      await flushPromises();

      // Drive heartbeat failures to hit the threshold
      for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
        jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
        await flushPromises();
      }

      expect(service.getState()).toBe('error');

      // Recovery timer should be scheduled (errorRecoveryTimer is set)
      expect((service as any).errorRecoveryTimer).not.toBeNull();
    });

    it('should recover from error state when heartbeat succeeds during recovery', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));

      service.start(testConfig);
      await flushPromises();

      // Drive into error state
      for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
        jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
        await flushPromises();
      }

      expect(service.getState()).toBe('error');

      // Now make heartbeat succeed — recovery attempt should restore state
      mockFetch.mockResolvedValue(mockResponse({ success: true }));

      const recoveryInterval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();

      expect(service.getState()).toBe('syncing');
      // Recovery timer should be cleared after successful recovery
      expect((service as any).errorRecoveryTimer).toBeNull();
    });

    it('should remain in error state if recovery heartbeat fails', async () => {
      mockFetch.mockRejectedValue(new Error('Still down'));

      service.start(testConfig);
      await flushPromises();

      // Drive into error state
      for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
        jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
        await flushPromises();
      }

      expect(service.getState()).toBe('error');

      // Recovery attempt also fails
      const recoveryInterval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();

      expect(service.getState()).toBe('error');
      // Recovery timer should still be active for next attempt
      expect((service as any).errorRecoveryTimer).not.toBeNull();
    });

    it('should clean up error recovery timer on stop', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));

      service.start(testConfig);
      await flushPromises();

      for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES; i++) {
        jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
        await flushPromises();
      }

      expect((service as any).errorRecoveryTimer).not.toBeNull();

      service.stop();
      expect((service as any).errorRecoveryTimer).toBeNull();
    });
  });
});
