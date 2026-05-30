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
 * Keeping this glue in a thin route component lets `LiveTeamChatPage` stay
 * host-agnostic (Portal injects its own labels/mentionables) and keeps the
 * `?team=` deep-link contract in one place.
 *
 * @module components/Chat-team/TeamChatRoute
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LiveTeamChatPage } from './LiveTeamChatPage';
import { useTeams } from '../../hooks/useTeams';
import { resolveBackendURL, resolveChatMode } from '../../utils/chat-backend';
import { buildTeamLabels, buildMentionables } from '../../utils/team-chat.utils';

/**
 * Query-param key used to deep-link into a specific team's workspace.
 * Shared with the /teams navigation buttons so the contract lives in one spot.
 */
export const TEAM_QUERY_PARAM = 'team';

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
