/**
 * Tests for useOnboardingChecklist.
 *
 * @module hooks/useOnboardingChecklist.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useOnboardingChecklist } from './useOnboardingChecklist';
import { onboardingChecklistService } from '../services/onboarding-checklist.service';
import { makeChecklist } from '../test/onboarding.fixtures';

vi.mock('../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: {
    getChecklist: vi.fn(),
    setDismissed: vi.fn(),
  },
}));

const svc = vi.mocked(onboardingChecklistService);

describe('useOnboardingChecklist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the checklist', async () => {
    svc.getChecklist.mockResolvedValue(makeChecklist(['harness']));
    const { result } = renderHook(() => useOnboardingChecklist());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.checklist?.doneCount).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('reports a load error', async () => {
    svc.getChecklist.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useOnboardingChecklist());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.checklist).toBeNull();
    expect(result.current.error).toBe('offline');
  });

  it('refresh re-reads and setDismissed stores the returned checklist', async () => {
    svc.getChecklist.mockResolvedValueOnce(makeChecklist()).mockResolvedValueOnce(makeChecklist(['team']));
    svc.setDismissed.mockResolvedValue(makeChecklist(['team'], { dismissed: true }));
    const { result } = renderHook(() => useOnboardingChecklist());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.checklist?.doneCount).toBe(1);
    await act(async () => {
      await result.current.setDismissed(true);
    });
    expect(svc.setDismissed).toHaveBeenCalledWith(true);
    expect(result.current.checklist?.dismissed).toBe(true);
  });

  it('keeps the checklist and reports a failed dismiss', async () => {
    svc.getChecklist.mockResolvedValue(makeChecklist());
    svc.setDismissed.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useOnboardingChecklist());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.setDismissed(true);
    });
    expect(result.current.checklist?.dismissed).toBe(false);
    expect(result.current.error).toBe('nope');
  });
});
