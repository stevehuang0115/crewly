/**
 * Teams Restore Popup Component
 *
 * Shown when teams data appears to be missing but a backup exists.
 * Offers the user the choice to restore from backup or dismiss.
 *
 * @module components/TeamsRestorePopup
 */

import React, { useState, useEffect, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { Popup } from '@crewly/ui/Popup';
import { Button } from '@crewly/ui/Button';
import { apiService } from '../services/api.service';
import type { TeamsBackupStatus } from '../types';

/**
 * TeamsRestorePopup checks for teams data mismatch on mount.
 * If current teams are empty but a backup exists, displays a popup
 * offering to restore.
 */
export const TeamsRestorePopup: React.FC = () => {
  const [status, setStatus] = useState<TeamsBackupStatus | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const checkBackupStatus = async () => {
      try {
        const result = await apiService.getTeamsBackupStatus();
        if (!cancelled && result.hasMismatch) {
          setStatus(result);
          setIsOpen(true);
        }
      } catch {
        // No backup or API not ready - silently ignore
      }
    };

    checkBackupStatus();
    return () => { cancelled = true; };
  }, []);

  const handleDismiss = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleRestore = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await apiService.restoreTeamsFromBackup();

      if (result.errors && result.errors.length > 0) {
        setError(`Restored ${result.restoredCount} of ${result.totalInBackup} teams. Some teams failed to restore.`);
        setLoading(false);
      } else {
        // Full success - close and reload to reflect restored data
        setIsOpen(false);
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore teams from backup');
      setLoading(false);
    }
  }, []);

  if (!isOpen || !status) return null;

  const backupDate = status.backupTimestamp
    ? new Date(status.backupTimestamp).toLocaleString()
    : 'unknown';

  const footer = (
    <>
      <Button
        variant="secondary"
        onClick={handleDismiss}
        disabled={loading}
      >
        Dismiss
      </Button>
      <Button
        variant="primary"
        icon={RotateCcw}
        onClick={handleRestore}
        disabled={loading}
      >
        Restore
      </Button>
    </>
  );

  return (
    <Popup
      isOpen={isOpen}
      onClose={handleDismiss}
      title="Teams Data Missing"
      subtitle="A backup of your teams data is available."
      size="md"
      footer={footer}
      loading={loading}
    >
      <div className="space-y-3">
        <p className="text-sm text-text-primary-dark">
          Your teams data appears to be missing. A backup with{' '}
          <span className="font-semibold">{status.backupTeamCount} team{status.backupTeamCount !== 1 ? 's' : ''}</span>{' '}
          from <span className="font-semibold">{backupDate}</span> is available.
        </p>
        <p className="text-xs text-text-secondary-dark">
          Click &quot;Restore&quot; to recover your teams, or &quot;Dismiss&quot; to start fresh.
        </p>
      </div>
      {error && (
        <p className="mt-3 text-xs text-rose-400">{error}</p>
      )}
    </Popup>
  );
};
