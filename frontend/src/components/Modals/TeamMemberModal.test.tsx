/**
 * TeamMemberModal tests — system prompt + terminal output for one member.
 *
 * @module components/Modals/TeamMemberModal.test
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamMemberModal } from './TeamMemberModal';
import type { TeamMember } from '@/types';

vi.mock('@/services/websocket.service', () => ({
  webSocketService: {
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    subscribeToSession: vi.fn(),
    unsubscribeFromSession: vi.fn(),
  },
}));

const member: TeamMember = {
  id: 'm1',
  name: 'Sam',
  sessionName: 'sam-session',
  role: 'developer',
  systemPrompt: 'You are Sam.',
  agentStatus: 'active',
  workingStatus: 'idle',
  runtimeType: 'claude-code',
  createdAt: '',
  updatedAt: '',
};

describe('TeamMemberModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { memberId: 'm1', memberName: 'Sam', sessionName: 'sam-session', output: 'hello world', timestamp: '2026-01-01T00:00:00Z' },
        }),
    }) as unknown as typeof fetch;
  });

  it('shows the member header and the system prompt tab', () => {
    render(<TeamMemberModal member={member} teamId="t1" onClose={vi.fn()} />);
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Agent: active')).toBeInTheDocument();
    expect(screen.getByText('You are Sam.')).toBeInTheDocument();
  });

  it('switches to the terminal tab and shows fetched output', async () => {
    render(<TeamMemberModal member={member} teamId="t1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal Output' }));
    expect(await screen.findByText('hello world')).toBeInTheDocument();
    expect(screen.getByText('Session: sam-session')).toBeInTheDocument();
  });

  it('closes from the dialog close button', () => {
    const onClose = vi.fn();
    render(<TeamMemberModal member={member} teamId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalled();
  });
});
