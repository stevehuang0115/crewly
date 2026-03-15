/**
 * Cloud Constants
 *
 * Shared constants for CrewlyAI Cloud API integration.
 * Used across hooks, pages, and components that interact with the Cloud service.
 *
 * @module constants/cloud.constants
 */

/** Cloud API base URL for device endpoints. */
export const CLOUD_API_BASE = 'https://api.crewlyai.com/api';

/** localStorage key for cloud access token. */
export const CLOUD_TOKEN_KEY = 'crewly_cloud_token';

/** Cloud auth page URL for OSS → Cloud login redirect. */
export const CLOUD_AUTH_URL = 'https://crewlyai.com/auth';

/**
 * Build the Cloud auth redirect URL with callback parameter.
 * OSS redirects to crewlyai.com/auth?redirect=<callback>, and after login
 * crewlyai.com redirects back with ?token=<jwt>.
 *
 * @param callbackUrl - The OSS callback URL (e.g., http://localhost:8787/auth/callback)
 * @returns Full redirect URL for Cloud auth
 */
export function buildCloudAuthRedirectUrl(callbackUrl?: string): string {
  const callback = callbackUrl || `${window.location.origin}/auth/callback`;
  return `${CLOUD_AUTH_URL}?redirect=${encodeURIComponent(callback)}`;
}
