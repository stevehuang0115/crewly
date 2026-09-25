/**
 * Tests for the bundle API client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { bundleService, BundleRequestError } from './bundle.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);

/** An axios-like error with a response body. */
function axiosError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
}

describe('bundleService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getBundle reads the detail', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { bundle: { id: 'smb' }, deployment: null } } });
    await expect(bundleService.getBundle('smb')).resolves.toEqual({ bundle: { id: 'smb' }, deployment: null });
    expect(mocked.get).toHaveBeenCalledWith('/api/bundles/smb');
  });

  it('apply posts the answers and the runtime, and returns the deployment', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { jobId: 'j', deployment: { jobId: 'j', status: 'running' } } } });
    await expect(bundleService.apply('smb', { business_name: 'x' }, 'crewly-agent')).resolves.toEqual({ jobId: 'j', status: 'running' });
    expect(mocked.post).toHaveBeenCalledWith('/api/bundles/apply', { templateId: 'smb', answers: { business_name: 'x' }, runtime: 'crewly-agent' });
    await bundleService.apply('smb', {});
    expect(mocked.post).toHaveBeenLastCalledWith('/api/bundles/apply', { templateId: 'smb', answers: {} });
  });

  it('apply surfaces the missing answers of a 400', async () => {
    mocked.post.mockRejectedValue(axiosError(400, { success: false, code: 'invalid_answers', error: '还没回答：名字', missing: [{ id: 'business_name', label: '名字', reason: '必填' }] }));
    const error = await bundleService.apply('smb', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BundleRequestError);
    expect((error as BundleRequestError).code).toBe('invalid_answers');
    expect((error as BundleRequestError).missing.map((m) => m.id)).toEqual(['business_name']);
    expect((error as Error).message).toBe('还没回答：名字');
  });

  it('getJob reads progress; an unsuccessful envelope becomes an error', async () => {
    mocked.get.mockResolvedValueOnce({ data: { success: true, data: { jobId: 'j', status: 'done' } } });
    await expect(bundleService.getJob('j')).resolves.toEqual({ jobId: 'j', status: 'done' });
    expect(mocked.get).toHaveBeenCalledWith('/api/bundles/apply/j');
    mocked.get.mockResolvedValueOnce({ data: { success: false, error: 'nope' } });
    await expect(bundleService.getJob('j')).rejects.toThrow('nope');
  });
});
