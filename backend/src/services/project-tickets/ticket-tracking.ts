/**
 * Keep `<project>/.crewly/tickets/` visible to git
 * (specs/2026-09-28-project-tickets.md §2 "Git tracking").
 *
 * Most projects ignore `.crewly/` as a whole. A bare `!.crewly/tickets/`
 * cannot undo that — git never descends into an excluded directory, so
 * nothing inside it can be re-included. When (and only when) git reports the
 * tickets folder as ignored, this appends a small block to the project's
 * `.gitignore` that re-includes `.crewly/`, re-ignores everything in it, then
 * re-includes `tickets/`. Existing lines are never touched, and any existing
 * `!.crewly/...` negations (e.g. `!.crewly/wiki/`) are re-emitted after the
 * block's `.crewly/*` so the block cannot re-ignore what the project already
 * tracks.
 *
 * @module services/project-tickets/ticket-tracking
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { runGit, type GitResult } from '../worktree/worktree-git.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';

/** What {@link ensureTicketsTracked} found / did. */
export type TicketTrackingOutcome =
  /** Project is not inside a git work tree */
  | 'not-a-repo'
  /** The tickets folder lives outside the project (package-tree fallback) */
  | 'outside-project'
  /** Git already sees the folder */
  | 'tracked'
  /** The block was appended and git now sees the folder */
  | 'unignored'
  /** Still ignored (global excludes, or a rule the block cannot override) */
  | 'still-ignored';

/** Git runner (injectable for tests). */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/** A path inside the tickets folder used to ask git about it. */
const PROBE_FILE = 'probe.md';

/**
 * Whether git would ignore a new file in the tickets folder.
 *
 * @param projectPath - Project root
 * @param git - Git runner
 * @returns True / false, or null when git could not answer
 */
async function isTicketsFolderIgnored(projectPath: string, git: GitRunner): Promise<boolean | null> {
  const probe = `${PROJECT_TICKET_CONSTANTS.REPO_RELATIVE_DIR}/${PROBE_FILE}`;
  const r = await git(projectPath, ['check-ignore', '-q', '--no-index', probe]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

/**
 * Build the block to append: the header, `!.crewly/` and `.crewly/*`, then the
 * project's existing `.crewly` negations, then the tickets re-includes. The
 * block's own `.crewly/*` comes after the project's rules, so without the
 * re-emitted negations it would hide everything they had re-included.
 *
 * @param current - Current `.gitignore` text
 * @returns Block lines, in order
 */
export function buildTicketsBlock(current: string): string[] {
  const block = PROJECT_TICKET_CONSTANTS.GITIGNORE_BLOCK;
  const own = new Set<string>(block);
  const kept: string[] = [];
  for (const raw of current.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^!\/?\.crewly\//.test(line) || own.has(line) || kept.includes(line)) continue;
    kept.push(line);
  }
  return [...block.slice(0, 3), ...kept, ...block.slice(3)];
}

/**
 * Make sure git tracks the project's tickets folder, appending the
 * re-include block to `<project>/.gitignore` when it is ignored.
 *
 * Idempotent: the block is appended at most once (its re-include line is the
 * marker).
 *
 * @param projectPath - Absolute project root
 * @param git - Git runner (defaults to the worktree helper's `runGit`)
 * @returns What was found / done
 *
 * @example
 * ```typescript
 * const outcome = await ensureTicketsTracked('/repo');
 * if (outcome === 'still-ignored') logger.warn('tickets are not tracked');
 * ```
 */
export async function ensureTicketsTracked(projectPath: string, git: GitRunner = runGit): Promise<TicketTrackingOutcome> {
  const root = path.resolve(projectPath);
  if (resolveProjectDataDir(root) !== path.join(root, '.crewly')) return 'outside-project';
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return 'not-a-repo';

  const ignored = await isTicketsFolderIgnored(root, git);
  if (ignored === false) return 'tracked';
  if (ignored === null) return 'still-ignored';

  const gitignorePath = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    current = '';
  }
  const block = PROJECT_TICKET_CONSTANTS.GITIGNORE_BLOCK;
  const marker = block[block.length - 2];
  const alreadyThere = current.split(/\r?\n/).some((l) => l.trim() === marker);
  if (!alreadyThere) {
    const lead = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    await fs.appendFile(gitignorePath, `${lead}${buildTicketsBlock(current).join('\n')}\n`, 'utf8');
  }
  return (await isTicketsFolderIgnored(root, git)) === false ? 'unignored' : 'still-ignored';
}
