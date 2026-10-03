/**
 * UpdateAvailableBanner (#1010 review)
 *
 * Shown when the backend serves a newer dashboard build than the one
 * running in this tab (services/dashboard-build.service). A tab that is not
 * in view reloads by itself; one in view asks first, so nothing typed is lost.
 *
 * @module components/Layout/UpdateAvailableBanner
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { DASHBOARD_UPDATED_EVENT } from '../../services/dashboard-build.service';

/** Props (tests). */
export interface UpdateAvailableBannerProps {
  /** Reload the page (defaults to `window.location.reload`) */
  reload?: () => void;
  /** Whether the tab is hidden (defaults to `document.hidden`) */
  isHidden?: () => boolean;
}

/**
 * The banner.
 *
 * @param props - Props
 * @returns The banner, or null while the build is current
 */
export const UpdateAvailableBanner: React.FC<UpdateAvailableBannerProps> = ({
  reload = () => window.location.reload(),
  isHidden = () => document.hidden,
}) => {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    const onUpdated = (): void => {
      if (isHidden()) {
        reload();
        return;
      }
      setUpdated(true);
    };
    window.addEventListener(DASHBOARD_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(DASHBOARD_UPDATED_EVENT, onUpdated);
  }, [reload, isHidden]);

  if (!updated) return null;
  return (
    <div
      role="status"
      data-testid="update-available-banner"
      className="fixed left-1/2 top-3 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-[var(--crewly-radius-sm)] border border-border bg-surface px-4 py-2 text-[13px] text-text shadow-lg"
    >
      <span>Crewly was updated. Reload this page to keep working.</span>
      <button
        type="button"
        onClick={reload}
        className="inline-flex items-center gap-1.5 rounded-[var(--crewly-radius-sm)] bg-primary px-3 py-1 font-bold text-on-primary hover:bg-primary/90"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Reload
      </button>
    </div>
  );
};
