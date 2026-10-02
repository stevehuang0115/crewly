/**
 * Update Banner
 *
 * The "a newer Crewly is available" line of the system status bar
 * (specs/2026-10-02-ui-redesign.md §SystemStatusBar). `useUpdateStatusItem`
 * builds the item; `AppStatusBar` combines it with the other sources; the
 * component renders it alone.
 *
 * @module components/UpdateBanner
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpCircle } from 'lucide-react';
import { SystemStatusBar, type SystemStatusItem } from '@crewly/ui';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { SYSTEM_SETTINGS_PATH } from '../constants/system-control.constants';

/**
 * The update item, or null while loading, when up to date, or dismissed.
 *
 * @returns Item for `SystemStatusBar`
 */
export function useUpdateStatusItem(): SystemStatusItem | null {
  const { versionInfo, isLoading } = useVersionCheck();
  const [dismissed, setDismissed] = useState(false);

  if (isLoading || !versionInfo?.updateAvailable || dismissed) {
    return null;
  }

  return {
    id: 'update',
    tone: 'primary',
    icon: ArrowUpCircle,
    title: 'Update Available',
    message: (
      <>
        Crewly v{versionInfo.latestVersion} is available (current: v{versionInfo.currentVersion}).{' '}
        <Link to={SYSTEM_SETTINGS_PATH} className="underline text-primary-text hover:text-text" data-testid="update-banner-link">
          Upgrade in Settings → System
        </Link>
      </>
    ),
    onDismiss: () => setDismissed(true),
    dismissLabel: 'Dismiss update banner',
  };
}

/** Update notice on its own (renders nothing when up to date). */
export const UpdateBanner: React.FC = () => {
  const item = useUpdateStatusItem();
  return item ? <SystemStatusBar items={[item]} /> : null;
};
