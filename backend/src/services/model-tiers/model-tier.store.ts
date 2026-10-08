/**
 * Model-tier review state per team (crewly#1173): when the lead last
 * reviewed, the proposal it is drafting, the open owner card, and the tier
 * changes the owner applied (watched by the quality guard).
 *
 * One JSON file under CREWLY_HOME, written atomically; every change goes
 * through {@link ModelTierStore.update}, serialised in-process.
 *
 * @module services/model-tiers/model-tier.store
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { MODEL_TIER_CONSTANTS } from '../../constants.js';
import type { TierChangeEntry } from '../../types/decision.types.js';
import { atomicWriteFile, readJsonStore } from '../../utils/file-io.utils.js';
import type { QualityStats } from './tier-quality.js';

/** A proposal the lead is putting together (not yet sent to the owner). */
export interface TierDraft {
  reviewId: string;
  askerSession: string;
  startedAt: string;
  updatedAt: string;
  changes: TierChangeEntry[];
  routing: string[];
}

/** A change the owner applied, and what the quality guard found. */
export interface AppliedTierChange extends TierChangeEntry {
  appliedAt: string;
  decisionId: string;
  /** Send-back stats over the member's last settled items before the change */
  baseline: QualityStats;
  /**
   * `watching` — a lowered member, not judged yet; `ok` — judged, no worse;
   * `revert_proposed` — worse, a revert card went to the owner; `expired` —
   * too few items within the watch window; `not_watched` — raised or same rank.
   */
  guard: 'watching' | 'ok' | 'revert_proposed' | 'expired' | 'not_watched';
  guardDecisionId?: string;
  guardCheckedAt?: string;
  guardAfter?: QualityStats;
}

/** Review state of one team. */
export interface TeamTierState {
  lastReviewAt?: string;
  lastReviewTrigger?: 'weekly' | 'on_demand';
  draft?: TierDraft;
  /** The owner card of the last submitted proposal, while open */
  openDecisionId?: string;
  applied: AppliedTierChange[];
}

/** The file. */
interface StoreFile {
  version: 1;
  teams: Record<string, TeamTierState>;
}

/** Applied changes kept per team (oldest dropped). */
const MAX_APPLIED = 100;

/** File-backed store. */
export class ModelTierStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * Store under a Crewly home.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns Store
   */
  static inHome(crewlyHome: string): ModelTierStore {
    return new ModelTierStore(path.join(crewlyHome, MODEL_TIER_CONSTANTS.STORE_FILE));
  }

  /**
   * One team's state (empty state when none).
   *
   * @param teamId - Team id
   * @returns State
   */
  async get(teamId: string): Promise<TeamTierState> {
    const data = await this.load();
    return data.teams[teamId] ?? { applied: [] };
  }

  /**
   * Every team's state.
   *
   * @returns Map of team id → state
   */
  async all(): Promise<Record<string, TeamTierState>> {
    return (await this.load()).teams;
  }

  /**
   * Change one team's state (serialised; the file is rewritten atomically).
   *
   * @param teamId - Team id
   * @param mutate - Returns the new state (may mutate and return the given one)
   * @returns The new state
   */
  update(teamId: string, mutate: (s: TeamTierState) => TeamTierState): Promise<TeamTierState> {
    const run = this.chain.then(async () => {
      const data = await this.load();
      const next = mutate(data.teams[teamId] ?? { applied: [] });
      next.applied = next.applied.slice(-MAX_APPLIED);
      data.teams[teamId] = next;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await atomicWriteFile(this.filePath, JSON.stringify(data, null, 2));
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<StoreFile> {
    const read = await readJsonStore<StoreFile>(this.filePath, {
      validate: (d) => (d && typeof d === 'object' && typeof (d as StoreFile).teams === 'object' ? null : 'not a model-tier store'),
    });
    if (read.status === 'ok') return { version: 1, teams: read.data.teams ?? {} };
    return { version: 1, teams: {} };
  }
}
