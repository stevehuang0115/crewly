/**
 * Tests for AgentDirectory — the left rail for /agents.
 *
 * @module components/Chat/AgentDirectory.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AgentDirectory, type DirectoryAgent } from './AgentDirectory';

const sampleAgents: DirectoryAgent[] = [
  {
    agentSession: 'crewly-orc',
    name: 'Orc',
    role: 'orchestrator',
    teamId: 'orchestrator',
    teamName: 'Orchestrator Team',
    agentStatus: 'active',
    workingStatus: 'idle',
  },
  {
    agentSession: 'crewly-marketing-ella',
    name: 'Ella',
    role: 'team-leader',
    teamId: 't-marketing',
    teamName: 'Marketing',
    agentStatus: 'active',
    workingStatus: 'in_progress',
  },
  {
    agentSession: 'crewly-marketing-luna',
    name: 'Luna',
    role: 'worker',
    teamId: 't-marketing',
    teamName: 'Marketing',
    agentStatus: 'inactive',
    workingStatus: 'idle',
  },
];

function makeFetchOk(agents: DirectoryAgent[]): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ success: true, data: { agents } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('AgentDirectory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading then renders agents grouped by team', async () => {
    const fetchImpl = makeFetchOk(sampleAgents);
    render(
      <AgentDirectory onSelectAgent={() => {}} fetchImpl={fetchImpl} />,
    );
    expect(screen.getByText('Loading agents…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Orc')).toBeInTheDocument();
    });
    expect(screen.getByText('Ella')).toBeInTheDocument();
    expect(screen.getByText('Luna')).toBeInTheDocument();
    // Team headings appear once each.
    expect(screen.getByText('Orchestrator Team')).toBeInTheDocument();
    expect(screen.getByText('Marketing')).toBeInTheDocument();
  });

  it('renders empty state when no agents are returned', async () => {
    const fetchImpl = makeFetchOk([]);
    render(
      <AgentDirectory onSelectAgent={() => {}} fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/No agents available/i),
      ).toBeInTheDocument();
    });
  });

  it('shows an error banner + retry button on fetch failure', async () => {
    const failingFetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    render(
      <AgentDirectory onSelectAgent={() => {}} fetchImpl={failingFetch} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/Retry/i)).toBeInTheDocument();
  });

  it('fires onSelectAgent when a row is clicked', async () => {
    const onSelect = vi.fn();
    const fetchImpl = makeFetchOk(sampleAgents);
    render(
      <AgentDirectory onSelectAgent={onSelect} fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Ella')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Ella'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].agentSession).toBe(
      'crewly-marketing-ella',
    );
  });

  it('disables the row + shows "opening…" while a click is in-flight', async () => {
    const fetchImpl = makeFetchOk(sampleAgents);
    render(
      <AgentDirectory
        onSelectAgent={() => {}}
        openingAgentSession="crewly-marketing-luna"
        fetchImpl={fetchImpl}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Luna')).toBeInTheDocument();
    });
    expect(screen.getByText(/opening…/i)).toBeInTheDocument();
    // The Luna button is the closest button ancestor of the "opening…" label.
    const lunaBtn = screen
      .getByText('Luna')
      .closest('button') as HTMLButtonElement;
    expect(lunaBtn).toBeDisabled();
  });

  it('highlights the active agent row', async () => {
    const fetchImpl = makeFetchOk(sampleAgents);
    render(
      <AgentDirectory
        onSelectAgent={() => {}}
        activeAgentSession="crewly-orc"
        fetchImpl={fetchImpl}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Orc')).toBeInTheDocument();
    });
    const orcBtn = screen.getByText('Orc').closest('button') as HTMLElement;
    // Tailwind class adds blue background; assert via class string presence
    // rather than rendered styles since jsdom doesn't compute CSS.
    expect(orcBtn.className).toMatch(/bg-blue-50|bg-blue-900\/20/);
  });
});
