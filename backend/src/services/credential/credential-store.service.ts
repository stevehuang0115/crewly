/**
 * Credential Store Service
 *
 * Manages the workspace-level credential registry and per-credential
 * encrypted payload files under `~/.crewly/credentials/`.
 *
 * The store is split into two surfaces:
 *
 * - **Metadata API** (`listCredentials`, `getCredential`, `findCredentialsByProvider`):
 *   returns `CredentialRegistryEntry` objects containing only non-secret
 *   information (id, name, provider, scopes, email, timestamps). Safe to
 *   expose to agent / LLM context and over MCP.
 *
 * - **Payload API** (`getPayload`, `setPayload`): decrypts the per-credential
 *   `.enc` file to return the actual token value(s). **Intended only for
 *   credential helpers and the skill executor** (which injects values into
 *   skill subprocess env vars). Callers must never return payload contents
 *   to agent/LLM context.
 *
 * Encrypted file format and threat model: see `utils/encryption.utils.ts`.
 *
 * @module services/credential/credential-store.service
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  CredentialRegistry,
  CredentialRegistryEntry,
  CredentialPayload,
  ApiKeyPayload,
  GoogleOAuthPayload,
  CredentialType,
  CredentialHelperName,
  CredentialStatus,
  CredentialNotFoundError,
} from '../../types/credential.types.js';

import {
  ensureDir,
  atomicWriteFile,
  atomicWriteJson,
  safeReadJson,
  withOperationLock,
} from '../../utils/file-io.utils.js';

import {
  encrypt,
  decrypt,
  ensureMasterKey,
  defaultCredentialsDir,
  defaultMasterKeyPath,
} from '../../utils/encryption.utils.js';

// ============================================================================
// Constants
// ============================================================================

const REGISTRY_FILENAME = 'registry.json';
const EMPTY_REGISTRY: CredentialRegistry = {
  schemaVersion: 1,
  credentials: [],
};

// ============================================================================
// Input shapes
// ============================================================================

/**
 * Arguments for adding an API key credential.
 */
export interface AddApiKeyInput {
  /** User-provided display name (must be unique recommended, not enforced). */
  name: string;
  /** Provider identifier (e.g., "gemini", "openai"). */
  provider: string;
  /** The actual API key value — never logged or returned to agent. */
  value: string;
}

/**
 * Arguments for adding an OAuth credential (usually produced by a helper's
 * capture flow).
 */
export interface AddOAuthInput {
  /** User-provided display name. */
  name: string;
  /** Provider identifier (e.g., "google"). */
  provider: string;
  /** Which helper manages refresh for this credential. */
  helper: CredentialHelperName;
  /** Full OAuth token payload captured from the helper's login flow. */
  payload: GoogleOAuthPayload;
}

/**
 * Updatable metadata fields on a credential. Other fields are managed
 * internally (id, type, provider, encFile, createdAt).
 */
export interface UpdateCredentialMetadata {
  name?: string;
  status?: CredentialStatus;
  lastUsedAt?: string;
  expiresAt?: number;
  scopes?: string[];
  accountEmail?: string;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Options for constructing a `CredentialStoreService`. Intended mainly for
 * tests — production uses the default paths under `~/.crewly/credentials/`.
 */
export interface CredentialStoreOptions {
  /** Override the credentials directory (default: `~/.crewly/credentials`). */
  dir?: string;
  /** Override the master.key file path (default: `<dir>/master.key`). */
  masterKeyPath?: string;
}

/**
 * File-based credential store.
 */
export class CredentialStoreService {
  private readonly dir: string;
  private readonly registryPath: string;
  private readonly masterKeyPath: string;
  private initialized = false;

  constructor(options?: CredentialStoreOptions) {
    this.dir = options?.dir ?? defaultCredentialsDir();
    this.registryPath = path.join(this.dir, REGISTRY_FILENAME);
    this.masterKeyPath =
      options?.masterKeyPath ?? path.join(this.dir, 'master.key');
  }

  // ------------------------------------------------------------------
  //  Initialization (idempotent, lazy)
  // ------------------------------------------------------------------

  /**
   * Ensure the credentials directory and master.key exist. Called
   * automatically by every public method — safe to invoke explicitly
   * for eager initialization.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(this.dir);
    await ensureMasterKey(this.masterKeyPath);
    this.initialized = true;
  }

  // ------------------------------------------------------------------
  //  Metadata API (safe to expose to agent/LLM)
  // ------------------------------------------------------------------

  /**
   * List all credentials' metadata. Does not include secret values.
   */
  async listCredentials(): Promise<CredentialRegistryEntry[]> {
    await this.init();
    const reg = await this.readRegistry();
    return reg.credentials;
  }

  /**
   * Get a single credential's metadata by id.
   *
   * @throws CredentialNotFoundError if no entry with that id exists
   */
  async getCredential(id: string): Promise<CredentialRegistryEntry> {
    await this.init();
    const reg = await this.readRegistry();
    const entry = reg.credentials.find((c) => c.id === id);
    if (!entry) throw new CredentialNotFoundError(id);
    return entry;
  }

  /**
   * Find all credentials for a given provider, optionally filtered by type.
   */
  async findCredentialsByProvider(
    provider: string,
    type?: CredentialType,
  ): Promise<CredentialRegistryEntry[]> {
    await this.init();
    const reg = await this.readRegistry();
    return reg.credentials.filter(
      (c) => c.provider === provider && (!type || c.type === type),
    );
  }

  // ------------------------------------------------------------------
  //  Add
  // ------------------------------------------------------------------

  /**
   * Add a new API key credential. The value is encrypted on disk and
   * never exposed back through the metadata API.
   */
  async addApiKey(
    input: AddApiKeyInput,
  ): Promise<CredentialRegistryEntry> {
    await this.init();
    const id = this.newId();
    const encFile = `${id}.enc`;
    const payload: ApiKeyPayload = { type: 'api-key', value: input.value };

    const now = new Date().toISOString();
    const entry: CredentialRegistryEntry = {
      id,
      name: input.name,
      type: 'api-key',
      provider: input.provider,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      encFile,
    };

    await this.writePayload(encFile, payload);
    await this.appendEntry(entry);

    return entry;
  }

  /**
   * Add a new OAuth credential. Typically called by a helper's capture
   * flow after completing an OAuth exchange.
   */
  async addOAuth(input: AddOAuthInput): Promise<CredentialRegistryEntry> {
    await this.init();
    const id = this.newId();
    const encFile = `${id}.enc`;

    const now = new Date().toISOString();
    const entry: CredentialRegistryEntry = {
      id,
      name: input.name,
      type: 'google-oauth',
      provider: input.provider,
      helper: input.helper,
      scopes: input.payload.scopes,
      accountEmail: input.payload.accountEmail,
      expiresAt: input.payload.expiresAt,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      encFile,
    };

    await this.writePayload(encFile, input.payload);
    await this.appendEntry(entry);

    return entry;
  }

  // ------------------------------------------------------------------
  //  Update
  // ------------------------------------------------------------------

  /**
   * Update a credential's metadata. Does not touch the encrypted payload.
   * Use `setPayload` to rewrite the secret material (e.g., after refresh).
   *
   * @throws CredentialNotFoundError if no entry with that id exists
   */
  async updateCredential(
    id: string,
    patch: UpdateCredentialMetadata,
  ): Promise<CredentialRegistryEntry> {
    await this.init();
    let updated!: CredentialRegistryEntry;
    await withOperationLock(this.registryPath, async () => {
      const reg = await this.readRegistry();
      const idx = reg.credentials.findIndex((c) => c.id === id);
      if (idx < 0) throw new CredentialNotFoundError(id);
      updated = {
        ...reg.credentials[idx],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      reg.credentials[idx] = updated;
      await this.writeRegistry(reg);
    });
    return updated;
  }

  // ------------------------------------------------------------------
  //  Delete
  // ------------------------------------------------------------------

  /**
   * Delete a credential (removes registry entry and encrypted payload).
   * The registry removal is authoritative — if the `.enc` file is missing
   * for any reason, that is not an error.
   *
   * @throws CredentialNotFoundError if no entry with that id exists
   */
  async deleteCredential(id: string): Promise<void> {
    await this.init();
    let encFileToDelete: string | null = null;
    await withOperationLock(this.registryPath, async () => {
      const reg = await this.readRegistry();
      const idx = reg.credentials.findIndex((c) => c.id === id);
      if (idx < 0) throw new CredentialNotFoundError(id);
      encFileToDelete = reg.credentials[idx].encFile;
      reg.credentials.splice(idx, 1);
      await this.writeRegistry(reg);
    });
    if (encFileToDelete) {
      try {
        await fs.unlink(this.encFilePath(encFileToDelete));
      } catch {
        // registry is source of truth — ignore missing .enc file
      }
    }
  }

  // ------------------------------------------------------------------
  //  Payload API (INTERNAL — helpers + executor only)
  // ------------------------------------------------------------------

  /**
   * Decrypt and return the credential's payload. **Do not return the
   * result to agent / LLM contexts** — intended only for helpers
   * refreshing tokens and the skill executor injecting env vars.
   *
   * @throws CredentialNotFoundError if no entry with that id exists
   */
  async getPayload(id: string): Promise<CredentialPayload> {
    await this.init();
    const entry = await this.getCredential(id);
    const b64 = await fs.readFile(this.encFilePath(entry.encFile), 'utf8');
    const encBuffer = Buffer.from(b64, 'base64');
    const plaintext = await decrypt(encBuffer, this.masterKeyPath);
    return JSON.parse(plaintext) as CredentialPayload;
  }

  /**
   * Encrypt and write a new payload for an existing credential. Used by
   * helpers after a successful token refresh.
   *
   * @throws CredentialNotFoundError if no entry with that id exists
   */
  async setPayload(id: string, payload: CredentialPayload): Promise<void> {
    await this.init();
    const entry = await this.getCredential(id);
    await this.writePayload(entry.encFile, payload);
  }

  // ------------------------------------------------------------------
  //  Internals
  // ------------------------------------------------------------------

  private async readRegistry(): Promise<CredentialRegistry> {
    return safeReadJson<CredentialRegistry>(this.registryPath, {
      ...EMPTY_REGISTRY,
      credentials: [],
    });
  }

  private async writeRegistry(reg: CredentialRegistry): Promise<void> {
    await atomicWriteJson(this.registryPath, reg);
  }

  private async appendEntry(entry: CredentialRegistryEntry): Promise<void> {
    await withOperationLock(this.registryPath, async () => {
      const reg = await this.readRegistry();
      reg.credentials.push(entry);
      await this.writeRegistry(reg);
    });
  }

  private encFilePath(encFile: string): string {
    return path.join(this.dir, encFile);
  }

  private async writePayload(
    encFile: string,
    payload: CredentialPayload,
  ): Promise<void> {
    const json = JSON.stringify(payload);
    const enc = await encrypt(json, this.masterKeyPath);
    // Encrypted bytes are stored base64-encoded so they go through
    // atomicWriteFile's utf8 serializer safely.
    await atomicWriteFile(this.encFilePath(encFile), enc.toString('base64'));
  }

  private newId(): string {
    return `cred-${crypto.randomUUID()}`;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: CredentialStoreService | null = null;

/**
 * Get the process-wide CredentialStoreService singleton.
 */
export function getCredentialStoreService(): CredentialStoreService {
  if (!instance) instance = new CredentialStoreService();
  return instance;
}

/**
 * Reset the singleton — for tests only.
 */
export function resetCredentialStoreService(): void {
  instance = null;
}

/**
 * Replace the singleton with a specific instance — for tests only.
 * Allows route/controller tests to point the store at a scratch directory.
 */
export function _setCredentialStoreForTesting(
  svc: CredentialStoreService,
): void {
  instance = svc;
}
