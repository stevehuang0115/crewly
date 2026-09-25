/**
 * Tests for the backend's background device pairing: start (idempotent),
 * approval → connect by itself, deny / expiry / cancel / errors, and that
 * status never carries a secret. Placeholder values only.
 *
 * @module services/cloud/cloud-device-pairing.service.test
 */

import { CloudDevicePairingService, type CloudDevicePairingDeps } from './cloud-device-pairing.service.js';
import type { DevicePairingOutcome, DevicePairingStartResult, WaitForApprovalOptions } from './cloud-device-pairing.client.js';

const STARTED: DevicePairingStartResult = {
  deviceCode: 'device-secret-never-shown',
  userCode: 'ABCD-2345',
  verificationUrl: 'https://portal.example.test/cloud/pair?code=ABCD-2345',
  verificationUri: 'https://portal.example.test/cloud/pair',
  expiresIn: 900,
  interval: 5,
};

const T0 = Date.parse('2026-09-25T00:00:00.000Z');

/** A deferred promise the test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as CloudDevicePairingDeps['logger'];

describe('CloudDevicePairingService', () => {
  let now: number;
  let outcome: ReturnType<typeof deferred<DevicePairingOutcome>>;
  let start: jest.Mock;
  let wait: jest.Mock;
  let connect: jest.Mock;
  let service: CloudDevicePairingService;

  beforeEach(() => {
    now = T0;
    outcome = deferred<DevicePairingOutcome>();
    start = jest.fn().mockResolvedValue(STARTED);
    wait = jest.fn((_opts: WaitForApprovalOptions) => outcome.promise);
    connect = jest.fn().mockResolvedValue({ tier: 'solo' });
    service = new CloudDevicePairingService({
      cloudUrl: () => 'https://api.example.test',
      identity: async () => ({ deviceId: 'dev-1', deviceName: 'studio-mac' }),
      connect,
      start,
      wait,
      now: () => now,
      logger: silentLogger,
    });
  });

  it('starts a pairing with this machine’s identity and shows only the link and code', async () => {
    const status = await service.start();
    expect(start).toHaveBeenCalledWith('https://api.example.test', { deviceName: 'studio-mac', deviceId: 'dev-1', purpose: 'setup' });
    expect(status).toEqual({
      state: 'pending',
      userCode: 'ABCD-2345',
      verificationUrl: STARTED.verificationUrl,
      verificationUri: STARTED.verificationUri,
      expiresAt: new Date(T0 + 900_000).toISOString(),
      deviceName: 'studio-mac',
    });
    expect(JSON.stringify(service.getStatus())).not.toContain('device-secret');
  });

  it('is idempotent while pending (reloading the page keeps the same code)', async () => {
    await service.start();
    await service.start();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('connects by itself once the owner approves, without exposing tokens', async () => {
    await service.start({ deviceName: 'My Mac' });
    outcome.resolve({ status: 'approved', credentials: { token: 'access-x', refreshToken: 'refresh-x', tier: 'solo', email: 'o@example.test' } });
    await service.settled();
    expect(connect).toHaveBeenCalledWith({ token: 'access-x', refreshToken: 'refresh-x', tier: 'solo', email: 'o@example.test' });
    const status = service.getStatus();
    expect(status).toEqual({ state: 'connected', deviceName: 'My Mac', tier: 'solo', email: 'o@example.test' });
    expect(JSON.stringify(status)).not.toMatch(/access-x|refresh-x/);
  });

  it('reports denied and expired, and a new start begins a fresh pairing', async () => {
    await service.start();
    outcome.resolve({ status: 'denied' });
    await service.settled();
    expect(service.getStatus().state).toBe('denied');
    expect(connect).not.toHaveBeenCalled();

    outcome = deferred<DevicePairingOutcome>();
    await service.start();
    expect(start).toHaveBeenCalledTimes(2);
    outcome.resolve({ status: 'expired' });
    await service.settled();
    expect(service.getStatus().state).toBe('expired');
  });

  it('reads as expired once the lifetime passes, even before the poller notices', async () => {
    await service.start();
    now = T0 + 900_000;
    expect(service.getStatus().state).toBe('expired');
    await service.start();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('cancel aborts the background wait and ignores its late result', async () => {
    await service.start();
    const signal = (wait.mock.calls[0][0] as WaitForApprovalOptions).signal!;
    expect(service.cancel().state).toBe('cancelled');
    expect(signal.aborted).toBe(true);
    outcome.resolve({ status: 'approved', credentials: { token: 't', refreshToken: 'r', tier: 'free' } });
    await service.settled();
    expect(connect).not.toHaveBeenCalled();
    expect(service.getStatus().state).toBe('cancelled');
  });

  it('a failed connect or poll becomes an error state', async () => {
    connect.mockRejectedValueOnce(new Error('Cloud authentication failed'));
    await service.start();
    outcome.resolve({ status: 'approved', credentials: { token: 't', refreshToken: 'r', tier: 'free' } });
    await service.settled();
    expect(service.getStatus()).toMatchObject({ state: 'error', error: 'Cloud authentication failed' });

    outcome = deferred<DevicePairingOutcome>();
    await service.start();
    outcome.reject(new Error('Crewly Cloud unreachable'));
    await service.settled();
    expect(service.getStatus()).toMatchObject({ state: 'error', error: 'Crewly Cloud unreachable' });
  });

  it('start propagates a Cloud refusal and stays idle', async () => {
    start.mockRejectedValueOnce(new Error('Too many pairing requests'));
    await expect(service.start()).rejects.toThrow('Too many pairing requests');
    expect(service.getStatus()).toEqual({ state: 'idle' });
  });
});
