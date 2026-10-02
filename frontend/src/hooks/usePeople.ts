/**
 * usePeople Hook
 *
 * The people directory (`/api/people`): load, add/edit, remove. Used by
 * Settings › People, the sharing control on each connected account, and the
 * "Works for" picker on a team member (issue #968).
 *
 * @module hooks/usePeople
 */

import { useCallback, useEffect, useState } from 'react';
import { peopleService, type Person, type PersonRole } from '../services/people.service';

/** Result of {@link usePeople}. */
export interface UsePeopleResult {
  people: Person[];
  /** The owner's person id */
  ownerId: string;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Add or edit a person; resolves false on failure (error set) */
  save: (id: string, patch: { name?: string | null; role?: PersonRole }) => Promise<boolean>;
  /** Remove a person; resolves false on failure (error set) */
  remove: (id: string) => Promise<boolean>;
}

/**
 * The people directory.
 *
 * @returns {@link UsePeopleResult}
 */
export function usePeople(): UsePeopleResult {
  const [people, setPeople] = useState<Person[]>([]);
  const [ownerId, setOwnerId] = useState('owner');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await peopleService.list();
      setPeople(data.people);
      setOwnerId(data.ownerId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (id: string, patch: { name?: string | null; role?: PersonRole }): Promise<boolean> => {
      try {
        await peopleService.upsert(id, patch);
        await reload();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await peopleService.remove(id);
        await reload();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [reload],
  );

  return { people, ownerId, loading, error, reload, save, remove };
}
