/**
 * Auth Callback Page
 *
 * Handles the OAuth callback from CrewlyAI Cloud.
 * Receives the token from the URL query parameter, stores it
 * in localStorage, hands it to this backend (`POST /api/cloud/connect`) and
 * redirects to `?next=` (a same-origin path, e.g. `/setup?step=cloud` from
 * the first-run checklist) or else to the Settings Cloud tab.
 *
 * @module pages/AuthCallback
 */

import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CLOUD_TOKEN_KEY } from '../constants/cloud.constants';
import { AUTH_CALLBACK_NEXT_PARAM, isSafeNextPath } from '../constants/onboarding-checklist.constants';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';

/**
 * AuthCallback component that processes the OAuth redirect.
 *
 * @returns Loading indicator while processing
 */
export const AuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const processCallback = async () => {
      const token = searchParams.get('token');
      const refreshToken = searchParams.get('refreshToken');
      const error = searchParams.get('error');

      if (token) {
        localStorage.setItem(CLOUD_TOKEN_KEY, token);
        // Store refresh token for frontend-side renewal
        if (refreshToken) {
          localStorage.setItem('crewly_refresh_token', refreshToken);
        }

        // Notify backend and wait for cloud connect + relay auto-connect to initiate
        try {
          await fetch('/api/cloud/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, ...(refreshToken ? { refreshToken } : {}) }),
          });
        } catch {
          // Non-fatal — settings page will validate independently
        }
      }

      // Back to where the sign-in started (first-run setup), else Settings → Cloud
      const next = searchParams.get(AUTH_CALLBACK_NEXT_PARAM);
      if (isSafeNextPath(next)) {
        const sep = next.includes('?') ? '&' : '?';
        navigate(error ? `${next}${sep}error=${encodeURIComponent(error)}` : next, { replace: true });
        return;
      }
      if (error) {
        navigate('/settings?tab=cloud&error=' + encodeURIComponent(error), { replace: true });
      } else {
        navigate('/settings?tab=cloud', { replace: true });
      }
    };

    processCallback();
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background-dark">
      <LoadingSpinner size="md" text="Completing sign-in..." />
    </div>
  );
};

export default AuthCallback;
