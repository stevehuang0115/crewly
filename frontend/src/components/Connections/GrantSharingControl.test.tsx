/**
 * Tests for the owner / sharing control of a connection (issue #968).
 *
 * @module components/Connections/GrantSharingControl.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrantSharingControl } from './GrantSharingControl';
import { peopleService, type Person } from '../../services/people.service';

vi.mock('../../services/people.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/people.service')>()),
  peopleService: { list: vi.fn(), upsert: vi.fn(), remove: vi.fn(), setGrantSharing: vi.fn() },
}));

const svc = vi.mocked(peopleService);
const people: Person[] = [
  { id: 'UOWN', name: 'Ina', role: 'owner', source: 'owner', createdAt: '', updatedAt: '' },
  { id: 'UINFO', name: 'Info', role: 'member', source: 'auto', createdAt: '', updatedAt: '' },
  { id: 'USTEVE', name: 'Steve', role: 'member', source: 'auto', createdAt: '', updatedAt: '' },
  { id: 'UGUS', name: 'Gus', role: 'guest', source: 'owner', createdAt: '', updatedAt: '' },
];

describe('GrantSharingControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.setGrantSharing.mockImplementation(async (_c, change) => ({
      authorizedBy: change.authorizedBy ?? 'UINFO',
      sharing: change.sharing ?? { mode: 'owner' },
    }));
  });

  it("shows whose it is and that it is theirs alone by default", () => {
    render(<GrantSharingControl connector="google-workspace" email="info@gmail.com" ownership={{ authorizedBy: 'UINFO' }} people={people} />);
    expect(screen.getByTestId('grant-sharing-owner')).toHaveValue('UINFO');
    expect(screen.getByTestId('grant-sharing-mode')).toHaveValue('owner');
  });

  it('shares with all members, then with specific people', async () => {
    const onSaved = vi.fn();
    render(<GrantSharingControl connector="google-workspace" email="info@gmail.com" ownership={{ authorizedBy: 'UINFO' }} people={people} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('grant-sharing-mode'), { target: { value: 'members' } });
    await waitFor(() => expect(svc.setGrantSharing).toHaveBeenCalledWith('google-workspace', { email: 'info@gmail.com', sharing: { mode: 'members' } }));
    expect(onSaved).toHaveBeenCalledWith({ authorizedBy: 'UINFO', sharing: { mode: 'members' } });

    fireEvent.change(screen.getByTestId('grant-sharing-mode'), { target: { value: 'people' } });
    await waitFor(() => expect(screen.getByTestId('grant-sharing-people')).toBeInTheDocument());
    // The owner of the grant is not offered; a guest is marked.
    expect(screen.queryByLabelText('Info')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Gus (guest)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Steve'));
    await waitFor(() =>
      expect(svc.setGrantSharing).toHaveBeenLastCalledWith('google-workspace', { email: 'info@gmail.com', sharing: { mode: 'people', people: ['USTEVE'] } }),
    );
  });

  it('changes the owner (no email outside Google) and shows a refusal', async () => {
    render(<GrantSharingControl connector="canva" ownership={{}} people={people} />);
    expect(screen.getByTestId('grant-sharing-owner')).toHaveValue('owner');
    fireEvent.change(screen.getByTestId('grant-sharing-owner'), { target: { value: 'USTEVE' } });
    await waitFor(() => expect(svc.setGrantSharing).toHaveBeenCalledWith('canva', { authorizedBy: 'USTEVE' }));

    svc.setGrantSharing.mockRejectedValueOnce(new Error('Only the owner can change who a connection is shared with.'));
    fireEvent.change(screen.getByTestId('grant-sharing-mode'), { target: { value: 'members' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner');
  });
});
