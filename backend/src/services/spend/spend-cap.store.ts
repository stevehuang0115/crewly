/**
 * Token caps on disk: the owner's caps, the boosts in force and today's
 * bookkeeping (the 80% notices and stop cards already sent). One small JSON
 * file under CREWLY_HOME, written atomically.
 *
 * The first token store is migrated from the pre-token USD file
 * (`spend-caps.json`) with the documented rate
 * (USAGE_CONSTANTS.TOKENS_PER_USD); the migration is logged.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.store
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { atomicWriteFileSync, quarantineCorruptFileSync, readJsonStoreSync, CorruptJsonFileError, type FileIOLogger } from '../../utils/file-io.utils.js';
import { usdToTokens } from '../usage/token-format.js';

/** The owner's caps (tokens per local day). */
export interface SpendCapConfig {
  /** Cap for every agent without an override; null = off (the default) */
  defaultAgentCapTokens: number | null;
  /** Cap on all agents together; null = off */
  totalCapTokens: number | null;
  /** Session → its own cap; null = no cap for this agent even when a default is set */
  agentCapsTokens: Record<string, number | null>;
  /** Team id → the team's cap (all its members together); absent / null = none */
  teamCapsTokens: Record<string, number | null>;
  updatedAt?: string;
}

/**
 * A temporary boost: extra tokens (or no cap at all) for a team, an agent
 * or everyone, until `until` (by default the next local midnight).
 */
export interface UsageBoost {
  id: string;
  /** Agent session, `team:<teamId>`, or `*` (everyone) */
  target: string;
  /** Tokens added to every cap checked for the covered agents */
  extraTokens?: number;
  /** No cap at all for the covered agents */
  unlimited?: boolean;
  /** ISO time it ends */
  until: string;
  createdAt: string;
  /** Who set it (`owner`, `orc-dm`, `card`) */
  by?: string;
}

/** Today's bookkeeping; reset at local midnight. */
export interface SpendCapDayState {
  /** `YYYY-MM-DD`, local */
  date: string;
  /** `target@cap` keys whose 80% notice was sent */
  warned: string[];
  /** `target@cap` keys whose stop was announced */
  stopped: string[];
  /** Target → id of today's "cap reached" decision card */
  cards: Record<string, string>;
}

/** The file. */
export interface SpendCapFile {
  config: SpendCapConfig;
  boosts: UsageBoost[];
  day: SpendCapDayState;
}

/** Storage the service uses (tests pass an in-memory one). */
export interface SpendCapStoreLike {
  read(): SpendCapFile | null;
  write(file: SpendCapFile): void;
}

/**
 * Caps off.
 *
 * @returns Config
 */
export function emptyConfig(): SpendCapConfig {
  return { defaultAgentCapTokens: null, totalCapTokens: null, agentCapsTokens: {}, teamCapsTokens: {} };
}

/**
 * Caps off, nothing recorded.
 *
 * @param date - Local day
 * @returns Fresh file
 */
export function emptySpendCapFile(date: string): SpendCapFile {
  return { config: emptyConfig(), boosts: [], day: emptyDay(date) };
}

/**
 * Empty day state.
 *
 * @param date - Local day
 * @returns State
 */
export function emptyDay(date: string): SpendCapDayState {
  return { date, warned: [], stopped: [], cards: {} };
}

/**
 * Convert the pre-token USD caps to tokens.
 *
 * @param raw - Parsed `spend-caps.json`
 * @returns Token config, or null when the file held no caps
 */
export function migrateUsdConfig(raw: unknown): SpendCapConfig | null {
  const cfg = (raw as { config?: Record<string, unknown> } | null)?.config;
  if (!cfg || typeof cfg !== 'object') return null;
  const conv = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? usdToTokens(v) : null);
  const out = emptyConfig();
  out.defaultAgentCapTokens = conv(cfg.defaultAgentCapUsd);
  out.totalCapTokens = conv(cfg.totalCapUsd);
  const agents = (cfg.agentCapsUsd ?? {}) as Record<string, unknown>;
  for (const [s, v] of Object.entries(agents)) out.agentCapsTokens[s] = v === null ? null : conv(v);
  const any = out.defaultAgentCapTokens !== null || out.totalCapTokens !== null || Object.keys(out.agentCapsTokens).length > 0;
  return any ? out : null;
}

/**
 * JSON file store.
 */
export class FileSpendCapStore implements SpendCapStoreLike {
  /**
   * @param file - Absolute path of the token store
   * @param legacyUsdFile - The pre-token USD store, migrated when the token store does not exist yet
   * @param onMigrated - Told what was converted (for the log)
   * @param logger - Told when the file is bad (copied aside) or cannot be saved
   */
  constructor(
    private readonly file: string,
    private readonly legacyUsdFile?: string,
    private readonly onMigrated?: (config: SpendCapConfig) => void,
    private readonly logger?: FileIOLogger,
  ) {}

  /** Why the store refuses to write: its file is bad and not yet copied aside. */
  private blockedReason: string | null = null;

  /**
   * Read the store.
   *
   * Missing: migrate the USD store, or null. Bad: copied aside to
   * `usage-caps.json.corrupt-<ts>` (error logged), null. Bad and the copy
   * fails, or unreadable (EMFILE, EIO…): null, and {@link write} first copies
   * the file aside, refusing to write while that copy fails.
   *
   * @returns The file, or null when absent / unreadable
   */
  read(): SpendCapFile | null {
    try {
      if (!existsSync(this.file)) return this.migrate();
      const read = readJsonStoreSync<Partial<SpendCapFile>>(this.file, {
        validate: (d) => (d && typeof d === 'object' && (d as Partial<SpendCapFile>).config ? null : 'no caps config in the file'),
        logger: this.logger,
      });
      if (read.status !== 'ok') return null;
      const raw = read.data;
      return {
        config: { ...emptyConfig(), ...raw.config },
        boosts: Array.isArray(raw.boosts) ? raw.boosts : [],
        day: { ...emptyDay(raw.day?.date ?? ''), ...(raw.day ?? {}) },
      };
    } catch (err) {
      // Bad and not copied aside, or unreadable (EMFILE, EIO…): the file may
      // hold the owner's caps. Writes copy it aside first (see write()).
      this.blockedReason = err instanceof CorruptJsonFileError ? err.reason : `read failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.error?.('Token caps file could not be read; it will be copied aside before it is ever overwritten', { file: this.file, reason: this.blockedReason });
      return null;
    }
  }

  /**
   * Persist atomically (temp + fsync + rename). A failure keeps the old file
   * and throws.
   *
   * @param file - Contents to persist
   * @throws While the bad file on disk still cannot be copied aside
   */
  write(file: SpendCapFile): void {
    if (this.blockedReason !== null) {
      if (existsSync(this.file)) quarantineCorruptFileSync(this.file, this.blockedReason, this.logger);
      this.blockedReason = null;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(file, null, 2));
  }

  private migrate(): SpendCapFile | null {
    if (!this.legacyUsdFile || !existsSync(this.legacyUsdFile)) return null;
    try {
      const config = migrateUsdConfig(JSON.parse(readFileSync(this.legacyUsdFile, 'utf-8')));
      if (!config) return null;
      config.updatedAt = new Date().toISOString();
      const file: SpendCapFile = { config, boosts: [], day: emptyDay('') };
      this.write(file);
      this.onMigrated?.(config);
      return file;
    } catch {
      return null;
    }
  }
}

/**
 * In-memory store (tests).
 */
export class MemorySpendCapStore implements SpendCapStoreLike {
  file: SpendCapFile | null = null;

  /** @returns Stored copy */
  read(): SpendCapFile | null {
    return this.file ? (JSON.parse(JSON.stringify(this.file)) as SpendCapFile) : null;
  }

  /** @param file - Contents */
  write(file: SpendCapFile): void {
    this.file = JSON.parse(JSON.stringify(file)) as SpendCapFile;
  }
}
