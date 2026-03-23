/**
 * Tests for SystemTab component
 *
 * @module components/Settings/SystemTab.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { SystemTab } from './SystemTab';

vi.mock('./CronJobPanel', () => ({
  CronJobPanel: () => <div data-testid="cron-job-panel">CronJobPanel</div>,
}));

vi.mock('./HeartbeatPanel', () => ({
  HeartbeatPanel: () => <div data-testid="heartbeat-panel">HeartbeatPanel</div>,
}));

describe('SystemTab', () => {
  it('should render HeartbeatPanel', () => {
    render(<SystemTab />);
    expect(screen.getByTestId('heartbeat-panel')).toBeInTheDocument();
  });

  it('should render CronJobPanel', () => {
    render(<SystemTab />);
    expect(screen.getByTestId('cron-job-panel')).toBeInTheDocument();
  });

  it('should render HeartbeatPanel before CronJobPanel', () => {
    const { container } = render(<SystemTab />);
    const panels = container.querySelectorAll('[data-testid]');
    expect(panels[0].getAttribute('data-testid')).toBe('heartbeat-panel');
    expect(panels[1].getAttribute('data-testid')).toBe('cron-job-panel');
  });

  it('should render a divider between sections', () => {
    const { container } = render(<SystemTab />);
    const divider = container.querySelector('.border-t.border-border-dark');
    expect(divider).toBeInTheDocument();
  });
});
