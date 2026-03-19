/**
 * Unified Environment Variable Configuration Loader
 *
 * Centralizes all environment variable definitions for the Crewly backend.
 * Provides typed access, sensible defaults, and startup validation.
 *
 * Priority order:
 * 1. Environment variables (highest — for Docker/cloud deployment)
 * 2. Hardcoded defaults (for local development convenience)
 *
 * Usage:
 * ```ts
 * import { getEnvConfig, validateEnvConfig } from './env.config.js';
 *
 * const config = getEnvConfig();
 * console.log(config.supabase.url);
 *
 * // At startup, validate and fail fast:
 * const { valid, errors } = validateEnvConfig();
 * if (!valid) process.exit(1);
 * ```
 *
 * @module services/core/env.config
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Server configuration. */
export interface ServerEnvConfig {
  /** HTTP port (default: 3000) */
  port: number;
  /** Bind host (default: 'localhost') */
  host: string;
  /** Node environment (default: 'development') */
  nodeEnv: string;
}

/** Supabase project configuration. */
export interface SupabaseEnvConfig {
  /** Supabase project URL */
  url: string;
  /** Supabase anonymous key (public, RLS-protected) */
  anonKey: string;
}

/** Authentication and secrets configuration. */
export interface AuthEnvConfig {
  /** JWT signing secret for local auth */
  jwtSecret: string;
  /** Encryption key for stored OAuth tokens */
  tokenEncryptionKey: string;
}

/** Slack integration configuration. */
export interface SlackEnvConfig {
  /** Bot token (xoxb-...) */
  botToken: string;
  /** App-level token (xapp-...) */
  appToken: string;
  /** Signing secret for request verification */
  signingSecret: string;
  /** Default channel for notifications */
  defaultChannel: string;
  /** Comma-separated allowed user IDs */
  allowedUsers: string;
}

/** Google OAuth configuration. */
export interface GoogleOAuthEnvConfig {
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** OAuth redirect URI */
  redirectUri: string;
}

/** WhatsApp integration configuration. */
export interface WhatsAppEnvConfig {
  /** Enable WhatsApp integration */
  enabled: boolean;
  /** Phone number for WhatsApp */
  phoneNumber: string;
  /** Auth state persistence path */
  authPath: string;
  /** Comma-separated allowed contacts */
  allowedContacts: string;
}

/** AI provider API keys. */
export interface AIEnvConfig {
  /** Gemini API key (for embeddings and Gemini CLI agents) */
  geminiApiKey: string;
}

/** CrewlyAI Cloud configuration. */
export interface CloudEnvConfig {
  /** Cloud API base URL */
  apiUrl: string;
  /** Crewly home directory */
  crewlyHome: string;
  /** Backend API URL (used by bash skills) */
  crewlyApiUrl: string;
}

/** Complete environment configuration. */
export interface EnvConfig {
  server: ServerEnvConfig;
  supabase: SupabaseEnvConfig;
  auth: AuthEnvConfig;
  slack: SlackEnvConfig;
  google: GoogleOAuthEnvConfig;
  whatsapp: WhatsAppEnvConfig;
  ai: AIEnvConfig;
  cloud: CloudEnvConfig;
}

/** Validation result. */
export interface EnvValidationResult {
  /** Whether all validations passed */
  valid: boolean;
  /** List of validation error messages */
  errors: string[];
  /** List of warning messages (non-fatal) */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/** Default Supabase URL (dev project). */
const DEFAULT_SUPABASE_URL = 'https://npveywncozhjzcxrhkuc.supabase.co';

/** Default Supabase anon key (dev project — safe to embed, RLS enforces security). */
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wdmV5d25jb3poanpjeHJoa3VjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MzUwNzIsImV4cCI6MjA4ODUxMTA3Mn0.xinT1XB9RaZ13CWQjbo95i_dJN7i463l9gAWQce32Yg';

/** Default JWT secret (development only — MUST override in production). */
const DEFAULT_JWT_SECRET = 'crewly-dev-jwt-secret-change-in-production';

/** Default Cloud API URL. */
const DEFAULT_CLOUD_URL = 'https://api.crewlyai.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a string env var with a fallback default.
 *
 * @param key - Environment variable name
 * @param defaultValue - Default if not set
 * @returns Resolved value
 */
function envStr(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Read a numeric env var with a fallback default.
 *
 * @param key - Environment variable name
 * @param defaultValue - Default if not set or not a valid number
 * @returns Resolved numeric value
 */
function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Read a boolean env var with a fallback default.
 *
 * @param key - Environment variable name
 * @param defaultValue - Default if not set
 * @returns Resolved boolean value
 */
function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return raw === 'true' || raw === '1';
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Cached config instance (loaded once). */
let cachedConfig: EnvConfig | null = null;

/**
 * Load and return the unified environment configuration.
 *
 * Reads from environment variables with sensible defaults for
 * local development. The result is cached after the first call.
 *
 * @returns Complete environment configuration
 */
export function getEnvConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    server: {
      port: envInt('PORT', 3000),
      host: envStr('HOST', 'localhost'),
      nodeEnv: envStr('NODE_ENV', 'development'),
    },

    supabase: {
      url: envStr('CREWLY_SUPABASE_URL', DEFAULT_SUPABASE_URL),
      anonKey: envStr('CREWLY_SUPABASE_ANON_KEY', DEFAULT_SUPABASE_ANON_KEY),
    },

    auth: {
      jwtSecret: envStr('CREWLY_JWT_SECRET', DEFAULT_JWT_SECRET),
      tokenEncryptionKey: envStr(
        'CREWLY_TOKEN_ENCRYPTION_KEY',
        envStr('CREWLY_SECRET', ''),
      ) || crypto.randomBytes(32).toString('hex'),
    },

    slack: {
      botToken: envStr('SLACK_BOT_TOKEN', ''),
      appToken: envStr('SLACK_APP_TOKEN', ''),
      signingSecret: envStr('SLACK_SIGNING_SECRET', ''),
      defaultChannel: envStr('SLACK_DEFAULT_CHANNEL', ''),
      allowedUsers: envStr('SLACK_ALLOWED_USERS', ''),
    },

    google: {
      clientId: envStr('GOOGLE_OAUTH_CLIENT_ID', ''),
      clientSecret: envStr('GOOGLE_OAUTH_CLIENT_SECRET', ''),
      redirectUri: envStr('GOOGLE_OAUTH_REDIRECT_URI', ''),
    },

    whatsapp: {
      enabled: envBool('WHATSAPP_ENABLED', false),
      phoneNumber: envStr('WHATSAPP_PHONE_NUMBER', ''),
      authPath: envStr('WHATSAPP_AUTH_PATH', ''),
      allowedContacts: envStr('WHATSAPP_ALLOWED_CONTACTS', ''),
    },

    ai: {
      geminiApiKey: envStr('GEMINI_API_KEY', ''),
    },

    cloud: {
      apiUrl: envStr('CREWLY_CLOUD_URL', DEFAULT_CLOUD_URL),
      crewlyHome: envStr('CREWLY_HOME', path.join(os.homedir(), '.crewly')),
      crewlyApiUrl: envStr('CREWLY_API_URL', ''),
    },
  };

  return cachedConfig;
}

/**
 * Reset the cached config (for testing).
 */
export function resetEnvConfig(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the current environment configuration.
 *
 * Checks for required variables in production, warns about
 * insecure defaults, and verifies value formats.
 *
 * Call at application startup and exit if `valid` is false.
 *
 * @returns Validation result with errors and warnings
 */
export function validateEnvConfig(): EnvValidationResult {
  const config = getEnvConfig();
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = config.server.nodeEnv === 'production';

  // --- Server ---
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('PORT must be between 1 and 65535');
  }

  // --- Auth / Secrets ---
  // Warn but do not error — random defaults are generated at startup when unset
  if (config.auth.jwtSecret === DEFAULT_JWT_SECRET) {
    warnings.push(
      isProduction
        ? 'CREWLY_JWT_SECRET is using the default dev secret in production — set a strong secret for security'
        : 'CREWLY_JWT_SECRET is using the default dev secret — set a strong secret for production',
    );
  }

  if (!process.env['CREWLY_TOKEN_ENCRYPTION_KEY'] && !process.env['CREWLY_SECRET']) {
    warnings.push(
      'No CREWLY_TOKEN_ENCRYPTION_KEY set — using auto-generated random key (tokens will not survive restarts)',
    );
  }

  // --- Supabase ---
  if (isProduction && config.supabase.url === DEFAULT_SUPABASE_URL) {
    warnings.push('CREWLY_SUPABASE_URL is using the default dev project URL — set your production Supabase URL');
  }

  if (!config.supabase.url) {
    errors.push('CREWLY_SUPABASE_URL must not be empty');
  }

  if (!config.supabase.anonKey) {
    errors.push('CREWLY_SUPABASE_ANON_KEY must not be empty');
  }

  // --- Slack (optional, but warn if partially configured) ---
  const slackPartial = [config.slack.botToken, config.slack.appToken, config.slack.signingSecret];
  const slackSet = slackPartial.filter(Boolean).length;
  if (slackSet > 0 && slackSet < 3) {
    warnings.push(
      'Slack is partially configured — set all of SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET',
    );
  }

  // --- Google OAuth (optional, but warn if partially configured) ---
  const googlePartial = [config.google.clientId, config.google.clientSecret];
  const googleSet = googlePartial.filter(Boolean).length;
  if (googleSet > 0 && googleSet < 2) {
    warnings.push(
      'Google OAuth is partially configured — set both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Log validation results to console.
 *
 * Intended to be called once at application startup.
 *
 * @param result - Validation result from validateEnvConfig()
 */
export function logEnvValidation(result: EnvValidationResult): void {
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`[env-config] WARNING: ${w}`);
    }
  }

  if (!result.valid) {
    for (const e of result.errors) {
      console.error(`[env-config] ERROR: ${e}`);
    }
    console.error('[env-config] Environment validation failed. Fix the above errors before starting.');
  }
}
