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
 * Build a minimal JWT (unsigned) with the given payload claims.
 *
 * @param payload - Claims to encode in the JWT payload
 * @returns A three-part dot-separated JWT string
 */
function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.nosig`;
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

    // -------------------------------------------------------------------------
    // 2026-05-17 — Don't synthesize a fake deviceName.
    //
    // The frontend Connected-Devices filter relies on `deviceName`
    // being present to distinguish real OSS installations from Portal
    // browser sessions. If we fill in `Device ${prefix}` here when the
    // upstream is empty, every Portal session shows up as a fake
    // machine row. Leave it undefined and let the device card render
    // its own display-time fallback.
    // -------------------------------------------------------------------------

    it('does NOT synthesize a deviceName when the upstream entry has none', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          success: true,
          devices: [
            // Real OSS row — has hostname
            { deviceId: 'oss-mac', deviceName: 'macbookpro.lan', status: 'online' },
            // Portal session row — no deviceName, no name field
            { deviceId: '85b41885-portal', sessionId: '85b41885-portal', status: 'online' },
          ],
        })
      );

      service.start(testConfig);
      await flushPromises();

      const devices = service.getDevices();
      const oss = devices.find((d) => d.deviceId === 'oss-mac');
      const portal = devices.find((d) => d.deviceId === '85b41885-portal');

      expect(oss?.deviceName).toBe('macbookpro.lan');
      // Crucial: the portal row stays `undefined`, not `Device 85b41885`.
      expect(portal?.deviceName).toBeUndefined();
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

  // ----- registerQueue ------------------------------------------------------

  describe('registerQueue', () => {
    it('should store queueId on successful registration', async () => {
      const validToken = buildJwt({ sub: 'user-abc-123' });
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: validToken };

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, queueId: 'q-assigned-001', peerQueueId: null })
      );

      service.start(configWithJwt);
      await flushPromises();

      expect(service.getQueueId()).toBe('q-assigned-001');
    });

    it('should not crash when the registration API returns an error', async () => {
      const validToken = buildJwt({ sub: 'user-abc-123' });
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: validToken };

      // First call (registerQueue) fails with 500, rest succeed
      mockFetch
        .mockResolvedValueOnce(mockResponse({ error: 'Internal' }, 500))  // registerQueue
        .mockResolvedValue(mockResponse({ success: true }));              // heartbeat + device poll

      service.start(configWithJwt);
      await flushPromises();

      // Service should still be syncing (registration failure is non-fatal)
      expect(service.getState()).toBe('syncing');
      expect(service.getQueueId()).toBeNull();
    });

    it('should return null pairing code when JWT has no sub claim', async () => {
      const noSubToken = buildJwt({ email: 'user@test.com' });
      const configWithBadJwt: CloudSyncConfig = { ...testConfig, token: noSubToken };

      mockFetch.mockResolvedValue(mockResponse({ success: true }));

      service.start(configWithBadJwt);
      await flushPromises();

      // registerQueue should bail early (no pairing code) so no queue/register call
      const registerCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/queue/register')
      );
      expect(registerCall).toBeUndefined();
      expect(service.getQueueId()).toBeNull();
    });
  });

  // ----- derivePairingCode --------------------------------------------------

  describe('derivePairingCode', () => {
    it('should produce deterministic output for the same userId', async () => {
      const token = buildJwt({ sub: 'user-deterministic-42' });
      const configA: CloudSyncConfig = { ...testConfig, token };

      // Access private method via any cast
      (service as any).config = configA;
      const code1 = await (service as any).derivePairingCode();
      const code2 = await (service as any).derivePairingCode();

      expect(code1).toBe(code2);
      expect(typeof code1).toBe('string');
      expect(code1).toHaveLength(12);
    });

    it('should return null when config has no token', async () => {
      (service as any).config = { ...testConfig, token: '' };
      const code = await (service as any).derivePairingCode();
      expect(code).toBeNull();
    });

    it('should return null for an invalid JWT (not three parts)', async () => {
      (service as any).config = { ...testConfig, token: 'not-a-jwt' };
      const code = await (service as any).derivePairingCode();
      expect(code).toBeNull();
    });

    it('should return null when config is null', async () => {
      (service as any).config = null;
      const code = await (service as any).derivePairingCode();
      expect(code).toBeNull();
    });
  });

  // ----- getQueueId ---------------------------------------------------------

  describe('getQueueId', () => {
    it('should return null before registration', () => {
      expect(service.getQueueId()).toBeNull();
    });

    it('should return the queueId after successful registration', async () => {
      const validToken = buildJwt({ sub: 'user-queue-test' });
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: validToken };

      mockFetch.mockResolvedValue(
        mockResponse({ success: true, queueId: 'q-test-789', peerQueueId: null })
      );

      service.start(configWithJwt);
      await flushPromises();

      expect(service.getQueueId()).toBe('q-test-789');
    });
  });

  // ----- sendMessage (device resolution) ------------------------------------

  describe('sendMessage (device resolution)', () => {
    it('should resolve peerQueueId from device cache sessionId', async () => {
      service.start(testConfig);
      await flushPromises();

      // Inject a device with sessionId into the cache
      (service as any).devices = [
        makeDevice({ deviceId: 'dev-peer-1', deviceName: 'Peer', sessionId: 'session-xyz' }),
      ];

      mockFetch.mockClear();
      mockFetch.mockResolvedValue(mockResponse({ success: true }));

      await service.sendMessage('dev-peer-1', 'command', { action: 'run' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts!.body as string);
      expect(body.peerQueueId).toBe('session-xyz');
    });

    it('should throw when device is not found in cache', async () => {
      service.start(testConfig);
      await flushPromises();

      // Device cache is empty (or does not contain the target)
      (service as any).devices = [];

      await expect(
        service.sendMessage('dev-nonexistent', 'ping', {})
      ).rejects.toThrow(/Device not found in cache/);
    });

    it('should throw when device has no sessionId', async () => {
      service.start(testConfig);
      await flushPromises();

      // Device exists but has no sessionId
      (service as any).devices = [
        makeDevice({ deviceId: 'dev-no-session', deviceName: 'NoSession' }),
      ];

      await expect(
        service.sendMessage('dev-no-session', 'command', {})
      ).rejects.toThrow(/no sessionId/);
    });
  });

  // ----- pollMessages (queueId null skip) -----------------------------------

  describe('pollMessages', () => {
    it('should skip polling when queueId is null and not make any fetch call', async () => {
      service.start(testConfig);
      await flushPromises();

      // Ensure queueId is null (no registration happened due to invalid token)
      expect(service.getQueueId()).toBeNull();

      mockFetch.mockClear();

      // Directly invoke pollMessages
      await service.pollMessages();

      // No fetch call should be made for message polling when queueId is null
      const pollCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/queue/poll')
      );
      expect(pollCall).toBeUndefined();
    });
  });
});
