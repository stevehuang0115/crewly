/**
 * Tests for the shared-channel norms API client.
 *
 * @module services/shared-channel-norms.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { SHARED_CHANNEL_NORMS_API, linkIdOfExternalChannel, sharedChannelNormsService } from './shared-channel-norms.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), put: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);
const NORMS = { linkId: 'l1', norm: 'Printer', allow: ['money'], updatedAt: null, allowances: [] };

describe('sharedChannelNormsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps an external channel id to its link id', () => {
    expect(linkIdOfExternalChannel('external-l1')).toBe('l1');
    expect(linkIdOfExternalChannel('external-')).toBeNull();
    expect(linkIdOfExternalChannel('ch-general')).toBeNull();
  });

  it('reads and saves a norm', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: NORMS } });
    await expect(sharedChannelNormsService.get('l1')).resolves.toEqual(NORMS);
    expect(mocked.get).toHaveBeenCalledWith('/api/shared-channels/l1/norms');
    mocked.put.mockResolvedValue({ data: { success: true, data: NORMS } });
    await sharedChannelNormsService.save('l1', { norm: 'Printer', allow: ['money'] });
    expect(mocked.put).toHaveBeenCalledWith(SHARED_CHANNEL_NORMS_API.norms('l1'), { norm: 'Printer', allow: ['money'] });
  });

  it("surfaces the server's error", async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { success: false, error: 'secret can never be allowed by a norm' } },
    });
    mocked.put.mockRejectedValue(err);
    await expect(sharedChannelNormsService.save('l1', { allow: ['secret'] })).rejects.toThrow('secret can never be allowed');
  });

  it('fails when the server answers without data', async () => {
    mocked.get.mockResolvedValue({ data: { success: false } });
    await expect(sharedChannelNormsService.get('l1')).rejects.toThrow('Could not load the norm');
  });
});
