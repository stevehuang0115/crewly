/**
 * CLI Tickets Command — project tickets from the terminal
 * (specs/2026-09-28-project-tickets.md §8).
 *
 * Usage:
 *   crewly tickets list [projectPath] [--status ready]
 *   crewly tickets migrate [projectPath]                    # dry-run report
 *   crewly tickets migrate [projectPath] --apply            # import
 *   crewly tickets migrate [projectPath] --milestone m1 --apply
 *
 * Works on the files directly (no backend needed); the folder lock makes it
 * safe to run while the backend is up.
 *
 * @module cli/commands/tickets
 */

import chalk from 'chalk';
import * as path from 'path';
import { ProjectTicketService } from '../../../backend/src/services/project-tickets/project-ticket.service.js';
import { migrateV1Tasks, type V1MigrationReport } from '../../../backend/src/services/project-tickets/v1-task-migration.js';

/** Options accepted by `crewly tickets`. */
export interface TicketsOptions {
  /** migrate: write the tickets (default: dry-run) */
  apply?: boolean;
  /** migrate: only these milestone folders */
  milestone?: string[];
  /** list: status filter */
  status?: string;
  /** Project name used for the id prefix (default: the registered name, else the folder name) */
  name?: string;
  /** Print JSON instead of text */
  json?: boolean;
}

/** Output sink (injectable for tests). */
export type Print = (line: string) => void;

/**
 * The project's display name: the registered Crewly project at that path,
 * else the folder name.
 *
 * @param projectPath - Absolute project path
 * @param override - `--name`
 * @returns Name
 */
export async function resolveProjectName(projectPath: string, override?: string): Promise<string> {
  if (override && override.trim()) return override.trim();
  try {
    const { StorageService } = await import('../../../backend/src/services/core/storage.service.js');
    const projects = await StorageService.getInstance().getProjects();
    const hit = projects.find((p) => path.resolve(p.path) === projectPath);
    if (hit) return hit.name;
  } catch {
    // No Crewly home yet — the folder name is fine.
  }
  return path.basename(projectPath);
}

/**
 * Render a migration report as text lines.
 *
 * @param report - Report
 * @returns Lines
 */
export function formatMigrationReport(report: V1MigrationReport): string[] {
  const lines = [
    `${report.apply ? 'Migrated' : 'Dry run —'} ${report.projectPath}`,
    `  v1 files (open / in_progress): ${report.scanned}`,
    `  ${report.apply ? 'created' : 'would create'}: ${report.apply ? report.created : report.toCreate}   skipped: ${report.skipped}`,
  ];
  for (const [m, c] of Object.entries(report.byMilestone)) lines.push(`    ${m}: ${c.create} to import, ${c.skip} skipped`);
  for (const i of report.items) {
    const tag = i.action === 'create' ? (report.apply ? `+ ${i.ticketId}` : '+') : `- ${i.action}${i.ticketId ? ` (${i.ticketId})` : ''}`;
    lines.push(`  ${tag}  [${i.priority}] ${i.title}  ← ${i.source}`);
  }
  if (!report.apply && report.toCreate > 0) lines.push('', 'Nothing was written. Re-run with --apply to import these as backlog tickets.');
  return lines;
}

/**
 * Run `crewly tickets <action> [projectPath]`.
 *
 * @param action - `list` | `migrate`
 * @param projectPathArg - Project folder (default: cwd)
 * @param options - Flags
 * @param print - Output sink
 * @param tickets - Ticket store (injectable for tests)
 * @returns Process exit code
 */
export async function ticketsCommand(
  action: string,
  projectPathArg: string | undefined,
  options: TicketsOptions = {},
  print: Print = (l) => console.log(l),
  tickets: ProjectTicketService = ProjectTicketService.getInstance(),
): Promise<number> {
  const projectPath = path.resolve(projectPathArg ?? process.cwd());
  try {
    if (action === 'list') {
      const { tickets: all, invalid } = await tickets.list(projectPath);
      const shown = options.status ? all.filter((t) => t.status === options.status) : all;
      if (options.json) {
        print(JSON.stringify({ tickets: shown, invalid }, null, 2));
        return 0;
      }
      if (shown.length === 0) print(chalk.gray('No tickets.'));
      for (const t of shown) print(`${t.id.padEnd(10)} ${t.status.padEnd(12)} ${t.priority}  ${t.title}${t.assignee ? chalk.gray(`  @${t.assignee}`) : ''}`);
      for (const i of invalid) print(chalk.yellow(`skipped ${i.fileName}: ${i.error}`));
      return 0;
    }
    if (action === 'migrate') {
      const name = await resolveProjectName(projectPath, options.name);
      const report = await migrateV1Tasks(tickets, projectPath, name, { apply: options.apply === true, milestones: options.milestone });
      if (options.json) print(JSON.stringify(report, null, 2));
      else for (const line of formatMigrationReport(report)) print(line);
      return 0;
    }
    print(chalk.red(`Unknown action: ${action}. Use: list | migrate`));
    return 1;
  } catch (err) {
    print(chalk.red(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}
