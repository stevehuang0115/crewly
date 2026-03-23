/**
 * SystemTab Component
 *
 * Settings tab combining Cron Job management and Agent Heartbeat monitoring.
 * Provides a unified system overview within the Settings page.
 *
 * @module components/Settings/SystemTab
 */

import React from 'react';
import { CronJobPanel } from './CronJobPanel';
import { HeartbeatPanel } from './HeartbeatPanel';

/**
 * System tab for Settings page.
 *
 * Renders two sections:
 * 1. Agent Heartbeat — real-time agent connection and activity monitoring
 * 2. Cron Jobs — scheduled task management with enable/disable/delete
 *
 * Heartbeat is shown first as it provides the most time-sensitive information.
 *
 * @returns SystemTab component
 */
export const SystemTab: React.FC = () => {
  return (
    <div className="space-y-8">
      <HeartbeatPanel />
      <div className="border-t border-border-dark" />
      <CronJobPanel />
    </div>
  );
};

export default SystemTab;
