/**
 * Environment Isolation Service
 *
 * Strips sensitive environment variables (API keys, tokens, secrets) from
 * child process environments when agents execute bash commands. Maintains
 * an allowlist of safe variables and provides a mechanism to explicitly
 * pass specific vars when needed.
 *
 * @module services/agent/crewly-agent/env-isolation.service
 *
 * @example
 * ```typescript
 * const isolation = new EnvIsolationService();
 * const safeEnv = isolation.createSafeEnv(process.env);
 * // safeEnv has PATH, HOME, etc. but no ANTHROPIC_API_KEY
 *
 * const withOverrides = isolation.createSafeEnv(process.env, ['MY_CUSTOM_VAR']);
 * // safeEnv + MY_CUSTOM_VAR explicitly included
 * ```
 */

/**
 * Environment variables that are always safe to pass to child processes.
 * These are essential for basic shell operation and don't contain secrets.
 */
export const SAFE_ENV_ALLOWLIST: readonly string[] = [
  // System essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TERM_PROGRAM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',

  // Node.js / runtime
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  'NVM_DIR',
  'NVM_BIN',

  // Build tools
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'EDITOR',
  'VISUAL',
  'PAGER',

  // Git (non-secret)
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',

  // Platform
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',

  // macOS specifics
  'COMMAND_MODE',
  '__CF_USER_TEXT_ENCODING',

  // Python
  'PYTHONPATH',
  'VIRTUAL_ENV',

  // Rust
  'CARGO_HOME',
  'RUSTUP_HOME',

  // Go
  'GOPATH',
  'GOROOT',

  // Java
  'JAVA_HOME',

  // Homebrew
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
] as const;

/**
 * Patterns that identify sensitive environment variable names.
 * Variables matching these patterns are stripped from child processes.
 */
export const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/i,
  /api[_-]?secret/i,
  /api[_-]?token/i,
  /secret[_-]?key/i,
  /access[_-]?key/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /bearer[_-]?token/i,
  /private[_-]?key/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /^AWS_SECRET/i,
  /^AWS_SESSION/i,
  /^ANTHROPIC_API/i,
  /^OPENAI_API/i,
  /^GOOGLE_API/i,
  /^GOOGLE_APPLICATION_CREDENTIALS/i,
  /^STRIPE_SECRET/i,
  /^SUPABASE_SERVICE_ROLE/i,
  /^DATABASE_URL$/i,
  /^REDIS_URL$/i,
  /^MONGODB_URI$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^DOCKER_PASSWORD$/i,
  /^DOCKER_AUTH$/i,
  /connection[_-]?string/i,
  /^SENTRY_DSN$/i,
  /^DATADOG_API_KEY$/i,
  /^SENDGRID_API_KEY$/i,
  /^TWILIO_AUTH_TOKEN$/i,
  /^SLACK_BOT_TOKEN$/i,
  /^SLACK_TOKEN$/i,
  /^DISCORD_TOKEN$/i,
  /^WEBHOOK_SECRET$/i,
  /^SIGNING_SECRET$/i,
  /^ENCRYPTION_KEY$/i,
  /^JWT_SECRET$/i,
  /^SESSION_SECRET$/i,
] as const;

/**
 * Service that creates sanitized environment objects for child processes.
 */
export class EnvIsolationService {
  private readonly allowlist: Set<string>;
  private readonly sensitivePatterns: readonly RegExp[];

  /**
   * Creates a new EnvIsolationService.
   *
   * @param additionalSafeVars - Extra variable names to always allow
   * @param additionalSensitivePatterns - Extra patterns to block
   */
  constructor(
    additionalSafeVars?: string[],
    additionalSensitivePatterns?: RegExp[],
  ) {
    this.allowlist = new Set([...SAFE_ENV_ALLOWLIST, ...(additionalSafeVars || [])]);
    this.sensitivePatterns = additionalSensitivePatterns
      ? [...SENSITIVE_ENV_PATTERNS, ...additionalSensitivePatterns]
      : SENSITIVE_ENV_PATTERNS;
  }

  /**
   * Creates a safe environment object by filtering out sensitive variables.
   *
   * Strategy:
   * 1. Start with all env vars
   * 2. Keep vars on the allowlist
   * 3. Remove vars matching sensitive patterns
   * 4. Add explicitly requested vars (overrides)
   *
   * @param sourceEnv - Source environment (typically process.env)
   * @param explicitVars - Variable names to explicitly include even if they'd be filtered
   * @returns Sanitized environment object safe for child processes
   */
  createSafeEnv(
    sourceEnv: Record<string, string | undefined>,
    explicitVars?: string[],
  ): Record<string, string> {
    const safeEnv: Record<string, string> = {};
    const explicitSet = new Set(explicitVars || []);

    for (const [key, value] of Object.entries(sourceEnv)) {
      if (value === undefined) continue;

      // Always include explicitly requested vars
      if (explicitSet.has(key)) {
        safeEnv[key] = value;
        continue;
      }

      // Include if on allowlist
      if (this.allowlist.has(key)) {
        safeEnv[key] = value;
        continue;
      }

      // Skip if matches a sensitive pattern
      if (this.isSensitive(key)) {
        continue;
      }

      // Default: include non-sensitive vars not on either list
      safeEnv[key] = value;
    }

    return safeEnv;
  }

  /**
   * Checks if an environment variable name matches any sensitive pattern.
   *
   * @param varName - Environment variable name to check
   * @returns True if the variable is considered sensitive
   */
  isSensitive(varName: string): boolean {
    return this.sensitivePatterns.some((pattern) => pattern.test(varName));
  }

  /**
   * Returns the list of sensitive variable names found in the given environment.
   * Useful for audit logging.
   *
   * @param sourceEnv - Environment to scan
   * @returns Array of sensitive variable names found
   */
  findSensitiveVars(sourceEnv: Record<string, string | undefined>): string[] {
    return Object.keys(sourceEnv).filter((key) => this.isSensitive(key));
  }

  /**
   * Returns the current allowlist as an array.
   * @returns Copy of the safe variable allowlist
   */
  getAllowlist(): string[] {
    return Array.from(this.allowlist);
  }
}
