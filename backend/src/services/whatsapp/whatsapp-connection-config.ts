/**
 * WhatsApp Connection Config Persistence
 *
 * Stores how the owner last connected WhatsApp (mode, allowed contacts,
 * whether to reconnect on boot) at `~/.crewly/whatsapp/connection.json`, so
 * a restart keeps inbox mode instead of silently falling back to the
 * auto-replying assistant.
 *
 * @module services/whatsapp/whatsapp-connection-config
 */

import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { isWhatsAppMode, type WhatsAppConfig, type WhatsAppMode } from '../../types/whatsapp.types.js';

/** Owner-only file mode for the config file. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

/**
 * What is persisted about a WhatsApp connection.
 */
export interface PersistedWhatsAppConnection {
  /** Connection mode */
  mode: WhatsAppMode;
  /** Reconnect on server start (true after connect, false after an explicit disconnect) */
  autoConnect: boolean;
  /** Allowed contacts (assistant mode only uses these) */
  allowedContacts?: string[];
  /** Display phone number */
  phoneNumber?: string;
  /** Custom auth-state directory */
  authStatePath?: string;
  /** Epoch ms of the last write */
  updatedAt: number;
}

/**
 * Path of the persisted connection config.
 *
 * @returns `<crewly home>/whatsapp/connection.json`
 */
export function getConnectionConfigPath(): string {
  return path.join(getCrewlyHomePath(), WHATSAPP_CONSTANTS.DATA_DIR, WHATSAPP_CONSTANTS.CONNECTION_CONFIG_FILE);
}

/**
 * Read the persisted connection config.
 *
 * @returns The config, or null when absent, unreadable or malformed
 */
export async function loadWhatsAppConnection(): Promise<PersistedWhatsAppConnection | null> {
  const file = getConnectionConfigPath();
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (!isWhatsAppMode(p.mode)) return null;
    return {
      mode: p.mode,
      autoConnect: p.autoConnect === true,
      allowedContacts: Array.isArray(p.allowedContacts)
        ? p.allowedContacts.filter((c): c is string => typeof c === 'string')
        : undefined,
      phoneNumber: typeof p.phoneNumber === 'string' ? p.phoneNumber : undefined,
      authStatePath: typeof p.authStatePath === 'string' ? p.authStatePath : undefined,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the config a connection was started with (auto-connect on).
 *
 * @param config - The config passed to `WhatsAppService.initialize`
 * @param mode - The resolved mode
 */
export async function saveWhatsAppConnection(config: WhatsAppConfig, mode: WhatsAppMode): Promise<void> {
  const record: PersistedWhatsAppConnection = {
    mode,
    autoConnect: true,
    allowedContacts: config.allowedContacts,
    phoneNumber: config.phoneNumber,
    authStatePath: config.authStatePath,
    updatedAt: Date.now(),
  };
  await writeConnection(record);
}

/**
 * Turn auto-connect off after an explicit disconnect, keeping the mode.
 */
export async function markWhatsAppDisconnected(): Promise<void> {
  const current = await loadWhatsAppConnection();
  if (!current) return;
  await writeConnection({ ...current, autoConnect: false, updatedAt: Date.now() });
}

/**
 * Convert a persisted record into a service config.
 *
 * @param persisted - Stored record
 * @returns Config for `WhatsAppService.initialize`
 */
export function toWhatsAppConfig(persisted: PersistedWhatsAppConnection): WhatsAppConfig {
  return {
    mode: persisted.mode,
    allowedContacts: persisted.allowedContacts,
    phoneNumber: persisted.phoneNumber,
    authStatePath: persisted.authStatePath,
  };
}

/**
 * Write the record owner-only.
 *
 * @param record - Record to write
 */
async function writeConnection(record: PersistedWhatsAppConnection): Promise<void> {
  const file = getConnectionConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.writeFile(file, JSON.stringify(record, null, 2), { mode: PRIVATE_FILE_MODE });
}
