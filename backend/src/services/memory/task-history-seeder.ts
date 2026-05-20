/**
 * Task History Seeder
 *
 * Seeds the project task-history ledger with synthetic "declared"
 * entries when a team member registers. Solves the cold-start problem
 * for capability routing: on day-0, no real tasks have run yet, but
 * the team config can still declare what capabilities each member
 * holds, and the orchestrator's `recall(capability)` query finds them.
 *
 * The convention: a `TeamMember.capabilities` entry counts as a
 * canonical capability when it contains a `:` separator (e.g.
 * `gmail:read`, `oauth:gmail`). Free-form strings without `:` are
 * ignored — they aren't part of the routing vocabulary.
 *
 * @module services/memory/task-history-seeder
 */

import { IProjectMemoryService } from './project-memory.service.js';
import { TaskHistoryEntry } from '../../types/memory.types.js';
import { LoggerService } from '../core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TaskHistorySeeder');

export interface SeedDeclaredCapabilitiesArgs {
  projectPath: string;
  member: {
    sessionName: string;
    role: string;
    teamId?: string;
    capabilities?: string[];
  };
  projectMemory: IProjectMemoryService;
  /** Optional clock for tests; defaults to Date.now() */
  now?: () => Date;
}

/**
 * Filter a free-form `capabilities[]` array down to the entries that
 * look like canonical capability strings. Exported for unit testing.
 */
export function pickCanonicalCapabilities(raw: readonly string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim();
    if (!trimmed.includes(':')) continue;
    const [left, right] = trimmed.split(':', 2);
    if (!left || !right) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Emit a single synthetic `outcome: 'declared'` entry capturing every
 * canonical capability the member declares. One entry per registration,
 * keyed `th-declared-<sessionName>` so re-registration dedups cleanly
 * (the entry is overwritten in place when the same id arrives — see
 * ProjectMemoryService.addTaskHistory).
 *
 * No-op if the member has no canonical capabilities to declare.
 *
 * @returns The entry id if one was written, or null when skipped.
 */
export async function seedDeclaredCapabilities(
  args: SeedDeclaredCapabilitiesArgs,
): Promise<string | null> {
  const canonical = pickCanonicalCapabilities(args.member.capabilities);
  if (canonical.length === 0) {
    return null;
  }

  const now = (args.now ?? (() => new Date()))().toISOString();
  const entry: TaskHistoryEntry = {
    id: `th-declared-${args.member.sessionName}`,
    completedAt: now,
    agent: {
      sessionName: args.member.sessionName,
      role: args.member.role,
      teamId: args.member.teamId,
    },
    task: {
      description: 'Self-declared capabilities at register_self',
      outcome: 'declared',
    },
    capabilities: canonical,
    toolsUsed: [],
  };

  try {
    await args.projectMemory.addTaskHistory(args.projectPath, entry);
    logger.info('Seeded declared capabilities', {
      sessionName: args.member.sessionName,
      count: canonical.length,
    });
    return entry.id;
  } catch (err) {
    // Non-fatal — registration must succeed even if memory write fails.
    logger.warn('Failed to seed declared capabilities (non-fatal)', {
      sessionName: args.member.sessionName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
