/**
 * Tests for CreateGroupModal — the multi-agent "拉群" picker.
 *
 * @module components/Chat-team/CreateGroupModal.test
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CreateGroupModal, type PickerAgent } from './CreateGroupModal';

const AGENTS: PickerAgent[] = [
  { agentSession: 'sess-ella', name: 'Ella', role: 'content-strategist' },
  { agentSession: 'sess-grace', name: 'Grace', role: 'sales' },
  { agentSession: 'sess-luna', name: 'Luna', role: 'content-strategist' },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof CreateGroupModal>> = {}) {
  const onClose = vi.fn();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <CreateGroupModal
      onClose={onClose}
      onCreate={onCreate}
      loadAgents={async () => AGENTS}
      {...overrides}
    />,
  );
  return { onClose, onCreate };
}

describe('CreateGroupModal', () => {
  it('loads and lists the agents', async () => {
    renderModal();
    expect(await screen.findByText('Ella')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('Luna')).toBeInTheDocument();
  });

  it('keeps Create disabled until a name and ≥2 agents are chosen', async () => {
    renderModal();
    await screen.findByText('Ella');
    const submit = screen.getByTestId('create-group-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Launch crew' } });
    expect(submit.disabled).toBe(true); // name but no members

    fireEvent.click(screen.getByLabelText(/Ella/));
    expect(submit.disabled).toBe(true); // only one member

    fireEvent.click(screen.getByLabelText(/Grace/));
    expect(submit.disabled).toBe(false); // name + two members
  });

  it('calls onCreate with the name and selected agent sessions', async () => {
    const { onCreate } = renderModal();
    await screen.findByText('Ella');

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Launch crew' } });
    fireEvent.click(screen.getByLabelText(/Ella/));
    fireEvent.click(screen.getByLabelText(/Luna/));
    fireEvent.click(screen.getByTestId('create-group-submit'));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith('Launch crew', ['sess-ella', 'sess-luna']),
    );
  });

  it('calls onClose when Cancel is clicked', async () => {
    const { onClose } = renderModal();
    await screen.findByText('Ella');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a load error', async () => {
    renderModal({ loadAgents: async () => { throw new Error('boom'); } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/);
  });
});
