/**
 * Update Banner
 *
 * Displays an informational banner when a newer version of Crewly is available.
 * Follows the OrchestratorStatusBanner pattern — dismissible, styled consistently.
 *
 * @module components/UpdateBanner
 */

import React, { useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { IconButton } from '@crewly/ui';
import { useVersionCheck } from '../hooks/useVersionCheck';

/**
 * A dismissible banner that notifies the user about available Crewly updates.
 * Renders nothing when loading, when no update is available, or when dismissed.
 */
export const UpdateBanner: React.FC = () => {
  const { versionInfo, isLoading } = useVersionCheck();
  const [dismissed, setDismissed] = useState(false);

  if (isLoading || !versionInfo?.updateAvailable || dismissed) {
    return null;
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b bg-cyan-500/10 border-cyan-500/30">
      <div className="flex items-center gap-3">
        <ArrowUpCircle className="shrink-0 text-cyan-400" size={18} />
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-cyan-300">Update Available</span>
          <span className="text-cyan-200/80">
            Crewly v{versionInfo.latestVersion} is available (current: v{versionInfo.currentVersion}).
            Run <code className="bg-cyan-500/20 px-1.5 py-0.5 rounded text-cyan-300">crewly upgrade</code> to update.
          </span>
        </div>
      </div>
      <IconButton
        icon={X}
        onClick={() => setDismissed(true)}
        variant="ghost"
        size="sm"
        aria-label="Dismiss update banner"
      />
    </div>
  );
};
