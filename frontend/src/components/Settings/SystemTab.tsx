/**
 * SystemTab Component
 *
 * Settings tab showing Agent Heartbeat monitoring.
 * Cron Jobs have been moved to the Schedules page for a unified scheduling view.
 *
 * @module components/Settings/SystemTab
 */

import React from 'react';
import { HeartbeatPanel } from './HeartbeatPanel';

/**
 * System tab for Settings page.
 *
 * Renders Agent Heartbeat panel for real-time agent connection monitoring.
 * Cron job management has been consolidated into the Schedules page.
 *
 * @returns SystemTab component
 */
export const SystemTab: React.FC = () => {
  return (
    <div className="space-y-8">
      <HeartbeatPanel />
    </div>
  );
};

export default SystemTab;
