/**
 * HealthBar Component Tests
 *
 * @module components/Dashboard/HealthBar.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { HealthBar, HealthBarProps } from './HealthBar';

const defaultProps: HealthBarProps = {
  runningAgents: 3,
  projectCount: 5,
  teamCount: 2,
  tasksInProgress: 4,
  tasksCompleted: 12,
  onFactoryClick: vi.fn(),
};

describe('HealthBar', () => {
  it('renders the health bar container', () => {
    render(<HealthBar {...defaultProps} />);
    expect(screen.getByTestId('health-bar')).toBeDefined();
  });

  it('displays running agents count', () => {
    render(<HealthBar {...defaultProps} />);
    const el = screen.getByTestId('health-stat-agents');
    expect(el.textContent).toContain('3');
    expect(el.textContent).toContain('Agents');
  });

  it('displays project count', () => {
    render(<HealthBar {...defaultProps} />);
    expect(screen.getByTestId('health-stat-projects').textContent).toContain('5');
  });

  it('displays team count', () => {
    render(<HealthBar {...defaultProps} />);
    expect(screen.getByTestId('health-stat-teams').textContent).toContain('2');
  });

  it('displays tasks in progress and completed', () => {
    render(<HealthBar {...defaultProps} />);
    const el = screen.getByTestId('health-stat-in-progress');
    expect(el.textContent).toContain('4');
    expect(el.textContent).toContain('12 done');
  });

  it('shows security shield indicator', () => {
    render(<HealthBar {...defaultProps} />);
    expect(screen.getByTestId('health-security').textContent).toContain('Secure');
  });

  it('shows factory button that triggers onFactoryClick', async () => {
    const onClick = vi.fn();
    render(<HealthBar {...defaultProps} onFactoryClick={onClick} />);
    const btn = screen.getByTestId('health-factory-btn');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders with zero values without crashing', () => {
    render(
      <HealthBar
        runningAgents={0}
        projectCount={0}
        teamCount={0}
        tasksInProgress={0}
        tasksCompleted={0}
        onFactoryClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('health-bar')).toBeDefined();
  });
});
