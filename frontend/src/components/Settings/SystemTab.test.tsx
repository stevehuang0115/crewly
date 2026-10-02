/**
 * Tests for SystemTab component
 *
 * @module components/Settings/SystemTab.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect } from 'vitest';
import { SystemTab } from './SystemTab';

vi.mock('./HeartbeatPanel', () => ({
  HeartbeatPanel: () => <div data-testid="heartbeat-panel">HeartbeatPanel</div>,
}));

vi.mock('./VersionUpdatePanel', () => ({
  VersionUpdatePanel: () => <div data-testid="version-update-panel">VersionUpdatePanel</div>,
}));

const renderTab = () =>
  render(
    <MemoryRouter>
      <SystemTab />
    </MemoryRouter>,
  );

describe('SystemTab', () => {
  it('renders version & restart and the heartbeat', () => {
    renderTab();
    expect(screen.getByTestId('version-update-panel')).toBeInTheDocument();
    expect(screen.getByTestId('heartbeat-panel')).toBeInTheDocument();
  });

  it('no longer hosts the usage panel; points at the Usage page instead', () => {
    renderTab();
    expect(screen.queryByTestId('usage-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('system-usage-moved')).toHaveAttribute('href', '/usage');
  });

  it('should not render CronJobPanel (moved to Schedules page)', () => {
    renderTab();
    expect(screen.queryByTestId('cron-job-panel')).not.toBeInTheDocument();
  });
});
