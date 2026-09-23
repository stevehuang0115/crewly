/**
 * SlackAgentIdentities
 *
 * Settings card for real per-agent Slack identities: each agent gets its own
 * Slack bot user (name in the member list, native `@` autocomplete) via
 * Crewly Cloud. The owner pastes a Slack app configuration token once; new
 * agents then get an install link the owner clicks once each.
 *
 * Talks to `/api/slack/agent-identities` (see backend `slack.controller.ts`).
 *
 * @module components/Settings/SlackAgentIdentities
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { Alert } from '@crewly/ui/Alert';
import { FormInput } from '@crewly/ui/Form';
import { isOrchestratorSession, ORCHESTRATOR_LABEL } from '../../utils/team-chat.utils';

/** One identity row as returned by the API (tokens never included). */
export interface AgentIdentityRow {
  agentSession: string;
  displayName: string;
  appId: string;
  status: 'pending_install' | 'installed' | 'error';
  botUserId?: string;
  installUrl?: string;
  /** Installed, but Slack needs a re-authorization for permissions added since. */
  reinstall?: boolean;
  error?: string;
  hasToken: boolean;
}

/** Cloud-side status half of the payload. */
export interface AgentIdentityCloudStatus {
  enabled: boolean;
  configToken: { configured: boolean; status?: 'ok' | 'invalid'; expiresAt?: string; lastError?: string };
  agents: { total: number; installed: number; pending: number };
}

interface Payload {
  cloud: AgentIdentityCloudStatus;
  identities: AgentIdentityRow[];
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data.data as T;
}

/** One agent app still needing its install click (from `/api/slack/cloud/status`). */
export interface PendingInstallLink {
  agentSession: string;
  url: string;
}

export interface SlackAgentIdentitiesProps {
  /**
   * Install links reported by the Cloud agent sync for agents that have no
   * local identity record yet. Rendered alongside the identity list so the
   * one place to click is here.
   */
  pendingInstalls?: PendingInstallLink[];
}

/**
 * Agent identities card.
 *
 * @param props - Optional pending install links from the Cloud sync
 * @returns The card
 */
/** Session name → team, from /api/teams (for grouping the identity list). */
interface TeamLookup {
  teamName: string;
  memberName: string;
}

/**
 * Build the session-name → team lookup used to group identities.
 *
 * A stopped member has an empty `sessionName` (the controller clears it on
 * stop), so it is derived with the controller's formula
 * (`<team-slug>-<member-slug>-<id[0:8]>`) — otherwise the member's identity
 * would land under "Other agents".
 *
 * @param teams - Teams as returned by /api/teams
 * @returns Lookup keyed by session name
 */
export function buildTeamLookup(
  teams: Array<{ name?: string; members?: Array<{ id?: string; sessionName?: string; name?: string }> }>,
): Record<string, TeamLookup> {
  const slug = (v: string) => v.toLowerCase().replace(/\s+/g, '-');
  const map: Record<string, TeamLookup> = {};
  for (const team of teams) {
    for (const m of team.members ?? []) {
      const session = m.sessionName || (m.id && m.name && team.name ? `${slug(team.name)}-${slug(m.name)}-${m.id.substring(0, 8)}` : '');
      if (session) map[session] = { teamName: team.name ?? 'Team', memberName: m.name ?? session };
    }
  }
  return map;
}

/**
 * Whether a group is this machine's orchestrator.
 *
 * By session, not by the team's name: the name is display text (and is
 * qualified by machine once a second one appears), while the session is the
 * stable id Cloud keys the app on.
 *
 * @param members - The rows in one group
 * @returns True when the orchestrator is among them
 */
export function isOrchestratorGroup(members: Array<{ agentSession: string }>): boolean {
  return members.some((m) => isOrchestratorSession(m.agentSession));
}

export const SlackAgentIdentities: React.FC<SlackAgentIdentitiesProps> = ({ pendingInstalls = [] }) => {
  const [data, setData] = useState<Payload | null>(null);
  const [teamBySession, setTeamBySession] = useState<Record<string, TeamLookup>>({});
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/teams')
      .then((res) => res.json())
      .then((body) => {
        if (cancelled || !body?.success || !Array.isArray(body.data)) return;
        setTeamBySession(buildTeamLookup(body.data));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const syncAgents = async () => {
    setSyncing(true);
    setError(null);
    try {
      await readJson(await fetch('/api/slack/cloud/agents/sync', { method: 'POST' }));
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const res = await fetch(`/api/slack/agent-identities${refresh ? '?refresh=1' : ''}`);
      const body = await res.json();
      if (res.status === 401 || res.status === 503) {
        setUnavailable(body?.error || 'Unavailable');
        setData(null);
        return;
      }
      if (!res.ok || !body?.success) throw new Error(body?.error || `Request failed (${res.status})`);
      setUnavailable(null);
      setData({
        cloud: body.data?.cloud,
        identities: Array.isArray(body.data?.identities) ? body.data.identities : [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent identities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveConfigToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setError(null);
      const res = await fetch('/api/slack/agent-identities/config-token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, refreshToken }),
      });
      await readJson(res);
      setToken('');
      setRefreshToken('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the configuration token');
    } finally {
      setSaving(false);
    }
  };

  const removeConfigToken = async () => {
    if (!window.confirm('Remove the Slack app configuration token from Crewly Cloud?')) return;
    try {
      setError(null);
      await readJson(await fetch('/api/slack/agent-identities/config-token', { method: 'DELETE' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the token');
    }
  };

  const removeIdentity = async (row: AgentIdentityRow) => {
    if (!window.confirm(`Delete the Slack app for ${row.displayName}?`)) return;
    try {
      setError(null);
      await readJson(
        await fetch(`/api/slack/agent-identities/${encodeURIComponent(row.agentSession)}`, { method: 'DELETE' }),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the identity');
    }
  };

  /**
   * Take an agent's bot out of the workspace. A free Slack workspace holds
   * ten apps; this frees one and keeps the app for a later reinstall.
   *
   * @param row - The agent
   */
  const uninstallIdentity = async (row: AgentIdentityRow) => {
    if (!window.confirm(`Remove ${row.displayName}'s bot from Slack? You can install it again later.`)) return;
    try {
      setError(null);
      await readJson(
        await fetch(`/api/slack/agent-identities/${encodeURIComponent(row.agentSession)}/uninstall`, { method: 'POST' }),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to uninstall the bot');
    }
  };

  const configured = !!data?.cloud?.configToken?.configured;
  const tokenInvalid = data?.cloud?.configToken?.status === 'invalid';
  const known = new Set((data?.identities ?? []).map((r) => r.agentSession));
  const extraPending = pendingInstalls.filter((p) => !known.has(p.agentSession));

  // Group by team so a 20-agent account reads as a handful of teams, each
  // with an "installed x / y" summary, instead of one long list.
  const rows: AgentIdentityRow[] = [
    ...(data?.identities ?? []),
    ...extraPending.map((p) => ({
      agentSession: p.agentSession,
      displayName: teamBySession[p.agentSession]?.memberName ?? p.agentSession,
      appId: '',
      status: 'pending_install' as const,
      installUrl: p.url,
      hasToken: false,
    })),
  ];
  const groups = new Map<string, AgentIdentityRow[]>();
  for (const row of rows) {
    // The orchestrator is in no stored team, so the lookup never has it —
    // and since it is registered under a per-instance session it does not
    // even match by name. Without this it landed in "Other agents", below
    // the teams, unhighlighted (owner, 2026-09-21).
    const team = isOrchestratorSession(row.agentSession)
      ? ORCHESTRATOR_LABEL
      : (teamBySession[row.agentSession]?.teamName ?? 'Other agents');
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team)!.push(row);
  }
  // The orchestrator is the one bot the owner talks to directly, and it
  // arrives last in the sync payload — so it landed at the bottom of a list
  // thirty agents long (owner, 2026-09-21). Identified by session rather
  // than by its team's name, which is display text and could change.
  const orderedGroups = [...groups.entries()].sort(
    ([, a], [, b]) => Number(isOrchestratorGroup(b)) - Number(isOrchestratorGroup(a)),
  );
  const installedTotal = rows.filter((r) => r.status === 'installed').length;
  // An agent that is installed but missing a newly added permission is not
  // in the same situation as one that was never set up: the first is
  // silently broken and one click from working, the second was simply never
  // wanted. Lumping them into one "waiting to install" list hid two agents
  // that could not react, and later every agent that could not read a file
  // (2026-09-21).
  const needsReauth = rows.filter((r) => r.status === 'installed' && r.reinstall);

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
            Agent Identities
          </h3>
          <p className="text-xs text-text-secondary-dark mt-1">
            Give each agent its own Slack bot user, so it shows up in the member list and can be
            <code className="mx-1 text-xs bg-background-dark px-1 py-0.5 rounded">@</code>
            mentioned natively. Provisioned through Crewly Cloud; each new agent needs one install click from you.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={syncAgents} loading={syncing} disabled={syncing} aria-label="Sync agents with Crewly Cloud">
            Sync agents
          </Button>
          <Button variant="ghost" size="sm" onClick={() => load(true)} icon={RefreshCw} aria-label="Refresh agent identities">
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary-dark">Loading agent identities...</p>
      ) : unavailable ? (
        <Alert variant="warning">{unavailable}</Alert>
      ) : data && !data.cloud?.enabled ? (
        <Alert variant="warning">Agent identities are not enabled on Crewly Cloud yet.</Alert>
      ) : data ? (
        <div className="space-y-5">
          {configured ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>
                <KeyRound className="inline w-4 h-4 -mt-0.5 mr-1" />
                {tokenInvalid ? (
                  <span className="text-red-400">
                    Configuration token is no longer valid{data.cloud.configToken.lastError ? ` (${data.cloud.configToken.lastError})` : ''}. Paste a new one below.
                  </span>
                ) : (
                  <span>Slack app configuration token stored on Crewly Cloud.</span>
                )}
              </span>
              <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={removeConfigToken}>
                Remove token
              </Button>
            </div>
          ) : null}

          {(!configured || tokenInvalid) && (
            <form onSubmit={saveConfigToken} className="space-y-3">
              <p className="text-xs text-text-secondary-dark">
                Generate an <strong>App Configuration Token</strong> at{' '}
                <a
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  api.slack.com/apps
                  <ExternalLink className="w-3 h-3" />
                </a>{' '}
                (“Your App Configuration Tokens” → Generate) and paste both values. Crewly Cloud keeps it refreshed.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="slack-config-token" className="block text-xs text-text-secondary-dark mb-1">
                    Access token (xoxe.xoxp-…)
                  </label>
                  <FormInput
                    id="slack-config-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="xoxe.xoxp-…"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label htmlFor="slack-config-refresh" className="block text-xs text-text-secondary-dark mb-1">
                    Refresh token (xoxe-…)
                  </label>
                  <FormInput
                    id="slack-config-refresh"
                    type="password"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="xoxe-…"
                    autoComplete="off"
                    required
                  />
                </div>
              </div>
              <Button type="submit" size="sm" disabled={saving || !refreshToken.trim()} loading={saving}>
                {saving ? 'Saving…' : 'Save configuration token'}
              </Button>
            </form>
          )}

          {rows.length === 0 ? (
            <p className="text-sm text-text-secondary-dark">
              No agent identities yet. They are created automatically for members of teams that have a Slack channel.
            </p>
          ) : (
            <div className="space-y-4" data-testid="slack-identity-groups">
              <p className="text-xs text-text-secondary-dark">
                {installedTotal} of {rows.length} agents installed. Installed agents join their team channel by themselves.
              </p>
              {needsReauth.length > 0 && (
                <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <p className="text-xs text-amber-300">
                    <strong>{needsReauth.length} installed {needsReauth.length === 1 ? 'agent needs' : 'agents need'} re-authorization.</strong>{' '}
                    They are running but a newer permission is missing, so part of what they do fails —
                    reading an image you send them, for instance. Their rows below carry an
                    “Authorize” link.
                  </p>
                  <p className="mt-1 text-xs text-amber-300/80">
                    {needsReauth.map((r) => r.displayName || r.agentSession).join(' · ')}
                  </p>
                </div>
              )}
              {orderedGroups.map(([team, members]) => {
                const installed = members.filter((m) => m.status === 'installed').length;
                const isOrc = isOrchestratorGroup(members);
                return (
                  <details
                    key={team}
                    open={installed < members.length}
                    className={isOrc ? 'group rounded-lg border border-primary/50 bg-primary/5 px-3' : 'group'}
                    data-testid={isOrc ? 'slack-identity-group-orchestrator' : undefined}
                  >
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3 py-2 border-b border-border-dark">
                      <span className="text-sm font-medium flex items-center gap-2">
                        {team}
                        {isOrc && (
                          <span className="text-xs font-normal text-primary border border-primary/50 rounded px-1.5 py-0.5">
                            talks to this machine
                          </span>
                        )}
                      </span>
                      <span className={`text-xs ${installed === members.length ? 'text-green-400' : 'text-text-secondary-dark'}`}>
                        {installed === members.length ? 'all installed' : `${installed} / ${members.length} installed`}
                      </span>
                    </summary>
                    <ul className="divide-y divide-border-dark">
                      {members.map((row) => (
                        <li key={row.agentSession} className="py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="text-sm truncate">
                              {row.status === 'installed' && <span className="text-green-400 mr-1">✓</span>}
                              {row.displayName}
                            </div>
                            <div className="text-xs text-text-secondary-dark">
                              {row.status === 'installed' && !row.reinstall && `Installed · bot ${row.botUserId ?? ''}`}
                              {row.status === 'installed' && row.reinstall && 'Installed · new permissions need your re-authorization'}
                              {row.status === 'pending_install' && 'Waiting for your install click'}
                              {row.status === 'error' && `Install failed${row.error ? `: ${row.error}` : ''}`}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {(row.status !== 'installed' || row.reinstall) && row.installUrl && (
                              <a
                                href={row.installUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                              >
                                {row.status === 'installed' ? 'Re-authorize' : 'Install'} {row.displayName}
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            {row.status === 'installed' && (
                              <Button variant="ghost" size="sm" onClick={() => uninstallIdentity(row)} aria-label={`Uninstall ${row.displayName} from Slack`}>
                                Uninstall
                              </Button>
                            )}
                            {row.appId && (
                              <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={() => removeIdentity(row)} aria-label={`Delete identity for ${row.displayName}`}>
                                Delete
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export default SlackAgentIdentities;
