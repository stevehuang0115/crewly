/**
 * TeamChatRoute — the routed, live host for the consolidated team-chat page.
 *
 * `LiveTeamChatPage` is a pure presentational shell: it expects the host to
 * resolve the backend URL and inject the team directory (labels + mention
 * pool). This wrapper supplies all of that for the OSS app:
 *
 *   - backend URL / mode  ← shared `resolveBackendURL` / `resolveChatMode`
 *   - teamLabels          ← `useTeams()` → `buildTeamLabels`
 *   - mentionables        ← `useTeams()` → `buildMentionables`
 *   - initialWorkspaceId  ← `?team=<id>` query param (deep-link from /teams)
 *
 * When arriving via a `?team=<id>` deep-link, it first POSTs
 * `/channels/team/ensure` so a team that never created a channel still has
 * one to land on (the workspace rail derives from channel rows). The page
 * render is gated on that call settling so `useChannels` picks up the
 * freshly-ensured channel on its initial load rather than racing it.
 *
 * Keeping this glue in a thin route component lets `LiveTeamChatPage` stay
 * host-agnostic (Portal injects its own labels/mentionables) and keeps the
 * `?team=` deep-link contract in one place.
 *
 * @module components/Chat-team/TeamChatRoute
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LiveTeamChatPage } from './LiveTeamChatPage';
import { useTeams } from '../../hooks/useTeams';
import { resolveBackendURL, resolveChatMode } from '../../utils/chat-backend';
import {
  buildTeamLabels,
  buildMentionables,
  TEAM_QUERY_PARAM,
} from '../../utils/team-chat.utils';

/**
 * Live route wrapper for `/team-chat`.
 *
 * @returns The consolidated team-chat page wired to the OSS backend.
 */
export function TeamChatRoute(): JSX.Element {
  const [searchParams] = useSearchParams();
  const { teams } = useTeams();

  const mode = resolveChatMode();
  const backendURL = mode === 'real' ? resolveBackendURL() : undefined;

  const teamLabels = useMemo(() => buildTeamLabels(teams), [teams]);
  const mentionables = useMemo(() => buildMentionables(teams), [teams]);

  const initialWorkspaceId = searchParams.get(TEAM_QUERY_PARAM) || null;

  // Ensure the deep-linked team has a channel before mounting the page.
  // Tracks the team id we've already ensured so re-renders don't re-fire,
  // and so switching teams re-ensures for the new one.
  const [ensuredTeamId, setEnsuredTeamId] = useState<string | null>(null);
  const needsEnsure =
    mode === 'real' && initialWorkspaceId !== null && ensuredTeamId !== initialWorkspaceId;

  useEffect(() => {
    if (mode !== 'real' || !initialWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        await fetch('/api/chat/channels/team/ensure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId: initialWorkspaceId }),
        });
      } catch {
        // Non-fatal: the page still renders (it shows an empty-state when the
        // team has no channel). Don't block the UI on a transient ensure error.
      } finally {
        if (!cancelled) setEnsuredTeamId(initialWorkspaceId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, initialWorkspaceId]);

  if (needsEnsure) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-text-secondary-dark"
        role="status"
      >
        Opening team chat…
      </div>
    );
  }

  return (
    <LiveTeamChatPage
      backendURL={backendURL}
      teamLabels={teamLabels}
      mentionables={mentionables}
      initialWorkspaceId={initialWorkspaceId}
    />
  );
}

export default TeamChatRoute;
