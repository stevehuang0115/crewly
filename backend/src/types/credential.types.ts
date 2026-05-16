/**
 * Credential System Types
 *
 * Workspace-level credential store. Credentials (API keys, OAuth tokens) are
 * decoupled from skills: skills declare slots, users add named credentials,
 * agents bind specific credentials to slots at execution time.
 *
 * Registry entries are safe to show to LLM/agent contexts. Encrypted
 * payloads (containing real token values) are never exposed to the agent —
 * they are read only by the credential helper and by the skill executor
 * for env-var injection into subprocesses.
 *
 * @module types/credential.types
 */

// ============================================================================
// Registry entry (LLM-safe metadata)
// ============================================================================

/**
 * High-level type of credential — determines which payload schema is used
 * and which helper (if any) owns the refresh lifecycle.
 */
export type CredentialType = 'api-key' | 'google-oauth';

/**
 * Lifecycle status of a credential.
 *
 * - `active`: usable; refresh tokens are valid
 * - `revoked`: underlying refresh token no longer works. User must re-authorize.
 */
export type CredentialStatus = 'active' | 'revoked';

/**
 * Identifier for the helper responsible for token acquisition and refresh.
 *
 * - `gemini-cli-workspace`: piggybacks on user's Gemini CLI Workspace extension (Phase 1)
 * - `byo-oauth`: user's own registered GCP OAuth client (Phase 2)
 * - `gcloud-adc`: Google Cloud Application Default Credentials (Phase 2)
 * - `crewly-official`: Crewly's published OAuth app (Phase 3)
 */
export type CredentialHelperName =
  | 'gemini-cli-workspace'
  | 'byo-oauth'
  | 'gcloud-adc'
  | 'crewly-official';

/**
 * Public metadata for a credential. Never contains secret material.
 * This is the exact shape exposed to agents / LLM contexts.
 */
export interface CredentialRegistryEntry {
  /** UUID v4 — stable reference used everywhere (bindings, URLs, logs). */
  id: string;
  /** User-provided display name (e.g., "personal-gmail"). Not a reference. */
  name: string;
  /** Type discriminator — drives payload schema. */
  type: CredentialType;
  /** Provider identifier (e.g., "gemini", "google", "openai"). */
  provider: string;
  /** Helper that manages refresh (required for OAuth types). */
  helper?: CredentialHelperName;
  /** Granted OAuth scopes (OAuth types only). */
  scopes?: string[];
  /** Email address of the OAuth account — for user-visible display. */
  accountEmail?: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last metadata update. */
  updatedAt: string;
  /** ISO-8601 last injection into a skill run. */
  lastUsedAt?: string;
  /** Unix epoch ms when the current access token expires (OAuth only). */
  expiresAt?: number;
  /** Current status. */
  status: CredentialStatus;
  /** Relative path to the encrypted payload file (from credentials dir). */
  encFile: string;
}

/**
 * Registry file format stored at `~/.crewly/credentials/registry.json`.
 */
export interface CredentialRegistry {
  schemaVersion: 1;
  credentials: CredentialRegistryEntry[];
}

// ============================================================================
// Encrypted payload schemas (never exposed to agent / LLM)
// ============================================================================

/**
 * Payload for a static API key credential.
 */
export interface ApiKeyPayload {
  type: 'api-key';
  value: string;
}

/**
 * Payload for a Google OAuth credential with refreshable access.
 */
export interface GoogleOAuthPayload {
  type: 'google-oauth';
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Unix epoch ms when accessToken expires. */
  expiresAt: number;
  /** Scopes granted by user consent. */
  scopes: string[];
  /** Account email (also denormalized into registry entry for display). */
  accountEmail?: string;
  /** OAuth client_id used to mint this grant (required for refresh). */
  clientId: string;
}

/**
 * Discriminated union over all payload variants. Switch on `type`.
 */
export type CredentialPayload = ApiKeyPayload | GoogleOAuthPayload;

// ============================================================================
// Helper interface
// ============================================================================

/**
 * Concrete implementation of a credential helper strategy.
 *
 * Helpers are responsible for:
 * - Returning a valid access token (refreshing if near expiry)
 * - Recognizing `invalid_grant` / revocation and signalling via thrown error
 *
 * Implementations must be idempotent under concurrent calls for the same
 * credential — the store's refresh manager wraps calls in a per-credential
 * mutex, but helpers should not assume exclusive access across processes.
 */
export interface CredentialHelper {
  readonly name: CredentialHelperName;

  /**
   * Return a valid access token for the given credential, refreshing if
   * within the expiry buffer.
   *
   * @throws CredentialRevokedError if the refresh token is no longer valid
   */
  getAccessToken(
    entry: CredentialRegistryEntry,
    payload: GoogleOAuthPayload,
  ): Promise<GoogleOAuthPayload>;
}

// ============================================================================
// Skill-side types
// ============================================================================

/**
 * A credential requirement declared in a SKILL.md frontmatter.
 * Each requirement is a named "slot" the skill will read via an env var
 * (`CREWLY_CRED_<SLOT>` for api-key, `CREWLY_CRED_<SLOT>_*` for OAuth).
 */
export interface SkillCredentialRequirement {
  /** Slot name — used verbatim in env var prefix. Alphanumeric + hyphens. */
  slot: string;
  /** Credential type this slot expects. */
  type: CredentialType;
  /** Provider the skill expects (e.g., 'gemini', 'google'). */
  provider: string;
  /** Whether execution fails if no credential is bound to this slot. */
  required: boolean;
  /** UUID of a credential to use when no binding is supplied at runtime. */
  default?: string;
  /** OAuth scopes required for this slot (google-oauth only). */
  requiredScopes?: string[];
  /** Description shown in UI when selecting a credential for this slot. */
  description?: string;
}

/**
 * Runtime map from slot name to credential UUID, supplied by the agent in
 * `execute_skill`. Overrides the skill's `default`.
 */
export type CredentialBindings = Record<string, string>;

// ============================================================================
// Errors
// ============================================================================

/**
 * One available credential, surfaced in MissingCredentialError so the
 * caller can re-invoke with `credentialBindings: { [slot]: id }`.
 */
export interface AvailableCredentialHint {
  id: string;
  name: string;
  type: CredentialType;
  status: CredentialStatus;
}

/**
 * Thrown when a required slot has neither a binding nor a default.
 *
 * The error message now includes the list of available credentials of
 * the matching provider so the caller can re-invoke with the right
 * `credentialBindings` map without having to grep `~/.crewly/credentials/`
 * by hand. Issue #324.
 */
export class MissingCredentialError extends Error {
  constructor(
    public readonly slot: string,
    public readonly provider: string,
    public readonly available: readonly AvailableCredentialHint[] = [],
  ) {
    const base = `No credential bound to required slot '${slot}' (provider: ${provider}).`;
    const hint =
      available.length > 0
        ? ` Available ${provider} credentials: ${available
            .map((c) => `${c.id} (name="${c.name}", status=${c.status})`)
            .join(', ')}. Re-invoke with credentialBindings: { ${slot}: "<id>" }.`
        : ` No ${provider} credentials registered. Add one via the Settings → Credentials UI before invoking this skill.`;
    super(base + hint);
    this.name = 'MissingCredentialError';
  }
}

/**
 * Thrown when a bound credential's scopes do not cover the slot's requirements.
 */
export class InsufficientScopeError extends Error {
  public readonly missing: string[];

  constructor(
    public readonly slot: string,
    public readonly required: string[],
    public readonly granted: string[],
  ) {
    const missing = required.filter((s) => !granted.includes(s));
    super(
      `Credential for slot '${slot}' is missing scope(s): ${missing.join(', ')}`,
    );
    this.name = 'InsufficientScopeError';
    this.missing = missing;
  }
}

/**
 * Thrown when an OAuth credential's refresh token is no longer valid.
 * Carries the remediation string that callers (UI / agent) can surface to users.
 */
export class CredentialRevokedError extends Error {
  constructor(
    public readonly credentialId: string,
    public readonly credentialName: string,
    public readonly remediation: string,
  ) {
    super(
      `Credential '${credentialName}' (${credentialId}) is revoked. ${remediation}`,
    );
    this.name = 'CredentialRevokedError';
  }
}

/**
 * Thrown when a referenced credential id doesn't exist in the registry.
 */
export class CredentialNotFoundError extends Error {
  constructor(public readonly credentialId: string) {
    super(`Credential not found: ${credentialId}`);
    this.name = 'CredentialNotFoundError';
  }
}
