/**
 * usePinnedChats — persistent set of "pinned" conversation keys for the
 * consolidated chat. Pinned conversations float into a top "Pinned Chats"
 * section. The orchestrator is pinned by default; the user can pin/unpin any
 * agent DM or group.
 *
 * Persistence is localStorage (per-browser) — there is no backend pin field
 * yet, mirroring the wiki tree-collapse persistence pattern. A pin "key" is
 * the conversation's agent session (stable for DMs) or its channel id (groups).
 *
 * @module hooks/usePinnedChats
 */

import { useCallback, useState } from 'react';
import { ORCHESTRATOR_SESSION } from '../utils/team-chat.utils';

const PINNED_KEY = 'crewly-chat-pinned';

/** Default pins applied when the user has no stored preference yet. */
const DEFAULT_PINS = [ORCHESTRATOR_SESSION];

function loadPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
    }
  } catch {
    // ignore — fall through to defaults
  }
  return new Set(DEFAULT_PINS);
}

export interface UsePinnedChatsResult {
  /** The set of pinned conversation keys. */
  pinned: Set<string>;
  /** True when `key` is pinned. */
  isPinned: (key: string) => boolean;
  /** Pin/unpin `key`, persisting the change. */
  toggle: (key: string) => void;
}

/**
 * Hook exposing the pinned-conversation set + a toggle, persisted to
 * localStorage. Orchestrator is pinned by default.
 *
 * @returns The pinned set, an `isPinned` predicate, and a `toggle` action.
 */
export function usePinnedChats(): UsePinnedChatsResult {
  const [pinned, setPinned] = useState<Set<string>>(loadPins);

  const toggle = useCallback((key: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify([...next]));
      } catch {
        // ignore — pinning is best-effort
      }
      return next;
    });
  }, []);

  const isPinned = useCallback((key: string) => pinned.has(key), [pinned]);

  return { pinned, isPinned, toggle };
}
