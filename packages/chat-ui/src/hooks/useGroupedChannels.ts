/**
 * useGroupedChannels — partition the current user's channels into the
 * Slack-like `Channels` vs `Direct Messages` sections rendered by
 * `ConversationListPanel` (SEALED design §6.1).
 *
 * Phase C wires this on top of `useChannels()` so the center panel
 * renders against real BE data. Pure state derivation; no IO.
 *
 * Behavior:
 *  - When `workspaceId` is provided, the hook scopes `Channels` to
 *    only those rows where `channel.teamId === workspaceId`. DMs and
 *    huddles (ad-hoc multi-agent group chats) are workspace-agnostic —
 *    they surface in every workspace's center panel under their own
 *    `Direct Messages` / `Group Chats` sections.
 *  - When `workspaceId` is null/undefined, all channel-typed rows
 *    appear. Useful for the cross-team Activity / All-DMs surface.
 *  - Rows are sorted by `lastMessageAt` (most recent first) within
 *    each group; channels without a last-message timestamp drop to
 *    the bottom in name order.
 *
 * @module hooks/useGroupedChannels
 */

import { useMemo } from 'react';
import type { Channel } from '../types/chat.types';
import type {
  ConversationGroup,
  ConversationKind,
  ConversationRow,
} from '../types/team-chat.types';
import type { ChatPresenceStatus } from '../components/AgentStatusBadge';

export interface UseGroupedChannelsOptions {
  /**
   * The workspace currently selected in the rail. When set, only
   * `type='channel'` rows tagged with this `teamId` flow into the
   * Channels section; DMs always flow in regardless of workspace.
   */
  workspaceId?: string | null;
}

/**
 * Derive `ConversationGroup[]` from a list of `Channel`s. Pure helper;
 * exposed for tests and for consumers (e.g. server-side render paths)
 * that already have channel data and don't need the React boundary.
 *
 * @param channels - The full set of channels visible to the user.
 * @param opts - Options including the selected workspace.
 * @returns Two groups (`channels`, `dms`) — empty arrays when no rows.
 */
export function buildConversationGroups(
  channels: Channel[],
  opts: UseGroupedChannelsOptions = {},
): ConversationGroup[] {
  const channelRows: ConversationRow[] = [];
  const huddleRows: ConversationRow[] = [];
  const dmRows: ConversationRow[] = [];

  for (const ch of channels) {
    // Treat missing `type` as `'dm'` — back-compat with legacy rows.
    const t = ch.type ?? 'dm';
    if (t === 'huddle') {
      // Huddles (ad-hoc multi-agent groups) aren't team-scoped — like DMs
      // they surface in every workspace. Rendered with the channel glyph.
      huddleRows.push(toRow(ch, 'channel'));
    } else if (t === 'channel') {
      // Scope channels to the active workspace when one is selected.
      if (opts.workspaceId && ch.teamId !== opts.workspaceId) continue;
      channelRows.push(toRow(ch, 'channel'));
    } else {
      dmRows.push(toRow(ch, 'dm'));
    }
  }

  // Sort by lastMessageAt desc — undefined/null sorts last in name order.
  channelRows.sort(byRecencyThenName);
  huddleRows.sort(byRecencyThenName);
  dmRows.sort(byRecencyThenName);

  // Empty groups are skipped by ConversationListPanel, so always returning
  // the Group Chats group is safe — it only shows once a huddle exists.
  return [
    { id: 'channels', label: 'Channels', rows: channelRows },
    { id: 'huddles', label: 'Huddles', rows: huddleRows },
    { id: 'dms', label: 'Direct Messages', rows: dmRows },
  ];
}

/** React hook wrapper — memoizes the grouping so re-renders are cheap. */
export function useGroupedChannels(
  channels: Channel[],
  opts: UseGroupedChannelsOptions = {},
): ConversationGroup[] {
  return useMemo(
    () => buildConversationGroups(channels, opts),
    // The array of channel ids + the workspace key form a stable enough
    // signature; deeper diffing isn't necessary for Phase C.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, opts.workspaceId],
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toRow(channel: Channel, kind: ConversationKind): ConversationRow {
  return {
    id: channel.id,
    kind,
    title: channel.name,
    subtitle: channel.purpose,
    lastMessageAt: channel.lastMessageAt,
    presence: kind === 'dm' ? mapPresence(channel.presence) : undefined,
    agentSession: kind === 'dm' ? channel.agentSession : undefined,
  };
}

/**
 * Map the Channel's `AgentPresenceStatus` (online | busy | offline) to
 * the chat-ui `ChatPresenceStatus` superset (which adds `idle` and
 * `inactive`). For Phase C we don't synthesize idle/inactive on the FE
 * — the BE wire vocabulary is the source of truth.
 */
function mapPresence(p: Channel['presence']): ChatPresenceStatus | undefined {
  if (!p) return undefined;
  return p;
}

/**
 * Recency-then-name comparator. Rows with a `lastMessageAt` come first
 * in descending order; remaining rows sort alphabetically by title to
 * keep the list deterministic.
 */
function byRecencyThenName(a: ConversationRow, b: ConversationRow): number {
  const aTime = a.lastMessageAt ? Date.parse(a.lastMessageAt) : NaN;
  const bTime = b.lastMessageAt ? Date.parse(b.lastMessageAt) : NaN;
  const aHas = Number.isFinite(aTime);
  const bHas = Number.isFinite(bTime);
  if (aHas && bHas) return bTime - aTime;
  if (aHas) return -1;
  if (bHas) return 1;
  return a.title.localeCompare(b.title);
}
