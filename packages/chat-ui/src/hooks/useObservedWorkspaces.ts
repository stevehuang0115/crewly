/**
 * useObservedWorkspaces — derive the `Workspace[]` rendered by
 * `WorkspaceRail` from the channels the user can see (SEALED design
 * §6.1, §11.2).
 *
 * Phase C wires this on top of `useChannels()` so the left rail
 * reflects every team the BE returns a `type='channel'` row for. The
 * mapping is intentionally minimal — Phase D will pivot to a richer
 * team-directory feed (presence aggregates, parent/sub-team grouping,
 * activity inbox row).
 *
 * Behavior:
 *  - One `Workspace` entry per unique `teamId` observed across all
 *    `type='channel'` rows. The label is taken from the optional
 *    `teamLabels` map (BE may inject team names from the team service)
 *    or falls back to the raw teamId so the rail is never blank.
 *  - The order is the order each teamId is first observed in the input
 *    list. This keeps the rail deterministic given a deterministic
 *    channel sort and avoids accidental flicker on re-renders.
 *  - Channels lacking a `teamId` (legacy or DM-only) are ignored —
 *    they have no workspace to belong to.
 *
 * @module hooks/useObservedWorkspaces
 */

import { useMemo } from 'react';
import type { Channel } from '../types/chat.types';
import type { Workspace } from '../types/team-chat.types';

export interface UseObservedWorkspacesOptions {
  /**
   * Optional map from `teamId` → human-readable display name. When a
   * teamId is missing here we fall back to the id itself so the rail
   * still renders.
   */
  teamLabels?: Record<string, string>;
}

/**
 * Pure derivation — exposed for tests and for callers that already
 * have a channel list and don't need the React boundary.
 *
 * @param channels - Channels the current user can see.
 * @param opts - Optional team-label injection.
 * @returns One workspace per observed teamId, in first-seen order.
 */
export function buildObservedWorkspaces(
  channels: Channel[],
  opts: UseObservedWorkspacesOptions = {},
): Workspace[] {
  const seen = new Map<string, Workspace>();
  for (const ch of channels) {
    if (ch.type !== 'channel') continue;
    const teamId = ch.teamId?.trim();
    if (!teamId || seen.has(teamId)) continue;
    seen.set(teamId, {
      id: teamId,
      name: opts.teamLabels?.[teamId] ?? teamId,
      kind: 'team',
    });
  }
  return Array.from(seen.values());
}

/** React hook wrapper — memoizes against the channel list + label map. */
export function useObservedWorkspaces(
  channels: Channel[],
  opts: UseObservedWorkspacesOptions = {},
): Workspace[] {
  return useMemo(
    () => buildObservedWorkspaces(channels, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, opts.teamLabels],
  );
}
