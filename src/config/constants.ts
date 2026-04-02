/**
 * Shared configuration constants.
 * BUG: The return type of getDefaultConfig() uses Record<string, string>
 * instead of preserving const narrowing. This breaks downstream consumers.
 */

export const APP_MODES = {
  development: 'development',
  production: 'production',
  test: 'test',
} as const;

export type AppMode = typeof APP_MODES[keyof typeof APP_MODES];

interface DefaultConfig {
  readonly mode: 'development';
  readonly logLevel: 'info';
  readonly apiUrl: 'http://localhost:3000';
  readonly wsUrl: 'ws://localhost:3001';
}

/**
 * Get the default application configuration.
 * BUG: Return type should preserve literal types from `as const`.
 */
export function getDefaultConfig(): DefaultConfig {
  return {
    mode: APP_MODES.development,
    logLevel: 'info',
    apiUrl: 'http://localhost:3000',
    wsUrl: 'ws://localhost:3001',
  } as const;
}

export const TIMEOUTS = {
  API_REQUEST: 30000,
  WS_CONNECT: 10000,
  HEALTH_CHECK: 5000,
} as const;
