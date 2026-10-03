/**
 * Codex Rollout Sync — records Codex CLI token usage in the shared ledger.
 *
 * Codex writes every conversation to `<codexHome>/sessions/YYYY/MM/DD/
 * rollout-<time>-<conversation id>.jsonl`. After each model call it appends
 * an `event_msg` line of type `token_count` whose `info.total_token_usage`
 * is the conversation's running total (OpenAI convention: `input_tokens`
 * includes `cached_input_tokens`; `output_tokens` includes reasoning) and
 * `info.last_token_usage` is that one call. The model comes from the
 * preceding `turn_context` line.
 *
 * Each pass reads only the bytes appended since the last pass (a byte
 * cursor per file, persisted under CREWLY_HOME like the Claude transcript
 * cursors) and records the DELTA of the running total, so a `token_count`
 * line Codex repeats (it re-emits the same totals) is counted once, and a
 * restart never re-counts a file.
 *
 * Attribution: Crewly persists each Codex agent's conversation id (learned
 * from the rollout right after launch, see runtime-session-recovery) in the
 * session state, so the rollout named `…-<id>.jsonl` belongs to that
 * session. A cursor keeps its session after the agent moves to a fresh
 * conversation, so the old file's last turns are still counted. Rollouts no
 * Crewly agent owns (the owner's own Codex use) are never read.
 *
 * Events are stored in the ledger's "cached on top" shape (`input` = fresh
 * tokens, `cachedInput` beside it, `runtime: 'codex-cli'`), the same as
 * Claude transcript turns. specs/2026-10-02-spend-cap.md §Sources.
 *
 * @module services/monitoring/codex-rollout-sync
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWriteFile, readJsonStore } from '../../utils/file-io.utils.js';
import { CODEX_USAGE_SYNC_CONSTANTS as C, RUNTIME_TYPES } from '../../constants.js';

/** Running token totals as Codex reports them. */
export interface CodexTotals {
  /** All input tokens, cached included */
  input: number;
  cached: number;
  output: number;
  total: number;
}

/** Parse state carried from one chunk of a rollout to the next. */
export interface CodexParseState {
  /** Model of the current turn */
  model: string;
  /** Last running total counted, null before the first */
  lastTotal: CodexTotals | null;
}

/** One model call's usage, ready for the ledger. */
export interface CodexUsageEvent {
  timestamp: string;
  model: string;
  /** Fresh (non-cached) input tokens */
  input: number;
  /** Cached input tokens (on top of `input`) */
  cachedInput: number;
  output: number;
}

/** A rollout file's cursor. */
export interface CodexRolloutCursor {
  /** Crewly session the conversation belongs to */
  session: string;
  /** Codex conversation id */
  conversationId: string;
  /** Bytes already consumed */
  offset: number;
  model: string;
  lastTotal: CodexTotals | null;
}

/** A registered agent session, as the sync needs it. */
export interface CodexSessionInfo {
  runtimeType: string;
  /** Runtime conversation id (Claude session id / Codex conversation id) */
  claudeSessionId?: string;
}

/** What one pass did. */
export interface CodexSyncResult {
  filesRead: number;
  eventsRecorded: number;
  tokensRecorded: number;
}

/** Collaborators. */
export interface CodexRolloutSyncDeps {
  /** Codex home (`CODEX_HOME` or `~/.codex`) */
  codexHome: string;
  /** Absolute cursor file path */
  cursorFile: string;
  /** Registered agent sessions: name → info */
  sessions: () => Map<string, CodexSessionInfo>;
  /** Record one event in the ledger */
  record: (session: string, event: CodexUsageEvent) => void;
  logger?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void };
}

/**
 * Read a usage block.
 *
 * @param u - `total_token_usage` / `last_token_usage`
 * @returns Totals, or null when it is not one
 */
function totalsOf(u: unknown): CodexTotals | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const num = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.max(0, o[k] as number) : 0);
  const input = num('input_tokens');
  const output = num('output_tokens');
  const total = typeof o.total_tokens === 'number' ? num('total_tokens') : input + output;
  return { input, cached: Math.min(num('cached_input_tokens'), input), output, total };
}

/**
 * Turn whole JSONL lines of a rollout into usage events. Mutates `state`.
 *
 * - `turn_context` sets the model;
 * - `token_count` with a running total records the delta since the last
 *   counted total (0 = a repeated line, skipped);
 * - a running total that went DOWN, or the first total of a file, records
 *   only that call's `last_token_usage` (a resumed conversation's file may
 *   open with history counted elsewhere).
 *
 * @param text - Whole lines
 * @param state - Parse state (model, last total)
 * @returns Events in file order
 */
export function parseCodexRolloutLines(text: string, state: CodexParseState): CodexUsageEvent[] {
  const events: CodexUsageEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) state.model = payload.model;
      continue;
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info as Record<string, unknown> | null | undefined;
    if (!info) continue;
    const total = totalsOf(info.total_token_usage);
    const last = totalsOf(info.last_token_usage);
    if (!total && !last) continue;
    let delta: CodexTotals | null;
    const prev = state.lastTotal;
    if (total && prev && total.total >= prev.total) {
      delta = {
        input: Math.max(0, total.input - prev.input),
        cached: Math.max(0, total.cached - prev.cached),
        output: Math.max(0, total.output - prev.output),
        total: total.total - prev.total,
      };
    } else {
      delta = last ?? total;
    }
    if (total) state.lastTotal = total;
    if (!delta || delta.input + delta.output <= 0) continue;
    const cached = Math.min(delta.cached, delta.input);
    events.push({
      timestamp: entry.timestamp || new Date().toISOString(),
      model: state.model || C.DEFAULT_MODEL,
      input: delta.input - cached,
      cachedInput: cached,
      output: delta.output,
    });
  }
  return events;
}

/**
 * Find a conversation's rollout file by id.
 *
 * @param codexHome - Codex home
 * @param conversationId - Conversation id
 * @returns Absolute path, or null
 */
export async function findCodexRollout(codexHome: string, conversationId: string): Promise<string | null> {
  const suffix = `-${conversationId}.jsonl`;
  const stack = [path.join(codexHome, 'sessions')];
  let visited = 0;
  while (stack.length > 0 && visited < C.MAX_SCAN_ENTRIES) {
    const dir = stack.pop() as string;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Newest day directories last on the stack = visited first.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      visited += 1;
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) return path.join(dir, e.name);
    }
  }
  return null;
}

/**
 * Polls Codex rollouts of Crewly's Codex agents and records their usage.
 */
export class CodexRolloutSyncService {
  private cursors = new Map<string, CodexRolloutCursor>();
  private loaded = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Conversation id → when a lookup last failed (ms), to avoid rescanning every pass */
  private readonly missing = new Map<string, number>();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: CodexRolloutSyncDeps) {}

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
   * @param filePath - Rollout path
   * @returns Its cursor (tests, diagnostics)
   */
  getCursor(filePath: string): CodexRolloutCursor | undefined {
    return this.cursors.get(filePath);
  }

  /**
   * One pass: adopt rollouts of newly seen Codex conversations, then read
   * the new tail of every known rollout.
   *
   * @returns What the pass recorded
   */
  async sync(): Promise<CodexSyncResult> {
    const result: CodexSyncResult = { filesRead: 0, eventsRecorded: 0, tokensRecorded: 0 };
    if (this.running) return result;
    this.running = true;
    let changed = false;
    try {
      if (!this.loaded) await this.load();
      // Cursor file bad and not set aside yet: count nothing, retry next pass.
      if (!this.loaded) return result;
      const known = new Set([...this.cursors.values()].map((c) => c.conversationId));
      for (const [session, info] of this.deps.sessions()) {
        const id = info.claudeSessionId;
        if (info.runtimeType !== RUNTIME_TYPES.CODEX_CLI || !id || known.has(id)) continue;
        const failedAt = this.missing.get(id);
        if (failedAt !== undefined && Date.now() - failedAt < 10 * C.SYNC_INTERVAL_MS) continue;
        const file = await findCodexRollout(this.deps.codexHome, id);
        if (!file) {
          this.missing.set(id, Date.now());
          continue;
        }
        this.missing.delete(id);
        this.cursors.set(file, { session, conversationId: id, offset: 0, model: '', lastTotal: null });
        known.add(id);
        changed = true;
      }
      for (const [file, cursor] of this.cursors) {
        const r = await this.syncFile(file, cursor);
        if (r.read) {
          result.filesRead += 1;
          changed = true;
        }
        result.eventsRecorded += r.events;
        result.tokensRecorded += r.tokens;
      }
      if (changed) await this.save();
      if (result.eventsRecorded > 0) this.deps.logger?.info('Synced Codex rollouts', { ...result });
    } catch (err) {
      this.deps.logger?.warn('Codex rollout sync pass failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return result;
  }

  private async syncFile(file: string, cursor: CodexRolloutCursor): Promise<{ read: boolean; events: number; tokens: number }> {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      return { read: false, events: 0, tokens: 0 };
    }
    if (size < cursor.offset) {
      // Rewritten underneath us: start over (the running-total delta keeps
      // already counted calls from counting twice only within one file
      // generation, so drop the total too).
      cursor.offset = 0;
      cursor.lastTotal = null;
    }
    if (size === cursor.offset) return { read: false, events: 0, tokens: 0 };
    const handle = await fs.open(file, 'r');
    let tail: string;
    try {
      const buf = Buffer.alloc(size - cursor.offset);
      await handle.read(buf, 0, buf.length, cursor.offset);
      tail = buf.toString('utf-8');
    } finally {
      await handle.close();
    }
    const nl = tail.lastIndexOf('\n');
    if (nl < 0) return { read: false, events: 0, tokens: 0 };
    const complete = tail.slice(0, nl);
    const state: CodexParseState = { model: cursor.model, lastTotal: cursor.lastTotal };
    const events = parseCodexRolloutLines(complete, state);
    cursor.offset += Buffer.byteLength(complete, 'utf-8') + 1;
    cursor.model = state.model;
    cursor.lastTotal = state.lastTotal;
    let tokens = 0;
    for (const e of events) {
      this.deps.record(cursor.session, e);
      tokens += e.input + e.cachedInput + e.output;
    }
    return { read: true, events: events.length, tokens };
  }

  /**
   * Read the cursors. Missing: start fresh. Bad: copied aside
   * (`.corrupt-<ts>`), logged, start fresh. Bad and cannot be copied aside,
   * or unreadable (EMFILE, EIO…): stay unloaded so the file is never
   * overwritten (retried next pass).
   */
  private async load(): Promise<void> {
    try {
      const read = await readJsonStore<Record<string, CodexRolloutCursor>>(this.deps.cursorFile, {
        validate: (d) => (d && typeof d === 'object' && !Array.isArray(d) ? null : 'not a JSON object of cursors'),
        logger: this.deps.logger,
      });
      this.cursors = read.status === 'ok' ? new Map(Object.entries(read.data)) : new Map();
      this.loaded = true;
    } catch {
      this.cursors = new Map();
    }
  }

  /** Write the cursors atomically (temp + fsync + rename); a failure keeps the old file. */
  private async save(): Promise<void> {
    if (!this.loaded) return;
    try {
      await fs.mkdir(path.dirname(this.deps.cursorFile), { recursive: true });
      await atomicWriteFile(this.deps.cursorFile, JSON.stringify(Object.fromEntries(this.cursors), null, 2));
    } catch (err) {
      this.deps.logger?.warn('Could not save Codex rollout cursors; the previous file was kept', { error: err instanceof Error ? err.message : String(err) });
    }
  }

}
