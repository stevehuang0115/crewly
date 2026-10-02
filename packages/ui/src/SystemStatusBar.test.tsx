import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SystemStatusBar, sortStatusItems, type SystemStatusItem } from './SystemStatusBar';

const update: SystemStatusItem = { id: 'update', tone: 'primary', title: 'Update available', message: 'Crewly 1.21 is out.' };
const orc: SystemStatusItem = { id: 'orc', tone: 'danger', title: 'Orchestrator not running', actions: <button type="button">Refresh status</button> };
const login: SystemStatusItem = { id: 'login', tone: 'attention', title: '1 agent needs you to sign in' };

describe('SystemStatusBar', () => {
  it('renders nothing when nothing is wrong', () => {
    const { container } = render(<SystemStatusBar items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the most severe item with its actions, the rest behind "+N more"', () => {
    render(<SystemStatusBar items={[update, orc, login]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Orchestrator not running');
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeInTheDocument();
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('system-status-more'));
    expect(screen.getByTestId('system-status-login')).toHaveTextContent('1 agent needs you to sign in');
    expect(screen.getByTestId('system-status-update')).toHaveTextContent('Crewly 1.21 is out.');
    expect(screen.getByTestId('system-status-more')).toHaveTextContent('Show less');
  });

  it('colours the bar by the top item and dismisses per item', () => {
    const onDismiss = vi.fn();
    render(<SystemStatusBar items={[{ ...login, onDismiss, dismissLabel: 'Dismiss sign-in banner', testId: 'pending-logins-banner' }]} />);
    expect(screen.getByTestId('system-status-bar').className).toContain('bg-attention-soft');
    expect(screen.getByTestId('pending-logins-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss sign-in banner' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('sorts danger > attention > primary, stable within a tone', () => {
    const login2 = { ...login, id: 'login2' };
    expect(sortStatusItems([update, login, orc, login2]).map((i) => i.id)).toEqual(['orc', 'login', 'login2', 'update']);
  });
});
