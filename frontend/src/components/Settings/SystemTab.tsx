/**
 * SystemTab Component
 *
 * Settings › System: version, upgrade and restart, then the agent heartbeat.
 * Token usage, daily caps and boosts moved to the Usage page (a one-line
 * pointer stays here). Cron jobs live on the Schedules page.
 *
 * @module components/Settings/SystemTab
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Gauge } from 'lucide-react';
import { HeartbeatPanel } from './HeartbeatPanel';
import { VersionUpdatePanel } from './VersionUpdatePanel';
import { ROUTES } from '../../constants/routes.constants';

/**
 * System tab for Settings page.
 *
 * @returns SystemTab component
 */
export const SystemTab: React.FC = () => {
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <VersionUpdatePanel />
      <HeartbeatPanel />
      <Link
        to={ROUTES.usage}
        className="flex items-center gap-2 border-t border-border-soft pt-4 text-[13px] text-text-2 hover:text-text"
        data-testid="system-usage-moved"
      >
        <Gauge className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1">
          Token usage, daily caps and boosts moved to the <span className="font-semibold text-primary-text">Usage</span> page.
        </span>
        <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
      </Link>
    </div>
  );
};

export default SystemTab;
