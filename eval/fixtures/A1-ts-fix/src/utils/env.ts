/**
 * Environment utilities that depend on config literal types.
 */

import { getDefaultConfig } from '../config/constants.js';

/**
 * Check if running in development mode.
 * Requires literal type narrowing from getDefaultConfig().
 */
export function isDevelopment(): boolean {
  const config = getDefaultConfig();
  // This comparison needs literal 'development', not just string
  return config.mode === 'development';
}

/**
 * Build the full WebSocket URL for the current environment.
 */
export function getWebSocketUrl(): string {
  const config = getDefaultConfig();
  return config.wsUrl;
}
