/**
 * SlackTeamChannels
 *
 * Settings card for Slack team channels: one Slack channel per Crewly team,
 * where every member of the team sees the conversation and `@name` picks a
 * specific agent. Lets the owner toggle auto-creation for new teams, set a
 * channel-name prefix, and create / link / unlink a channel per team.
 *
 * Talks to `/api/slack/team-channels` (see backend `slack.controller.ts`).
 *
 * @module components/Settings/SlackTeamChannels
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Hash, Link2, Unlink, RefreshCw } from 'lucide-react';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';
import { FormInput } from '../UI/Form';
import { Toggle } from '../UI/Toggle';

/** One team row as returned by `GET /api/slack/team-channels`. */
export interface SlackTeamChannelRow {
  teamId: string;
  teamName: string;
  memberCount: number;
  mapping: {
    slackChannelId: string;
    slackChannelName: string;
    chatChannelId: string;
    autoCreated: boolean;
  } | null;
}

/** Settings half of the API payload. */
export interface SlackTeamChannelSettings {
  autoCreate: boolean;
  channelPrefix: string;
}

interface TeamChannelsData {
  settings: SlackTeamChannelSettings;
  teams: SlackTeamChannelRow[];
}

/**
 * Parse a JSON API response, turning HTTP failures and `success:false`
 * envelopes into thrown errors with the server's message.
 */
async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data.data as T;
}

/**
 * Team channels card. Renders nothing useful until the first load resolves.
 *
 * @returns The card
 */
export const SlackTeamChannels: React.FC = () => {
  const [data, setData] = useState<TeamChannelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [linkIds, setLinkIds] = useState<Record<string, string>>({});
  const [busyTeam, setBusyTeam] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/slack/team-channels');
      const payload = await readJson<TeamChannelsData>(res);
      const teams = Array.isArray(payload?.teams) ? payload.teams : [];
      const settings = payload?.settings ?? { autoCreate: true, channelPrefix: '' };
      setData({ settings, teams });
      setPrefix(settings.channelPrefix ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load team channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateSettings = async (patch: Partial<SlackTeamChannelSettings>) => {
    try {
      setError(null);
      const res = await fetch('/api/slack/team-channels/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const settings = await readJson<SlackTeamChannelSettings>(res);
      setData((prev) => (prev ? { ...prev, settings } : prev));
      setPrefix(settings.channelPrefix ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  };

  const createOrLink = async (teamId: string, slackChannelId?: string) => {
    setBusyTeam(teamId);
    try {
      setError(null);
      const res = await fetch('/api/slack/team-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackChannelId ? { teamId, slackChannelId } : { teamId }),
      });
      await readJson(res);
      setLinkIds((prev) => ({ ...prev, [teamId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    } finally {
      setBusyTeam(null);
    }
  };

  const unlink = async (row: SlackTeamChannelRow) => {
    if (!row.mapping) return;
    const archive = row.mapping.autoCreated
      ? window.confirm(`Also archive #${row.mapping.slackChannelName} in Slack?`)
      : false;
    setBusyTeam(row.teamId);
    try {
      setError(null);
      const res = await fetch(
        `/api/slack/team-channels/${encodeURIComponent(row.teamId)}${archive ? '?archive=true' : ''}`,
        { method: 'DELETE' },
      );
      await readJson(res);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink channel');
    } finally {
      setBusyTeam(null);
    }
  };

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
            Team Channels
          </h3>
          <p className="text-xs text-text-secondary-dark mt-1">
            Each team gets its own Slack channel. Everyone on the team sees the conversation,
            <code className="mx-1 text-xs bg-background-dark px-1 py-0.5 rounded">@name</code>
            picks a specific agent, and replies show up under each agent&apos;s own name.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} icon={RefreshCw} aria-label="Reload team channels">
          Reload
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary-dark">Loading team channels...</p>
      ) : data ? (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <Toggle
              id="slack-team-channels-auto"
              label="Auto-create a channel for every new team"
              checked={data.settings.autoCreate}
              onChange={(e) => updateSettings({ autoCreate: e.target.checked })}
            />
            <div className="flex items-end gap-2">
              <div>
                <label htmlFor="slack-team-channels-prefix" className="block text-xs text-text-secondary-dark mb-1">
                  Channel name prefix
                </label>
                <FormInput
                  id="slack-team-channels-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="e.g. crew-"
                  className="w-40"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={prefix === (data.settings.channelPrefix ?? '')}
                onClick={() => updateSettings({ channelPrefix: prefix })}
              >
                Save prefix
              </Button>
            </div>
          </div>

          {data.teams.length > 0 && (
            <p className="text-xs text-text-secondary-dark">
              {data.teams.filter((t) => t.mapping).length} of {data.teams.length} teams have a channel.
              {data.teams.some((t) => !t.mapping) && ' Teams without one are listed below.'}
            </p>
          )}
          {data.teams.length === 0 ? (
            <p className="text-sm text-text-secondary-dark">No teams yet. Create a team and its channel will appear here.</p>
          ) : (
            <ul className="divide-y divide-border-dark">
              {[...data.teams].sort((a, b) => Number(!!b.mapping) - Number(!!a.mapping)).map((row) => (
                <li key={row.teamId} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{row.teamName}</div>
                    <div className="text-xs text-text-secondary-dark">
                      {row.memberCount} {row.memberCount === 1 ? 'agent' : 'agents'}
                      {row.mapping && (
                        <>
                          {' · '}
                          <Hash className="inline w-3 h-3 -mt-0.5" />
                          {row.mapping.slackChannelName}
                          {' · '}
                          {row.mapping.autoCreated ? 'created by Crewly' : 'linked'}
                        </>
                      )}
                    </div>
                  </div>
                  {row.mapping ? (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      icon={Unlink}
                      disabled={busyTeam === row.teamId}
                      onClick={() => unlink(row)}
                    >
                      Unlink
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <FormInput
                        aria-label={`Slack channel ID to link for ${row.teamName}`}
                        value={linkIds[row.teamId] ?? ''}
                        onChange={(e) => setLinkIds((prev) => ({ ...prev, [row.teamId]: e.target.value }))}
                        placeholder="C0123… to link"
                        className="w-40"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={Link2}
                        disabled={busyTeam === row.teamId || !(linkIds[row.teamId] ?? '').trim()}
                        onClick={() => createOrLink(row.teamId, (linkIds[row.teamId] ?? '').trim())}
                      >
                        Link
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        icon={Hash}
                        disabled={busyTeam === row.teamId}
                        loading={busyTeam === row.teamId}
                        onClick={() => createOrLink(row.teamId)}
                      >
                        Create channel
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export default SlackTeamChannels;
