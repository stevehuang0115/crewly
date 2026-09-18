/**
 * Tests for the shared OKR badge widgets.
 *
 * @module components/Missions/OkrBadges.test
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LevelBadge, ApprovalChip, KrStatusCountsRow, ProgressBar } from './OkrBadges';
import { emptyKrStatusCounts } from '../../types/mission.types';

describe('OkrBadges', () => {
  it('renders the level label', () => {
    render(<LevelBadge level="company" />);
    expect(screen.getByTestId('level-badge-company')).toHaveTextContent('Company');
  });

  it('renders the approval chip with a highlighted pending state', () => {
    render(<ApprovalChip state="pending_approval" />);
    const chip = screen.getByTestId('approval-chip-pending_approval');
    expect(chip).toHaveTextContent('Pending approval');
    expect(chip.className).toContain('font-semibold');
  });

  it('renders only non-zero KR status counts', () => {
    const counts = { ...emptyKrStatusCounts(), on_track: 2, off_track: 1 };
    render(<KrStatusCountsRow counts={counts} />);
    expect(screen.getByTestId('kr-count-on_track')).toHaveTextContent('2 on track');
    expect(screen.getByTestId('kr-count-off_track')).toHaveTextContent('1 off track');
    expect(screen.queryByTestId('kr-count-achieved')).toBeNull();
  });

  it('renders nothing when there are no KRs', () => {
    const { container } = render(<KrStatusCountsRow counts={emptyKrStatusCounts()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a clamped progress bar with percentage label', () => {
    render(<ProgressBar percent={137} label="Rolled-up" data-testid="rollup" />);
    expect(screen.getByTestId('rollup')).toHaveTextContent('Rolled-up');
    expect(screen.getByTestId('progress-percent')).toHaveTextContent('100%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('colours the bar by the derived status band', () => {
    render(<ProgressBar percent={10} />);
    expect(screen.getByRole('progressbar').className).toContain('bg-rose-500');
  });
});
