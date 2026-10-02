/**
 * Tests for usePeople (issue #968).
 *
 * @module hooks/usePeople.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePeople } from './usePeople';
import { peopleService } from '../services/people.service';

vi.mock('../services/people.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/people.service')>()),
  peopleService: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn(), setGrantSharing: vi.fn() },
}));

const svc = vi.mocked(peopleService);
const OWNER = { id: 'UOWN', name: 'Ina', role: 'owner' as const, source: 'owner' as const, createdAt: '', updatedAt: '' };

describe('usePeople', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.list.mockResolvedValue({ people: [OWNER], ownerId: 'UOWN' });
  });

  it('loads the directory', async () => {
    const { result } = renderHook(() => usePeople());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.people).toEqual([OWNER]);
    expect(result.current.ownerId).toBe('UOWN');
  });

  it('saves and removes, reloading after each; reports a failure', async () => {
    svc.upsert.mockResolvedValue({ ...OWNER, id: 'U1', role: 'guest' });
    svc.remove.mockResolvedValue({ removed: true });
    const { result } = renderHook(() => usePeople());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => expect(await result.current.save('U1', { role: 'guest' })).toBe(true));
    await act(async () => expect(await result.current.remove('U1')).toBe(true));
    expect(svc.list).toHaveBeenCalledTimes(3);

    svc.upsert.mockRejectedValue(new Error('nope'));
    await act(async () => expect(await result.current.save('U1', { role: 'owner' })).toBe(false));
    expect(result.current.error).toBe('nope');
  });

  it('reports a load failure', async () => {
    svc.list.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => usePeople());
    await waitFor(() => expect(result.current.error).toBe('down'));
  });
});
