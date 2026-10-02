/**
 * Tests for SystemTab component
 *
 * CronJobPanel has been moved to the Schedules page.
 * SystemTab now only renders HeartbeatPanel.
 *
 * @module components/Settings/SystemTab.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { SystemTab } from './SystemTab';

vi.mock('./HeartbeatPanel', () => ({
  HeartbeatPanel: () => <div data-testid="heartbeat-panel">HeartbeatPanel</div>,
}));

vi.mock('./SpendPanel', () => ({
  SpendPanel: () => <div data-testid="spend-panel">SpendPanel</div>,
}));

describe('SystemTab', () => {
  it('should render HeartbeatPanel', () => {
    render(<SystemTab />);
    expect(screen.getByTestId('heartbeat-panel')).toBeInTheDocument();
  });

  it('should render the Spend panel', () => {
    render(<SystemTab />);
    expect(screen.getByTestId('spend-panel')).toBeInTheDocument();
  });

  it('should not render CronJobPanel (moved to Schedules page)', () => {
    render(<SystemTab />);
    expect(screen.queryByTestId('cron-job-panel')).not.toBeInTheDocument();
  });
});
