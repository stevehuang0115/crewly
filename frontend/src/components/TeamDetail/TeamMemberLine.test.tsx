import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamMemberLine, getMemberState } from './TeamMemberLine';
import type { TeamMember } from '@/types';

vi.mock('@/components/SignInNeededChip', () => ({
  SignInNeededChip: ({ agentLabel }: { agentLabel: string }) => <span data-testid="sign-in-chip">{agentLabel} sign-in</span>,
}));

const member = (over: Partial<TeamMember> = {}): TeamMember =>
  ({
    id: 'm1',
    name: 'Owen',
    role: 'developer',
    sessionName: 'owen-s',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    systemPrompt: '',
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as TeamMember;

describe('getMemberState', () => {
  it('describes what a member is doing', () => {
    expect(getMemberState(member({ currentTickets: ['CE-81'] })).doing).toBe('working on CE-81');
    expect(getMemberState(member({ currentTickets: ['CE-81', 'CE-82'] })).doing).toBe('working on CE-81 +1');
    expect(getMemberState(member({ workingStatus: 'in_progress' })).doing).toBe('working');
    expect(getMemberState(member()).doing).toBe('idle, nothing assigned');
    expect(getMemberState(member({ agentStatus: 'inactive' }))).toMatchObject({ running: false, label: 'Stopped', doing: 'stopped' });
    expect(getMemberState(member({ agentStatus: 'suspended' }))).toMatchObject({ label: 'Suspended', tone: 'attention' });
    expect(getMemberState(member({ agentStatus: 'starting' })).label).toBe('Starting…');
    expect(getMemberState(member({ agentStatus: 'inactive' }), null, true).label).toBe('Starting…');
    expect(getMemberState(member(), 'stop').label).toBe('Stopping…');
  });
});

describe('TeamMemberLine', () => {
  const handlers = {
    onStart: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn().mockResolvedValue(undefined),
    onMakeLead: vi.fn().mockResolvedValue(undefined),
    onViewAgent: vi.fn(),
    onViewTerminal: vi.fn(),
    onMessage: vi.fn(),
    onRemove: vi.fn(),
  };
  beforeEach(() => vi.clearAllMocks());

  const openMenu = (name = 'Owen') => fireEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }));

  it('reads as one line: name — role — doing', () => {
    render(<TeamMemberLine member={member({ currentTickets: ['CE-81'] })} {...handlers} />);
    expect(screen.getByTestId('member-line-m1')).toHaveTextContent('Owen — developer — working on CE-81');
    expect(screen.getByText('Owen')).toHaveAttribute('title', 'Session: owen-s');
  });

  it('says "lead" for the team lead and hides Make lead', () => {
    render(<TeamMemberLine member={member()} isLead {...handlers} />);
    expect(screen.getByTestId('lead-badge')).toHaveTextContent('lead');
    openMenu();
    expect(screen.queryByText('Make lead')).not.toBeInTheDocument();
  });

  it('running member: Message visible; view agent, terminal, stop, make lead, remove in ⋯', async () => {
    render(<TeamMemberLine member={member()} {...handlers} />);
    fireEvent.click(screen.getByTestId('member-message-m1'));
    expect(handlers.onMessage).toHaveBeenCalled();

    openMenu();
    fireEvent.click(screen.getByText('View agent'));
    expect(handlers.onViewAgent).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Open terminal'));
    expect(handlers.onViewTerminal).toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByText('Make lead'));
    await waitFor(() => expect(handlers.onMakeLead).toHaveBeenCalledWith('m1'));
    openMenu();
    fireEvent.click(screen.getByText('Stop Owen'));
    await waitFor(() => expect(handlers.onStop).toHaveBeenCalledWith('m1'));
    openMenu();
    fireEvent.click(screen.getByText('Remove from team'));
    expect(handlers.onRemove).toHaveBeenCalled();
  });

  it('stopped member: Start visible, Edit agent and Message in ⋯', async () => {
    render(<TeamMemberLine member={member({ agentStatus: 'inactive', sessionName: '' })} {...handlers} />);
    fireEvent.click(screen.getByTestId('member-start-m1'));
    await waitFor(() => expect(handlers.onStart).toHaveBeenCalledWith('m1'));
    openMenu();
    expect(screen.getByText('Edit agent')).toBeInTheDocument();
    expect(screen.queryByText('Open terminal')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop Owen')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Message'));
    expect(handlers.onMessage).toHaveBeenCalled();
  });

  it('shows fallback runtime, expert and sign-in needed on the meta line', () => {
    render(
      <TeamMemberLine
        member={member({
          runtimeOverride: { badge: 'On Codex', until: undefined } as unknown as TeamMember['runtimeOverride'],
          expertId: 'growth',
          loginRequired: { url: 'u', detectedAt: '' } as unknown as TeamMember['loginRequired'],
        })}
        {...handlers}
      />,
    );
    expect(screen.getByTestId('runtime-override-badge')).toHaveTextContent('On Codex');
    expect(screen.getByTestId('expert-badge')).toHaveTextContent('Expert');
    expect(screen.getByTestId('sign-in-chip')).toHaveTextContent('Owen sign-in');
  });

  it('offers no Make lead or Remove for the orchestrator member', () => {
    render(<TeamMemberLine member={member({ role: 'orchestrator' })} onViewAgent={handlers.onViewAgent} onRemove={handlers.onRemove} />);
    openMenu();
    expect(screen.queryByText('Make lead')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove from team')).not.toBeInTheDocument();
  });
});
