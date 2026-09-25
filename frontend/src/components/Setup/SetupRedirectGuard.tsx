/**
 * SetupRedirectGuard
 *
 * Mounted once inside the router. On app load it checks `GET /api/harness`
 * and sends the user to `/setup` when setup is incomplete (no orc harness,
 * orc harness not installed, or known to be logged out). It never fires
 * from `/setup` or `/auth*`, when the user chose "稍后再说 / Skip for now",
 * or when the status request fails (e.g. waiting on the API token).
 *
 * @module components/Setup/SetupRedirectGuard
 */

import React, { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { harnessService } from '../../services/harness.service';
import { SETUP_ROUTE } from '../../constants/harness.constants';
import { isSetupRedirectAllowedFrom, isSetupSkipped, needsHarnessSetup } from '../../utils/setup-redirect';

/**
 * First-run redirect to `/setup`. Renders nothing.
 *
 * @returns null
 */
export const SetupRedirectGuard: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  // Read the path at resolve time: the user may have navigated meanwhile.
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    if (isSetupSkipped() || !isSetupRedirectAllowedFrom(pathRef.current)) return undefined;
    let cancelled = false;
    harnessService
      .getStatus()
      .then((overview) => {
        if (cancelled || isSetupSkipped() || !isSetupRedirectAllowedFrom(pathRef.current)) return;
        if (needsHarnessSetup(overview)) navigate(SETUP_ROUTE, { replace: true });
      })
      .catch(() => {
        // Status unavailable: never block the app on it.
      });
    return () => {
      cancelled = true;
    };
    // Only on app load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
};
