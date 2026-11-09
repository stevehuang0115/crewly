/**
 * Loader for the verified-work spot-check (#1315): reads the WorkItems and the
 * team index, checks files on the real disk, and hands them to the pure
 * {@link runSpotCheck}.
 *
 * @module services/v3/owner-receipt/verified-spot-check.loader
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import type { WorkItem } from '../../../types/v2/work-item.types.js';
import { runSpotCheck, type SpotCheckResult } from './verified-spot-check.js';

/** Where the loader reads from. */
export interface SpotCheckLoaderDeps {
  listWorkItems: () => Promise<WorkItem[]>;
  /** session → team name */
  loadTeamIndex: () => Promise<Map<string, string>>;
  /** File check, injectable for tests; default is `fs.stat` */
  exists?: (absolutePath: string) => Promise<boolean>;
  /** Random source, injectable for tests */
  random?: () => number;
}

/**
 * Whether anything exists at a path.
 *
 * @param p - Absolute path
 * @returns True when `fs.stat` succeeds
 */
async function statExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the `loadSpotCheck` dependency of the owner receipt service.
 *
 * @param deps - Data sources
 * @returns Function that runs the spot-check as of `now`
 */
export function createSpotCheckLoader(deps: SpotCheckLoaderDeps): (now: Date) => Promise<SpotCheckResult> {
  return async (now: Date): Promise<SpotCheckResult> => {
    const [workItems, teams] = await Promise.all([deps.listWorkItems(), deps.loadTeamIndex()]);
    return runSpotCheck({
      workItems,
      now,
      teamOf: (session) => teams.get(session) ?? null,
      exists: deps.exists ?? statExists,
      homeDir: os.homedir(),
      ...(deps.random ? { random: deps.random } : {}),
    });
  };
}
