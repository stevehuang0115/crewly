/**
 * Tests for FirstTaskStep.
 *
 * @module components/Onboarding/FirstTaskStep.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirstTaskStep } from './FirstTaskStep';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';

vi.mock('../../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: { sendFirstTask: vi.fn() },
}));

const svc = vi.mocked(onboardingChecklistService);
const SUGGESTIONS = ['每天早上给我一份简报', '帮我整理收件箱', '提醒我这周要办的事'];
const SENT = { forwarded: true, queued: true, conversationId: 'c1', teamId: 't1', sentAt: 'now', message: null };

describe('FirstTaskStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fills the box from a suggestion and sends it to the team', async () => {
    svc.sendFirstTask.mockResolvedValue(SENT);
    const onSent = vi.fn();
    render(<FirstTaskStep suggestions={SUGGESTIONS} teamId="t1" teamName="Personal Assistant" onSent={onSent} />);
    expect(screen.getByText(/For "Personal Assistant"/)).toBeInTheDocument();
    expect(screen.getByTestId('first-task-send')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[1] }));
    expect(screen.getByLabelText('First task')).toHaveValue(SUGGESTIONS[1]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-task-send'));
    });
    expect(svc.sendFirstTask).toHaveBeenCalledWith(SUGGESTIONS[1], 't1');
    expect(onSent).toHaveBeenCalledWith(SENT);
    expect(screen.getByTestId('first-task-sent')).toHaveTextContent('Handed to the Orc');
  });

  it('sends typed text (trimmed) to the orchestrator when there is no team', async () => {
    svc.sendFirstTask.mockResolvedValue({ ...SENT, teamId: null, message: 'Orchestrator is currently offline.' });
    render(<FirstTaskStep suggestions={[]} teamId={null} teamName={null} onSent={vi.fn()} />);
    expect(screen.getByText(/For the Orc/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First task'), { target: { value: '  Plan my week  ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-task-send'));
    });
    expect(svc.sendFirstTask).toHaveBeenCalledWith('Plan my week', null);
    expect(screen.getByTestId('first-task-sent')).toHaveTextContent('as soon as it is online');
  });

  it('shows a send error and keeps the text', async () => {
    svc.sendFirstTask.mockRejectedValue(new Error('Orchestrator is not running.'));
    const onSent = vi.fn();
    render(<FirstTaskStep suggestions={SUGGESTIONS} teamId="t1" teamName="PA" onSent={onSent} />);
    fireEvent.change(screen.getByLabelText('First task'), { target: { value: 'Hi' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-task-send'));
    });
    expect(screen.getByText('Orchestrator is not running.')).toBeInTheDocument();
    expect(screen.getByLabelText('First task')).toHaveValue('Hi');
    expect(onSent).not.toHaveBeenCalled();
  });
});
