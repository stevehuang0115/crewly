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
 *   - directMessagesWorkspace ← the always-present "Direct Messages" rail entry
 *
 * Consolidation host: before mounting the page it ensures the channels the
 * page needs exist, so `useChannels` picks them up on its initial load
 * (rather than racing a later refetch):
 *   - Always ensures the **orchestrator DM** (`crewly-orc`) so talking to the
 *     orchestrator lives on this one page (the old `/chat` pipe folds in here).
 *   - When deep-linked via `?team=<id>`, also ensures that team's channel so
 *     the workspace isn't empty.
 *
 * Default landing (no `?team=`): the Direct Messages workspace with the
 * orchestrator conversation selected — preserving the old `/chat` behavior of
 * opening straight onto the orchestrator.
 *
 * @module components/Chat-team/TeamChatRoute
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LiveTeamChatPage,
  HOME_ID,
  teamRailId,
  type DirectoryAgentEntry,
  type ChatTeam,
} from './LiveTeamChatPage';
import { useTeams } from '../../hooks/useTeams';
import { resolveBackendURL, resolveChatMode } from '../../utils/chat-backend';
import {
  buildTeamLabels,
  buildMentionables,
  agentStatusToPresence,
  TEAM_QUERY_PARAM,
  ORCHESTRATOR_SESSION,
  ORCHESTRATOR_LABEL,
} from '../../utils/team-chat.utils';

/** POST a chat-v2 ensure endpoint and return the resolved channel id, or null. */
async function ensureChannel(url: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { success?: boolean; data?: { id?: string } };
    return json?.data?.id ?? null;
  } catch {
    // Non-fatal: the page still renders its own empty states. Never block the
    // UI on a transient ensure failure.
    return null;
  }
}

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

  // Full agent directory → shown in the DM list (online + offline) so every
  // agent is reachable. Derived from the teams the hook already fetched, so
  // no extra request; falls back to GET /api/chat/agents semantics (session
  // name + presence) without the round-trip.
  const directoryAgents = useMemo<DirectoryAgentEntry[]>(() => {
    const seen = new Set<string>();
    const out: DirectoryAgentEntry[] = [];
    for (const team of teams) {
      for (const member of team.members ?? []) {
        const session = member.sessionName;
        if (!session || seen.has(session)) continue;
        seen.add(session);
        out.push({
          agentSession: session,
          name: member.name,
          presence: agentStatusToPresence(member.agentStatus),
          teamName: team.name,
        });
      }
    }
    return out;
  }, [teams]);

  // Teams for the workspace rail: identity + lead/member sessions. The lead is
  // a member listed in `leaderIds` (or the deprecated `leaderId`), or a member
  // at hierarchy level 1.
  const chatTeams = useMemo<ChatTeam[]>(() => {
    return teams.map((t) => {
      const leaderIds = t.leaderIds?.length ? t.leaderIds : t.leaderId ? [t.leaderId] : [];
      const leadIdSet = new Set(leaderIds);
      const members = t.members ?? [];
      const leaderSessions = members
        .filter((m) => m.sessionName && (leadIdSet.has(m.id) || m.hierarchyLevel === 1))
        .map((m) => m.sessionName);
      const memberSessions = members.filter((m) => m.sessionName).map((m) => m.sessionName);
      return { id: t.id, name: t.name, leaderSessions, memberSessions };
    });
  }, [teams]);

  const teamParam = searchParams.get(TEAM_QUERY_PARAM) || null;

  // Find-or-create a DM for an agent the user opens from the directory.
  const onEnsureDm = useCallback(
    async (agentSession: string): Promise<string> => {
      const agent = directoryAgents.find((a) => a.agentSession === agentSession);
      const id = await ensureChannel('/api/chat/channels/dm/ensure', {
        agentSession,
        name: agent?.name ?? agentSession,
      });
      return id ?? '';
    },
    [directoryAgents],
  );

  // Ensure the channels the page needs exist before mounting it: the
  // orchestrator DM + EVERY team's huddle channel (so each team rail icon has
  // its all-members huddle). `readyKey` is keyed on the team-id set so it
  // re-runs (and re-gates) once `useTeams` resolves, but is stable across
  // presence-only updates.
  const teamIds = useMemo(() => chatTeams.map((t) => t.id), [chatTeams]);
  const targetKey = `${teamParam ?? '__none__'}|${teamIds.join(',')}`;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [orcChannelId, setOrcChannelId] = useState<string | null>(null);
  const ready = mode !== 'real' || readyKey === targetKey;

  useEffect(() => {
    if (mode !== 'real') return;
    let cancelled = false;
    void (async () => {
      // Always make the orchestrator reachable on this page.
      const orcId = await ensureChannel('/api/chat/channels/dm/ensure', {
        agentSession: ORCHESTRATOR_SESSION,
        name: ORCHESTRATOR_LABEL,
        purpose: 'Talk to the orchestrator',
      });
      // Ensure each team's huddle channel exists for its rail view.
      await Promise.all(
        teamIds.map((id) => ensureChannel('/api/chat/channels/team/ensure', { teamId: id })),
      );
      if (!cancelled) {
        if (orcId) setOrcChannelId(orcId);
        setReadyKey(targetKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, targetKey, teamIds]);

  if (!ready) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-text-secondary-dark"
        role="status"
      >
        Opening chat…
      </div>
    );
  }

  // Default landing is Home (orchestrator selected); a `?team=` deep-link
  // focuses that team's rail icon instead.
  const initialWorkspaceId = teamParam ? teamRailId(teamParam) : HOME_ID;
  const initialConversationId = teamParam ? null : orcChannelId;

  return (
    <LiveTeamChatPage
      backendURL={backendURL}
      teamLabels={teamLabels}
      mentionables={mentionables}
      initialWorkspaceId={initialWorkspaceId}
      initialConversationId={initialConversationId}
      directoryAgents={directoryAgents}
      teams={chatTeams}
      onEnsureDm={onEnsureDm}
    />
  );
}

export default TeamChatRoute;
