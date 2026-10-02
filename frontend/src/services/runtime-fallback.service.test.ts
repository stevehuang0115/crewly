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
    default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

  it('adds, signs in and removes a Claude Code account (#942)', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { login: { account: 'work' } } } });
    await runtimeFallbackService.addClaudeAccount('work');
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-fallback/claude-accounts', { name: 'work' });
    await runtimeFallbackService.signInClaudeAccount('work');
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-fallback/claude-accounts/work/login', {});
    mocked.delete.mockResolvedValue({ data: { success: true, data: { claudeAccounts: [] } } });
    await runtimeFallbackService.removeClaudeAccount('work');
    expect(mocked.delete).toHaveBeenCalledWith('/api/system/runtime-fallback/claude-accounts/work');
  });

  it('starts and reads smoke tests', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { jobId: 'j1', state: 'running' } } });
    await expect(runtimeFallbackService.startSmokeTest('crewly-agent')).resolves.toMatchObject({ jobId: 'j1' });
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-smoke-test', { runtime: 'crewly-agent' });
    mocked.get.mockResolvedValue({ data: { success: true, data: { jobId: 'j1', state: 'done' } } });
    await expect(runtimeFallbackService.getSmokeTest('j1')).resolves.toMatchObject({ state: 'done' });
    expect(mocked.get).toHaveBeenCalledWith('/api/system/runtime-smoke-test/j1');
  });

  it('reads, requests, probes and answers runtime Terms', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: [{ runtime: 'antigravity-cli', status: 'pending' }] } });
    await expect(runtimeFallbackService.getTerms()).resolves.toHaveLength(1);
    expect(mocked.get).toHaveBeenCalledWith('/api/system/runtime-terms');
    mocked.post.mockResolvedValue({ data: { success: true, data: { runtime: 'antigravity-cli', status: 'pending' } } });
    await runtimeFallbackService.requestTerms('antigravity-cli');
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-terms/antigravity-cli/request', {});
    await runtimeFallbackService.probeTerms('antigravity-cli');
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-terms/antigravity-cli/probe', {});
    await runtimeFallbackService.answerTerms('antigravity-cli', 'agree_no_data');
    expect(mocked.post).toHaveBeenCalledWith('/api/system/runtime-terms/antigravity-cli/answer', { choice: 'agree_no_data' });
  });
});
