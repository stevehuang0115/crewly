/**
 * Configuration service that relies on literal type narrowing from constants.
 */

import { getDefaultConfig, APP_MODES, type AppMode } from '../config/constants';

/**
 * Validate that the current mode is a known app mode.
 * This function REQUIRES literal types — fails if getDefaultConfig() returns Record<string, string>.
 */
export function validateMode(): boolean {
  const config = getDefaultConfig();
  // This line causes TS error because Record<string, string> is not assignable to AppMode
  const mode: AppMode = config.mode;
  return mode === APP_MODES.development || mode === APP_MODES.production || mode === APP_MODES.test;
}

/**
 * Get the API URL from config.
 * Uses string literal comparison that needs narrowed types.
 */
export function getApiEndpoint(): string {
  const config = getDefaultConfig();
  if (config.mode === APP_MODES.development) {
    return config.apiUrl;
  }
  return 'https://api.production.example.com';
}
