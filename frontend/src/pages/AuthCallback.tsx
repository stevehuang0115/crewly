/**
 * Auth Callback Page
 *
 * Handles the OAuth callback from CrewlyAI Cloud.
 * Receives the token from the URL query parameter, stores it
 * in localStorage, and redirects to the Settings Cloud tab.
 *
 * @module pages/AuthCallback
 */

import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CLOUD_TOKEN_KEY } from '../constants/cloud.constants';
import { LoadingSpinner } from '@/components/UI/LoadingSpinner';

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
            body: JSON.stringify({ token, refreshToken }),
          });
        } catch {
          // Non-fatal — settings page will validate independently
        }
      }

      // Redirect to settings with cloud tab active
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
