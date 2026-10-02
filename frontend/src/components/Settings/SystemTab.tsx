/**
 * SystemTab Component
 *
 * Settings tab with the Upgrade / Restart controls, Usage (token stats, daily
 * token caps and boosts) and Agent Heartbeat monitoring.
 * Cron Jobs have been moved to the Schedules page for a unified scheduling view.
 *
 * @module components/Settings/SystemTab
 */

import React from 'react';
import { HeartbeatPanel } from './HeartbeatPanel';
import { VersionUpdatePanel } from './VersionUpdatePanel';
import { UsagePanel } from './UsagePanel';

/**
 * System tab for Settings page.
 *
 * Renders the version / upgrade / restart controls, then the Agent Heartbeat
 * panel for real-time agent connection monitoring.
 * Cron job management has been consolidated into the Schedules page.
 *
 * @returns SystemTab component
 */
export const SystemTab: React.FC = () => {
  return (
    <div className="space-y-8">
      <VersionUpdatePanel />
      <UsagePanel />
      <HeartbeatPanel />
    </div>
  );
};

export default SystemTab;
