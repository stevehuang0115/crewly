/**
 * Tests for usePinnedChats — localStorage-backed pinned-conversation set.
 *
 * @module hooks/usePinnedChats.test
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { usePinnedChats } from './usePinnedChats';

describe('usePinnedChats', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('pins the orchestrator by default', () => {
    const { result } = renderHook(() => usePinnedChats());
    expect(result.current.isPinned('crewly-orc')).toBe(true);
    expect(result.current.isPinned('sess-ella')).toBe(false);
  });

  it('toggles a key on and off and persists to localStorage', () => {
    const { result } = renderHook(() => usePinnedChats());

    act(() => result.current.toggle('sess-ella'));
    expect(result.current.isPinned('sess-ella')).toBe(true);
    expect(window.localStorage.getItem('crewly-chat-pinned')).toContain('sess-ella');

    act(() => result.current.toggle('sess-ella'));
    expect(result.current.isPinned('sess-ella')).toBe(false);
  });

  it('honors a stored preference (e.g. orchestrator unpinned) over the default', () => {
    window.localStorage.setItem('crewly-chat-pinned', JSON.stringify([]));
    const { result } = renderHook(() => usePinnedChats());
    expect(result.current.isPinned('crewly-orc')).toBe(false);
  });
});
