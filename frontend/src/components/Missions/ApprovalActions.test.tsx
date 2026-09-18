/**
 * Tests for ApprovalActions — approve posts immediately; reject requires a
 * reason and posts through the dialog.
 *
 * @module components/Missions/ApprovalActions.test
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalActions } from './ApprovalActions';

const approveMock = vi.fn();
const rejectMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    approveMission: (...args: unknown[]) => approveMock(...args),
    rejectMission: (...args: unknown[]) => rejectMock(...args),
  },
}));

describe('ApprovalActions', () => {
  beforeEach(() => {
    approveMock.mockReset();
    rejectMock.mockReset();
  });

  it('calls approveMission and reports the updated mission', async () => {
    const updated = { id: 'm-child', approval: { state: 'approved' } };
    approveMock.mockResolvedValue(updated);
    const onDecided = vi.fn();
    render(<ApprovalActions missionId="m-child" onDecided={onDecided} />);

    fireEvent.click(screen.getByTestId('approve-m-child'));

    await waitFor(() => expect(onDecided).toHaveBeenCalledWith(updated));
    expect(approveMock).toHaveBeenCalledWith('m-child');
  });

  it('shows the server error when approval fails', async () => {
    approveMock.mockRejectedValue(new Error('Cannot approve a mission in state "approved"'));
    render(<ApprovalActions missionId="m-child" onDecided={vi.fn()} />);

    fireEvent.click(screen.getByTestId('approve-m-child'));

    await waitFor(() =>
      expect(screen.getByTestId('approval-error-m-child')).toHaveTextContent('Cannot approve'),
    );
  });

  it('requires a reason before rejecting', async () => {
    render(<ApprovalActions missionId="m-child" onDecided={vi.fn()} />);
    fireEvent.click(screen.getByTestId('reject-m-child'));
    fireEvent.click(screen.getByTestId('reject-confirm-m-child'));

    await waitFor(() => expect(screen.getByText(/reason is required/i)).toBeInTheDocument());
    expect(rejectMock).not.toHaveBeenCalled();
  });

  it('posts the reason on reject and closes the dialog', async () => {
    const updated = { id: 'm-child', approval: { state: 'rejected', rejectionReason: 'Too vague' } };
    rejectMock.mockResolvedValue(updated);
    const onDecided = vi.fn();
    render(<ApprovalActions missionId="m-child" onDecided={onDecided} />);

    fireEvent.click(screen.getByTestId('reject-m-child'));
    fireEvent.change(screen.getByTestId('reject-reason-m-child'), { target: { value: 'Too vague' } });
    fireEvent.click(screen.getByTestId('reject-confirm-m-child'));

    await waitFor(() => expect(onDecided).toHaveBeenCalledWith(updated));
    expect(rejectMock).toHaveBeenCalledWith('m-child', 'Too vague');
    expect(screen.queryByTestId('reject-reason-m-child')).toBeNull();
  });
});
