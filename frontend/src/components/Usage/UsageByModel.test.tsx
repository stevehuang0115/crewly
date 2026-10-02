/**
 * Tests for UsageByModel.
 *
 * @module components/Usage/UsageByModel.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { UsageByModel, modelMeta } from './UsageByModel';
import { M, makeUsageStats, usageRow } from '../../test/usage.fixtures';

describe('UsageByModel', () => {
  it('lists each model with tokens and estimated cost; models not priced by exact id are marked ≈', () => {
    render(<UsageByModel rows={makeUsageStats().groups.model ?? []} />);
    expect(screen.getByRole('heading', { name: 'By model' })).toBeInTheDocument();
    const opus = screen.getByTestId('usage-model-claude-opus-5');
    expect(opus).toHaveTextContent('Claude Opus · Claude Code · 60M input (30M cached) · 0 output');
    expect(screen.getByTestId('usage-model-claude-opus-5-cost')).toHaveTextContent('$60.00');
    expect(screen.getByTestId('usage-model-(unknown-model)')).toHaveTextContent('Unknown model');
    expect(screen.getByTestId('usage-model-(unknown-model)-cost')).toHaveTextContent('≈$10.00');
  });

  it('marks a family-priced model ≈ with its reason', () => {
    render(<UsageByModel rows={[usageRow('gpt-5.1-codex', 'gpt-5.1-codex', M, { meta: { family: 'GPT', rate: 'family' } })]} />);
    const cost = screen.getByTestId('usage-model-gpt-5.1-codex-cost');
    expect(cost).toHaveTextContent('≈$1.00');
    expect(cost).toHaveAttribute('title', "Priced at its model family's list price");
  });

  it('shows five models, then Show all', () => {
    const rows = Array.from({ length: 7 }, (_, i) => usageRow(`m${i}`, `model-${i}`, (7 - i) * M));
    render(<UsageByModel rows={rows} />);
    expect(screen.queryByTestId('usage-model-m5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getByTestId('usage-model-m6')).toBeInTheDocument();
  });

  it('says so when empty', () => {
    render(<UsageByModel rows={[]} />);
    expect(screen.getByText('No usage in this period.')).toBeInTheDocument();
  });

  it('modelMeta leaves out an unknown family', () => {
    expect(modelMeta(usageRow('x', 'x', M, { meta: { family: 'Unknown' } }))).toBe('1M input (500K cached) · 0 output');
  });
});
