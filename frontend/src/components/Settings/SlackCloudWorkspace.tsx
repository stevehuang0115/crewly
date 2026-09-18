/**
 * SlackCloudWorkspace
 *
 * The one-click path of Settings → Slack: install the Crewly Slack app from
 * your Crewly Cloud account once, and every Crewly instance signed in to
 * that account gets Slack automatically. Shows the Connect button, the
 * connected-workspace card, the "primary instance" toggle and the agents
 * still waiting for their one-time install click.
 *
 * Talks to `/api/slack/cloud/*` (see backend `slack.controller.ts`).
 *
 * @module components/Settings/SlackCloudWorkspace
 */

import React, { useState } from 'react';
import { Cloud, ExternalLink, RefreshCw, Unlink, Users } from 'lucide-react';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';
import { Toggle } from '../UI/Toggle';

/** One agent app still needing its install click. */
export interface SlackPendingInstall {
  agentSession: string;
  url: string;
}

/** One workspace on the Crewly Cloud account (never a token). */
export interface SlackCloudWorkspaceSummary {
  slackTeamId: string;
  slackTeamName: string;
  botUserId?: string;
  installedAt?: string;
  agentIdentities?: number;
}

/** `GET /api/slack/cloud/status` payload. */
export interface SlackCloudStatus {
  cloudConnected: boolean;
  sourceMode: 'env' | 'cloud' | 'auto';
  activeSource: 'env' | 'cloud' | null;
  connected: boolean;
  transport: 'socket' | 'cloud' | null;
  workspace: {
    slackTeamId: string;
    slackTeamName: string;
    botUserId: string;
    appId: string;
    agentIdentities: number;
  } | null;
  configFetchedAt: string | null;
  configError: string | null;
  primary: boolean;
  instanceId: string | null;
  lastHeartbeatAt: string | null;
  registryError: string | null;
  pendingInstalls: SlackPendingInstall[];
  /** Set when Cloud holds several workspaces and this instance has not chosen one. */
  availableWorkspaces?: SlackCloudWorkspaceSummary[] | null;
  /** Every workspace on the account (null when Cloud could not be asked). */
  workspaces?: SlackCloudWorkspaceSummary[] | null;
  /** The workspace this instance chose to serve (null = Cloud decides). */
  selectedWorkspaceId?: string | null;
  local: { env: boolean; saved: boolean };
}

export interface SlackCloudWorkspaceProps {
  /** Latest status (null while loading / when the request failed). */
  status: SlackCloudStatus | null;
  /** Re-fetch the status; `refresh` asks the backend to re-fetch from Cloud too. */
  onRefresh: (refresh?: boolean) => Promise<void>;
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data.data as T;
}

/**
 * Dashboard URL the Slack install flow returns to.
 *
 * @returns `<origin>/settings?tab=slack`
 */
export function slackInstallReturnUrl(): string {
  return `${window.location.origin}/settings?tab=slack`;
}

/**
 * Cloud-owned Slack card.
 *
 * @param props - Status + refresh callback
 * @returns The card
 */
export const SlackCloudWorkspace: React.FC<SlackCloudWorkspaceProps> = ({ status, onRefresh }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>('');

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run('connect', async () => {
      const res = await fetch(`/api/slack/cloud/install-url?returnUrl=${encodeURIComponent(slackInstallReturnUrl())}`);
      const { url } = await readJson<{ url: string }>(res);
      window.location.assign(url);
    });

  const useWorkspace = (slackTeamId: string) =>
    run('workspace', async () => {
      await readJson(
        await fetch('/api/slack/cloud/workspace', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slackTeamId }),
        }),
      );
      await onRefresh(true);
    });

  const setPrimary = (primary: boolean) =>
    run('primary', async () => {
      await readJson(
        await fetch('/api/slack/cloud/primary', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primary }),
        }),
      );
      await onRefresh();
    });

  const syncAgents = () =>
    run('sync', async () => {
      await readJson(await fetch('/api/slack/cloud/agents/sync', { method: 'POST' }));
      await onRefresh();
    });

  const disconnectWorkspace = () =>
    run('disconnect', async () => {
      if (!window.confirm('Remove this Slack workspace from your Crewly account? Every Crewly instance serving it loses Slack.')) {
        return;
      }
      await readJson(await fetch('/api/slack/cloud/workspace', { method: 'DELETE' }));
      await onRefresh();
    });

  const workspace = status?.workspace ?? null;
  const cloudConnected = !!status?.cloudConnected;
  const envOnly = status?.sourceMode === 'env';
  const choices = status?.availableWorkspaces && status.availableWorkspaces.length > 0 ? status.availableWorkspaces : null;
  const switchable = status?.workspaces && status.workspaces.length > 1 ? status.workspaces : null;

  const workspacePicker = (list: SlackCloudWorkspaceSummary[], current: string | null) => (
    <div className="flex items-center gap-2" data-testid="slack-cloud-workspace-picker">
      <select
        className="bg-background-dark border border-border-dark rounded px-2 py-1.5 text-sm"
        value={pick || current || ''}
        onChange={(e) => setPick(e.target.value)}
        aria-label="Slack workspace for this instance"
        disabled={busy !== null}
      >
        {!current && !pick && <option value="">Choose a workspace…</option>}
        {list.map((w) => (
          <option key={w.slackTeamId} value={w.slackTeamId}>
            {w.slackTeamName}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        onClick={() => useWorkspace(pick || current || '')}
        loading={busy === 'workspace'}
        disabled={busy !== null || !(pick || current) || (pick || current) === current}
      >
        Use this workspace
      </Button>
    </div>
  );

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
            <Cloud className="inline w-4 h-4 -mt-0.5 mr-1" />
            Slack via Crewly Cloud
          </h3>
          <p className="text-xs text-text-secondary-dark mt-1">
            Install the Crewly app in your Slack workspace once; every Crewly instance signed in to your
            Crewly account gets team channels and agent identities automatically — no tokens to copy.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onRefresh(true)} icon={RefreshCw} aria-label="Refresh Cloud Slack status">
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {!status ? (
        <p className="text-sm text-text-secondary-dark">Loading Cloud Slack status...</p>
      ) : envOnly ? (
        <Alert variant="info">
          <code className="text-xs bg-background-dark px-1 py-0.5 rounded">CREWLY_SLACK_SOURCE=env</code> is set: this
          instance only uses its self-hosted Slack app tokens (see Advanced below).
        </Alert>
      ) : !cloudConnected ? (
        <Alert variant="warning">
          Log in to Crewly Cloud first (
          <a href="/cloud" className="underline">Settings → Cloud</a>
          ) — Slack is installed through your Crewly account.
        </Alert>
      ) : !workspace && choices ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary-dark">
            Your Crewly account has {choices.length} Slack workspaces. Pick the one this instance should serve, or
            connect another one.
          </p>
          {workspacePicker(choices, null)}
          <Button variant="ghost" size="sm" onClick={connect} loading={busy === 'connect'} disabled={busy !== null} icon={ExternalLink}>
            Connect another workspace
          </Button>
        </div>
      ) : !workspace ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary-dark">
            No Slack workspace is connected to your Crewly account yet.
          </p>
          <Button onClick={connect} loading={busy === 'connect'} disabled={busy !== null} icon={ExternalLink}>
            {busy === 'connect' ? 'Opening Slack...' : 'Connect Slack'}
          </Button>
          {status.configError && (
            <p className="text-xs text-amber-400/80">Last Cloud check failed: {status.configError}</p>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2" data-testid="slack-cloud-workspace-card">
            <div className="flex items-center justify-between py-2 border-b border-border-dark">
              <span className="text-sm text-text-secondary-dark">Workspace</span>
              <span className="text-sm font-medium">{workspace.slackTeamName}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border-dark">
              <span className="text-sm text-text-secondary-dark">Bot user</span>
              <span className="text-sm font-medium font-mono">{workspace.botUserId}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border-dark">
              <span className="text-sm text-text-secondary-dark">Events</span>
              <span className="text-sm font-medium">
                {status.connected && status.transport === 'cloud'
                  ? 'Delivered by Crewly Cloud (no Socket Mode)'
                  : status.connected
                    ? 'Self-hosted Socket Mode (Cloud config ignored)'
                    : 'Not connected on this instance yet'}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border-dark">
              <span className="text-sm text-text-secondary-dark">Agent identities</span>
              <span className="text-sm font-medium">{workspace.agentIdentities} installed</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-text-secondary-dark">This instance</span>
              <span className="text-sm font-medium">
                {status.instanceId ? <code className="text-xs">{status.instanceId}</code> : 'not registered'}
                {status.lastHeartbeatAt && (
                  <span className="text-xs text-text-secondary-dark ml-2">
                    · registered {new Date(status.lastHeartbeatAt).toLocaleString()}
                  </span>
                )}
              </span>
            </div>
            {status.registryError && (
              <p className="text-xs text-amber-400/80">Registry: {status.registryError}</p>
            )}
          </div>

          <div className="space-y-2">
            {switchable && (
              <>
                <p className="text-xs text-text-secondary-dark">
                  Your account has {switchable.length} workspaces. This instance serves one of them:
                </p>
                {workspacePicker(switchable, workspace.slackTeamId)}
              </>
            )}
            <Button variant="ghost" size="sm" onClick={connect} loading={busy === 'connect'} disabled={busy !== null} icon={ExternalLink}>
              Connect another workspace
            </Button>
          </div>

          <div className="flex items-start gap-3">
            <Toggle
              id="slack-cloud-primary"
              checked={status.primary}
              disabled={busy !== null}
              onChange={(e) => setPrimary(e.target.checked)}
              label="Make this the primary instance"
              aria-label="Make this the primary instance"
            />
          </div>
          <p className="text-xs text-text-secondary-dark -mt-3">
            Direct messages to the Crewly bot and channels no team owns go to the primary instance. Team channels
            always reach the instance running that team.
          </p>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h4 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wide">
                <Users className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />
                Agents waiting for install
              </h4>
              <Button variant="ghost" size="sm" onClick={syncAgents} loading={busy === 'sync'} disabled={busy !== null}>
                Sync agents
              </Button>
            </div>
            {status.pendingInstalls.length === 0 ? (
              <p className="text-xs text-text-secondary-dark">
                Every agent with a Slack identity is installed. New team members get an install link here.
              </p>
            ) : (
              <ul className="divide-y divide-border-dark">
                {status.pendingInstalls.map((p) => (
                  <li key={p.agentSession} className="py-2 flex items-center justify-between gap-3">
                    <span className="text-sm truncate">{p.agentSession}</span>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                    >
                      Install
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button variant="danger-ghost" size="sm" icon={Unlink} onClick={disconnectWorkspace} loading={busy === 'disconnect'} disabled={busy !== null}>
              Disconnect workspace
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
};

export default SlackCloudWorkspace;
