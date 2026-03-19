/**
 * Auth Types (Frontend)
 *
 * Type definitions for the CrewlyAI Cloud auth API.
 * Mirrors the backend auth types for type-safe API interactions.
 *
 * @module types/auth.types
 */

// ---------------------------------------------------------------------------
// User plan
// ---------------------------------------------------------------------------

/** Subscription plan type — must match backend AUTH_CONSTANTS.PLANS. */
export type UserPlan = 'free' | 'pro' | 'enterprise';

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

/** Public user profile returned by the API. */
export interface UserProfile {
  /** Unique user identifier */
  id: string;
  /** User email address */
  email: string;
  /** Display name */
  displayName: string;
  /** Subscription plan */
  plan: UserPlan;
  /** ISO timestamp of account creation */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Auth API request/response
// ---------------------------------------------------------------------------

/** Response from Cloud OAuth authentication endpoints. */
export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserProfile;
}

/** License status from GET /api/auth/license. */
export interface LicenseStatus {
  plan: UserPlan;
  features: string[];
  active: boolean;
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

/** Shape of the auth state managed by AuthContext. */
export interface AuthState {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Current user profile, or null */
  user: UserProfile | null;
  /** License status, or null */
  license: LicenseStatus | null;
  /** Whether initial auth check is in progress */
  isLoading: boolean;
  /** Last error message */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Check whether a value is a valid UserPlan.
 *
 * @param value - Value to check
 * @returns true if value is 'free' or 'pro'
 */
export function isValidUserPlan(value: unknown): value is UserPlan {
  return value === 'free' || value === 'pro' || value === 'enterprise';
}

/**
 * Check whether a value looks like a UserProfile.
 *
 * @param value - Value to check
 * @returns true if value has all required UserProfile fields
 */
export function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['email'] === 'string' &&
    typeof obj['displayName'] === 'string' &&
    isValidUserPlan(obj['plan']) &&
    typeof obj['createdAt'] === 'string'
  );
}
