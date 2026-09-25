/**
 * Solution bundle catalog: finds bundle templates on disk.
 *
 * Bundles are ordinary team templates with a `bundle` section. They are read
 * from the OSS `config/templates/` and from every directory in
 * `CREWLY_TEMPLATE_DIRS` (path-delimited). Crewly Pro sets that variable to
 * its own `config/templates/` when it starts the engine, which is how paid
 * bundles reach a Pro or hosted install without living in the OSS repo.
 *
 * Both layouts are read: `<dir>/<name>/template.json` (relative files such as
 * `norms/*.md` resolve against `<dir>/<name>/`) and flat `<dir>/<name>.json`.
 * The first directory that defines an id wins.
 *
 * @module services/bundle/bundle-catalog
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { BUNDLE_CONSTANTS } from '../../constants.js';
import type { BundleTemplate, LoadedBundle } from '../../types/solution-bundle.types.js';
import { bundleTeams, hasBundleSection, validateBundleTemplate, type BundleValidation } from './bundle-manifest.js';

/** A bundle found on disk with its validation result. */
export interface BundleCatalogEntry extends LoadedBundle {
  validation: BundleValidation;
}

/** Result of a scan. */
export interface BundleCatalogScan {
  /** Valid bundles, first definition of each id */
  bundles: BundleCatalogEntry[];
  /** Files with a bundle section that failed validation */
  invalid: Array<{ file: string; id: string | null; errors: string[] }>;
}

/** Owner-facing summary of a bundle (lists, starter cards). */
export interface BundleSummary {
  id: string;
  name: string;
  label: string;
  tagline: string;
  description: string;
  status: string;
  tier: string | null;
  recommendedRuntime: string;
  serverTier: string;
  memberCount: number;
  questionCount: number;
}

/** Everything the owner sees before deploying (questions included). */
export interface BundleDetail extends BundleSummary {
  ownerSummary: string;
  ownerDoes: string[];
  runtime: BundleTemplate['bundle']['runtime'];
  server: BundleTemplate['bundle']['server'];
  questions: NonNullable<BundleTemplate['bundle']['questions']>;
  teams: Array<{ key: string; name: string; members: Array<{ name: string; role: string; title: string }> }>;
  skills: string[];
  connectors: NonNullable<BundleTemplate['bundle']['connectors']>;
  schedules: Array<{ id: string; title: string; cron: string }>;
  firstWeek: Array<{ id: string; day: number; title: string }>;
  channels: string[];
}

/**
 * Read a UTF-8 file, or null when it does not exist / cannot be read.
 *
 * @param file - Absolute path
 * @returns Content or null
 */
export function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The template directories to scan: the given base dirs, then every entry
 * of `CREWLY_TEMPLATE_DIRS`. Duplicates and empty entries are dropped.
 *
 * @param baseDirs - Directories that always come first (the OSS templates)
 * @param env - Environment (tests)
 * @returns Absolute directories, in priority order
 */
export function resolveTemplateDirs(baseDirs: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env[BUNDLE_CONSTANTS.TEMPLATE_DIRS_ENV] ?? '').split(path.delimiter);
  const out: string[] = [];
  for (const dir of [...baseDirs, ...extra]) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const abs = path.resolve(trimmed);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * The template directories to read bundles from.
 *
 * @param packageRoot - Crewly package root
 * @param extra - Extra directories (CLI `--templates-dir`)
 * @param env - Environment
 * @returns Directories in priority order: OSS templates, extra, CREWLY_TEMPLATE_DIRS
 */
export function bundleTemplateDirs(packageRoot: string, extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveTemplateDirs([path.join(packageRoot, 'config', 'templates'), ...extra], env);
}

/**
 * The JSON files a directory may define templates in.
 *
 * @param dir - Template directory
 * @returns `[file, baseDir]` pairs
 */
function templateFiles(dir: string): Array<[string, string]> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const file = path.join(full, 'template.json');
      if (existsSync(file)) out.push([file, full]);
    } else if (entry.endsWith('.json')) {
      out.push([full, dir]);
    }
  }
  return out;
}

/**
 * Scan directories for bundle templates.
 *
 * @param dirs - Directories in priority order
 * @returns Valid bundles and invalid files
 *
 * @example
 * const { bundles } = scanBundles(resolveTemplateDirs([ossTemplatesDir]));
 */
export function scanBundles(dirs: string[]): BundleCatalogScan {
  const bundles: BundleCatalogEntry[] = [];
  const invalid: BundleCatalogScan['invalid'] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const [file, baseDir] of templateFiles(dir)) {
      const text = readTextOrNull(file);
      if (text === null) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        continue; // not a template; the template loaders report parse errors
      }
      if (!hasBundleSection(raw)) continue;
      const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null;
      const validation = validateBundleTemplate(raw, { dir: baseDir, readFile: readTextOrNull });
      if (!validation.ok) {
        invalid.push({ file, id, errors: validation.errors });
        continue;
      }
      const template = raw as BundleTemplate;
      if (seen.has(template.id)) continue;
      seen.add(template.id);
      bundles.push({ template, dir: baseDir, file, validation });
    }
  }
  return { bundles, invalid };
}

/**
 * Bundle catalog over a set of directories. Re-scans on every call (a
 * handful of small files), so templates added on disk show up without a
 * restart.
 */
export class BundleCatalog {
  /**
   * @param getDirs - Directories to scan, in priority order
   */
  constructor(private readonly getDirs: () => string[]) {}

  /**
   * Every valid bundle.
   *
   * @param options - `includeDrafts` to list drafts too
   * @returns Bundles
   */
  list(options: { includeDrafts?: boolean } = {}): BundleCatalogEntry[] {
    const { bundles } = scanBundles(this.getDirs());
    return options.includeDrafts ? bundles : bundles.filter((b) => isReady(b.template));
  }

  /**
   * One bundle by template id (drafts included).
   *
   * @param templateId - Template id
   * @returns The bundle, or null
   */
  get(templateId: string): BundleCatalogEntry | null {
    return scanBundles(this.getDirs()).bundles.find((b) => b.template.id === templateId) ?? null;
  }

  /**
   * Files with a bundle section that failed validation (for diagnostics).
   *
   * @returns Invalid files with their errors
   */
  invalid(): BundleCatalogScan['invalid'] {
    return scanBundles(this.getDirs()).invalid;
  }
}

/**
 * Whether a bundle may be deployed without `allowDraft`.
 *
 * @param template - Bundle template
 * @returns True unless the status is `draft`
 */
export function isReady(template: BundleTemplate): boolean {
  return (template.bundle.status ?? BUNDLE_CONSTANTS.STATUS.READY) === BUNDLE_CONSTANTS.STATUS.READY;
}

/**
 * The summary shown in lists.
 *
 * @param template - Bundle template
 * @returns Summary
 */
export function toBundleSummary(template: BundleTemplate): BundleSummary {
  const members = bundleTeams(template).reduce((sum, team) => sum + team.roles.reduce((n, r) => n + r.count, 0), 0);
  return {
    id: template.id,
    name: template.name,
    label: template.bundle.label,
    tagline: template.bundle.tagline,
    description: template.description,
    status: template.bundle.status ?? BUNDLE_CONSTANTS.STATUS.READY,
    tier: template.tier ?? template.requiredTier ?? null,
    recommendedRuntime: template.bundle.runtime.recommended,
    serverTier: template.bundle.server.tier,
    memberCount: members,
    questionCount: template.bundle.questions?.length ?? 0,
  };
}

/**
 * The detail shown before deploying: questions, members, what gets set up.
 *
 * @param template - Bundle template
 * @returns Detail
 */
export function toBundleDetail(template: BundleTemplate): BundleDetail {
  const b = template.bundle;
  return {
    ...toBundleSummary(template),
    ownerSummary: b.ownerSummary,
    ownerDoes: b.ownerDoes ?? [],
    runtime: b.runtime,
    server: b.server,
    questions: b.questions ?? [],
    teams: bundleTeams(template).map((team) => ({
      key: team.key,
      name: team.name,
      members: team.roles.flatMap((r) =>
        Array.from({ length: r.count }, (_, i) => ({
          name: r.count > 1 ? `${r.defaultName}${i + 1}` : r.defaultName,
          role: r.role,
          title: r.jobTitle ?? r.label,
        })),
      ),
    })),
    skills: [...(b.skills?.required ?? []), ...(b.skills?.optional ?? [])],
    connectors: b.connectors ?? [],
    schedules: (b.schedules ?? []).map((s) => ({ id: s.id, title: s.title, cron: s.cron })),
    firstWeek: (b.firstWeek ?? []).map((t) => ({ id: t.id, day: t.day, title: t.title })),
    channels: (b.slack?.channels ?? []).map((c) => c.name),
  };
}
