/**
 * Cloud Login Button
 *
 * Replaces the legacy email/password login form with a single
 * "Connect to Cloud" button that redirects to crewlyai.com/auth.
 * After authentication, crewlyai.com redirects back with a JWT token.
 *
 * @module components/Auth/LoginForm
 */

import React from 'react';
import { Cloud, ExternalLink } from 'lucide-react';
import { Button } from '../UI';
import { buildCloudAuthRedirectUrl } from '../../constants/cloud.constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for LoginForm. */
export interface LoginFormProps {
  /** Whether a request is in flight */
  isLoading?: boolean;
  /** Error message to display */
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Cloud login button that redirects to crewlyai.com for authentication.
 *
 * @param props - LoginForm props
 * @returns Cloud login button component
 */
export const LoginForm: React.FC<LoginFormProps> = ({
  isLoading = false,
  error = null,
}) => {
  const handleCloudLogin = () => {
    window.location.href = buildCloudAuthRedirectUrl();
  };

  return (
    <div className="space-y-4 text-center">
      <div className="flex flex-col items-center gap-3 py-4">
        <Cloud className="w-10 h-10 text-primary" />
        <h3 className="text-lg font-semibold text-text-primary-dark">
          Connect to CrewlyAI Cloud
        </h3>
        <p className="text-sm text-text-secondary-dark max-w-xs">
          Sign in with your CrewlyAI account to unlock Pro features,
          team templates, and multi-device sync.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-400" role="alert">{error}</p>
      )}

      <Button
        type="button"
        variant="primary"
        disabled={isLoading}
        className="w-full"
        onClick={handleCloudLogin}
      >
        <Cloud size={16} className="mr-2" />
        Sign in with CrewlyAI Cloud
        <ExternalLink size={12} className="ml-2 opacity-60" />
      </Button>

      <p className="text-xs text-text-secondary-dark mt-2">
        You'll be redirected to crewlyai.com to sign in, then returned here.
      </p>
    </div>
  );
};

LoginForm.displayName = 'LoginForm';
