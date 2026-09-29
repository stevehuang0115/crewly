/**
 * Orchestrator Status Banner
 *
 * Displays a warning/error banner when the orchestrator is not active.
 * Uses the shared useOrchestratorStatus hook for consistent status across the app.
 *
 * A pending runtime sign-in is *not* shown here: `PendingLoginsBanner` (same
 * content column, directly above) is the single sign-in banner, fed by the
 * same OAuth monitor. Showing it in both places stacked two banners with
 * the same message on top of each other.
 *
 * @module components/OrchestratorStatusBanner
 */

import React, { useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { IconButton } from '@crewly/ui';
import { useOrchestratorStatus } from '../hooks/useOrchestratorStatus';

export const OrchestratorStatusBanner: React.FC = () => {
  const { status, isLoading, refresh } = useOrchestratorStatus();
  const [dismissed, setDismissed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const isActive = status?.isActive ?? true;
  const agentStatus = status?.agentStatus;

  // Waiting on a sign-in: the sign-in banner above covers it.
  const waitingOnSignIn = Boolean(status?.loginRequired);

  // Don't show banner while loading, if active, while a sign-in is pending,
  // if no status yet, or if dismissed
  if (isLoading || isActive || waitingOnSignIn || !status || dismissed) {
    return null;
  }

  const isActivating = agentStatus === 'activating' || agentStatus === 'starting' || agentStatus === 'started';

  const bgColor = isActivating
    ? 'bg-yellow-500/10 border-yellow-500/30'
    : 'bg-rose-500/10 border-rose-500/30';

  const iconColor = isActivating ? 'text-yellow-400' : 'text-rose-400';
  const titleColor = isActivating ? 'text-yellow-300' : 'text-rose-300';
  const messageColor = isActivating ? 'text-yellow-200/80' : 'text-rose-200/80';

  return (
    <div className={`flex items-start justify-between gap-3 px-4 py-2.5 border-b ${bgColor}`}>
      <div className="flex flex-1 min-w-0 items-start gap-3">
        <AlertTriangle className={`shrink-0 mt-0.5 ${iconColor}`} size={18} />
        <div className="flex min-w-0 items-center gap-x-2 gap-y-1 text-sm flex-wrap">
          <span className={`font-semibold ${titleColor}`}>
            {isActivating ? 'Orchestrator Initializing' : 'Orchestrator Not Running'}
          </span>
          <span className={messageColor}>
            {isActivating
              ? 'The Crewly orchestrator is starting up. This may take a few moments...'
              : 'The Crewly orchestrator is not running. Check the application logs for issues.'}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          icon={RefreshCw}
          onClick={handleRefresh}
          variant="ghost"
          size="sm"
          loading={isRefreshing}
          aria-label="Refresh status"
        />
        <IconButton
          icon={X}
          onClick={() => setDismissed(true)}
          variant="ghost"
          size="sm"
          aria-label="Dismiss banner"
        />
      </div>
    </div>
  );
};
