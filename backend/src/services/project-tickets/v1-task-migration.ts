/**
 * One-off, explicit migration of the retired v1 task files
 * (`.crewly/tasks/<milestone>/{open,in_progress}/*.md`) into project tickets
 * (specs/2026-09-28-project-tickets.md §8).
 *
 * - Only unfinished files are imported (open / in_progress); done/ and
 *   blocked/ are left alone.
 * - Every import becomes a `backlog` ticket — nobody is working on it now, and
 *   a person decides what is still wanted.
 * - The original file is never modified, moved or deleted; its repo-relative
 *   path is recorded as `migratedFrom`, which also makes re-runs no-ops.
 * - Dry-run unless `apply: true`.
 *
 * @module services/project-tickets/v1-task-migration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYAML } from 'yaml';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { normalizeProjectTicketPriority, type ProjectTicketCriterion, type ProjectTicketPriority } from '../../types/project-ticket.types.js';
import type { ProjectTicketService } from './project-ticket.service.js';

/** Options for {@link migrateV1Tasks}. */
export interface V1MigrationOptions {
  /** Write the tickets (default false = dry-run) */
  apply?: boolean;
  /** Only these milestone folders (default: all) */
  milestones?: string[];
}

/** What happens to one v1 file. */
export interface V1MigrationItem {
  /** Repo-relative path of the v1 file */
  source: string;
  milestone: string;
  /** The v1 status folder it sits in */
  v1Status: string;
  title: string;
  priority: ProjectTicketPriority;
  action: 'create' | 'skip-existing' | 'skip-invalid' | 'skip-milestone';
  /** Id of the created ticket (apply) or the existing one */
  ticketId?: string;
  reason?: string;
}

/** Report of a run. */
export interface V1MigrationReport {
  projectPath: string;
  apply: boolean;
  /** v1 files found in open/in_progress folders */
  scanned: number;
  /** Tickets created (apply) or that would be created (dry-run) */
  toCreate: number;
  created: number;
  skipped: number;
  byMilestone: Record<string, { create: number; skip: number }>;
  items: V1MigrationItem[];
}

/** A v1 file read into ticket content. */
interface V1Parsed {
  title: string;
  priority: ProjectTicketPriority;
  labels: string[];
  description: string;
  acceptance: ProjectTicketCriterion[];
}

/** Max folder depth walked under `.crewly/tasks`. */
const MAX_WALK_DEPTH = 6;

/** v1 frontmatter at the start of a file. */
const V1_FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Find v1 files in open / in_progress status folders.
 *
 * @param v1Root - `<data dir>/tasks`
 * @returns Absolute file paths with milestone and status
 */
async function findV1Files(v1Root: string): Promise<Array<{ file: string; milestone: string; status: string }>> {
  const found: Array<{ file: string; milestone: string; status: string }> = [];
  const statuses = PROJECT_TICKET_CONSTANTS.MIGRATION_STATUS_FOLDERS as readonly string[];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.md') && statuses.includes(path.basename(dir))) {
        const milestoneDir = path.relative(v1Root, path.dirname(dir));
        found.push({ file: full, milestone: milestoneDir === '' ? '(none)' : milestoneDir.split(path.sep).join('/'), status: path.basename(dir) });
      }
    }
  };
  await walk(v1Root, 0);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Push markdown headings two levels down (outside code fences) so an imported
 * body cannot open sections of its own inside the ticket.
 *
 * @param text - Markdown
 * @returns Markdown with `#` → `###`, `##` → `####`, …
 */
export function demoteHeadings(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return /^#{1,4}\s/.test(line) ? `##${line}` : line;
    })
    .join('\n');
}

/**
 * Read a v1 task file.
 *
 * @param content - File content
 * @param fileBase - File name without `.md`
 * @param milestone - Milestone folder
 * @returns Ticket content
 */
export function parseV1Task(content: string, fileBase: string, milestone: string): V1Parsed {
  let fm: Record<string, unknown> = {};
  let body = content;
  const m = V1_FRONTMATTER_RE.exec(content);
  if (m) {
    try {
      const parsed: unknown = parseYAML(m[1] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
    } catch {
      fm = {};
    }
    body = content.slice(m[0].length);
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const title = (typeof fm.title === 'string' && fm.title.trim()) || heading || fileBase.replace(/[_-]+/g, ' ');
  const inlinePriority = /^\s*\*\*Priority:\*\*\s*(.+?)\s*$/m.exec(body)?.[1];
  const priority =
    normalizeProjectTicketPriority(fm.priority) ??
    normalizeProjectTicketPriority(inlinePriority) ??
    (PROJECT_TICKET_CONSTANTS.DEFAULT_PRIORITY as ProjectTicketPriority);
  const fmLabels = Array.isArray(fm.labels) ? fm.labels.map(String) : typeof fm.labels === 'string' ? fm.labels.split(',') : [];
  const labels = [...fmLabels.map((l) => l.trim()).filter(Boolean), `milestone:${milestone}`];

  const acceptance: ProjectTicketCriterion[] = [];
  const acc = /^#{2,3}\s+Acceptance Criteria\s*$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/im.exec(body);
  if (acc) {
    for (const line of acc[1].split(/\r?\n/)) {
      const item = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.+)$/.exec(line);
      if (item) acceptance.push({ text: item[2].trim(), done: (item[1] ?? ' ').toLowerCase() === 'x' });
    }
  }
  return { title: String(title).replace(/\s+/g, ' ').trim(), priority, labels, description: demoteHeadings(body.trim()), acceptance };
}

/**
 * Import unfinished v1 task files as backlog tickets.
 *
 * @param tickets - Ticket store
 * @param projectPath - Project root
 * @param projectName - Project name (id prefix on first allocation)
 * @param options - `apply` (default false), `milestones`
 * @returns What was / would be done
 *
 * @example
 * ```typescript
 * const dry = await migrateV1Tasks(svc, '/repo', 'repo');          // report only
 * const run = await migrateV1Tasks(svc, '/repo', 'repo', { apply: true });
 * ```
 */
export async function migrateV1Tasks(
  tickets: ProjectTicketService,
  projectPath: string,
  projectName: string,
  options: V1MigrationOptions = {},
): Promise<V1MigrationReport> {
  const root = path.resolve(projectPath);
  const apply = options.apply === true;
  const v1Root = path.join(resolveProjectDataDir(root), PROJECT_TICKET_CONSTANTS.MIGRATION_V1_DIR);
  const files = await findV1Files(v1Root);
  const existing = new Map<string, string>();
  for (const t of (await tickets.list(root)).tickets) if (t.migratedFrom) existing.set(t.migratedFrom, t.id);

  const report: V1MigrationReport = { projectPath: root, apply, scanned: files.length, toCreate: 0, created: 0, skipped: 0, byMilestone: {}, items: [] };
  for (const f of files) {
    const source = path.relative(root, f.file).split(path.sep).join('/');
    const bucket = (report.byMilestone[f.milestone] ??= { create: 0, skip: 0 });
    const base: Pick<V1MigrationItem, 'source' | 'milestone' | 'v1Status'> = { source, milestone: f.milestone, v1Status: f.status };
    let parsed: V1Parsed;
    let createdAt: string | undefined;
    try {
      const [content, stat] = await Promise.all([fs.readFile(f.file, 'utf8'), fs.stat(f.file)]);
      parsed = parseV1Task(content, path.basename(f.file, '.md'), f.milestone);
      createdAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
    } catch (err) {
      report.items.push({ ...base, title: path.basename(f.file), priority: 'P2', action: 'skip-invalid', reason: err instanceof Error ? err.message : String(err) });
      report.skipped += 1;
      bucket.skip += 1;
      continue;
    }
    const item: V1MigrationItem = { ...base, title: parsed.title, priority: parsed.priority, action: 'create' };
    if (options.milestones && options.milestones.length > 0 && !options.milestones.includes(f.milestone)) {
      item.action = 'skip-milestone';
    } else if (existing.has(source)) {
      item.action = 'skip-existing';
      item.ticketId = existing.get(source);
    }
    if (item.action !== 'create') {
      report.skipped += 1;
      bucket.skip += 1;
      report.items.push(item);
      continue;
    }
    report.toCreate += 1;
    bucket.create += 1;
    if (apply) {
      const t = await tickets.create(
        root,
        projectName,
        {
          title: parsed.title,
          description: parsed.description,
          acceptance: parsed.acceptance,
          priority: parsed.priority,
          labels: parsed.labels,
          status: 'backlog',
          source: PROJECT_TICKET_CONSTANTS.MIGRATION_SOURCE,
          migratedFrom: source,
          createdAt,
        },
        'crewly-migration',
      );
      item.ticketId = t.id;
      existing.set(source, t.id);
      report.created += 1;
    }
    report.items.push(item);
  }
  return report;
}
