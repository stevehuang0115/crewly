/**
 * CreateGroupModal — "拉群": pull multiple agents into one group chat.
 *
 * Fetches the agent directory (`GET /api/chat/agents`), lets the user pick a
 * name + ≥2 agents, and hands the selection back via `onCreate`. The actual
 * `createHuddle` call lives in the host (LiveTeamChatPage) so this component
 * stays a pure picker and is easy to test.
 *
 * @module components/Chat-team/CreateGroupModal
 */

import { useEffect, useMemo, useState } from 'react';

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
}

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
}: CreateGroupModalProps): JSX.Element {
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

  // A group needs a name and at least two agents to be a "group".
  const canCreate = useMemo(
    () => name.trim().length > 0 && selected.size >= 2 && !submitting,
    [name, selected, submitting],
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create group chat"
      data-testid="create-group-modal"
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-border-dark bg-surface-dark shadow-xl">
        <header className="border-b border-border-dark px-4 py-3">
          <h2 className="text-base font-semibold text-text-primary-dark">New group chat</h2>
          <p className="text-xs text-text-secondary-dark">
            Pull two or more agents into one room. Messages reach everyone.
          </p>
        </header>

        <div className="px-4 py-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name (e.g. Launch crew)"
            className="mb-3 w-full rounded-md border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark placeholder:text-text-secondary-dark focus:border-primary focus:outline-none"
            aria-label="Group name"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border-dark px-2 py-2">
          {loading && <p className="px-2 py-2 text-sm text-text-secondary-dark">Loading agents…</p>}
          {loadError && (
            <p className="px-2 py-2 text-sm text-red-400" role="alert">
              Failed to load agents: {loadError}
            </p>
          )}
          {!loading && !loadError && agents.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-secondary-dark">No agents available.</p>
          )}
          {agents.map((a) => {
            const checked = selected.has(a.agentSession);
            return (
              <label
                key={a.agentSession}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-background-dark"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(a.agentSession)}
                  className="h-4 w-4"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text-primary-dark">{a.name}</span>
                  <span className="block truncate text-xs text-text-secondary-dark">{a.role}</span>
                </span>
              </label>
            );
          })}
        </div>

        {submitError && (
          <p className="px-4 py-1 text-xs text-red-400" role="alert">
            {submitError}
          </p>
        )}

        <footer className="flex items-center justify-between border-t border-border-dark px-4 py-3">
          <span className="text-xs text-text-secondary-dark">{selected.size} selected</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-dark px-3 py-1.5 text-sm text-text-secondary-dark hover:bg-background-dark"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!canCreate}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="create-group-submit"
            >
              {submitting ? 'Creating…' : 'Create group'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default CreateGroupModal;
