/**
 * Tests for the Usage page's Caps & boosts section.
 *
 * @module components/Usage/CapsBoostsSection.test
 */

import React, { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CapsBoostsSection, capsSummary } from './CapsBoostsSection';
import type { CapsDraft } from '../../hooks/useUsage';
import type { CapsView } from '../../services/usage.service';
import { M, makeCapsView, makeUsageStats } from '../../test/usage.fixtures';

interface HostProps {
  caps?: CapsView;
  onBoost?: ReturnType<typeof vi.fn>;
  onEndBoost?: ReturnType<typeof vi.fn>;
  onSaveCaps?: ReturnType<typeof vi.fn>;
  startOpen?: boolean;
}

/** Holds the open state the page would hold. */
const Host: React.FC<HostProps> = ({ caps = makeCapsView(), onBoost = vi.fn(), onEndBoost = vi.fn(), onSaveCaps = vi.fn().mockResolvedValue(true), startOpen = false }) => {
  const [open, setOpen] = useState(startOpen);
  const [perOpen, setPerOpen] = useState(false);
  return (
    <CapsBoostsSection
      caps={caps}
      teamRows={makeUsageStats().groups.team ?? []}
      busy={false}
      onBoost={onBoost}
      onEndBoost={onEndBoost}
      onSaveCaps={onSaveCaps}
      open={open}
      onOpenChange={setOpen}
      perOpen={perOpen}
      onPerOpenChange={setPerOpen}
    />
  );
};

describe('CapsBoostsSection', () => {
  it('is collapsed with a one-line summary', () => {
    render(<Host />);
    expect(screen.getByRole('button', { name: /Caps & boosts/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('usage-caps-summary')).toHaveTextContent('1 team cap · no boosts today');
    expect(screen.queryByLabelText('Each agent, per day')).not.toBeInTheDocument();
  });

  it('saves the typed caps, including a team and an agent cap', async () => {
    const onSaveCaps = vi.fn().mockResolvedValue(true);
    render(<Host startOpen onSaveCaps={onSaveCaps} />);
    expect(screen.getByTestId('usage-suggestion')).toHaveTextContent('Suggested: 8M');
    fireEvent.change(screen.getByLabelText('Each agent, per day'), { target: { value: '8M' } });
    fireEvent.change(screen.getByLabelText('All agents together, per day'), { target: { value: '200M' } });
    fireEvent.click(screen.getByRole('button', { name: 'Per-team and per-agent caps' }));
    fireEvent.change(screen.getByLabelText('Daily cap for team CE'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Daily cap for agent Nova'), { target: { value: '5M' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save caps' })[0]);
    const draft: CapsDraft = onSaveCaps.mock.calls[0][0];
    expect(draft).toEqual({ total: '200M', defaultAgent: '8M', teams: { 't-ce': '' }, agents: { 'ce-nova': '5M' } });
  });

  it('boosts everyone, a team (unlimited) and an agent; ends a boost', () => {
    const onBoost = vi.fn();
    const onEndBoost = vi.fn();
    const caps = makeCapsView({ boosts: [{ id: 'b3', target: 'team:t-ce', extraTokens: 20 * M, until: '', createdAt: '' }] });
    caps.teams[0] = { ...caps.teams[0], boosts: caps.boosts, extraTokens: 20 * M };
    render(<Host startOpen caps={caps} onBoost={onBoost} onEndBoost={onEndBoost} />);

    fireEvent.click(screen.getByText('Unlimited today for everyone'));
    expect(onBoost).toHaveBeenCalledWith({ scope: 'all', unlimited: true }, 'Everyone');

    const boost = screen.getByTestId('usage-boost-b3');
    expect(boost).toHaveTextContent('CE · +20M until midnight');
    fireEvent.click(within(boost).getByRole('button', { name: 'End boost' }));
    expect(onEndBoost).toHaveBeenCalledWith('b3');

    fireEvent.click(screen.getByRole('button', { name: 'Per-team and per-agent caps' }));
    fireEvent.click(within(screen.getByTestId('usage-cap-team-t-ce')).getByRole('button', { name: 'Unlimited today' }));
    expect(onBoost).toHaveBeenLastCalledWith({ scope: 'team', id: 't-ce', unlimited: true }, 'CE');
    fireEvent.click(within(screen.getByTestId('usage-cap-agent-ce-nova')).getByRole('button', { name: '+10M today' }));
    expect(onBoost).toHaveBeenLastCalledWith({ scope: 'agent', id: 'ce-nova', extraTokens: 10 * M }, 'Nova');
  });

  it('offers "End everyone boost" while everyone is boosted', () => {
    const onEndBoost = vi.fn();
    render(<Host startOpen onEndBoost={onEndBoost} caps={makeCapsView({ boosts: [{ id: 'all', target: '*', unlimited: true, until: '', createdAt: '' }] })} />);
    fireEvent.click(screen.getByText('End everyone boost'));
    expect(onEndBoost).toHaveBeenCalledWith('all');
  });
});

describe('capsSummary', () => {
  it('lists the caps in force and the boosts', () => {
    const caps = makeCapsView({
      caps: { defaultAgentCapTokens: 8 * M, totalCapTokens: 200 * M, agentCapsTokens: { a: 5 * M }, teamCapsTokens: {} },
      boosts: [{ id: 'b', target: '*', unlimited: true, until: '', createdAt: '' }],
    });
    expect(capsSummary(caps)).toBe('200M a day for all agents · 8M per agent · 1 agent cap · 1 boost today');
    expect(capsSummary(makeCapsView({ caps: { defaultAgentCapTokens: null, totalCapTokens: null, agentCapsTokens: {}, teamCapsTokens: {} } }))).toBe(
      'No daily caps set · no boosts today',
    );
  });
});
