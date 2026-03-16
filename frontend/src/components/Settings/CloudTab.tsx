/**
 * CloudTab Component
 *
 * CrewlyAI Cloud connection management in Settings.
 * Allows users to sign in to CrewlyAI Cloud via OAuth to access
 * Pro features like device sync and relay connections.
 *
 * @module components/Settings/CloudTab
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, LogOut, RefreshCw, Check, ExternalLink, Zap } from 'lucide-react';
import { CLOUD_TOKEN_KEY, buildCloudAuthRedirectUrl } from '../../constants/cloud.constants';

/**
 * Cloud API validation endpoint — proxied through the local OSS backend
 * to avoid CORS issues when validating tokens against api.crewlyai.com.
 */
const CLOUD_VALIDATE_URL = '/api/cloud/validate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cloud user profile from validation response. */
interface CloudUser {
  id: string;
  email: string;
  plan: string;
  name?: string;
  avatar?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Cloud connection tab for Settings page.
 *
 * Shows "Sign in with CrewlyAI" when disconnected, or connection
 * status with user info when connected.
 *
 * @returns CloudTab component
 */
export const CloudTab: React.FC = () => {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Validate the stored cloud token and fetch user info.
   */
  const validateToken = useCallback(async () => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(CLOUD_VALIDATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (res.ok && data.success && data.data) {
        setUser({
          id: data.data.id,
          email: data.data.email,
          plan: data.data.plan,
          name: data.data.name,
          avatar: data.data.avatar,
        });
        setError(null);
      } else {
        // Invalid token — clear it
        localStorage.removeItem(CLOUD_TOKEN_KEY);
        setUser(null);
      }
    } catch {
      // Connection failed — keep token but show error
      setError('Could not reach CrewlyAI Cloud. Check your internet connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Validate token on mount. */
  useEffect(() => {
    validateToken();
  }, [validateToken]);

  /**
   * Start the OAuth sign-in flow via crewlyai.com/cloud/auth.
   * After login, the user is redirected back to this OSS instance with a JWT token.
   */
  const handleSignIn = () => {
    const callbackUrl = `${window.location.origin}/auth/callback`;
    window.location.href = buildCloudAuthRedirectUrl(callbackUrl);
  };

  /**
   * Store token via the OSS backend connect endpoint.
   */
  const handleStoreToken = useCallback(async (token: string) => {
    try {
      await fetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Best-effort — the token is already stored in localStorage
    }
  }, []);

  /** Store token in OSS backend when user connects. */
  useEffect(() => {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (token && user) {
      handleStoreToken(token);
    }
  }, [user, handleStoreToken]);

  /**
   * Disconnect from CrewlyAI Cloud.
   */
  const handleDisconnect = () => {
    localStorage.removeItem(CLOUD_TOKEN_KEY);
    setUser(null);
    setError(null);
  };

  /**
   * Get plan badge color class.
   */
  const getPlanBadgeClass = (plan: string): string => {
    switch (plan) {
      case 'pro': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
      case 'enterprise': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/30';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary-dark flex items-center gap-2">
          <Cloud className="w-5 h-5" />
          CrewlyAI Cloud
        </h2>
        <p className="text-sm text-text-secondary-dark mt-1">
          Connect to CrewlyAI Cloud for device sync, remote access, and Pro features.
        </p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Connected State */}
      {user ? (
        <div className="bg-surface-dark border border-border-dark rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.name || user.email}
                    className="w-10 h-10 rounded-full"
                  />
                ) : (
                  <Cloud className="w-5 h-5 text-primary" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary-dark">
                    {user.name || user.email}
                  </span>
                  <Check className="w-4 h-4 text-emerald-400" />
                </div>
                <span className="text-xs text-text-secondary-dark">{user.email}</span>
              </div>
            </div>

            <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getPlanBadgeClass(user.plan)}`}>
              {user.plan.charAt(0).toUpperCase() + user.plan.slice(1)}
            </span>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-border-dark">
            <button
              onClick={validateToken}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary-dark hover:text-rose-400 rounded-md hover:bg-background-dark transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        /* Disconnected State */
        <div className="bg-surface-dark border border-border-dark rounded-lg p-6 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10">
            <Zap className="w-6 h-6 text-primary" />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-text-primary-dark">
              Connect to CrewlyAI Cloud
            </h3>
            <p className="text-xs text-text-secondary-dark mt-1 max-w-sm mx-auto">
              Sign in with your CrewlyAI account to enable device sync,
              remote team access, and Pro features.
            </p>
          </div>

          <button
            onClick={handleSignIn}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg font-medium text-sm hover:bg-primary/90 transition-colors"
            data-testid="cloud-sign-in-button"
          >
            <ExternalLink className="w-4 h-4" />
            Sign in with CrewlyAI
          </button>
        </div>
      )}
    </div>
  );
};

export default CloudTab;
