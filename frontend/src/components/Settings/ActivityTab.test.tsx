/**
 * Tests for Settings › Activity (issue #881).
 *
 * @module components/Settings/ActivityTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityTab, changeLines, describeActor, describeTarget } from './ActivityTab';
import { listActivity, type ActivityEntry } from '../../services/activity.service';

vi.mock('../../services/activity.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/activity.service')>()),
  listActivity: vi.fn(),
}));

const list = vi.mocked(listActivity);

const ENTRY: ActivityEntry = {
  id: 'e1',
  ts: '2026-10-25T10:00:00.000Z',
  actor: { type: 'owner', via: 'dashboard' },
  action: 'team.member.updated',
  target: { type: 'team-member', id: 'm1', name: 'Vera' },
  before: { role: 'developer' },
  after: { role: 'qa', model: 'sonnet' },
  requestId: 'R-9',
};

const SEND: ActivityEntry = {
  id: 'e2',
  ts: '2026-10-25T09:00:00.000Z',
  actor: { type: 'agent', id: 'ce-vera-d8f94e9c', via: 'agent-session' },
  action: 'send.whatsapp',
  target: { type: 'whatsapp-chat', id: '1555@s.whatsapp.net', name: 'Ann' },
  note: 'API keys changed: global.openai',
};

describe('ActivityTab helpers', () => {
  it('describes actors and targets in one line', () => {
    expect(describeActor(ENTRY.actor)).toBe('Owner (dashboard)');
    expect(describeActor(SEND.actor)).toBe('Agent · ce-vera-d8f94e9c (agent-session)');
    expect(describeTarget(ENTRY.target)).toBe('team member · Vera');
    expect(describeTarget({ type: 'settings', id: 'all' })).toBe('settings · all');
  });

  it('renders changed fields as before → after lines', () => {
    expect(changeLines(ENTRY)).toEqual(['role: developer → qa', 'model: sonnet']);
    expect(changeLines({ ...ENTRY, before: { until: '2026-11-01' }, after: undefined })).toEqual(['until: 2026-11-01 → —']);
    expect(changeLines(SEND)).toEqual([]);
  });
});

describe('ActivityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ count: 2, limit: 100, entries: [ENTRY, SEND] });
  });

  it('lists entries newest first with actor, action, target, changes and note', async () => {
    render(<ActivityTab />);
    const row = await screen.findByTestId('activity-e1');
    expect(row).toHaveTextContent('Owner (dashboard)');
    expect(row).toHaveTextContent('team.member.updated');
    expect(row).toHaveTextContent('team member · Vera');
    expect(row).toHaveTextContent('role: developer → qa');
    expect(row).toHaveTextContent('request R-9');
    expect(screen.getByTestId('activity-e2')).toHaveTextContent('API keys changed: global.openai');
    expect(list).toHaveBeenCalledWith({ actorType: '', actorId: '', action: '', targetId: '', since: '', until: '', limit: 100 });
  });

  it('applies the filters on submit and clears them', async () => {
    render(<ActivityTab />);
    await screen.findByTestId('activity-e1');
    fireEvent.change(screen.getByTestId('activity-filter-actor-type'), { target: { value: 'agent' } });
    fireEvent.change(screen.getByTestId('activity-filter-action'), { target: { value: 'send.' } });
    fireEvent.change(screen.getByTestId('activity-filter-since'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'agent', action: 'send.', since: '2026-10-20', limit: 100 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: '', action: '', since: '' })));
  });

  it('shows an empty state, and the API error', async () => {
    list.mockResolvedValueOnce({ count: 0, limit: 100, entries: [] });
    render(<ActivityTab />);
    expect(await screen.findByText('Nothing recorded')).toBeInTheDocument();

    list.mockRejectedValueOnce(new Error('Only the owner can read the activity log.'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Only the owner can read the activity log.')).toBeInTheDocument();
  });

  it('offers "Show more" only when the page is full, then asks for the next size', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...ENTRY, id: `f${i}` }));
    list.mockResolvedValueOnce({ count: 100, limit: 100, entries: full });
    render(<ActivityTab />);
    await screen.findByTestId('activity-f0');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 300 })));
    // Two entries: nothing more to show.
    await screen.findByTestId('activity-e1');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});
