/**
 * Chat V2 — Configuration constants.
 *
 * Loads Phase 1 defaults (from spec §15) and honors
 * `CREWLY_CHAT_*` environment overrides. Pure functions;
 * no disk I/O here.
 *
 * @module services/chat-v2/config
 */

import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** Full Chat V2 runtime config. All durations in ms, sizes in bytes. */
export interface ChatV2Config {
  enabled: boolean;
  /** Hard cap on message body size in UTF-8 bytes after NFC normalization. */
  maxMessageBytes: number;
  maxAttachmentBytes: number;
  maxAttachmentsPerMessage: number;
  allowedAttachmentMimes: readonly string[];
  /** Max chars on channel name (validated at controller). */
  maxChannelNameChars: number;
  /** Max chars on optional channel purpose. */
  maxPurposeChars: number;
  /** Max bytes in message metadata JSON blob. */
  maxMetadataBytes: number;
  rateLimits: {
    messagesPerSec: number;
    messagesPerMin: number;
    uploadsPerSec: number;
    uploadsPerMin: number;
    wsFramesPerSec: number;
  };
  websocket: {
    heartbeatIntervalMs: number;
    idleTimeoutMs: number;
    pongTimeoutMs: number;
    replayCap: number;
    maxFrameBytes: number;
  };
  offlineQueue: {
    maxPendingPerAgent: number;
    maxAgeMs: number;
    drainBatchSize: number;
    drainPauseMs: number;
  };
  presence: {
    pollIntervalMs: number;
  };
  portal: {
    /** Name of the env var holding the Cloud-OSS shared service token. */
    sharedSecretEnv: string;
  };
  storage: {
    dbPath: string;
    attachmentsDir: string;
    uploadsStagingDir: string;
  };
}

// ---------------------------------------------------------------------------
// Defaults (spec §15)
// ---------------------------------------------------------------------------

/**
 * Resolve a path containing a leading `~` or `~/` to the user's home directory.
 *
 * @param input - Path possibly prefixed with `~` or `~/`
 * @returns Absolute path with `~` expanded
 */
export function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Phase 1 defaults — source of truth is the tech spec §15. */
export const CHAT_V2_DEFAULTS: ChatV2Config = Object.freeze({
  enabled: true,
  maxMessageBytes: 32768,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentsPerMessage: 4,
  allowedAttachmentMimes: Object.freeze([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ]),
  maxChannelNameChars: 128,
  maxPurposeChars: 512,
  maxMetadataBytes: 2048,
  rateLimits: Object.freeze({
    messagesPerSec: 10,
    messagesPerMin: 60,
    uploadsPerSec: 3,
    uploadsPerMin: 20,
    wsFramesPerSec: 20,
  }),
  websocket: Object.freeze({
    heartbeatIntervalMs: 30000,
    idleTimeoutMs: 60000,
    pongTimeoutMs: 5000,
    replayCap: 200,
    maxFrameBytes: 65536,
  }),
  offlineQueue: Object.freeze({
    maxPendingPerAgent: 100,
    maxAgeMs: 24 * 60 * 60 * 1000,
    drainBatchSize: 50,
    drainPauseMs: 2000,
  }),
  presence: Object.freeze({
    pollIntervalMs: 10000,
  }),
  portal: Object.freeze({
    sharedSecretEnv: 'CREWLY_CLOUD_OSS_SERVICE_TOKEN',
  }),
  storage: Object.freeze({
    dbPath: '~/.crewly/chat.db',
    attachmentsDir: '~/.crewly/chat-attachments',
    uploadsStagingDir: '~/.crewly/chat-uploads-staging',
  }),
}) as ChatV2Config;

// ---------------------------------------------------------------------------
// Env-override loader
// ---------------------------------------------------------------------------

/**
 * Parse a positive integer from an env-string, falling back to a default.
 *
 * @param raw - Raw env-var value or undefined
 * @param fallback - Default if raw is missing/invalid/non-positive
 * @returns The parsed positive integer
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Parse a boolean env-var supporting `true`/`false`/`1`/`0` (case-insensitive).
 *
 * @param raw - Raw env-var value or undefined
 * @param fallback - Default if raw is missing
 * @returns The parsed boolean
 */
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  return fallback;
}

/**
 * Build a fully-resolved config from defaults + environment overrides.
 *
 * Env vars honored (all optional):
 * - `CREWLY_CHAT_ENABLED` — master switch
 * - `CREWLY_CHAT_MAX_MESSAGE_BYTES` — per-message byte cap
 * - `CREWLY_CHAT_MAX_ATTACHMENT_BYTES` — per-attachment byte cap
 * - `CREWLY_CHAT_WS_HEARTBEAT_MS` — client-ping interval
 * - `CREWLY_CHAT_WS_IDLE_TIMEOUT_MS` — server idle close
 * - `CREWLY_CHAT_DB_PATH` — SQLite DB path (expands `~`)
 * - `CREWLY_CHAT_ATTACHMENTS_DIR` — committed attachment dir (expands `~`)
 * - `CREWLY_CHAT_UPLOADS_STAGING_DIR` — pre-commit upload dir (expands `~`)
 * - `CREWLY_HOME` — when set and DB/path env vars are not, rebases storage under this dir
 *
 * @param env - The environment object to read from (defaults to `process.env`)
 * @returns A fully-resolved, immutable ChatV2Config
 */
export function loadChatV2Config(env: NodeJS.ProcessEnv = process.env): ChatV2Config {
  const defaults = CHAT_V2_DEFAULTS;

  // Optionally rebase storage paths under CREWLY_HOME when explicit storage envs are absent.
  const crewlyHome = env['CREWLY_HOME'];
  const crewlyHomeResolved = crewlyHome ? expandHomePath(crewlyHome) : null;

  const rebase = (defaultRelative: string): string => {
    // `defaults.storage.*` are `~/.crewly/...` style; strip `~/.crewly/` → relative.
    if (!crewlyHomeResolved) return expandHomePath(defaultRelative);
    const marker = '~/.crewly/';
    if (defaultRelative.startsWith(marker)) {
      return path.join(crewlyHomeResolved, defaultRelative.slice(marker.length));
    }
    return expandHomePath(defaultRelative);
  };

  const dbPathEnv = env['CREWLY_CHAT_DB_PATH'];
  const attachmentsDirEnv = env['CREWLY_CHAT_ATTACHMENTS_DIR'];
  const stagingDirEnv = env['CREWLY_CHAT_UPLOADS_STAGING_DIR'];

  return Object.freeze({
    enabled: parseBoolean(env['CREWLY_CHAT_ENABLED'], defaults.enabled),
    maxMessageBytes: parsePositiveInt(
      env['CREWLY_CHAT_MAX_MESSAGE_BYTES'],
      defaults.maxMessageBytes,
    ),
    maxAttachmentBytes: parsePositiveInt(
      env['CREWLY_CHAT_MAX_ATTACHMENT_BYTES'],
      defaults.maxAttachmentBytes,
    ),
    maxAttachmentsPerMessage: defaults.maxAttachmentsPerMessage,
    allowedAttachmentMimes: defaults.allowedAttachmentMimes,
    maxChannelNameChars: defaults.maxChannelNameChars,
    maxPurposeChars: defaults.maxPurposeChars,
    maxMetadataBytes: defaults.maxMetadataBytes,
    rateLimits: defaults.rateLimits,
    websocket: Object.freeze({
      ...defaults.websocket,
      heartbeatIntervalMs: parsePositiveInt(
        env['CREWLY_CHAT_WS_HEARTBEAT_MS'],
        defaults.websocket.heartbeatIntervalMs,
      ),
      idleTimeoutMs: parsePositiveInt(
        env['CREWLY_CHAT_WS_IDLE_TIMEOUT_MS'],
        defaults.websocket.idleTimeoutMs,
      ),
    }),
    offlineQueue: defaults.offlineQueue,
    presence: defaults.presence,
    portal: defaults.portal,
    storage: Object.freeze({
      dbPath: dbPathEnv ? expandHomePath(dbPathEnv) : rebase(defaults.storage.dbPath),
      attachmentsDir: attachmentsDirEnv
        ? expandHomePath(attachmentsDirEnv)
        : rebase(defaults.storage.attachmentsDir),
      uploadsStagingDir: stagingDirEnv
        ? expandHomePath(stagingDirEnv)
        : rebase(defaults.storage.uploadsStagingDir),
    }),
  }) as ChatV2Config;
}
