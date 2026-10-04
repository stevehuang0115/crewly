import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { PauseTeamDialog } from './PauseTeamDialog';

describe('PauseTeamDialog (specs/2026-10-04-team-pause.md)', () => {
  it('explains the pause, names the issue repo, and sends reason + until', () => {
    const onConfirm = vi.fn();
    render(<PauseTeamDialog isOpen teamName="Crewly" issueRepo="stevehuang0115/crewly" onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText('stevehuang0115/crewly')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('pause-reason'), { target: { value: '  harness work moved ' } });
    fireEvent.change(screen.getByTestId('pause-until'), { target: { value: '2026-10-10T09:00' } });
    fireEvent.click(screen.getByTestId('pause-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'harness work moved', until: new Date('2026-10-10T09:00').toISOString() });
  });

  it('sends nothing optional when left empty, and cancels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<PauseTeamDialog isOpen teamName="Crewly" onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByText(/they tell the orc instead/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pause-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
