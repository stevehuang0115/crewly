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
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';
import { FormInput } from '../UI/Form';

/** One identity row as returned by the API (tokens never included). */
export interface AgentIdentityRow {
  agentSession: string;
  displayName: string;
  appId: string;
  status: 'pending_install' | 'installed' | 'error';
  botUserId?: string;
  installUrl?: string;
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

/**
 * Agent identities card.
 *
 * @returns The card
 */
export const SlackAgentIdentities: React.FC = () => {
  const [data, setData] = useState<Payload | null>(null);
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

  const configured = !!data?.cloud?.configToken?.configured;
  const tokenInvalid = data?.cloud?.configToken?.status === 'invalid';

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
        <Button variant="ghost" size="sm" onClick={() => load(true)} icon={RefreshCw} aria-label="Refresh agent identities">
          Refresh
        </Button>
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

          {data.identities.length === 0 ? (
            <p className="text-sm text-text-secondary-dark">
              No agent identities yet. They are created automatically for members of teams that have a Slack channel.
            </p>
          ) : (
            <ul className="divide-y divide-border-dark">
              {data.identities.map((row) => (
                <li key={row.agentSession} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{row.displayName}</div>
                    <div className="text-xs text-text-secondary-dark">
                      {row.status === 'installed' && `Installed · bot ${row.botUserId ?? ''}`}
                      {row.status === 'pending_install' && 'Waiting for your install click'}
                      {row.status === 'error' && `Install failed${row.error ? `: ${row.error}` : ''}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {row.status !== 'installed' && row.installUrl && (
                      <a
                        href={row.installUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        Install {row.displayName}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    <Button variant="danger-ghost" size="sm" icon={Trash2} onClick={() => removeIdentity(row)} aria-label={`Delete identity for ${row.displayName}`}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export default SlackAgentIdentities;
