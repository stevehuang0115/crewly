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
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin mx-auto" />
        <p className="text-sm text-text-secondary-dark mt-4">Completing sign-in...</p>
      </div>
    </div>
  );
};

export default AuthCallback;
