/**
 * Who a connected account belongs to and who it is shared with (issue #968).
 *
 * Shown on each connected Google account, and on the Canva and Microsoft
 * To Do connections. A connection is usable only for the person who
 * connected it until it is shared with named people or with every member
 * (guests excluded). Crewly Cloud enforces it on every credential request:
 * an agent working for someone else gets "Info's Google Calendar isn't
 * shared with you".
 *
 * @module components/Connections/GrantSharingControl
 */

import React, { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import {
  CLOUD_UPDATE_REQUIRED_CODE,
  CLOUD_UPDATE_REQUIRED_MESSAGE,
  PeopleApiError,
  canonicalPersonId,
  personName,
  peopleService,
  type GrantOwnership,
  type GrantSharing,
  type Person,
  type SharableConnector,
} from '../../services/people.service';

const FIELD =
  'h-8 rounded-lg border border-border bg-bg px-2 text-[13px] text-text focus:border-primary focus:outline-none disabled:opacity-50';

/** Sharing mode labels. */
export const SHARING_LABELS: Record<GrantSharing['mode'], string> = {
  owner: 'Only them',
  people: 'Specific people',
  members: 'All members',
};

/** Props of {@link GrantSharingControl}. */
export interface GrantSharingControlProps {
  connector: SharableConnector;
  /** The Google account, for Google */
  email?: string;
  ownership: GrantOwnership;
  /** The people directory */
  people: Person[];
  /** Called with the ownership Cloud now reports */
  onSaved?: (ownership: Required<GrantOwnership>) => void;
  /**
   * False when Crewly Cloud is too old for per-person access (its status had
   * no owner/sharing): the control is shown disabled with "Requires a Cloud update".
   */
  cloudSupported?: boolean;
  testIdPrefix?: string;
}

/**
 * Owner and sharing of one connection, both editable.
 *
 * @param props - Connector, account, current ownership, people
 * @returns Control
 */
export const GrantSharingControl: React.FC<GrantSharingControlProps> = ({
  connector,
  email,
  ownership,
  people,
  onSaved,
  cloudSupported = true,
  testIdPrefix = 'grant-sharing',
}) => {
  const [current, setCurrent] = useState<Required<GrantOwnership>>({
    authorizedBy: canonicalPersonId(ownership.authorizedBy ?? 'owner', people),
    sharing: ownership.sharing ?? { mode: 'owner' },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cloud said it has no sharing yet (auth < 1.10): stays disabled.
  const [cloudTooOld, setCloudTooOld] = useState(false);
  const unsupported = !cloudSupported || cloudTooOld;
  const disabled = busy || unsupported;

  useEffect(() => {
    setCurrent({ authorizedBy: canonicalPersonId(ownership.authorizedBy ?? 'owner', people), sharing: ownership.sharing ?? { mode: 'owner' } });
  }, [ownership.authorizedBy, ownership.sharing, people]);

  const save = async (change: GrantOwnership): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await peopleService.setGrantSharing(connector, { ...(email ? { email } : {}), ...change });
      setCurrent(next);
      onSaved?.(next);
    } catch (err) {
      if (err instanceof PeopleApiError && err.code === CLOUD_UPDATE_REQUIRED_CODE) {
        setCloudTooOld(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const ownerValue = current.authorizedBy;
  const ownerKnown = people.some((p) => p.id === ownerValue) || ownerValue === 'owner';
  const shared = current.sharing.people ?? [];
  const others = people.filter((p) => p.id !== ownerValue && !(ownerValue === 'owner' && p.role === 'owner'));

  return (
    <div className="flex flex-col gap-2 text-[13px]" data-testid={testIdPrefix}>
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
        <label className="flex items-center gap-1.5 text-text-2">
          Belongs to
          <select
            className={FIELD}
            value={ownerKnown ? ownerValue : ''}
            disabled={disabled}
            aria-label="Belongs to"
            onChange={(e) => e.target.value && void save({ authorizedBy: e.target.value })}
            data-testid={`${testIdPrefix}-owner`}
          >
            {!ownerKnown && <option value="">{personName(ownerValue, people)}</option>}
            {people.map((p) => (
              <option key={p.id} value={p.role === 'owner' && ownerValue === 'owner' ? 'owner' : p.id}>
                {personName(p.id, people)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-text-2">
          Usable by
          <select
            className={FIELD}
            value={current.sharing.mode}
            disabled={disabled}
            aria-label="Usable by"
            onChange={(e) => {
              const mode = e.target.value as GrantSharing['mode'];
              void save({ sharing: mode === 'people' ? { mode, people: shared } : { mode } });
            }}
            data-testid={`${testIdPrefix}-mode`}
          >
            {(Object.keys(SHARING_LABELS) as Array<GrantSharing['mode']>).map((mode) => (
              <option key={mode} value={mode}>
                {SHARING_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {unsupported && (
        <p className="pl-5 text-text-3" data-testid={`${testIdPrefix}-cloud-update`}>
          {CLOUD_UPDATE_REQUIRED_MESSAGE}
        </p>
      )}
      {!unsupported && current.sharing.mode === 'people' && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 pl-5" disabled={busy} data-testid={`${testIdPrefix}-people`}>
          <legend className="sr-only">Shared with</legend>
          {others.length === 0 && <span className="text-text-3">Nobody else yet — people appear in Settings › People once they message an agent.</span>}
          {others.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-text-2">
              <input
                type="checkbox"
                checked={shared.includes(p.id)}
                onChange={(e) => {
                  const people = e.target.checked ? [...shared, p.id] : shared.filter((x) => x !== p.id);
                  void save({ sharing: { mode: 'people', people } });
                }}
              />
              {personName(p.id, others)}
              {p.role === 'guest' ? ' (guest)' : ''}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export default GrantSharingControl;
