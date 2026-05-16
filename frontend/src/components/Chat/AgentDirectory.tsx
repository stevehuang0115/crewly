/**
 * AgentDirectory — left rail for the /agents page.
 *
 * Fetches `GET /api/chat/agents` and renders one row per (team × agent)
 * so the user can open a DM with any agent in their teams without first
 * creating a channel. Channels are created lazily on click via the
 * `Agents` page's `ensureDmChannel` helper.
 *
 * Why a custom rail instead of `ChannelList` from `@crewly/chat-ui`?
 *   `ChannelList` shows persisted channels. On first page load there
 *   are no DM channels yet, so the rail would be empty and the user
 *   would have no entry point. Showing agents directly maps better to
 *   the user's mental model ("I want to talk to Leo") than to channels
 *   ("I want to open the channel I once created for Leo").
 *
 * @module components/Chat/AgentDirectory
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * One row in the `/api/chat/agents` response. Mirrors
 * `ChatAgentDirectoryEntry` on the backend.
 */
export interface DirectoryAgent {
  agentSession: string;
  name: string;
  role: string;
  teamId: string;
  teamName: string;
  agentStatus: string;
  workingStatus: string;
  avatar?: string;
}

interface DirectoryEnvelope {
  success: boolean;
  data?: { agents: DirectoryAgent[] };
  error?: { code: string; message: string };
}

export interface AgentDirectoryProps {
  /** sessionName of the currently-open agent (for active-row highlight). */
  activeAgentSession?: string | null;
  /**
   * sessionName of the agent whose channel is mid-`ensure`. Used to show
   * an inline spinner so users don't double-click while the network call
   * is in flight.
   */
  openingAgentSession?: string | null;
  onSelectAgent(agent: DirectoryAgent): void;
  className?: string;
  /** Override the fetch impl (tests pass a stub). */
  fetchImpl?: typeof fetch;
}

const DIRECTORY_PATH = '/api/chat/agents';

/**
 * Group flat agent rows by teamName so the rail renders a tidy
 * "Team Marketing → Ella / Luna" hierarchy instead of one long list.
 */
function groupByTeam(
  agents: DirectoryAgent[],
): Array<{ teamId: string; teamName: string; members: DirectoryAgent[] }> {
  const buckets = new Map<
    string,
    { teamId: string; teamName: string; members: DirectoryAgent[] }
  >();
  for (const a of agents) {
    let bucket = buckets.get(a.teamId);
    if (!bucket) {
      bucket = { teamId: a.teamId, teamName: a.teamName, members: [] };
      buckets.set(a.teamId, bucket);
    }
    bucket.members.push(a);
  }
  return Array.from(buckets.values());
}

/**
 * Map `(agentStatus, workingStatus)` to a tiny status dot color.
 * Mirrors `resolvePresenceStatus` on the backend, but operates on the
 * cached fields the directory ships in one round-trip (avoids one
 * /presence call per row at list-time).
 */
function statusDotClass(agent: DirectoryAgent): string {
  if (agent.agentStatus !== 'active' && agent.agentStatus !== 'started') {
    if (agent.agentStatus === 'starting') return 'bg-amber-400';
    return 'bg-slate-500';
  }
  if (agent.workingStatus === 'in_progress') return 'bg-blue-400';
  return 'bg-emerald-400';
}

export const AgentDirectory: React.FC<AgentDirectoryProps> = ({
  activeAgentSession = null,
  openingAgentSession = null,
  onSelectAgent,
  className = '',
  fetchImpl,
}) => {
  const [agents, setAgents] = useState<DirectoryAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const doFetch = useMemo(() => fetchImpl ?? globalThis.fetch, [fetchImpl]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await doFetch(DIRECTORY_PATH);
      const body = (await res.json()) as DirectoryEnvelope;
      if (!res.ok || !body.success || !body.data) {
        throw new Error(
          body?.error?.message ?? `Failed to load agents (HTTP ${res.status})`,
        );
      }
      setAgents(body.data.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupByTeam(agents), [agents]);

  return (
    <aside
      className={`flex h-full w-64 flex-col border-r border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900 ${className}`}
      aria-label="Agent directory"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Agents
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="p-4 text-sm text-slate-500 dark:text-slate-400"
            role="status"
            aria-live="polite"
          >
            Loading agents…
          </div>
        )}

        {error && (
          <div className="p-4 text-sm text-red-600 dark:text-red-400" role="alert">
            <div className="mb-2">Failed to load agents: {error}</div>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && agents.length === 0 && (
          <div className="p-4 text-sm text-slate-500 dark:text-slate-400">
            No agents available. Create a team and add a member to get started.
          </div>
        )}

        {!loading && !error && grouped.length > 0 && (
          <ul role="list" className="divide-y divide-slate-100 dark:divide-slate-800">
            {grouped.map((team) => (
              <li key={team.teamId} className="py-1">
                <div className="px-4 py-1 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {team.teamName}
                </div>
                <ul role="list" className="space-y-px">
                  {team.members.map((agent) => {
                    const isActive = agent.agentSession === activeAgentSession;
                    const isOpening = agent.agentSession === openingAgentSession;
                    return (
                      <li key={agent.agentSession}>
                        <button
                          type="button"
                          disabled={isOpening}
                          onClick={() => onSelectAgent(agent)}
                          className={`flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-slate-50 disabled:cursor-progress disabled:opacity-60 dark:hover:bg-slate-800 ${
                            isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                          }`}
                        >
                          <span
                            aria-hidden
                            className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(
                              agent,
                            )}`}
                          />
                          <div className="flex-1 overflow-hidden">
                            <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                              {agent.name}
                            </div>
                            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                              {agent.role}
                            </div>
                          </div>
                          {isOpening && (
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">
                              opening…
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};

export default AgentDirectory;
