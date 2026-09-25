/**
 * Tests for the Cloud device-code pairing client: start, poll, and the
 * wait loop (interval, slow_down, 429 back-off, transient errors, expiry,
 * deny, cancel). Placeholder values only.
 *
 * @module services/cloud/cloud-device-pairing.client.test
 */

import {
  startCloudDevicePairing,
  pollCloudDevicePairing,
  waitForCloudDeviceApproval,
  abortableSleep,
  DevicePairingError,
  type DevicePairingStartResult,
  type FetchLike,
} from './cloud-device-pairing.client.js';

const CLOUD = 'https://api.example.test/';

/** A JSON Response. */
function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch double that answers from a queue. */
function queuedFetch(...responses: Array<Response | Error>): jest.Mock & FetchLike {
  const queue = [...responses];
  return jest.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  }) as jest.Mock & FetchLike;
}

const STARTED: DevicePairingStartResult = {
  deviceCode: 'device-secret',
  userCode: 'ABCD-2345',
  verificationUrl: 'https://portal.example.test/cloud/pair?code=ABCD-2345',
  expiresIn: 900,
  interval: 5,
};

describe('cloud-device-pairing.client', () => {
  describe('startCloudDevicePairing', () => {
    it('posts the device intro and returns the pairing', async () => {
      const fetchImpl = queuedFetch(reply(200, { success: true, data: { ...STARTED, verificationUri: 'https://portal.example.test/cloud/pair' } }));
      const started = await startCloudDevicePairing(CLOUD, { deviceName: 'mac', deviceId: 'd1', purpose: 'cli' }, fetchImpl);
      expect(started).toEqual({ ...STARTED, verificationUri: 'https://portal.example.test/cloud/pair' });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.example.test/api/cloud/device/start');
      expect(JSON.parse(init.body)).toEqual({ deviceName: 'mac', deviceId: 'd1', purpose: 'cli' });
    });

    it('fills in default lifetime and interval', async () => {
      const fetchImpl = queuedFetch(reply(200, { success: true, data: { deviceCode: 'd', userCode: 'u', verificationUrl: 'v' } }));
      expect(await startCloudDevicePairing(CLOUD, { deviceName: 'x' }, fetchImpl)).toMatchObject({ expiresIn: 900, interval: 5 });
    });

    it('surfaces a refusal (429 is retryable, 400 is not)', async () => {
      await expect(startCloudDevicePairing(CLOUD, { deviceName: 'x' }, queuedFetch(reply(429, { success: false, error: 'Too many pairing requests' }))))
        .rejects.toMatchObject({ status: 429, retryable: true, message: 'Too many pairing requests' });
      await expect(startCloudDevicePairing(CLOUD, { deviceName: 'x' }, queuedFetch(reply(400, { success: false, error: 'bad' }))))
        .rejects.toMatchObject({ status: 400, retryable: false });
      await expect(startCloudDevicePairing(CLOUD, { deviceName: 'x' }, queuedFetch(new Error('ENOTFOUND'))))
        .rejects.toMatchObject({ status: 0, retryable: true });
      await expect(startCloudDevicePairing(CLOUD, { deviceName: 'x' }, queuedFetch(reply(200, { success: true, data: {} }))))
        .rejects.toBeInstanceOf(DevicePairingError);
    });
  });

  describe('pollCloudDevicePairing', () => {
    it('maps every status', async () => {
      const f = queuedFetch(
        reply(200, { success: true, data: { status: 'authorization_pending', interval: 5 } }),
        reply(200, { success: true, data: { status: 'slow_down', interval: 10 } }),
        reply(200, { success: true, data: { status: 'denied' } }),
        reply(200, { success: true, data: { status: 'expired' } }),
        reply(200, { success: true, data: { status: 'approved', token: 't', refreshToken: 'r', tier: 'solo', email: 'o@example.test' } }),
      );
      expect(await pollCloudDevicePairing(CLOUD, 'dc', f)).toEqual({ status: 'authorization_pending', interval: 5 });
      expect(await pollCloudDevicePairing(CLOUD, 'dc', f)).toEqual({ status: 'slow_down', interval: 10 });
      expect(await pollCloudDevicePairing(CLOUD, 'dc', f)).toEqual({ status: 'denied' });
      expect(await pollCloudDevicePairing(CLOUD, 'dc', f)).toEqual({ status: 'expired' });
      expect(await pollCloudDevicePairing(CLOUD, 'dc', f)).toEqual({
        status: 'approved',
        credentials: { token: 't', refreshToken: 'r', tier: 'solo', email: 'o@example.test' },
      });
      expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ deviceCode: 'dc' });
    });

    it('rejects an approval without tokens and unknown statuses', async () => {
      await expect(pollCloudDevicePairing(CLOUD, 'dc', queuedFetch(reply(200, { success: true, data: { status: 'approved' } })))).rejects.toThrow('no tokens');
      await expect(pollCloudDevicePairing(CLOUD, 'dc', queuedFetch(reply(200, { success: true, data: { status: '??' } })))).rejects.toThrow('Unexpected');
    });
  });

  describe('waitForCloudDeviceApproval', () => {
    /** Instant sleep that records the requested delays and advances the clock. */
    function harness() {
      let clock = 0;
      const delays: number[] = [];
      return {
        delays,
        now: () => clock,
        sleep: async (ms: number) => {
          delays.push(ms);
          clock += ms;
        },
      };
    }

    it('polls at the interval, backs off on slow_down and 429, and returns the credentials', async () => {
      const h = harness();
      const fetchImpl = queuedFetch(
        reply(200, { success: true, data: { status: 'authorization_pending', interval: 5 } }),
        reply(200, { success: true, data: { status: 'slow_down', interval: 10 } }),
        reply(429, { success: false, error: 'Polling too often' }),
        new Error('ECONNRESET'),
        reply(200, { success: true, data: { status: 'approved', token: 't', refreshToken: 'r', tier: 'free' } }),
      );
      const seen: string[] = [];
      const outcome = await waitForCloudDeviceApproval({
        cloudUrl: CLOUD,
        start: STARTED,
        fetchImpl,
        sleep: h.sleep,
        now: h.now,
        onPoll: (status) => seen.push(status),
      });
      expect(outcome).toEqual({ status: 'approved', credentials: { token: 't', refreshToken: 'r', tier: 'free' } });
      expect(h.delays).toEqual([5000, 5000, 10000, 15000, 15000]);
      expect(seen).toEqual(['authorization_pending', 'slow_down', 'approved']);
    });

    it('returns denied / expired from the Cloud', async () => {
      const h = harness();
      expect(await waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: STARTED, fetchImpl: queuedFetch(reply(200, { success: true, data: { status: 'denied' } })), sleep: h.sleep, now: h.now }))
        .toEqual({ status: 'denied' });
      expect(await waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: STARTED, fetchImpl: queuedFetch(reply(200, { success: true, data: { status: 'expired' } })), sleep: h.sleep, now: h.now }))
        .toEqual({ status: 'expired' });
    });

    it('expires locally once the lifetime has passed, without polling again', async () => {
      const h = harness();
      const fetchImpl = queuedFetch();
      const outcome = await waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: { ...STARTED, expiresIn: 3, interval: 5 }, fetchImpl, sleep: h.sleep, now: h.now });
      expect(outcome).toEqual({ status: 'expired' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('stops when cancelled', async () => {
      const controller = new AbortController();
      const fetchImpl = queuedFetch();
      controller.abort();
      expect(await waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: STARTED, fetchImpl, signal: controller.signal })).toEqual({ status: 'cancelled' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('gives up after too many consecutive errors, and on a non-retryable refusal', async () => {
      const h = harness();
      const errors = Array.from({ length: 11 }, () => new Error('down'));
      await expect(waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: STARTED, fetchImpl: queuedFetch(...errors), sleep: h.sleep, now: h.now }))
        .rejects.toMatchObject({ status: 0 });
      await expect(waitForCloudDeviceApproval({ cloudUrl: CLOUD, start: STARTED, fetchImpl: queuedFetch(reply(400, { success: false, error: 'Missing deviceCode' })), sleep: h.sleep, now: h.now }))
        .rejects.toMatchObject({ status: 400 });
    });
  });

  describe('abortableSleep', () => {
    it('resolves early on abort and immediately when already aborted', async () => {
      const controller = new AbortController();
      const pending = abortableSleep(60_000, controller.signal);
      controller.abort();
      await expect(pending).resolves.toBeUndefined();
      await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
      await expect(abortableSleep(1)).resolves.toBeUndefined();
    });
  });
});
