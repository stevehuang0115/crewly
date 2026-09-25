/**
 * Tests for the harness service.
 *
 * @module services/harness.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { harnessService, asLoginSession } from './harness.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);

describe('harnessService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus unwraps the envelope', async () => {
    const data = { harnesses: [], orcHarness: null, systemTools: [] };
    mocked.get.mockResolvedValue({ data: { success: true, data } });
    await expect(harnessService.getStatus()).resolves.toEqual(data);
    expect(mocked.get).toHaveBeenCalledWith('/api/harness');
  });

  it('throws the server error when success is false', async () => {
    mocked.get.mockResolvedValue({ data: { success: false, error: 'boom' } });
    await expect(harnessService.getStatus()).rejects.toThrow('boom');
  });

  it('surfaces the error body of a rejected axios request', async () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { success: false, error: 'not installed' } },
    });
    mocked.post.mockRejectedValue(err);
    await expect(harnessService.startLogin('claude-code', 'subscription')).rejects.toThrow('not installed');
  });

  it('startInstall returns the job id', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { jobId: 'j1' } } });
    await expect(harnessService.startInstall('codex-cli')).resolves.toBe('j1');
    expect(mocked.post).toHaveBeenCalledWith('/api/harness/codex-cli/install');
  });

  it('getInstallJob polls the job endpoint', async () => {
    const job = { state: 'running', log: 'x', usedUserPrefix: false };
    mocked.get.mockResolvedValue({ data: { success: true, data: job } });
    await expect(harnessService.getInstallJob('j1')).resolves.toEqual(job);
    expect(mocked.get).toHaveBeenCalledWith('/api/harness/install/j1');
  });

  it('setOrcHarness PUTs the harness id', async () => {
    mocked.put.mockResolvedValue({ data: { success: true, data: { orcHarness: 'codex-cli' } } });
    await expect(harnessService.setOrcHarness('codex-cli')).resolves.toBe('codex-cli');
    expect(mocked.put).toHaveBeenCalledWith('/api/harness/orc', { harnessId: 'codex-cli' });
  });

  it('login endpoints use the contract paths and bodies', async () => {
    const s = { id: 's1', state: 'starting' };
    mocked.post.mockResolvedValue({ data: { success: true, data: s } });
    mocked.get.mockResolvedValue({ data: { success: true, data: s } });

    await harnessService.startLogin('codex-cli', 'device');
    expect(mocked.post).toHaveBeenCalledWith('/api/harness/codex-cli/login', { method: 'device' });

    await harnessService.getLoginSession('s1');
    expect(mocked.get).toHaveBeenCalledWith('/api/harness/login/s1');

    await harnessService.sendLoginInput('s1', 'CODE');
    expect(mocked.post).toHaveBeenCalledWith('/api/harness/login/s1/input', { text: 'CODE' });

    await harnessService.cancelLogin('s1');
    expect(mocked.post).toHaveBeenCalledWith('/api/harness/login/s1/cancel');
  });

  it('setApiKey posts the key and returns the harness status', async () => {
    const status = { id: 'claude-code', loginState: 'logged_in' };
    mocked.post.mockResolvedValue({ data: { success: true, data: status } });
    await expect(harnessService.setApiKey('claude-code', 'sk-test')).resolves.toEqual(status);
    expect(mocked.post).toHaveBeenCalledWith('/api/harness/claude-code/api-key', { key: 'sk-test' });
  });

  it('input/cancel accept a response without a session payload', async () => {
    mocked.post.mockResolvedValue({ data: { success: true } });
    await expect(harnessService.sendLoginInput('s1', 'x')).resolves.toBeNull();
    await expect(harnessService.cancelLogin('s1')).resolves.toBeNull();
  });

  it('input still throws on success:false', async () => {
    mocked.post.mockResolvedValue({ data: { success: false, error: 'session ended' } });
    await expect(harnessService.sendLoginInput('s1', 'x')).rejects.toThrow('session ended');
  });

  it('asLoginSession narrows payloads', () => {
    expect(asLoginSession({ id: 's', state: 'starting' })).toEqual({ id: 's', state: 'starting' });
    expect(asLoginSession({ ok: true })).toBeNull();
    expect(asLoginSession(null)).toBeNull();
  });
});
