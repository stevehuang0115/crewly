/**
 * Orchestrator Status Banner
 *
 * The "orchestrator is down / starting" line of the system status bar
 * (specs/2026-10-02-ui-redesign.md §SystemStatusBar). `useOrchestratorStatusItem`
 * turns the shared orchestrator status into a `SystemStatusItem`;
 * `AppStatusBar` combines it with the other sources. The component below
 * renders the item on its own for any page that wants just this line.
 *
 * A pending runtime sign-in is *not* shown here: the sign-in item
 * (`PendingLoginsBanner`) covers it, fed by the same OAuth monitor.
 *
 * @module components/OrchestratorStatusBanner
 */

import React, { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { IconButton, SystemStatusBar, type SystemStatusItem } from '@crewly/ui';
import { useOrchestratorStatus } from '../hooks/useOrchestratorStatus';

/**
 * The orchestrator's status-bar item, or null when it is running (or still
 * loading, waiting on a sign-in, or dismissed).
 *
 * @returns Item for `SystemStatusBar`
 */
export function useOrchestratorStatusItem(): SystemStatusItem | null {
  const { status, isLoading, refresh } = useOrchestratorStatus();
  const [dismissed, setDismissed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const isActive = status?.isActive ?? true;
  const agentStatus = status?.agentStatus;
  // Waiting on a sign-in: the sign-in item covers it.
  const waitingOnSignIn = Boolean(status?.loginRequired);

  if (isLoading || isActive || waitingOnSignIn || !status || dismissed) {
    return null;
  }

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const isActivating = agentStatus === 'activating' || agentStatus === 'starting' || agentStatus === 'started';

  return {
    id: 'orchestrator',
    tone: isActivating ? 'attention' : 'danger',
    icon: AlertTriangle,
    title: isActivating ? 'Orchestrator Initializing' : 'Orchestrator Not Running',
    message: isActivating
      ? 'The Crewly orchestrator is starting up. This may take a few moments...'
      : 'The Crewly orchestrator is not running. Check the application logs for issues.',
    actions: (
      <IconButton icon={RefreshCw} onClick={handleRefresh} variant="ghost" size="sm" loading={isRefreshing} aria-label="Refresh status" />
    ),
    onDismiss: () => setDismissed(true),
    dismissLabel: 'Dismiss banner',
  };
}

/** Orchestrator status on its own (renders nothing when it is running). */
export const OrchestratorStatusBanner: React.FC = () => {
  const item = useOrchestratorStatusItem();
  return item ? <SystemStatusBar items={[item]} /> : null;
};
