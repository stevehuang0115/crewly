/**
 * Durable store of owner decisions (specs/2026-10-01-decision-cards.md §1).
 *
 * One JSON file under CREWLY_HOME with a monotonically increasing id
 * counter, so `D-7` is never reused. All writes are serialised and atomic.
 * Settled decisions are pruned after {@link DECISION_CONSTANTS.RESOLVED_KEEP_MS}.
 *
 * @module services/decisions/decision-store
 */

import * as path from 'path';
import { DECISION_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { traceDecisionChanged, traceDecisionCreated } from '../trace/trace-recorder.js';

/** On-disk shape. */
interface DecisionFile {
  nextId: number;
  decisions: OwnerDecision[];
}

/** Statuses still in front of the owner. */
export const PENDING_DECISION_STATUSES: ReadonlySet<OwnerDecision['status']> = new Set(['open', 'parked']);

/**
 * Persistent decision store.
 */
export class DecisionStore {
  private data: DecisionFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - JSON file
   * @param now - Clock (tests)
   */
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Store under a CREWLY_HOME.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns The store
   */
  static inHome(crewlyHome: string): DecisionStore {
    return new DecisionStore(path.join(crewlyHome, DECISION_CONSTANTS.STORE_FILENAME));
  }

  /**
   * Add a decision, assigning its id.
   *
   * @param draft - Decision without id/timestamps
   * @returns The stored decision
   */
  async create(draft: Omit<OwnerDecision, 'id' | 'createdAt' | 'updatedAt'>): Promise<OwnerDecision> {
    return this.serial(async () => {
      const data = await this.load();
      const at = this.now().toISOString();
      const decision: OwnerDecision = { ...draft, id: `${DECISION_CONSTANTS.ID_PREFIX}${data.nextId}`, createdAt: at, updatedAt: at };
      data.nextId += 1;
      data.decisions.push(decision);
      await this.save();
      traceDecisionCreated(decision);
      return { ...decision };
    });
  }

  /**
   * Change a decision under the write lock.
   *
   * @param id - Decision id
   * @param fn - Returns the patch, or null to leave it alone
   * @returns The updated decision, or null when missing / unchanged
   */
  async update(id: string, fn: (d: OwnerDecision) => Partial<OwnerDecision> | null): Promise<OwnerDecision | null> {
    return this.serial(async () => {
      const data = await this.load();
      const idx = data.decisions.findIndex((d) => d.id === id);
      if (idx < 0) return null;
      const patch = fn({ ...data.decisions[idx] });
      if (!patch) return null;
      const previous = data.decisions[idx];
      const next: OwnerDecision = { ...previous, ...patch, updatedAt: this.now().toISOString() };
      data.decisions[idx] = next;
      await this.save();
      traceDecisionChanged(previous, next);
      return { ...next };
    });
  }

  /**
   * One decision.
   *
   * @param id - Decision id
   * @returns Copy, or null
   */
  async get(id: string): Promise<OwnerDecision | null> {
    const data = await this.load();
    const d = data.decisions.find((x) => x.id === id);
    return d ? { ...d } : null;
  }

  /**
   * All decisions, newest first, optionally filtered.
   *
   * @param filter - Predicate
   * @returns Copies
   */
  async list(filter?: (d: OwnerDecision) => boolean): Promise<OwnerDecision[]> {
    const data = await this.load();
    return data.decisions
      .filter((d) => !filter || filter(d))
      .map((d) => ({ ...d }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  }

  /**
   * The open decision whose card is this message (or whose thread this is).
   *
   * @param slackChannelId - Channel
   * @param ts - Card ts or thread ts
   * @returns Decision, or null
   */
  async findByCard(slackChannelId: string, ts: string): Promise<OwnerDecision | null> {
    const data = await this.load();
    const d = data.decisions.find((x) => x.card?.slackChannelId === slackChannelId && x.card.messageTs === ts);
    return d ? { ...d } : null;
  }

  /**
   * Drop settled decisions older than the keep window.
   *
   * @returns How many were dropped
   */
  async prune(): Promise<number> {
    return this.serial(async () => {
      const data = await this.load();
      const cutoff = this.now().getTime() - DECISION_CONSTANTS.RESOLVED_KEEP_MS;
      const before = data.decisions.length;
      data.decisions = data.decisions.filter((d) => PENDING_DECISION_STATUSES.has(d.status) || Date.parse(d.updatedAt) >= cutoff);
      const dropped = before - data.decisions.length;
      if (dropped > 0) await this.save();
      return dropped;
    });
  }

  private async load(): Promise<DecisionFile> {
    if (this.data) return this.data;
    const raw = await safeReadJson<Partial<DecisionFile>>(this.filePath, {});
    const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
    const maxId = decisions.reduce((m, d) => Math.max(m, Number(String(d.id).replace(DECISION_CONSTANTS.ID_PREFIX, '')) || 0), 0);
    this.data = { nextId: Math.max(Number(raw.nextId) || 1, maxId + 1), decisions };
    return this.data;
  }

  private async save(): Promise<void> {
    if (this.data) await atomicWriteJson(this.filePath, this.data);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
