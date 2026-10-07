/**
 * ChannelSettingsModal — rename a Crewly channel and change who is in it.
 *
 * A rename also renames the linked Slack channel; Slack normalises names
 * (lower case, no spaces), so the field shows the name Slack applied after
 * saving. Adding an agent invites its bot to the Slack channel; removing one
 * takes it out.
 *
 * @module components/Chat-team/ChannelSettingsModal
 */

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { FormInput } from '@crewly/ui/Form';
import { Popup } from '@crewly/ui/Popup';
import type { ChannelsApi, CrewlyChannel } from '../../services/channels.service';
import type { PickerAgent } from './CreateGroupModal';

/** Props of {@link ChannelSettingsModal}. */
export interface ChannelSettingsModalProps {
  channel: CrewlyChannel;
  api: Pick<ChannelsApi, 'rename' | 'addMember' | 'removeMember'>;
  onClose: () => void;
  /** Called after every successful change (the host re-reads its list) */
  onChanged: (channel: CrewlyChannel) => void;
  /** Agent loader — defaults to `GET /api/chat/agents`. Injectable for tests. */
  loadAgents?: () => Promise<PickerAgent[]>;
}

/** Default loader: the OSS agent directory. */
async function defaultLoadAgents(): Promise<PickerAgent[]> {
  const res = await fetch('/api/chat/agents');
  const body = (await res.json()) as { data?: { agents?: PickerAgent[] } };
  return body?.data?.agents ?? [];
}

/**
 * Channel settings dialog: name and members.
 *
 * @param props - {@link ChannelSettingsModalProps}
 * @returns The dialog
 */
export function ChannelSettingsModal({
  channel: initial,
  api,
  onClose,
  onChanged,
  loadAgents = defaultLoadAgents,
}: ChannelSettingsModalProps): JSX.Element {
  const [channel, setChannel] = useState<CrewlyChannel>(initial);
  const [name, setName] = useState(initial.name);
  const [agents, setAgents] = useState<PickerAgent[]>([]);
  const [toAdd, setToAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadAgents]);

  const memberSessions = useMemo(() => new Set(channel.members.map((m) => m.sessionName)), [channel]);
  const addable = agents.filter((a) => !memberSessions.has(a.agentSession));

  /** Run a change, show its error, keep the dialog in step with the result. */
  const run = async (change: () => Promise<CrewlyChannel>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await change();
      setChannel(next);
      setName(next.name);
      onChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const renameChanged = name.trim().replace(/^#/, '') !== channel.name && name.trim().length > 0;

  return (
    <Popup
      isOpen
      onClose={onClose}
      title={`#${channel.name}`}
      subtitle={channel.slack ? `Matched to the Slack channel #${channel.slack.channelName}. Changes here change it too.` : 'Not linked to Slack yet.'}
      size="md"
      footer={
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4" data-testid="channel-settings-modal">
        <div className="flex items-center gap-2">
          <FormInput
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Channel name"
            placeholder="Channel name"
          />
          <Button
            type="button"
            size="sm"
            disabled={!renameChanged || busy}
            onClick={() => void run(() => api.rename(channel.id, name))}
            data-testid="channel-rename-submit"
          >
            Rename
          </Button>
        </div>

        <section aria-label="Members">
          <h3 className="mb-1 text-xs font-bold text-text-3">Members</h3>
          <ul className="space-y-1">
            {channel.members.map((m) => (
              <li key={m.sessionName} className="flex items-center justify-between gap-2 rounded-xl px-2 py-1 hover:bg-surface-2">
                <span className="min-w-0 truncate text-sm text-text">
                  {m.name ?? m.sessionName}
                  {m.teamName && <span className="ml-2 text-xs text-text-3">{m.teamName}</span>}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${m.name ?? m.sessionName}`}
                  disabled={busy || channel.members.length <= 1}
                  onClick={() => void run(() => api.removeMember(channel.id, m.sessionName))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:text-text disabled:opacity-40"
                  data-testid={`channel-remove-${m.sessionName}`}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={toAdd}
              onChange={(e) => setToAdd(e.target.value)}
              aria-label="Add an agent"
              className="h-9 min-w-0 flex-1 rounded-[var(--crewly-radius-sm)] border border-border bg-surface px-2 text-sm text-text"
              data-testid="channel-add-select"
            >
              <option value="">Add an agent from any team…</option>
              {addable.map((a) => (
                <option key={a.agentSession} value={a.agentSession}>
                  {a.name} — {a.role}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={!toAdd || busy}
              onClick={() =>
                void run(async () => {
                  const next = await api.addMember(channel.id, toAdd);
                  setToAdd('');
                  return next;
                })
              }
              data-testid="channel-add-submit"
            >
              Add
            </Button>
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}
      </div>
    </Popup>
  );
}

export default ChannelSettingsModal;
