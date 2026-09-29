/**
 * Tests for useCopyToClipboard.
 *
 * @module hooks/useCopyToClipboard.test
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCopyToClipboard } from './useCopyToClipboard';

vi.mock('../utils/clipboard', () => ({ copyText: vi.fn() }));
import { copyText } from '../utils/clipboard';

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(copyText).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reports copied, then reverts to idle', async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    const { result } = renderHook(() => useCopyToClipboard(1000));
    await act(async () => {
      await result.current.copy('abc', 'code');
    });
    expect(result.current.status).toBe('copied');
    expect(result.current.copiedKey).toBe('code');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.copiedKey).toBeNull();
  });

  it('reports failed when the copy did not happen', async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    const { result } = renderHook(() => useCopyToClipboard());
    let ok = true;
    await act(async () => {
      ok = await result.current.copy('abc');
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe('failed');
  });
});
