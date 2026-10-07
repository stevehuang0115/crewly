/**
 * CreateGroupModal — "New group": pull multiple agents into one group chat.
 * With `variant="channel"` it is the "New channel" dialog: a named Crewly
 * channel with agents from any team (one is enough), matched to a Slack
 * channel of the same name when Slack is connected.
 *
 * Fetches the agent directory (`GET /api/chat/agents`), lets the user pick a
 * name + ≥2 agents, and hands the selection back via `onCreate`. The actual
 * `createHuddle` call lives in the host (LiveTeamChatPage) so this component
 * stays a pure picker and is easy to test.
 *
 * @module components/Chat-team/CreateGroupModal
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { FormInput } from '@crewly/ui/Form';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Popup } from '@crewly/ui/Popup';

/** One selectable agent in the picker (subset of the directory shape). */
export interface PickerAgent {
  agentSession: string;
  name: string;
  role: string;
}

export interface CreateGroupModalProps {
  /** Close without creating. */
  onClose: () => void;
  /** Create the group with a name + the chosen agent session names. */
  onCreate: (name: string, memberSessions: string[]) => Promise<void> | void;
  /**
   * Agent loader — defaults to `GET /api/chat/agents`. Injectable for tests.
   */
  loadAgents?: () => Promise<PickerAgent[]>;
  /** `group` (default) = group chat, ≥2 agents; `channel` = Crewly channel, ≥1 agent. */
  variant?: 'group' | 'channel';
}

/** Copy and limits per variant. */
const VARIANT_TEXT = {
  group: {
    title: 'New group chat',
    subtitle: 'Pull two or more agents into one room. Messages reach everyone.',
    placeholder: 'Group name (e.g. Launch crew)',
    label: 'Group name',
    submit: 'Create group',
    minAgents: 2,
  },
  channel: {
    title: 'New channel',
    subtitle: 'Agents from any team, in one room. With Slack connected, a Slack channel of the same name is created and they are invited.',
    placeholder: 'Channel name (e.g. tech-brief)',
    label: 'Channel name',
    submit: 'Create channel',
    minAgents: 1,
  },
} as const;

/** Default loader: hit the OSS agent directory endpoint. */
async function defaultLoadAgents(): Promise<PickerAgent[]> {
  const res = await fetch('/api/chat/agents');
  const body = (await res.json()) as { data?: { agents?: PickerAgent[] } };
  return body?.data?.agents ?? [];
}

/**
 * Modal dialog for creating a multi-agent group chat.
 *
 * @returns The group-creation modal.
 */
export function CreateGroupModal({
  onClose,
  onCreate,
  loadAgents = defaultLoadAgents,
  variant = 'group',
}: CreateGroupModalProps): JSX.Element {
  const text = VARIANT_TEXT[variant];
  const [agents, setAgents] = useState<PickerAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await loadAgents();
        if (!cancelled) setAgents(list);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAgents]);

  const toggle = (session: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(session)) next.delete(session);
      else next.add(session);
      return next;
    });
  };

  // A group needs a name and at least two agents to be a "group"; a channel one.
  const canCreate = useMemo(
    () => name.trim().length > 0 && selected.size >= text.minAgents && !submitting,
    [name, selected, submitting, text.minAgents],
  );

  const handleCreate = async (): Promise<void> => {
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onCreate(name.trim(), [...selected]);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <span className="text-xs text-text-secondary-dark">{selected.size} selected</span>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          data-testid="create-group-submit"
        >
          {submitting ? 'Creating…' : text.submit}
        </Button>
      </div>
    </>
  );

  return (
    <Popup
      isOpen
      onClose={onClose}
      title={text.title}
      subtitle={text.subtitle}
      size="md"
      footer={footer}
      footerAlign="space-between"
    >
      <div className="space-y-3" data-testid="create-group-modal">
        <FormInput
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={text.placeholder}
          aria-label={text.label}
        />

        <div className="-mx-2 max-h-[45vh] overflow-y-auto border-t border-border-dark pt-2">
          {loading && <LoadingSpinner size="sm" text="Loading agents…" className="py-2" />}
          {loadError && <Alert variant="error">Failed to load agents: {loadError}</Alert>}
          {!loading && !loadError && agents.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-secondary-dark">No agents available.</p>
          )}
          {agents.map((a) => {
            const checked = selected.has(a.agentSession);
            return (
              // Whole row is the click target; a native checkbox keeps the
              // multi-select semantics (a switch would read as on/off).
              <label
                key={a.agentSession}
                className="flex cursor-pointer items-center gap-3 rounded-2xl px-2 py-2 hover:bg-background-dark"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(a.agentSession)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text-primary-dark">{a.name}</span>
                  <span className="block truncate text-xs text-text-secondary-dark">{a.role}</span>
                </span>
              </label>
            );
          })}
        </div>

        {submitError && <Alert variant="error">{submitError}</Alert>}
      </div>
    </Popup>
  );
}

export default CreateGroupModal;
