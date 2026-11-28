/**
 * A team's triggers (schedules and event watchers) in a team move. They live in
 * the machine's one trigger store, held in memory by the {@link TriggerEngine},
 * so a move reads and writes them through the running engine: a copy of the
 * file would miss it or overwrite it (CREW-1332).
 *
 * @module services/team-move/team-move-triggers
 */

import type { Trigger } from '../../types/v2/trigger.types.js';
import type { TriggerEngine, TriggerRestoreResult } from '../v3/trigger-engine.service.js';
import type { TeamMoveTriggerReport } from './team-move.types.js';

/** Package path of a team's triggers. */
export const TRIGGER_RECORD = 'records/triggers.json';

/** How long a move waits for the trigger engine after a boot. */
const ENGINE_WAIT_MS = 120_000;

/** Interval between looks while waiting. */
const ENGINE_POLL_MS = 500;

/** The trigger store as a move uses it. */
export interface TeamMoveTriggerStore {
  /** Every trigger on this machine. */
  list(): Promise<Trigger[]>;
  /** Add stored triggers, keeping ids; one-shot timers wait for {@link arm}. */
  restore(rows: readonly unknown[]): Promise<TriggerRestoreResult>;
  /** Arm restored one-shot timers. */
  arm(ids: readonly string[]): Promise<void>;
  /** Delete triggers by id; returns how many were there. */
  remove(ids: readonly string[]): Promise<number>;
}

/** The engine methods the store needs. */
export type TeamMoveTriggerEngine = Pick<TriggerEngine, 'isRunning' | 'list' | 'restoreTriggers' | 'armTriggers' | 'delete'>;

/**
 * A move's view of the running trigger engine. Every call waits for the engine
 * to have loaded its store: an engine that is not running lists nothing, which
 * would move a team without its schedules and say nothing.
 *
 * @param engine - Returns the engine
 * @param options - Test hooks
 * @param options.sleep - Wait between looks
 * @param options.timeoutMs - How long to wait before giving up
 * @returns The store
 */
export function engineTriggerStore(
  engine: () => TeamMoveTriggerEngine,
  options: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): TeamMoveTriggerStore {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? ENGINE_WAIT_MS;
  const ready = async (): Promise<TeamMoveTriggerEngine> => {
    const instance = engine();
    for (let waited = 0; !instance.isRunning(); waited += ENGINE_POLL_MS) {
      if (waited >= timeoutMs) throw new Error('the trigger engine is not running, so the team\'s schedules cannot be moved');
      await sleep(ENGINE_POLL_MS);
    }
    return instance;
  };
  return {
    list: async () => (await ready()).list(),
    restore: async (rows) => (await ready()).restoreTriggers(rows),
    arm: async (ids) => (await ready()).armTriggers(ids),
    remove: async (ids) => {
      const instance = await ready();
      let removed = 0;
      // One by one: each write shrinks the store by one, within its integrity guard.
      for (const id of ids) if (await instance.delete(id)) removed += 1;
      return removed;
    },
  };
}

/**
 * Whether a project data file belongs to a trigger store.
 *
 * @param rel - Path relative to the project's `.crewly`
 * @returns True for `triggers/…`
 */
export function isTriggerStorePath(rel: string): boolean {
  return rel === 'triggers' || rel.startsWith('triggers/');
}

/**
 * Every trigger a team owns, in any status (what the source takes out of its
 * store and keeps in the archive).
 *
 * @param triggers - All triggers
 * @param teamId - The team
 * @returns The team's triggers
 */
export function selectTeamTriggers(triggers: readonly Trigger[], teamId: string): Trigger[] {
  return triggers.filter((t) => t.teamId === teamId);
}

/**
 * The team's triggers that still have something to do (what travels in the
 * package): active and paused ones. Exhausted and cancelled ones are history.
 *
 * @param triggers - All triggers
 * @param teamId - The team
 * @returns The live triggers
 */
export function selectLiveTeamTriggers(triggers: readonly Trigger[], teamId: string): Trigger[] {
  return selectTeamTriggers(triggers, teamId).filter((t) => t.status === 'active' || t.status === 'paused');
}

/**
 * How a report names a trigger: its name and the start of its id.
 *
 * @param row - A trigger row, possibly unusable
 * @returns The label
 */
export function triggerLabel(row: unknown): string {
  const t = (typeof row === 'object' && row !== null ? row : {}) as { id?: unknown; name?: unknown };
  const id = typeof t.id === 'string' && t.id ? t.id.slice(0, 8) : null;
  const name = typeof t.name === 'string' && t.name ? t.name : null;
  if (name && id) return `${name} (${id})`;
  return name ?? id ?? 'unnamed trigger';
}

/**
 * Turn the engine's restore result into the report's names.
 *
 * @param result - What the engine did
 * @returns Names of the imported, skipped and failed triggers
 */
export function triggerReport(result: TriggerRestoreResult): TeamMoveTriggerReport {
  return {
    imported: result.imported.map(triggerLabel),
    skipped: result.skipped.map((s) => ({ trigger: triggerLabel(s.row), reason: s.reason })),
    failed: result.failed.map((f) => ({ trigger: triggerLabel(f.row), reason: f.reason })),
  };
}

/**
 * The report's lines about triggers.
 *
 * @param report - Names of what happened; null when the package carries no trigger record
 * @returns Warning lines, failures first
 */
export function triggerWarnings(report: TeamMoveTriggerReport | null): string[] {
  if (!report) {
    return ['This package carries no schedules (the source runs an older Crewly). Check the team\'s schedules and recreate any that are missing.'];
  }
  const out: string[] = [];
  const named = (rows: Array<{ trigger: string; reason: string }>): string => rows.map((r) => `${r.trigger}: ${r.reason}`).join('; ');
  if (report.failed.length > 0) out.push(`${report.failed.length} schedule(s) could not be imported: ${named(report.failed)}.`);
  if (report.skipped.length > 0) out.push(`${report.skipped.length} schedule(s) were skipped: ${named(report.skipped)}.`);
  if (report.imported.length > 0) out.push(`${report.imported.length} schedule(s) moved with the team: ${report.imported.join(', ')}.`);
  return out;
}
