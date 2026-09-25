/**
 * Tests for the frontend device pairing client.
 *
 * @module services/cloud-device-pairing.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { cloudDevicePairingService } from './cloud-device-pairing.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn(), post: vi.fn() } };
});

const mocked = vi.mocked(axios);

describe('cloudDevicePairingService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('start posts to the backend and unwraps the status', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { state: 'pending', userCode: 'ABCD-2345' } } });
    expect(await cloudDevicePairingService.start()).toEqual({ state: 'pending', userCode: 'ABCD-2345' });
    expect(mocked.post).toHaveBeenCalledWith('/api/cloud/device/start', {});
    await cloudDevicePairingService.start('Office Mac');
    expect(mocked.post).toHaveBeenLastCalledWith('/api/cloud/device/start', { deviceName: 'Office Mac' });
  });

  it('status and cancel hit their endpoints', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { state: 'connected', tier: 'free' } } });
    expect((await cloudDevicePairingService.status()).state).toBe('connected');
    expect(mocked.get).toHaveBeenCalledWith('/api/cloud/device/status');
    mocked.post.mockResolvedValue({ data: { success: true, data: { state: 'cancelled' } } });
    expect((await cloudDevicePairingService.cancel()).state).toBe('cancelled');
    expect(mocked.post).toHaveBeenCalledWith('/api/cloud/device/cancel');
  });

  it('surfaces the server error', async () => {
    const err = Object.assign(new Error('Request failed'), { isAxiosError: true, response: { data: { success: false, error: 'Too many pairing requests' } } });
    mocked.post.mockRejectedValue(err);
    await expect(cloudDevicePairingService.start()).rejects.toThrow('Too many pairing requests');
    mocked.get.mockResolvedValue({ data: { success: false, error: 'nope' } });
    await expect(cloudDevicePairingService.status()).rejects.toThrow('nope');
  });
});
