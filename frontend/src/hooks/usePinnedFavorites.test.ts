/**
 * usePinnedFavorites Hook Tests
 *
 * @module hooks/usePinnedFavorites.test
 */
import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { usePinnedFavorites, MAX_PINNED, STORAGE_KEY, PinnedItem } from './usePinnedFavorites';

describe('usePinnedFavorites', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should start with empty pins when localStorage is empty', () => {
    const { result } = renderHook(() => usePinnedFavorites());
    expect(result.current.pinnedItems).toEqual([]);
  });

  it('should load existing pins from localStorage', () => {
    const existing: PinnedItem[] = [{ id: 'p1', name: 'Project 1', type: 'project' }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));

    const { result } = renderHook(() => usePinnedFavorites());
    expect(result.current.pinnedItems).toEqual(existing);
  });

  it('should pin an item', () => {
    const { result } = renderHook(() => usePinnedFavorites());

    act(() => {
      result.current.togglePin({ id: 'p1', name: 'Project 1', type: 'project' });
    });

    expect(result.current.pinnedItems).toHaveLength(1);
    expect(result.current.isPinned('p1')).toBe(true);
  });

  it('should unpin an item', () => {
    const { result } = renderHook(() => usePinnedFavorites());

    act(() => {
      result.current.togglePin({ id: 'p1', name: 'Project 1', type: 'project' });
    });
    expect(result.current.isPinned('p1')).toBe(true);

    act(() => {
      result.current.togglePin({ id: 'p1', name: 'Project 1', type: 'project' });
    });
    expect(result.current.isPinned('p1')).toBe(false);
    expect(result.current.pinnedItems).toHaveLength(0);
  });

  it('should persist pins to localStorage', () => {
    const { result } = renderHook(() => usePinnedFavorites());

    act(() => {
      result.current.togglePin({ id: 't1', name: 'Team 1', type: 'team' });
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('t1');
  });

  it('should enforce MAX_PINNED limit', () => {
    const { result } = renderHook(() => usePinnedFavorites());

    // Pin MAX_PINNED items
    for (let i = 0; i < MAX_PINNED; i++) {
      act(() => {
        result.current.togglePin({ id: `p${i}`, name: `Item ${i}`, type: 'project' });
      });
    }
    expect(result.current.pinnedItems).toHaveLength(MAX_PINNED);
    expect(result.current.isAtLimit).toBe(true);

    // Try to pin one more — should return false
    let pinResult: boolean = true;
    act(() => {
      pinResult = result.current.togglePin({ id: 'extra', name: 'Extra', type: 'project' });
    });
    expect(pinResult).toBe(false);
    expect(result.current.pinnedItems).toHaveLength(MAX_PINNED);
  });

  it('should handle corrupted localStorage gracefully', () => {
    localStorage.setItem(STORAGE_KEY, 'not-valid-json');

    const { result } = renderHook(() => usePinnedFavorites());
    expect(result.current.pinnedItems).toEqual([]);
  });

  it('should report isPinned correctly', () => {
    const { result } = renderHook(() => usePinnedFavorites());

    expect(result.current.isPinned('p1')).toBe(false);

    act(() => {
      result.current.togglePin({ id: 'p1', name: 'P1', type: 'project' });
    });

    expect(result.current.isPinned('p1')).toBe(true);
    expect(result.current.isPinned('p2')).toBe(false);
  });
});
