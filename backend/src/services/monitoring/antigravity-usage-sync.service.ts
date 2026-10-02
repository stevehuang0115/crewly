/**
 * Antigravity Usage Sync — records Antigravity CLI (`agy`) token usage in
 * the shared ledger, BEST EFFORT.
 *
 * Where agy keeps usage: one SQLite database per conversation,
 * `~/.gemini/antigravity-cli/conversations/<conversation id>.db`. Its
 * `steps` table holds one row per step; a model-generation step's
 * `metadata` blob is a protobuf whose field 9 is a usage message with the
 * input tokens in field 2 and the output tokens in field 3 (observed on agy
 * 1.x: a one-word prompt read 12,719 in / 169 out). The schema is not
 * published, so:
 *
 * - only blobs that carry exactly that shape are counted; anything else is
 *   skipped, never guessed;
 * - agy does not expose cached input there, so Antigravity events have no
 *   `cachedInput` (their total = input + output as recorded);
 * - the model is stored as an enum, so events use the model id
 *   `antigravity-cli-default`.
 *
 * `agy --output-format stream-json` is print mode only; Crewly runs agy as an
 * interactive PTY, so the conversation database is the only source.
 *
 * Attribution: Crewly records each agy agent's conversation id in the
 * session state right after launch (runtime-session-recovery). Steps are
 * counted once each (a per-conversation set of counted step indexes,
 * persisted under CREWLY_HOME), so passes and restarts are idempotent; a
 * step whose usage is written later is picked up on a later pass.
 *
 * specs/2026-10-02-spend-cap.md §Sources
 *
 * @module services/monitoring/antigravity-usage-sync
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS, ANTIGRAVITY_USAGE_SYNC_CONSTANTS as C, RUNTIME_TYPES } from '../../constants.js';

/** One protobuf field. */
export interface ProtoField {
  field: number;
  wireType: number;
  /** Varint / fixed value */
  int?: number;
  /** Length-delimited bytes */
  bytes?: Buffer;
}

/**
 * Decode one level of a protobuf message (no schema).
 *
 * @param buf - Message bytes
 * @returns Fields in order, or null when the bytes are not a valid message
 */
export function decodeProtoFields(buf: Buffer): ProtoField[] | null {
  const out: ProtoField[] = [];
  let i = 0;
  const varint = (): number | null => {
    let result = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) return null;
    }
    return null;
  };
  while (i < buf.length) {
    const key = varint();
    if (key === null || key === 0) return null;
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      const v = varint();
      if (v === null) return null;
      out.push({ field, wireType, int: v });
    } else if (wireType === 2) {
      const len = varint();
      if (len === null || i + len > buf.length) return null;
      out.push({ field, wireType, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) return null;
      out.push({ field, wireType, int: Number(buf.readBigUInt64LE(i)) });
      i += 8;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) return null;
      out.push({ field, wireType, int: buf.readUInt32LE(i) });
      i += 4;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * The usage a step's metadata blob records.
 *
 * @param metadata - `steps.metadata` blob
 * @returns Input / output tokens, or null when the blob carries no usage
 */
export function antigravityStepUsage(metadata: Buffer | null | undefined): { input: number; output: number } | null {
  if (!metadata || metadata.length === 0) return null;
  const top = decodeProtoFields(metadata);
  const usageField = top?.find((f) => f.field === C.USAGE_FIELD && f.wireType === 2);
  if (!usageField?.bytes) return null;
  const usage = decodeProtoFields(usageField.bytes);
  if (!usage) return null;
  const input = usage.find((f) => f.field === C.INPUT_FIELD && f.wireType === 0)?.int;
  const output = usage.find((f) => f.field === C.OUTPUT_FIELD && f.wireType === 0)?.int;
  if (typeof input !== 'number' || typeof output !== 'number' || input + output <= 0) return null;
  return { input, output };
}

/**
 * Step timestamp: metadata field 1 is a protobuf Timestamp (seconds, nanos).
 *
 * @param metadata - `steps.metadata` blob
 * @returns ISO time, or null
 */
export function antigravityStepTime(metadata: Buffer): string | null {
  const top = decodeProtoFields(metadata);
  const ts = top?.find((f) => f.field === 1 && f.wireType === 2)?.bytes;
  const fields = ts ? decodeProtoFields(ts) : null;
  const seconds = fields?.find((f) => f.field === 1 && f.wireType === 0)?.int;
  if (typeof seconds !== 'number' || seconds <= 0) return null;
  const nanos = fields?.find((f) => f.field === 2 && f.wireType === 0)?.int ?? 0;
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

/** A step row. */
export interface AntigravityStepRow {
  idx: number;
  metadata: Buffer | null;
}

/** One step's usage, ready for the ledger. */
export interface AntigravityUsageEvent {
  timestamp: string;
  model: string;
  input: number;
  output: number;
}

/** Collaborators. */
export interface AntigravityUsageSyncDeps {
  /** agy config dir (`~/.gemini/antigravity-cli`) */
  configDir: string;
  cursorFile: string;
  sessions: () => Map<string, { runtimeType: string; claudeSessionId?: string }>;
  /** Read the step rows of a conversation database (null = unreadable) */
  readSteps: (dbPath: string) => AntigravityStepRow[] | null;
  record: (session: string, event: AntigravityUsageEvent) => void;
  now?: () => Date;
  logger?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void };
}

/** Per-conversation cursor. */
interface AntigravityCursor {
  session: string;
  /** Step indexes already counted */
  counted: number[];
  /** Database mtime at the last read (skip unchanged files) */
  mtimeMs: number;
}

/**
 * Read step rows with better-sqlite3, read-only.
 *
 * @param nodeRequire - A require able to load `better-sqlite3`
 * @returns Reader
 */
export function sqliteStepReader(nodeRequire: NodeRequire): (dbPath: string) => AntigravityStepRow[] | null {
  return (dbPath) => {
    let db: { prepare(sql: string): { all(): unknown[] }; close(): void } | null = null;
    try {
      const Database = nodeRequire('better-sqlite3') as new (p: string, o: Record<string, unknown>) => typeof db;
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      return (db as NonNullable<typeof db>).prepare('SELECT idx, metadata FROM steps ORDER BY idx').all() as AntigravityStepRow[];
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Polls the conversation databases of Crewly's agy agents.
 */
export class AntigravityUsageSyncService {
  private cursors = new Map<string, AntigravityCursor>();
  private loaded = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** @param deps - Collaborators */
  constructor(private readonly deps: AntigravityUsageSyncDeps) {}

  /** Run a pass now, then poll. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.sync();
    this.timer = setInterval(() => void this.sync(), C.SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass.
   *
   * @returns Events and tokens recorded
   */
  async sync(): Promise<{ eventsRecorded: number; tokensRecorded: number }> {
    const result = { eventsRecorded: 0, tokensRecorded: 0 };
    if (this.running) return result;
    this.running = true;
    let changed = false;
    try {
      if (!this.loaded) await this.load();
      for (const [session, info] of this.deps.sessions()) {
        const id = info.claudeSessionId;
        if (info.runtimeType !== RUNTIME_TYPES.ANTIGRAVITY_CLI || !id || this.cursors.has(id)) continue;
        this.cursors.set(id, { session, counted: [], mtimeMs: 0 });
        changed = true;
      }
      for (const [id, cursor] of this.cursors) {
        const dbPath = path.join(this.deps.configDir, ANTIGRAVITY_CONSTANTS.CONVERSATIONS_DIR, `${id}${ANTIGRAVITY_CONSTANTS.CONVERSATION_FILE_EXT}`);
        let mtimeMs: number;
        try {
          mtimeMs = (await fs.stat(dbPath)).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs === cursor.mtimeMs) continue;
        const rows = this.deps.readSteps(dbPath);
        if (!rows) continue;
        cursor.mtimeMs = mtimeMs;
        changed = true;
        const counted = new Set(cursor.counted);
        for (const row of rows) {
          if (counted.has(row.idx)) continue;
          const usage = antigravityStepUsage(row.metadata);
          if (!usage || !row.metadata) continue;
          counted.add(row.idx);
          const timestamp = antigravityStepTime(row.metadata) ?? (this.deps.now?.() ?? new Date()).toISOString();
          this.deps.record(cursor.session, { timestamp, model: C.MODEL, input: usage.input, output: usage.output });
          result.eventsRecorded += 1;
          result.tokensRecorded += usage.input + usage.output;
        }
        cursor.counted = [...counted].sort((a, b) => a - b);
      }
      if (changed) await this.save();
      if (result.eventsRecorded > 0) this.deps.logger?.info('Synced Antigravity usage', result);
    } catch (err) {
      this.deps.logger?.warn('Antigravity usage sync pass failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return result;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    try {
      this.cursors = new Map(Object.entries(JSON.parse(await fs.readFile(this.deps.cursorFile, 'utf-8')) as Record<string, AntigravityCursor>));
    } catch {
      this.cursors = new Map();
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.deps.cursorFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.deps.cursorFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.cursors), null, 2), 'utf-8');
      await fs.rename(tmp, this.deps.cursorFile);
    } catch (err) {
      this.deps.logger?.warn('Could not save Antigravity usage cursors', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
