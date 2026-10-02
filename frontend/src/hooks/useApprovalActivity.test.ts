/**
 * Tests for useApprovalActivity.
 *
 * @module hooks/useApprovalActivity.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useApprovalActivity } from './useApprovalActivity';
import { securityService } from '../services/security.service';

vi.mock('../services/security.service', () => ({ securityService: { approvals: vi.fn() } }));
const svc = vi.mocked(securityService);

describe('useApprovalActivity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the window, reloads on change and on demand', async () => {
    svc.approvals.mockResolvedValue({ days: 7 } as never);
    const { result, rerender } = renderHook(({ d }) => useApprovalActivity(d), { initialProps: { d: 7 as 7 | 30 } });
    await waitFor(() => expect(result.current.data).toEqual({ days: 7 }));
    rerender({ d: 30 });
    await waitFor(() => expect(svc.approvals).toHaveBeenLastCalledWith(30));
    await act(() => result.current.reload());
    expect(svc.approvals).toHaveBeenCalledTimes(3);
  });

  it('keeps the error', async () => {
    svc.approvals.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useApprovalActivity(7));
    await waitFor(() => expect(result.current.error).toBe('down'));
    expect(result.current.loading).toBe(false);
  });
});
