/**
 * Tests for the runtime fallback service.
 *
 * @module services/runtime-fallback.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { runtimeFallbackService, RUNTIME_FALLBACK_API } from './runtime-fallback.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);

describe('runtimeFallbackService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getState unwraps the envelope', async () => {
    const data = { settings: {}, runtimes: [], exhausted: [], overrides: [] };
    mocked.get.mockResolvedValue({ data: { success: true, data } });
    await expect(runtimeFallbackService.getState()).resolves.toEqual(data);
    expect(mocked.get).toHaveBeenCalledWith(RUNTIME_FALLBACK_API.STATE);
  });

  it('updateSettings PUTs the patch and surfaces a validation error', async () => {
    mocked.put.mockResolvedValue({ data: { success: true, data: { ok: 1 } } });
    await runtimeFallbackService.updateSettings({ chain: ['claude-code'] });
    expect(mocked.put).toHaveBeenCalledWith('/api/system/runtime-fallback/settings', { chain: ['claude-code'] });

    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { success: false, error: 'chain has an unknown runtime: x' } },
    });
    mocked.put.mockRejectedValue(err);
    await expect(runtimeFallbackService.updateSettings({ chain: ['x'] })).rejects.toThrow('chain has an unknown runtime: x');
  });

  it('starts and reads smoke tests', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { jobId: 'j1', state: 'running' } } });
    await expect(runtimeFallbackService.startSmokeTest('crewly-agent')).resolves.toMatchObject({ jobId: 'j1' });
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-smoke-test', { runtime: 'crewly-agent' });
    mocked.get.mockResolvedValue({ data: { success: true, data: { jobId: 'j1', state: 'done' } } });
    await expect(runtimeFallbackService.getSmokeTest('j1')).resolves.toMatchObject({ state: 'done' });
    expect(mocked.get).toHaveBeenCalledWith('/api/system/runtime-smoke-test/j1');
  });
});
