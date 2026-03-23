/**
 * Tests for CloudSyncService
 *
 * Covers lifecycle, heartbeat, device polling, message polling, sending,
 * error handling, device online/offline events, and auth_expired terminal state.
 *
 * @module services/cloud/cloud-sync.service.test
 */

import { CloudSyncService } from './cloud-sync.service.js';
import { CLOUD_SYNC_CONSTANTS } from '../../constants.js';
import type { CloudSyncConfig, SyncDevice } from './cloud-sync.types.js';

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

jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({
      getTeams: jest.fn().mockResolvedValue([
        { id: 't1', name: 'Team Alpha', members: [{ agentStatus: 'active' }, { agentStatus: 'inactive' }] },
      ]),
    }),
  },
}));

jest.mock('./cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      tryRefreshToken: jest.fn().mockResolvedValue(false),
      getToken: jest.fn().mockReturnValue(null),
      loadPersistedConfig: jest.fn().mockResolvedValue(null),
      connectLocal: jest.fn(),
    }),
  },
}));

const mockFetch = jest.fn() as jest.MockedFunction<typeof global.fetch>;
global.fetch = mockFetch;

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

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

const flushPromises = () => jest.advanceTimersByTimeAsync(0);

function makeDevice(overrides: Partial<SyncDevice> = {}): SyncDevice {
  return {
    deviceId: 'dev-remote-456',
    deviceName: 'iMac.local',
    status: 'online',
    lastHeartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Drive service into error state via repeated failures.
 * Advances time in small MESSAGE_POLL steps to avoid overshooting.
 * Resets errorRecoveryAttempts so tests start fresh.
 */
async function driveIntoErrorState(svc: CloudSyncService): Promise<void> {
  const step = CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS;
  for (let i = 0; i < CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES + 5; i++) {
    jest.advanceTimersByTime(step);
    await flushPromises();
    if (svc.getState() === 'error') break;
  }
  expect(svc.getState()).toBe('error');
  (svc as any).errorRecoveryAttempts = 0;
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
      service.start(testConfig);
      expect(service.getState()).toBe('syncing');
    });

    it('should transition to stopped state on stop', () => {
      service.start(testConfig);
      service.stop();
      expect(service.getState()).toBe('stopped');
      expect(service.isStarted()).toBe(false);
    });

    it('should clear devices on stop', () => {
      service.start(testConfig);
      (service as any).devices = [makeDevice()];
      expect(service.getDevices()).toHaveLength(1);
      service.stop();
      expect(service.getDevices()).toHaveLength(0);
    });

    it('should fire immediate heartbeat and device poll on start', async () => {
      service.start(testConfig);
      await flushPromises();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ----- Heartbeat ----------------------------------------------------------

  describe('sendHeartbeat', () => {
    it('should POST to heartbeat endpoint with correct payload', async () => {
      service.start(testConfig);
      await flushPromises();

      const hbCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/relay/handshake')
      );
      expect(hbCall).toBeDefined();
      expect(hbCall![0]).toBe(`${CLOUD_URL}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.HEARTBEAT}`);

      const body = JSON.parse(hbCall![1]!.body as string);
      expect(body.deviceId).toBe(DEVICE_ID);
      expect(body.deviceName).toBe(DEVICE_NAME);
      expect(body.status).toBe('online');
      expect(body.teams).toHaveLength(1);
    });

    it('should handle heartbeat failure gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))
               .mockResolvedValue(mockResponse({ success: true }));

      service.start(testConfig);
      await flushPromises();
      expect(service.getState()).toBe('syncing');
    });
  });

  // ----- Device Polling -----------------------------------------------------

  describe('pollDevices', () => {
    it('should update cached devices after poll', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ success: true, devices: [makeDevice({ deviceId: 'dev-r', deviceName: 'R.local' })] })
      );

      service.start(testConfig);
      await flushPromises();

      expect(service.getDevices()).toHaveLength(1);
      expect(service.getDevices()[0].deviceName).toBe('R.local');
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

    it('should deduplicate devices with the same deviceId', async () => {
      const now = new Date();
      const older = new Date(now.getTime() - 10_000).toISOString();
      const newer = now.toISOString();

      mockFetch.mockResolvedValue(
        mockResponse({
          success: true,
          devices: [
            { deviceId: 'dev-d', deviceName: 'D', status: 'online', lastSeenAt: older },
            { deviceId: 'dev-d', deviceName: 'D', status: 'online', lastSeenAt: newer },
          ],
        })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].lastHeartbeatAt).toBe(newer);
    });
  });

  // ----- sendMessage --------------------------------------------------------

  describe('sendMessage', () => {
    it('should POST to send endpoint', async () => {
      service.start(testConfig);
      await flushPromises();
      mockFetch.mockClear();
      mockFetch.mockResolvedValue(mockResponse({ success: true }));

      await service.sendMessage('dev-target', 'command', { action: 'deploy' });

      expect(mockFetch).toHaveBeenCalledWith(
        `${CLOUD_URL}${CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES}`,
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw when not started', async () => {
      await expect(service.sendMessage('dev-1', 'ping', {})).rejects.toThrow(/not started/);
    });
  });

  // ----- Error Handling -----------------------------------------------------

  describe('error handling', () => {
    it('should enter error state after MAX_CONSECUTIVE_FAILURES', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);
    });

    it('should schedule error recovery after entering error state', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);
      expect((service as any).errorRecoveryTimer).not.toBeNull();
    });

    it('should recover from error state when heartbeat succeeds', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      mockFetch.mockResolvedValue(mockResponse({ success: true }));

      const interval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
      jest.advanceTimersByTime(interval);
      await flushPromises();

      expect(service.getState()).toBe('syncing');
      expect((service as any).errorRecoveryTimer).toBeNull();
    });

    it('should remain in error state if recovery fails', async () => {
      mockFetch.mockRejectedValue(new Error('Still down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      const interval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
      jest.advanceTimersByTime(interval);
      await flushPromises();

      expect(service.getState()).toBe('error');
      expect((service as any).errorRecoveryTimer).not.toBeNull();
    });

    it('should clean up error recovery timer on stop', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      expect((service as any).errorRecoveryTimer).not.toBeNull();
      service.stop();
      expect((service as any).errorRecoveryTimer).toBeNull();
    });
  });

  // ----- Auth Expired (Bug 2 fix) -------------------------------------------

  describe('auth_expired terminal state', () => {
    const recoveryInterval = CLOUD_SYNC_CONSTANTS.ERROR_RECOVERY_INTERVAL_MS ?? 60_000;
    const maxAttempts = CLOUD_SYNC_CONSTANTS.MAX_ERROR_RECOVERY_ATTEMPTS ?? 5;

    it('should transition to auth_expired after max 403 recovery failures', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      // All recovery attempts return 403
      mockFetch.mockResolvedValue(mockResponse({}, 403));

      for (let i = 0; i < maxAttempts; i++) {
        jest.advanceTimersByTime(recoveryInterval);
        await flushPromises();
      }

      expect(service.getState()).toBe('auth_expired');
    });

    it('should emit auth_expired event', async () => {
      const listener = jest.fn();
      service.on('auth_expired', listener);

      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      mockFetch.mockResolvedValue(mockResponse({}, 401));

      for (let i = 0; i < maxAttempts; i++) {
        jest.advanceTimersByTime(recoveryInterval);
        await flushPromises();
      }

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should clear all timers after auth_expired', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      mockFetch.mockResolvedValue(mockResponse({}, 403));

      for (let i = 0; i < maxAttempts; i++) {
        jest.advanceTimersByTime(recoveryInterval);
        await flushPromises();
      }

      expect((service as any).errorRecoveryTimer).toBeNull();
      expect((service as any).heartbeatTimer).toBeNull();
      expect((service as any).devicePollTimer).toBeNull();
      expect((service as any).messagePollTimer).toBeNull();
    });

    it('should not make further fetch calls after auth_expired', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      mockFetch.mockResolvedValue(mockResponse({}, 403));

      for (let i = 0; i < maxAttempts; i++) {
        jest.advanceTimersByTime(recoveryInterval);
        await flushPromises();
      }

      expect(service.getState()).toBe('auth_expired');
      mockFetch.mockClear();

      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(recoveryInterval);
        await flushPromises();
      }

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not enter auth_expired if recovery succeeds before limit', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      // First 2 recoveries return 403
      mockFetch.mockResolvedValue(mockResponse({}, 403));
      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();
      expect(service.getState()).toBe('error');

      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();
      expect(service.getState()).toBe('error');

      // 3rd recovery succeeds
      mockFetch.mockResolvedValue(mockResponse({ success: true }));
      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();

      expect(service.getState()).toBe('syncing');
    });

    it('should reset errorRecoveryAttempts on stop', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await driveIntoErrorState(service);

      mockFetch.mockResolvedValue(mockResponse({}, 403));
      jest.advanceTimersByTime(recoveryInterval);
      await flushPromises();

      expect((service as any).errorRecoveryAttempts).toBeGreaterThan(0);
      service.stop();
      expect((service as any).errorRecoveryAttempts).toBe(0);
    });
  });
});
