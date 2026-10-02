/**
 * Settings › People
 *
 * Who uses this Crewly instance (issue #968): each Slack user with a role.
 * The owner is the Slack user who installed Crewly in Slack; anyone who
 * messages an agent is added as a member. Mark someone a guest to keep them
 * out of connections shared with "all members"; add a person by Slack user
 * id to share a connection with them before they have written.
 *
 * Connections are each person's own until shared (Connections page), and an
 * agent can be dedicated to one person (team member settings).
 *
 * @module components/Settings/PeopleTab
 */

import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, Button, LoadingSpinner } from '@crewly/ui';
import { usePeople } from '../../hooks/usePeople';
import type { PersonRole } from '../../services/people.service';

const FIELD =
  'h-9 rounded-lg border border-border bg-bg px-3 text-sm text-text focus:border-primary focus:outline-none';

/** Slack user ids: `U…` / `W…`. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,30}$/;

/** Role labels. */
export const ROLE_LABELS: Record<PersonRole, string> = {
  owner: 'Owner',
  member: 'Member',
  guest: 'Guest',
};

/**
 * The People tab.
 *
 * @returns Panel
 */
export const PeopleTab: React.FC = () => {
  const { people, loading, error, save, remove } = usePeople();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <LoadingSpinner centered text="Loading people…" />;

  const id = newId.trim().toUpperCase();
  const canAdd = SLACK_USER_ID.test(id) && !people.some((p) => p.id === id);
  const run = async (action: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="people-tab">
      <div>
        <h2 className="text-[15px] font-semibold text-text">People</h2>
        <p className="text-[13px] text-text-2">
          Everyone who uses this Crewly, by Slack account. A connection (Gmail, Calendar, Drive…) is only usable for the person who connected it until it is
          shared — change that on the Connections page. Guests are left out of connections shared with all members.
        </p>
      </div>
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      <ul className="flex flex-col" aria-label="People">
        {people.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 border-b border-border-soft py-3 last:border-b-0 sm:flex-row sm:items-center" data-testid={`person-${p.id}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text">{p.name ?? (p.role === 'owner' ? 'Owner' : p.id)}</p>
              <p className="text-[13px] text-text-3">
                {p.id === 'owner' ? 'Slack account not known yet' : p.id}
                {p.source === 'auto' ? ' · added when they first wrote' : ''}
              </p>
            </div>
            {p.role === 'owner' ? (
              <span className="text-[13px] text-text-2">Owner</span>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  className={FIELD}
                  aria-label={`Role of ${p.name ?? p.id}`}
                  value={p.role}
                  disabled={busy}
                  onChange={(e) => void run(() => save(p.id, { role: e.target.value as PersonRole }))}
                  data-testid={`person-role-${p.id}`}
                >
                  <option value="member">{ROLE_LABELS.member}</option>
                  <option value="guest">{ROLE_LABELS.guest}</option>
                </select>
                <button
                  type="button"
                  className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-danger disabled:opacity-30"
                  aria-label={`Remove ${p.name ?? p.id}`}
                  disabled={busy}
                  onClick={() => void run(() => remove(p.id))}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          void run(async () => {
            const ok = await save(id, { ...(newName.trim() ? { name: newName.trim() } : {}), role: 'member' });
            if (ok) {
              setNewId('');
              setNewName('');
            }
            return ok;
          });
        }}
      >
        <input className={`${FIELD} sm:w-48`} value={newId} placeholder="Slack user id, e.g. U0123ABCD" aria-label="Slack user id" onChange={(e) => setNewId(e.target.value)} data-testid="person-new-id" />
        <input className={`${FIELD} sm:w-48`} value={newName} placeholder="Name (optional)" aria-label="Name" onChange={(e) => setNewName(e.target.value)} />
        <Button type="submit" size="sm" variant="secondary" icon={Plus} disabled={!canAdd || busy} data-testid="person-add">
          Add person
        </Button>
      </form>
    </div>
  );
};

export default PeopleTab;
