/**
 * Spend caps on disk: the owner's caps plus today's bookkeeping (raises,
 * the 80% notices and stop cards already sent). One small JSON file under
 * CREWLY_HOME, written atomically.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

/** The owner's caps (USD per local day). */
export interface SpendCapConfig {
  /** Cap for every agent without an override; null = off (the default) */
  defaultAgentCapUsd: number | null;
  /** Cap on all agents together; null = off */
  totalCapUsd: number | null;
  /** Session → its own cap; null = no cap for this agent even when a default is set */
  agentCapsUsd: Record<string, number | null>;
  updatedAt?: string;
}

/** Today's bookkeeping; reset at local midnight. */
export interface SpendCapDayState {
  /** `YYYY-MM-DD`, local */
  date: string;
  /** Target (session, or `*` for the total) → cap raised to for today (USD) */
  raised: Record<string, number>;
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
  day: SpendCapDayState;
}

/** Storage the service uses (tests pass an in-memory one). */
export interface SpendCapStoreLike {
  read(): SpendCapFile | null;
  write(file: SpendCapFile): void;
}

/**
 * Caps off, nothing recorded.
 *
 * @param date - Local day
 * @returns Fresh file
 */
export function emptySpendCapFile(date: string): SpendCapFile {
  return {
    config: { defaultAgentCapUsd: null, totalCapUsd: null, agentCapsUsd: {} },
    day: emptyDay(date),
  };
}

/**
 * Empty day state.
 *
 * @param date - Local day
 * @returns State
 */
export function emptyDay(date: string): SpendCapDayState {
  return { date, raised: {}, warned: [], stopped: [], cards: {} };
}

/**
 * JSON file store.
 */
export class FileSpendCapStore implements SpendCapStoreLike {
  /**
   * @param file - Absolute path
   */
  constructor(private readonly file: string) {}

  /**
   * @returns The file, or null when absent / unreadable
   */
  read(): SpendCapFile | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<SpendCapFile>;
      if (!raw || typeof raw !== 'object' || !raw.config) return null;
      return {
        config: {
          defaultAgentCapUsd: raw.config.defaultAgentCapUsd ?? null,
          totalCapUsd: raw.config.totalCapUsd ?? null,
          agentCapsUsd: raw.config.agentCapsUsd ?? {},
          ...(raw.config.updatedAt ? { updatedAt: raw.config.updatedAt } : {}),
        },
        day: {
          ...emptyDay(raw.day?.date ?? ''),
          ...(raw.day ?? {}),
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * @param file - Contents to persist
   */
  write(file: SpendCapFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    renameSync(tmp, this.file);
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
