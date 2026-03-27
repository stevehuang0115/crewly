/**
 * usePinnedFavorites Hook
 *
 * Manages user's pinned favorite projects/teams (max 5) stored in localStorage.
 * Items appear at the top of the Work navigation group.
 *
 * Uses a custom DOM event ('crewly-pinned-changed') to synchronize state
 * across all hook instances in the same window (since the 'storage' event
 * only fires for changes made by other tabs/windows).
 *
 * @module hooks/usePinnedFavorites
 */
import { useState, useCallback, useEffect } from 'react';

/** Maximum number of pinned items allowed */
export const MAX_PINNED = 5;

/** localStorage key for pinned favorites */
export const STORAGE_KEY = 'crewly_pinned_favorites';

/** Custom event name dispatched when pins change within the same window */
const PINNED_CHANGED_EVENT = 'crewly-pinned-changed';

/** A pinned favorite item */
export interface PinnedItem {
  /** Unique ID (project ID or team ID) */
  id: string;
  /** Display name */
  name: string;
  /** Type of item */
  type: 'project' | 'team';
}

/**
 * Read pinned items from localStorage.
 *
 * @returns Array of pinned items, or empty array on parse error
 */
function readPinned(): PinnedItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Guard to prevent re-entrant event dispatch during sync */
let isSyncing = false;

/**
 * Write pinned items to localStorage and notify other hook instances.
 *
 * @param items - Items to persist
 */
function writePinned(items: PinnedItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  // Dispatch custom event so other hook instances in the same window re-sync.
  // Guard prevents infinite loop: write → event → sync → write → event ...
  if (!isSyncing) {
    isSyncing = true;
    window.dispatchEvent(new CustomEvent(PINNED_CHANGED_EVENT));
    isSyncing = false;
  }
}

/**
 * Hook for managing pinned favorites.
 *
 * All instances of this hook stay in sync: when one component toggles a pin,
 * all other mounted components using this hook will re-read from localStorage.
 *
 * @returns Pin state and mutation functions
 *
 * @example
 * ```tsx
 * const { pinnedItems, isPinned, togglePin } = usePinnedFavorites();
 * ```
 */
export function usePinnedFavorites() {
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>(readPinned);

  /** Sync state to localStorage on change */
  useEffect(() => {
    writePinned(pinnedItems);
  }, [pinnedItems]);

  /**
   * Listen for pin changes from other hook instances (same window)
   * and from other tabs/windows (storage event).
   */
  useEffect(() => {
    const syncFromStorage = () => {
      setPinnedItems(readPinned());
    };

    // Same-window sync (custom event)
    window.addEventListener(PINNED_CHANGED_EVENT, syncFromStorage);
    // Cross-tab sync (storage event)
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) syncFromStorage();
    });

    return () => {
      window.removeEventListener(PINNED_CHANGED_EVENT, syncFromStorage);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  /**
   * Check if an item is currently pinned.
   *
   * @param id - Item ID
   * @returns True if pinned
   */
  const isPinned = useCallback(
    (id: string) => pinnedItems.some(p => p.id === id),
    [pinnedItems],
  );

  /**
   * Toggle pin state for an item.
   * Unpins if already pinned; pins if under the limit.
   *
   * @param item - Item to pin or unpin
   * @returns True if item is now pinned, false if unpinned or limit reached
   */
  const togglePin = useCallback(
    (item: PinnedItem): boolean => {
      const existing = pinnedItems.find(p => p.id === item.id);
      if (existing) {
        // Unpin
        setPinnedItems(prev => prev.filter(p => p.id !== item.id));
        return false;
      }
      if (pinnedItems.length >= MAX_PINNED) {
        return false; // At limit
      }
      // Pin
      setPinnedItems(prev => [...prev, item]);
      return true;
    },
    [pinnedItems],
  );

  /**
   * Check if the pin limit has been reached.
   */
  const isAtLimit = pinnedItems.length >= MAX_PINNED;

  return { pinnedItems, isPinned, togglePin, isAtLimit };
}
