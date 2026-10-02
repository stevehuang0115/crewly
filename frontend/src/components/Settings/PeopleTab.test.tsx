/**
 * Tests for Settings › People (issue #968).
 *
 * @module components/Settings/PeopleTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeopleTab } from './PeopleTab';
import { peopleService } from '../../services/people.service';

vi.mock('../../services/people.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/people.service')>()),
  peopleService: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn(), setGrantSharing: vi.fn() },
}));

const svc = vi.mocked(peopleService);

describe('PeopleTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.list.mockResolvedValue({
      ownerId: 'UOWN',
      people: [
        { id: 'UOWN', name: 'Ina', role: 'owner', source: 'owner', createdAt: '', updatedAt: '' },
        { id: 'UINFO', name: 'Info', role: 'member', source: 'auto', createdAt: '', updatedAt: '' },
      ],
    });
    svc.upsert.mockResolvedValue({ id: 'UINFO', role: 'guest', source: 'owner', createdAt: '', updatedAt: '' });
    svc.remove.mockResolvedValue({ removed: true });
  });

  it('lists people; the owner has no role picker', async () => {
    render(<PeopleTab />);
    expect(await screen.findByTestId('person-UINFO')).toHaveTextContent('Info');
    expect(screen.getByTestId('person-UOWN')).toHaveTextContent('Owner');
    expect(screen.queryByTestId('person-role-UOWN')).not.toBeInTheDocument();
  });

  it('changes a role and removes a person', async () => {
    render(<PeopleTab />);
    fireEvent.change(await screen.findByTestId('person-role-UINFO'), { target: { value: 'guest' } });
    await waitFor(() => expect(svc.upsert).toHaveBeenCalledWith('UINFO', { role: 'guest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Info' }));
    await waitFor(() => expect(svc.remove).toHaveBeenCalledWith('UINFO'));
  });

  it('adds a person by Slack user id only when the id is valid and new', async () => {
    render(<PeopleTab />);
    const input = await screen.findByTestId('person-new-id');
    const add = screen.getByTestId('person-add');
    fireEvent.change(input, { target: { value: 'not an id' } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'uinfo' } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'u0steve1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Steve' } });
    fireEvent.click(add);
    await waitFor(() => expect(svc.upsert).toHaveBeenCalledWith('U0STEVE1', { name: 'Steve', role: 'member' }));
  });
});
