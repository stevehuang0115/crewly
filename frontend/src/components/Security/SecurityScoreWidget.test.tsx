/**
 * SecurityScoreWidget Tests
 *
 * @module components/Security/SecurityScoreWidget.test
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { SecurityScoreWidget, calculateSecurityScore, getScoreGrade } from './SecurityScoreWidget';
import type { SecurityScoreInput } from './SecurityScoreWidget';

vi.mock('lucide-react', () => ({
  Shield: () => <svg data-testid="shield-icon" />,
}));

/** Create default input with all healthy values */
function healthyInput(overrides: Partial<SecurityScoreInput> = {}): SecurityScoreInput {
  return {
    ptyStatus: 'healthy',
    ptyTotalAgents: 4,
    ptyIsolatedCount: 4,
    approvalStatus: 'enforced',
    approvalsDeniedToday: 0,
    approvalsBypassedToday: 0,
    storageStatus: 'secure',
    ...overrides,
  };
}

describe('calculateSecurityScore', () => {
  it('should return 100 for fully secure config', () => {
    expect(calculateSecurityScore(healthyInput())).toBe(100);
  });

  it('should return lower score when not all agents isolated', () => {
    const score = calculateSecurityScore(healthyInput({ ptyIsolatedCount: 2, ptyTotalAgents: 4 }));
    expect(score).toBe(80); // 20 + 35 + 25
  });

  it('should penalize bypassed approvals', () => {
    const score = calculateSecurityScore(healthyInput({ approvalsBypassedToday: 2 }));
    expect(score).toBe(90); // 40 + 25 + 25 = 90 (35 - 10 = 25)
  });

  it('should give 0 approval points when disabled', () => {
    const score = calculateSecurityScore(healthyInput({ approvalStatus: 'disabled' }));
    expect(score).toBe(65); // 40 + 0 + 25
  });

  it('should handle zero agents gracefully', () => {
    const score = calculateSecurityScore(healthyInput({ ptyTotalAgents: 0, ptyIsolatedCount: 0 }));
    expect(score).toBe(100);
  });

  it('should give partial storage points', () => {
    const score = calculateSecurityScore(healthyInput({ storageStatus: 'partial' }));
    expect(score).toBe(90); // 40 + 35 + 15
  });

  it('should clamp to 0 minimum', () => {
    const score = calculateSecurityScore({
      ptyStatus: 'error', ptyTotalAgents: 4, ptyIsolatedCount: 0,
      approvalStatus: 'disabled', approvalsDeniedToday: 0, approvalsBypassedToday: 0,
      storageStatus: 'compromised',
    });
    expect(score).toBe(0);
  });
});

describe('getScoreGrade', () => {
  it('should return Excellent for 90+', () => {
    expect(getScoreGrade(95).label).toBe('Excellent');
  });

  it('should return Good for 70-89', () => {
    expect(getScoreGrade(75).label).toBe('Good');
  });

  it('should return Fair for 50-69', () => {
    expect(getScoreGrade(55).label).toBe('Fair');
  });

  it('should return Needs Attention for <50', () => {
    expect(getScoreGrade(30).label).toBe('Needs Attention');
  });
});

describe('SecurityScoreWidget', () => {
  it('should render score value', () => {
    render(<SecurityScoreWidget data={healthyInput()} />);
    expect(screen.getByTestId('score-value')).toHaveTextContent('100');
  });

  it('should render grade label', () => {
    render(<SecurityScoreWidget data={healthyInput()} />);
    expect(screen.getByTestId('score-grade')).toHaveTextContent('Excellent');
  });

  it('should render detail lines', () => {
    render(<SecurityScoreWidget data={healthyInput()} />);
    expect(screen.getByText('4/4 agents isolated')).toBeInTheDocument();
    expect(screen.getByText('Tool approval enforced')).toBeInTheDocument();
    expect(screen.getByText('Data stored locally')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<SecurityScoreWidget data={healthyInput()} loading />);
    expect(screen.getByText('Calculating score...')).toBeInTheDocument();
  });

  it('should show bypass count', () => {
    render(<SecurityScoreWidget data={healthyInput({ approvalsBypassedToday: 3 })} />);
    expect(screen.getByText('3 bypasses today')).toBeInTheDocument();
  });

  it('should render SVG score ring', () => {
    render(<SecurityScoreWidget data={healthyInput()} />);
    expect(screen.getByTestId('score-ring')).toBeInTheDocument();
  });
});
