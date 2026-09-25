/**
 * Tests for the onboarding checklist service.
 *
 * @module services/onboarding-checklist.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { onboardingChecklistService } from './onboarding-checklist.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn() },
    isAxiosError: actual.isAxiosError,
  };
});

const mocked = vi.mocked(axios);

describe('onboardingChecklistService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getChecklist unwraps the envelope', async () => {
    const data = { steps: [], doneCount: 0, total: 5, allDone: false, dismissed: false, dismissedAt: null };
    mocked.get.mockResolvedValue({ data: { success: true, data } });
    await expect(onboardingChecklistService.getChecklist()).resolves.toEqual(data);
    expect(mocked.get).toHaveBeenCalledWith('/api/onboarding/checklist');
  });

  it('setDismissed posts the flag', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { dismissed: true } } });
    await onboardingChecklistService.setDismissed(true);
    expect(mocked.post).toHaveBeenCalledWith('/api/onboarding/checklist/dismiss', { dismissed: true });
  });

  it('getStarters returns the list', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { starters: [{ id: 'blank' }] } } });
    await expect(onboardingChecklistService.getStarters()).resolves.toEqual([{ id: 'blank' }]);
  });

  it('createStarterTeam posts the starter id', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { starterId: 'blank', team: null, created: false } } });
    await onboardingChecklistService.createStarterTeam('blank');
    expect(mocked.post).toHaveBeenCalledWith('/api/onboarding/starter-team', { starterId: 'blank' });
  });

  it('sendFirstTask includes the team only when given', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { forwarded: true } } });
    await onboardingChecklistService.sendFirstTask('Plan my week', 't1');
    expect(mocked.post).toHaveBeenLastCalledWith('/api/onboarding/first-task', { text: 'Plan my week', teamId: 't1' });
    await onboardingChecklistService.sendFirstTask('Hi', null);
    expect(mocked.post).toHaveBeenLastCalledWith('/api/onboarding/first-task', { text: 'Hi' });
  });

  it('surfaces the server message of a refused first task', async () => {
    const err = Object.assign(new Error('Request failed with status code 503'), {
      isAxiosError: true,
      response: { data: { success: false, error: 'Orchestrator is not running.' } },
    });
    mocked.post.mockRejectedValue(err);
    await expect(onboardingChecklistService.sendFirstTask('Hi')).rejects.toThrow('Orchestrator is not running.');
  });

  it('connectCloud posts the token and the refresh token', async () => {
    mocked.post.mockResolvedValue({ data: { success: true, data: { tier: 'free' } } });
    await expect(onboardingChecklistService.connectCloud('t', 'r')).resolves.toEqual({ tier: 'free' });
    expect(mocked.post).toHaveBeenLastCalledWith('/api/cloud/connect', { token: 't', refreshToken: 'r' });
    await onboardingChecklistService.connectCloud('t');
    expect(mocked.post).toHaveBeenLastCalledWith('/api/cloud/connect', { token: 't' });
  });

  it('getSlackInstallUrl passes the return URL', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { url: 'https://api.crewlyai.com/slack' } } });
    await expect(onboardingChecklistService.getSlackInstallUrl('http://h/setup?step=slack')).resolves.toBe('https://api.crewlyai.com/slack');
    expect(mocked.get).toHaveBeenCalledWith('/api/slack/cloud/install-url', { params: { returnUrl: 'http://h/setup?step=slack' } });
  });

  it('refreshSlack asks the backend to re-read Slack from Cloud', async () => {
    mocked.get.mockResolvedValue({ data: { success: true, data: { connected: true, cloudConnected: true } } });
    await expect(onboardingChecklistService.refreshSlack()).resolves.toEqual({ connected: true, cloudConnected: true });
    expect(mocked.get).toHaveBeenCalledWith('/api/slack/cloud/status', { params: { refresh: '1' } });
  });

  it('throws a fallback message on an empty success', async () => {
    mocked.get.mockResolvedValue({ data: { success: true } });
    await expect(onboardingChecklistService.getChecklist()).rejects.toThrow('无法读取设置清单');
  });

  it('rethrows non-axios errors', async () => {
    mocked.get.mockRejectedValue(new Error('offline'));
    await expect(onboardingChecklistService.getStarters()).rejects.toThrow('offline');
  });
});
