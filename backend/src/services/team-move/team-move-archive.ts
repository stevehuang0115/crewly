/**
 * Source-side stop, archive and rollback of a moved team.
 *
 * `archive` stops the team and hides it: its folder, open work items, open
 * decisions, triggers, chat channels and Slack mapping are saved under
 * `~/.crewly/team-moves/<moveId>/archive/` and taken out of the live stores, so
 * nothing on this machine wakes agents that now live elsewhere. The archive is
 * kept 7 days. `restore` puts everything back and starts the team (rollback).
 * The same `archive` is what the target runs when a move is rolled back.
 *
 * The team's folder is removed with `detachTeamForMove`, never `deleteTeam`:
 * a delete would archive the Slack channel and remove the agents' Slack apps,
 * which now belong to the other machine.
 *
 * @module services/team-move/team-move-archive
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TEAM_MOVE_CONSTANTS } from '../../constants.js';
import type { ScheduledMessage, Team } from '../../types/index.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import { selectTeamTriggers, triggerLabel, type TeamMoveTriggerStore } from './team-move-triggers.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { readTeamChat, setChannelsArchived } from './team-move-chat.js';
import { StagingArea, pathExists, walkFiles } from './team-move-fs.js';
import { MoveJournal, listLocalMoveIds, moveDirFor } from './team-move-journal.js';
import { identityOf, selectDecisions, selectPoolItems, selectScheduledMessages, type DecisionLike } from './team-move-select.js';

const C = TEAM_MOVE_CONSTANTS;

/** What the archive keeps of the global stores. */
interface ArchiveRecords {
  workItems: WorkItem[];
  decisionIds: string[];
  channelIds: string[];
  mapping: Record<string, unknown> | null;
  scheduledMessages: ScheduledMessage[];
  /** The team's triggers in every status; absent in archives made before they were saved. */
  triggers?: Trigger[];
}

/** `archive/meta.json`. */
export interface ArchiveMeta {
  moveId: string;
  teamId: string;
  teamName: string;
  archivedAt: string;
  expiresAt: string;
  state: 'archived' | 'restored' | 'purged';
  records: ArchiveRecords;
}

/** Collaborators of the archiver. */
export interface ArchiveDeps {
  home?: string;
  storage: {
    getTeams(): Promise<Team[]>;
    saveTeam(team: Team): Promise<void>;
    detachTeamForMove(teamId: string): Promise<void>;
    getScheduledMessages(): Promise<ScheduledMessage[]>;
    saveScheduledMessage(message: ScheduledMessage): Promise<void>;
    deleteScheduledMessage(id: string): Promise<boolean>;
  };
  runtime: {
    stopTeam(teamId: string): Promise<void>;
    startTeam(teamId: string): Promise<{ ok: boolean; error?: string }>;
  };
  pool: {
    /** The pool file's content (items and claims). */
    read(): Promise<{ workItems?: WorkItem[]; claims?: never[] }>;
    removeWorkItems(ids: string[]): Promise<number>;
    addWorkItems(items: WorkItem[]): Promise<number>;
  };
  decisions: {
    list(): Promise<Array<DecisionLike & Record<string, unknown>>>;
    setStatus(id: string, status: 'open' | 'cancelled'): Promise<void>;
  };
  /** This machine's trigger store. */
  triggers: TeamMoveTriggerStore;
  slack: {
    /** Remove the team's channel mapping (the Slack channel itself stays). Returns the removed mapping. */
    unlink(teamId: string): Promise<Record<string, unknown> | null>;
    adopt(mapping: Record<string, unknown>): Promise<boolean>;
  };
  now?: () => string;
}

/** Outcome of {@link TeamMoveArchiver.restore}. */
export interface RestoreOutcome {
  restored: boolean;
  started: boolean;
  error?: string;
  /** Archived triggers that could not be put back, by name and reason. */
  triggerFailures?: string[];
}

/** The archiver. */
export class TeamMoveArchiver {
  private readonly home: string;
  private readonly now: () => string;

  constructor(private readonly deps: ArchiveDeps) {
    this.home = deps.home ?? getCrewlyHomePath();
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private archiveDir(moveId: string): string {
    return path.join(moveDirFor(moveId, this.home), 'archive');
  }

  /**
   * Read a move's archive record.
   *
   * @param moveId - Move id
   * @returns The metadata, or null when nothing was archived
   */
  async readMeta(moveId: string): Promise<ArchiveMeta | null> {
    return safeReadJson<ArchiveMeta | null>(path.join(this.archiveDir(moveId), 'meta.json'), null);
  }

  /**
   * Stop the team and archive it (hidden, kept 7 days). Idempotent.
   *
   * @param moveId - Move id
   * @param teamId - Team to archive
   * @returns The archive metadata, or null when the team is not on this machine
   */
  async archive(moveId: string, teamId: string): Promise<ArchiveMeta | null> {
    const journal = new MoveJournal(moveId, this.home, this.now);
    const existing = await this.readMeta(moveId);
    if (existing && existing.state === 'archived') return existing;

    const team = (await this.deps.storage.getTeams()).find((t) => t.id === teamId);
    if (!team) return null;
    const id = identityOf(team);
    const dir = this.archiveDir(moveId);

    await journal.run('archive:stop', async () => {
      await this.deps.runtime.stopTeam(teamId);
      return { stopped: true };
    });

    const records = await journal.run('archive:snapshot', async () => {
      const staging = new StagingArea(path.join(dir, 'team'));
      await staging.init();
      const teamDir = path.join(this.home, 'teams', teamId);
      for await (const f of walkFiles(teamDir)) await staging.copyIn(f.abs, f.rel);
      // The config as stored, with its runtime state (the live file is about to go).
      const config = await safeReadJson<unknown>(path.join(teamDir, 'config.json'), null);
      await staging.writeJson('config.json', config ?? team);

      const pool = await this.deps.pool.read();
      const slice = selectPoolItems(pool as { workItems?: WorkItem[] }, id);
      const decisions = selectDecisions(await this.deps.decisions.list(), id);
      const scheduled = selectScheduledMessages(await this.deps.storage.getScheduledMessages(), id);
      const chat = readTeamChat(this.home, id);
      const out: ArchiveRecords = {
        workItems: slice.workItems,
        decisionIds: decisions.map((d) => d.id),
        channelIds: chat.channels.map((c) => String(c['id'])),
        mapping: null,
        scheduledMessages: scheduled,
        triggers: selectTeamTriggers(await this.deps.triggers.list(), teamId),
      };
      return out;
    });

    // Take the team out of the live stores. Each piece is safe to repeat.
    await journal.run('archive:release', async () => {
      const removed = await this.deps.pool.removeWorkItems(records.workItems.map((w) => w.id));
      for (const decisionId of records.decisionIds) await this.deps.decisions.setStatus(decisionId, 'cancelled');
      for (const m of records.scheduledMessages) await this.deps.storage.deleteScheduledMessage(m.id);
      // Only what the snapshot saved: nothing leaves the store without a copy to restore it from.
      await this.deps.triggers.remove((records.triggers ?? []).map((t) => t.id));
      setChannelsArchived(this.home, records.channelIds, true);
      const mapping = await this.deps.slack.unlink(teamId);
      return { removed, mapping };
    });
    const released = (await journal.detailOf<{ mapping: Record<string, unknown> | null }>('archive:release')) ?? { mapping: null };

    await journal.run('archive:detach', async () => {
      await this.deps.storage.detachTeamForMove(teamId);
      return { detached: true };
    });

    const at = this.now();
    const meta: ArchiveMeta = {
      moveId,
      teamId,
      teamName: team.name,
      archivedAt: at,
      expiresAt: new Date(Date.parse(at) + C.ARCHIVE_RETENTION_MS).toISOString(),
      state: 'archived',
      records: { ...records, mapping: released.mapping },
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * Put an archived team back and start it (rollback on the source).
   *
   * @param moveId - Move id
   * @param options - `start` false restores without starting
   * @returns What happened; `restored` is false when there is nothing to restore
   */
  async restore(moveId: string, options: { start?: boolean } = {}): Promise<RestoreOutcome> {
    const meta = await this.readMeta(moveId);
    if (!meta || meta.state !== 'archived') return { restored: false, started: false };
    if (Date.parse(meta.expiresAt) < Date.parse(this.now())) return { restored: false, started: false, error: 'the archive has expired' };
    const dir = this.archiveDir(moveId);
    const teamDir = path.join(this.home, 'teams', meta.teamId);
    const journal = new MoveJournal(moveId, this.home, this.now);

    const restored = await journal.run('restore:records', async () => {
      // The Slack mapping first, so the returning team keeps its channel.
      if (meta.records.mapping) await this.deps.slack.adopt(meta.records.mapping);
      setChannelsArchived(this.home, meta.records.channelIds, false);
      await this.deps.pool.addWorkItems(meta.records.workItems);
      for (const decisionId of meta.records.decisionIds) await this.deps.decisions.setStatus(decisionId, 'open');
      const have = new Set((await this.deps.storage.getScheduledMessages()).map((m) => m.id));
      for (const m of meta.records.scheduledMessages) if (!have.has(m.id)) await this.deps.storage.saveScheduledMessage(m);
      // Before the team returns, so its declared schedules are found rather than recreated.
      const triggers = await this.deps.triggers.restore(meta.records.triggers ?? []);
      return {
        restored: true,
        triggerIds: triggers.imported.map((t) => t.id),
        triggerFailures: triggers.failed.map((f) => `${triggerLabel(f.row)}: ${f.reason}`),
      };
    });

    await journal.run('restore:team', async () => {
      for await (const f of walkFiles(path.join(dir, 'team'))) {
        if (f.rel === 'config.json') continue;
        const dest = path.join(teamDir, ...f.rel.split('/'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(f.abs, dest);
      }
      const config = await safeReadJson<Team | null>(path.join(dir, 'team', 'config.json'), null);
      if (!config) throw new Error('the archive has no team config');
      await this.deps.storage.saveTeam({ ...config, updatedAt: this.now() });
      return { restored: true };
    });

    // The team is back: a one-shot that came due meanwhile may fire now.
    await this.deps.triggers.arm(restored?.triggerIds ?? []);

    let started = false;
    let error: string | undefined;
    if (options.start !== false) {
      const result = await journal.run('restore:start', async () => this.deps.runtime.startTeam(meta.teamId));
      started = result.ok;
      error = result.error;
    }
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, state: 'restored' }, null, 2));
    const lost = restored?.triggerFailures ?? [];
    return { restored: true, started, ...(error ? { error } : {}), ...(lost.length > 0 ? { triggerFailures: lost } : {}) };
  }

  /**
   * Delete archives past their retention. Run at boot and daily.
   *
   * @returns Move ids that were purged
   */
  async purgeExpired(): Promise<string[]> {
    const purged: string[] = [];
    const nowMs = Date.parse(this.now());
    for (const moveId of await listLocalMoveIds(this.home)) {
      const meta = await this.readMeta(moveId);
      if (!meta || meta.state === 'purged') continue;
      if (meta.state === 'archived' && Date.parse(meta.expiresAt) > nowMs) continue;
      // A restored archive and an expired one are both done with.
      const dir = this.archiveDir(moveId);
      if (await pathExists(dir)) {
        await fs.rm(path.join(dir, 'team'), { recursive: true, force: true });
        await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, state: 'purged', records: { ...meta.records, workItems: [], triggers: [] } }, null, 2));
      }
      purged.push(moveId);
    }
    return purged;
  }
}
