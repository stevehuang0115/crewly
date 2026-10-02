/**
 * Tests for the project ticket prefix loader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { loadProjectTicketPrefixes, resetProjectTicketPrefixes, useProjectTicketPrefixes } from './useProjectTicketPrefixes';
import { listAllProjectTickets } from '../../services/project-tickets.service';

vi.mock('../../services/project-tickets.service', () => ({ listAllProjectTickets: vi.fn() }));

const GROUPS = [
  { project: { id: 'p1', name: 'CE', path: '/ce' }, tickets: [{ id: 'CE-69' }, { id: 'CE-70' }] },
  { project: { id: 'p2', name: 'Flopost', path: '/f' }, tickets: [{ id: 'flo-1' }] },
] as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectTicketPrefixes();
});

describe('useProjectTicketPrefixes', () => {
  it('collects prefixes once and shares them', async () => {
    vi.mocked(listAllProjectTickets).mockResolvedValue(GROUPS);
    const { result } = renderHook(() => useProjectTicketPrefixes());
    await waitFor(() => expect([...result.current].sort()).toEqual(['CE', 'FLO']));
    await loadProjectTicketPrefixes();
    expect(listAllProjectTickets).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load so the next caller retries', async () => {
    vi.mocked(listAllProjectTickets).mockRejectedValueOnce(new Error('down')).mockResolvedValue(GROUPS);
    await expect(loadProjectTicketPrefixes()).rejects.toThrow('down');
    expect([...(await loadProjectTicketPrefixes())].sort()).toEqual(['CE', 'FLO']);
  });
});
