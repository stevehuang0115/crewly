/**
 * Tests for ChannelSettingsModal — rename and members of a Crewly channel.
 *
 * @module components/Chat-team/ChannelSettingsModal.test
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import type { CrewlyChannel } from '../../services/channels.service';

const CHANNEL: CrewlyChannel = {
  id: 'huddle-1',
  name: 'tech-brief',
  origin: 'crewly',
  createdAt: 'now',
  slack: { channelId: 'C1', channelName: 'tech-brief' },
  members: [
    { sessionName: 'research-ella', name: 'Ella', teamName: 'Research' },
    { sessionName: 'eng-atlas', name: 'Atlas', teamName: 'Engineering' },
  ],
};

const AGENTS = [
  { agentSession: 'research-ella', name: 'Ella', role: 'researcher' },
  { agentSession: 'eng-atlas', name: 'Atlas', role: 'developer' },
  { agentSession: 'ops-iris', name: 'Iris', role: 'ops' },
];

function setup() {
  const api = {
    rename: vi.fn(async (_id: string, _name: string) => ({ ...CHANNEL, name: 'morning-brief', slack: { channelId: 'C1', channelName: 'morning-brief' } })),
    addMember: vi.fn(async () => ({ ...CHANNEL, members: [...CHANNEL.members, { sessionName: 'ops-iris', name: 'Iris', teamName: 'Ops' }] })),
    removeMember: vi.fn(async () => ({ ...CHANNEL, members: [CHANNEL.members[0]] })),
  };
  const onChanged = vi.fn();
  render(<ChannelSettingsModal channel={CHANNEL} api={api} onClose={vi.fn()} onChanged={onChanged} loadAgents={async () => AGENTS} />);
  return { api, onChanged };
}

describe('ChannelSettingsModal', () => {
  it('renames and shows the name Slack applied', async () => {
    const { api, onChanged } = setup();
    expect(screen.getByText(/Matched to the Slack channel #tech-brief/)).toBeInTheDocument();
    const input = screen.getByLabelText('Channel name') as HTMLInputElement;
    expect((screen.getByTestId('channel-rename-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Morning Brief' } });
    fireEvent.click(screen.getByTestId('channel-rename-submit'));
    await waitFor(() => expect(input.value).toBe('morning-brief'));
    expect(api.rename).toHaveBeenCalledWith('huddle-1', 'Morning Brief');
    expect(onChanged).toHaveBeenCalled();
  });

  it('adds an agent from any team (only non-members offered) and removes one', async () => {
    const { api } = setup();
    await waitFor(() => expect(screen.getByRole('option', { name: /Iris/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Atlas/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('channel-add-select'), { target: { value: 'ops-iris' } });
    fireEvent.click(screen.getByTestId('channel-add-submit'));
    await waitFor(() => expect(screen.getByText('Iris')).toBeInTheDocument());
    expect(api.addMember).toHaveBeenCalledWith('huddle-1', 'ops-iris');
    fireEvent.click(screen.getByTestId('channel-remove-eng-atlas'));
    await waitFor(() => expect(screen.queryByTestId('channel-remove-eng-atlas')).not.toBeInTheDocument());
    expect(api.removeMember).toHaveBeenCalledWith('huddle-1', 'eng-atlas');
  });

  it("shows the server's error (e.g. Slack refused the name)", async () => {
    const { api } = setup();
    api.rename.mockRejectedValueOnce(new Error('Slack did not rename #tech-brief: name_taken'));
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'taken' } });
    fireEvent.click(screen.getByTestId('channel-rename-submit'));
    expect(await screen.findByText(/name_taken/)).toBeInTheDocument();
  });
});
