/**
 * Auth Context
 *
 * React context that manages CrewlyAI Cloud authentication state.
 * Authentication happens via Cloud redirect (OAuth). Tokens are
 * received from the callback and stored in localStorage via the
 * token-storage helpers.
 *
 * On mount the context checks for a stored token, validates it via
 * the /auth/me endpoint, and restores the session.
 *
 * @module contexts/AuthContext
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getAccessToken, getRefreshToken, storeTokens, clearTokens } from '../services/token-storage';
import { apiService } from '../services/api.service';
import type { UserProfile, LicenseStatus, AuthState, AuthTokenResponse } from '../types/auth.types';

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

/** Actions and state exposed by the Auth context. */
export interface AuthContextType extends AuthState {
  /** Apply tokens received from Cloud OAuth callback */
  applyCloudAuth: (response: AuthTokenResponse) => Promise<void>;
  /** Log out and clear stored tokens */
  logout: () => void;
  /** Get the current access token (for manual API calls) */
  getAccessToken: () => string | null;
  /** Check whether user has a specific pro feature */
  hasFeature: (feature: string) => boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextType | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Props for AuthProvider. */
export interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * Provides auth state and actions to the component tree.
 *
 * On mount, checks localStorage for a stored access token and
 * validates it via the Cloud API. Token refresh is handled
 * automatically when the access token expires.
 *
 * @param props - Provider props
 * @returns AuthProvider component
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);

  /** Apply an auth token response — store tokens and update state. */
  const applyAuthResponse = useCallback(async (response: AuthTokenResponse) => {
    storeTokens(response.accessToken, response.refreshToken);
    accessTokenRef.current = response.accessToken;
    setUser(response.user);

    // Fetch license status
    try {
      const status = await apiService.authGetLicense(response.accessToken);
      setLicense(status);
    } catch {
      // Non-critical — license check failure is OK
    }
  }, []);

  // -----------------------------------------------------------------------
  // Restore session on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      const storedToken = getAccessToken();
      if (!storedToken) {
        setIsLoading(false);
        return;
      }

      try {
        // Validate stored token by fetching profile
        const profile = await apiService.authGetProfile(storedToken);
        if (cancelled) return;

        accessTokenRef.current = storedToken;
        setUser(profile);

        // Fetch license
        try {
          const status = await apiService.authGetLicense(storedToken);
          if (!cancelled) setLicense(status);
        } catch {
          // Non-critical
        }
      } catch {
        // Token invalid — try refresh
        const refreshToken = getRefreshToken();
        if (refreshToken && !cancelled) {
          try {
            const response = await apiService.authRefresh(refreshToken);
            if (!cancelled) await applyAuthResponse(response);
          } catch {
            // Refresh also failed — clear tokens
            clearTokens();
          }
        } else {
          clearTokens();
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    restoreSession();

    return () => { cancelled = true; };
  }, [applyAuthResponse]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const applyCloudAuth = useCallback(async (response: AuthTokenResponse) => {
    setError(null);
    try {
      await applyAuthResponse(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed';
      setError(msg);
      throw err;
    }
  }, [applyAuthResponse]);

  const logout = useCallback(() => {
    setError(null);
    clearTokens();
    accessTokenRef.current = null;
    setUser(null);
    setLicense(null);
  }, []);

  const getToken = useCallback((): string | null => {
    return accessTokenRef.current;
  }, []);

  const hasFeature = useCallback((feature: string): boolean => {
    if (!license) return false;
    return license.features.includes(feature);
  }, [license]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const value: AuthContextType = {
    isAuthenticated: user !== null,
    user,
    license,
    isLoading,
    error,
    applyCloudAuth,
    logout,
    getAccessToken: getToken,
    hasFeature,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for accessing auth state and actions.
 *
 * Must be used within an AuthProvider.
 *
 * @returns Auth context value
 * @throws Error if used outside AuthProvider
 *
 * @example
 * ```typescript
 * const { isAuthenticated, user, applyCloudAuth, logout } = useAuth();
 * ```
 */
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
