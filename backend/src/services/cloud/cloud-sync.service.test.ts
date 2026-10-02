/**
 * Tests for CloudSyncService
 *
 * Covers lifecycle, heartbeat, device polling, message polling, sending,
 * error handling, device online/offline events, and auth_expired terminal state.
 *
 * @module services/cloud/cloud-sync.service.test
 */

import { CloudSyncService, registerRetryDelay } from './cloud-sync.service.js';
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

import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';

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

/** One turn of the real event loop (fake timers do not cover Node's `timers` module) — lets real fs I/O land. */
const realTick = (): Promise<void> =>
  new Promise((resolve) => (jest.requireActual('timers') as typeof import('timers')).setImmediate(resolve));

/**
 * Wait until registration settles: it reads the id file with real fs, so a
 * single fake-timer flush is not always enough.
 *
 * @param svc - Service under test
 */
async function untilQueueId(svc: CloudSyncService): Promise<void> {
  for (let i = 0; i < 100 && svc.getQueueId() === null; i++) {
    await realTick();
    await flushPromises();
  }
}

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
 *
 * Advances time in small MESSAGE_POLL steps to avoid overshooting. The
 * message-poll loop only hits the network once a relay queue is registered
 * (50080b079), and with every fetch failing registration never succeeds, so
 * the failures that count are the heartbeat and device poll. The step budget
 * therefore covers MAX_CONSECUTIVE_FAILURES of the slower of those two loops.
 * Resets errorRecoveryAttempts so tests start fresh.
 */
async function driveIntoErrorState(svc: CloudSyncService): Promise<void> {
  const step = CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS;
  const slowestLoopMs = Math.max(
    CLOUD_SYNC_CONSTANTS.HEARTBEAT_INTERVAL_MS,
    CLOUD_SYNC_CONSTANTS.DEVICE_POLL_INTERVAL_MS,
  );
  const maxSteps = Math.ceil((CLOUD_SYNC_CONSTANTS.MAX_CONSECUTIVE_FAILURES * slowestLoopMs) / step) + 5;
  for (let i = 0; i < maxSteps; i++) {
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

/**
 * Every test in this file runs against a throwaway Crewly home. Set once for
 * the whole file and never unset between tests: a registration still in
 * flight when a test ends must not fall back to the real ~/.crewly (a random
 * queue id written there on 2026-10-02 cost the owner's Mac half an hour of
 * Slack).
 */
const TEST_CREWLY_HOME = path.join(os.tmpdir(), `cloud-sync-${process.pid}-${Math.random().toString(36).slice(2)}`);
const queueFile = path.join(TEST_CREWLY_HOME, 'cloud', 'relay-queue.json');
const previousCrewlyHome = process.env['CREWLY_HOME'];

beforeAll(() => { process.env['CREWLY_HOME'] = TEST_CREWLY_HOME; });
afterAll(async () => {
  if (previousCrewlyHome === undefined) delete process.env['CREWLY_HOME'];
  else process.env['CREWLY_HOME'] = previousCrewlyHome;
  await fsp.rm(TEST_CREWLY_HOME, { recursive: true, force: true });
});

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

  // ----- Message-poll watchdog ----------------------------------------------

  describe('checkMessagePollAlive (2026-09-23: loop went silent for ~50 min)', () => {
    it('leaves a loop alone that finished a cycle recently', () => {
      service.start(testConfig);
      (service as any).lastMessagePollAt = 1_000_000;
      expect(service.checkMessagePollAlive(1_000_000 + 30_000)).toBe(false);
    });

    it('restarts a loop that has not finished a cycle for too long, even if one is marked in flight', () => {
      service.start(testConfig);
      (service as any).lastMessagePollAt = 1_000_000;
      (service as any).messagePollRunning = true;
      const schedule = jest.spyOn(service as any, 'scheduleNextMessagePoll');

      expect(service.checkMessagePollAlive(1_000_000 + 120_000)).toBe(true);
      expect((service as any).messagePollRunning).toBe(false);
      expect(schedule).toHaveBeenCalledWith(0);
    });

    it('does nothing when stopped or before the first cycle', () => {
      service.start(testConfig);
      expect(service.checkMessagePollAlive(Date.now() + 10 * 60_000)).toBe(false);
      (service as any).lastMessagePollAt = 1;
      service.stop();
      expect(service.checkMessagePollAlive(10 * 60_000)).toBe(false);
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
      // Since cross-machine messaging moved to the relay queue (50080b079),
      // sendMessage routes by the target's cached sessionId, so the target
      // must be in the device cache.
      (service as any).devices = [makeDevice({ deviceId: 'dev-target', sessionId: 'session-target' })];
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
      await untilQueueId(service);

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

  // A machine whose owner signs in under a second Crewly account keeps
  // asking for a queue named after its deviceId, which the relay still
  // attributes to the first account. The 403 repeats on every boot, the
  // Slack heartbeat is skipped for want of a queue id, and Cloud marks the
  // instance stale — one MacBook sat deaf to Slack for two hours
  // (owner's MacBook Air, 2026-09-21).
  describe('registerQueue — the relay refuses our device-id queue', () => {
    afterEach(async () => {
      service.stop();
      await fsp.rm(path.dirname(queueFile), { recursive: true, force: true });
    });

    const registerCalls = () => mockFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/queue/register'),
    );
    /**
     * Registration reads and writes the fallback file, so it settles over
     * several turns of the microtask queue — more than one flush.
     *
     * @param n - How many register calls to wait for
     */
    const untilRegisterCalls = async (n: number): Promise<void> => {
      for (let i = 0; i < 50 && registerCalls().length < n; i++) await flushPromises();
    };
    const claimedId = (i: number) =>
      JSON.parse(String((registerCalls()[i]?.[1] as { body: string }).body)).deviceId as string;

    it('takes a fresh queue id after a 403 and remembers it', async () => {
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
      // Route by URL, not call order: start() also fires a heartbeat and a
      // device poll, and either can land before registration.
      let attempt = 0;
      mockFetch.mockImplementation(async (url) => {
        if (typeof url === 'string' && url.includes('/queue/register')) {
          attempt += 1;
          return attempt === 1
            ? mockResponse({ success: false, error: 'Not authorized to access this queue' }, 403)
            : mockResponse({ success: true, queueId: 'q-fresh', peerQueueId: null });
        }
        return mockResponse({ success: true });
      });

      service.start(configWithJwt);
      await untilRegisterCalls(2);

      expect(claimedId(0)).toBe(DEVICE_ID);          // asked for its own first
      expect(claimedId(1)).not.toBe(DEVICE_ID);      // then took a new one
      expect(service.getQueueId()).toBe('q-fresh');
      expect(service.getQueueError()).toBeNull();
      for (let i = 0; i < 50; i++) {
        if (await fsp.stat(queueFile).then(() => true, () => false)) break;
        await flushPromises();
      }
      expect(JSON.parse(await fsp.readFile(queueFile, 'utf-8')).queueId).toBe(claimedId(1));
    });

    it('reuses the remembered id on the next boot rather than minting another', async () => {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      await fsp.writeFile(queueFile, JSON.stringify({ queueId: 'q-remembered' }), 'utf-8');
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
      mockFetch.mockImplementation(async (url) =>
        typeof url === 'string' && url.includes('/queue/register')
          ? mockResponse({ success: true, queueId: 'q-remembered', peerQueueId: null })
          : mockResponse({ success: true }),
      );

      service.start(configWithJwt);
      await untilRegisterCalls(1);
      await flushPromises();

      expect(registerCalls()).toHaveLength(1);
      expect(claimedId(0)).toBe('q-remembered');
    });

    it('heartbeats under the queue it polls, so the portal does not pick the dead one', async () => {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      await fsp.writeFile(queueFile, JSON.stringify({ queueId: 'q-remembered' }), 'utf-8');
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
      mockFetch.mockImplementation(async (url) =>
        typeof url === 'string' && url.includes('/queue/register')
          ? mockResponse({ success: true, queueId: 'q-remembered', peerQueueId: null })
          : mockResponse({ success: true }),
      );

      service.start(configWithJwt);
      await untilRegisterCalls(1);
      for (let i = 0; i < 10; i++) await flushPromises();
      mockFetch.mockClear();

      await service.sendHeartbeat();

      const body = JSON.parse(String((mockFetch.mock.calls[0]?.[1] as { body: string }).body));
      expect(body.deviceId).toBe('q-remembered');
    });

    it('does not take a fresh id on a non-403 failure, and records why', async () => {
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
      mockFetch.mockImplementation(async (url) =>
        typeof url === 'string' && url.includes('/queue/register')
          ? mockResponse({ error: 'Internal' }, 500)
          : mockResponse({ success: true }),
      );

      service.start(configWithJwt);
      await untilRegisterCalls(1);
      await flushPromises();

      // A 500 is not a wrong-owner answer: no fresh id, just a later retry.
      expect(registerCalls()).toHaveLength(1);
      expect(service.getQueueId()).toBeNull();
      expect(service.getQueueError()).toContain('500');
      expect(await fsp.stat(queueFile).then(() => true, () => false)).toBe(false);
    });

    it('takes a fresh id when the remembered queue is refused too (account switched again)', async () => {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      await fsp.writeFile(queueFile, JSON.stringify({ queueId: 'q-old-account' }), 'utf-8');
      const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
      mockFetch.mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/queue/register')) {
          const id = JSON.parse(String((init as { body: string }).body)).deviceId as string;
          return id === 'q-old-account'
            ? mockResponse({ success: false, error: 'Not authorized to access this queue' }, 403)
            : mockResponse({ success: true, queueId: id, peerQueueId: null });
        }
        return mockResponse({ success: true });
      });

      service.start(configWithJwt);
      await untilRegisterCalls(2);
      for (let i = 0; i < 50; i++) {
        const raw = await fsp.readFile(queueFile, 'utf-8').catch(() => '');
        if (raw && !raw.includes('q-old-account')) break;
        await flushPromises();
      }

      expect(claimedId(0)).toBe('q-old-account');
      expect(service.getQueueId()).toBe(claimedId(1));
      expect(JSON.parse(await fsp.readFile(queueFile, 'utf-8')).queueId).toBe(claimedId(1));
    });
  });

  // A running machine must never move to another queue: every move left the
  // old queue behind on the relay and counted against the per-user quota.
  // On 2026-10-02 the owner's MacBook went f68e1995 → a8eeab1d → d5c4ebc2
  // without restarting, each time because relay-queue.json had been
  // rewritten underneath it; the last move hit 429 quota_exceeded.
  describe('registerQueue — one machine, one queue', () => {
    const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
    const registerCalls = () => mockFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/queue/register'),
    );
    const claimedIds = () => registerCalls().map(([, init]) =>
      JSON.parse(String((init as { body: string }).body)).deviceId as string);
    const echoRegister = () => mockFetch.mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.includes('/queue/register')) {
        const id = JSON.parse(String((init as { body: string }).body)).deviceId as string;
        return mockResponse({ success: true, queueId: id, peerQueueId: null });
      }
      return mockResponse({ success: true });
    });
    const settle = async (rounds = 20): Promise<void> => {
      for (let i = 0; i < rounds; i++) {
        await realTick();
        await flushPromises();
      }
    };
    /** Real fs work (read/write the id file) settles over real time, not fake timers. */
    const untilFile = async (predicate: (raw: string | null) => boolean): Promise<string | null> => {
      let raw: string | null = null;
      for (let i = 0; i < 200; i++) {
        raw = await fsp.readFile(queueFile, 'utf-8').catch(() => null);
        if (predicate(raw)) return raw;
        await realTick();
        await flushPromises();
      }
      return raw;
    };
    const writeQueueFile = async (queueId: string): Promise<void> => {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      await fsp.writeFile(queueFile, JSON.stringify({ queueId }), 'utf-8');
    };

    afterEach(async () => {
      service.stop();
      await fsp.rm(path.dirname(queueFile), { recursive: true, force: true });
    });

    it('keeps re-registering the queue it holds when the id file is rewritten, and restores the file', async () => {
      await writeQueueFile('q-held');
      echoRegister();

      service.start(configWithJwt);
      await settle();
      expect(service.getQueueId()).toBe('q-held');

      await writeQueueFile('q-intruder');
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.REGISTER_INTERVAL_MS);
      await settle();
      const raw = await untilFile((r) => !!r && r.includes('q-held'));

      expect(claimedIds()).toEqual(['q-held', 'q-held']);
      expect(service.getQueueId()).toBe('q-held');
      expect(JSON.parse(raw ?? '{}').queueId).toBe('q-held');
    });

    it('removes an id file that names a queue other than the device-id queue it holds', async () => {
      echoRegister();

      service.start(configWithJwt);
      await settle();
      expect(service.getQueueId()).toBe(DEVICE_ID);

      await writeQueueFile('q-intruder');
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.REGISTER_INTERVAL_MS);
      await settle();
      const raw = await untilFile((r) => r === null);

      expect(claimedIds()).toEqual([DEVICE_ID, DEVICE_ID]);
      expect(raw).toBeNull();
    });

    it('writes the id file under the Crewly home it started with, even if CREWLY_HOME changes meanwhile', async () => {
      const elsewhere = path.join(os.tmpdir(), `cloud-sync-elsewhere-${process.pid}-${Math.random().toString(36).slice(2)}`);
      let attempt = 0;
      mockFetch.mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/queue/register')) {
          attempt += 1;
          if (attempt === 1) return mockResponse({ success: false, error: 'Not authorized to access this queue' }, 403);
          // The caller's environment changes while the fresh registration is in flight.
          process.env['CREWLY_HOME'] = elsewhere;
          const id = JSON.parse(String((init as { body: string }).body)).deviceId as string;
          return mockResponse({ success: true, queueId: id, peerQueueId: null });
        }
        return mockResponse({ success: true });
      });

      try {
        service.start(configWithJwt);
        const raw = await untilFile((r) => r !== null);
        expect(JSON.parse(raw ?? '{}').queueId).toBe(service.getQueueId());
        expect(await fsp.stat(path.join(elsewhere, 'cloud', 'relay-queue.json')).then(() => true, () => false)).toBe(false);
      } finally {
        process.env['CREWLY_HOME'] = TEST_CREWLY_HOME;
        await fsp.rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('writes nothing when stopped while a fresh registration is in flight', async () => {
      let release: (r: Response) => void = () => {};
      let attempt = 0;
      mockFetch.mockImplementation(async (url) => {
        if (typeof url === 'string' && url.includes('/queue/register')) {
          attempt += 1;
          if (attempt === 1) return mockResponse({ success: false, error: 'Not authorized to access this queue' }, 403);
          return new Promise<Response>((resolve) => { release = resolve; });
        }
        return mockResponse({ success: true });
      });

      service.start(configWithJwt);
      await settle();
      expect(attempt).toBe(2);
      service.stop();
      release(mockResponse({ success: true, queueId: 'q-late', peerQueueId: null }));
      await settle(40);

      expect(service.getQueueId()).toBeNull();
      expect(await fsp.stat(queueFile).then(() => true, () => false)).toBe(false);
    });
  });

  // ----- registerQueue: retry --------------------------------------------------

  // 2026-10-02: one 429 quota_exceeded at boot and the Mac stayed deaf to
  // Slack until a person noticed. Registration must retry, back off, and
  // show why it is failing.
  describe('registerQueue — retries until the relay accepts', () => {
    const configWithJwt: CloudSyncConfig = { ...testConfig, token: buildJwt({ sub: 'user-abc-123' }) };
    const QUOTA = { success: false, error: 'quota_exceeded', limit: 8, current: 8 };
    const registerCount = () => mockFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/queue/register'),
    ).length;
    const pollCount = () => mockFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes(CLOUD_SYNC_CONSTANTS.ENDPOINTS.MESSAGES_POLL),
    ).length;
    const settle = async (rounds = 20): Promise<void> => {
      for (let i = 0; i < rounds; i++) {
        await realTick();
        await flushPromises();
      }
    };

    afterEach(async () => {
      service.stop();
      await fsp.rm(path.dirname(queueFile), { recursive: true, force: true });
    });

    it('backs off 30 s, 1 min, 2 min, 5 min, then every 5 min', () => {
      expect([1, 2, 3, 4, 5, 6, 50].map(registerRetryDelay))
        .toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000]);
    });

    it('retries a 429 on the backoff schedule, reports it in health, then starts polling once accepted', async () => {
      let refuse = true;
      mockFetch.mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/queue/register')) {
          if (refuse) return mockResponse(QUOTA, 429);
          const id = JSON.parse(String((init as { body: string }).body)).deviceId as string;
          return mockResponse({ success: true, queueId: id, peerQueueId: null });
        }
        return mockResponse({ success: true, messages: [] });
      });

      const t0 = Date.now();
      service.start(configWithJwt);
      await settle();

      expect(registerCount()).toBe(1);
      let health = service.getHealth().relayQueue!;
      expect(health.queueId).toBeNull();
      expect(health.error).toContain('429');
      expect(health.error).toContain('quota_exceeded');
      expect(health.failures).toBe(1);
      expect(health.failingSince).toBeGreaterThanOrEqual(t0);
      expect(health.nextAttemptAt! - Date.now()).toBe(30_000);
      expect(pollCount()).toBe(0); // nothing to poll without a queue

      // 30 s, then 60 s, then 120 s, then 300 s, then 300 s again.
      for (const [gap, expected] of [[30_000, 2], [60_000, 3], [120_000, 4], [300_000, 5], [300_000, 6]] as const) {
        jest.advanceTimersByTime(gap - 1);
        await settle();
        expect(registerCount()).toBe(expected - 1);
        jest.advanceTimersByTime(1);
        await settle();
        expect(registerCount()).toBe(expected);
      }
      health = service.getHealth().relayQueue!;
      expect(health.failures).toBe(6);
      expect(health.failingSince).toBeGreaterThanOrEqual(t0);

      refuse = false;
      jest.advanceTimersByTime(300_000);
      await settle();

      expect(registerCount()).toBe(7);
      health = service.getHealth().relayQueue!;
      expect(health).toMatchObject({ queueId: DEVICE_ID, error: null, failingSince: null, failures: 0 });
      expect(health.nextAttemptAt! - Date.now()).toBe(CLOUD_SYNC_CONSTANTS.REGISTER_INTERVAL_MS);
      expect(service.getQueueError()).toBeNull();

      // Polling picks the queue up on its next cycle.
      jest.advanceTimersByTime(CLOUD_SYNC_CONSTANTS.MESSAGE_POLL_INTERVAL_MS);
      await settle();
      expect(pollCount()).toBeGreaterThan(0);
    });

    it('stops retrying on stop()', async () => {
      mockFetch.mockImplementation(async (url) =>
        typeof url === 'string' && url.includes('/queue/register')
          ? mockResponse(QUOTA, 429)
          : mockResponse({ success: true }),
      );

      service.start(configWithJwt);
      await settle();
      expect(registerCount()).toBe(1);
      service.stop();
      jest.advanceTimersByTime(60 * 60_000);
      await settle();

      expect(registerCount()).toBe(1);
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
      await untilQueueId(service);

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

    it('long-polls with ?wait= once a queueId is registered', async () => {
      service.start(testConfig);
      await flushPromises();
      // Simulate a successful registration so pollMessages proceeds.
      (service as unknown as { queueId: string }).queueId = 'q-abc';

      mockFetch.mockClear();
      mockFetch.mockResolvedValue(mockResponse({ success: true, messages: [] }));

      await service.pollMessages();

      const pollCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/queue/poll'),
      );
      expect(pollCall).toBeDefined();
      const url = pollCall![0] as string;
      expect(url).toContain('queueId=q-abc');
      expect(url).toContain(`wait=${CLOUD_SYNC_CONSTANTS.MESSAGE_LONGPOLL_WAIT_MS}`);
    });
  });

  // ----- getHealth + re-login restart (Cloud disconnect notice) ----------

  describe('getHealth and restart after a lost sign-in', () => {
    it('reports never-contacted before start and records contact on a good heartbeat', async () => {
      expect(service.getHealth()).toEqual({
        state: 'stopped',
        lastContactAt: null,
        startedAt: null,
        authRejected: false,
        relayQueue: { queueId: null, error: null, failingSince: null, failures: 0, nextAttemptAt: null },
      });
      service.start(testConfig);
      await flushPromises();
      const health = service.getHealth();
      expect(health.state).toBe('syncing');
      expect(health.startedAt).not.toBeNull();
      expect(health.lastContactAt).not.toBeNull();
      expect(health.authRejected).toBe(false);
    });

    it('does not record contact while every request fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network down'));
      service.start(testConfig);
      await flushPromises();
      await service.sendHeartbeat();
      expect(service.getHealth()).toMatchObject({ lastContactAt: null, authRejected: false });
    });

    it('flags authRejected when Cloud refuses and the token refresh fails, clears it on contact', async () => {
      mockFetch.mockResolvedValue(mockResponse({}, 401));
      service.start(testConfig);
      await flushPromises();
      await service.sendHeartbeat();
      expect(service.getHealth()).toMatchObject({ lastContactAt: null, authRejected: true });

      mockFetch.mockResolvedValue(mockResponse({ success: true }));
      await service.sendHeartbeat();
      expect(service.getHealth().authRejected).toBe(false);
      expect(service.getHealth().lastContactAt).not.toBeNull();
    });

    it('start() after auth_expired resets and syncs again (re-login)', async () => {
      service.start(testConfig);
      await flushPromises();
      (service as any).enterAuthExpiredState();
      expect(service.getState()).toBe('auth_expired');

      service.start({ ...testConfig, token: 'new-token' });
      await flushPromises();
      expect(service.getHealth()).toMatchObject({ state: 'syncing', authRejected: false });
      expect((service as any).config.token).toBe('new-token');
    });

    it('start() while in error does not leave the old timers running', async () => {
      service.start(testConfig);
      await flushPromises();
      (service as any).state = 'error';
      (service as any).scheduleErrorRecovery();
      const oldHeartbeat = (service as any).heartbeatTimer;
      const clearSpy = jest.spyOn(global, 'clearInterval');

      service.start({ ...testConfig, token: 'new-token' });

      expect(clearSpy).toHaveBeenCalledWith(oldHeartbeat);
      expect((service as any).errorRecoveryTimer).toBeNull();
      expect(service.getState()).toBe('syncing');
      clearSpy.mockRestore();
    });
  });
});
