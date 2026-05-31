/**
 * SOP catalog service.
 *
 * `config/sops/` is a *catalog* of reusable SOPs (a marketplace), NOT content a
 * team owns automatically. A team owns a SOP only once it is INSTALLED — copied
 * into the team's own `~/.crewly/teams/<id>/sops/` store, which the wiki then
 * surfaces (via the overlay resolver) under the team's `sop/` folder.
 *
 * This service lists the catalog, reports which entries a given team has
 * installed, and performs install / uninstall (copy / remove of the per-team
 * copy — the catalog original is never touched).
 *
 * @module services/wiki/sop-catalog.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';

/** A single SOP available in the catalog. */
export interface SopCatalogEntry {
  /** Catalog-relative path, e.g. `pm/progress-tracking.md`. Stable id. */
  path: string;
  /** Display title (from frontmatter `title:` or the filename). */
  title: string;
  /** Top-level category folder (`common`, `developer`, …) or `general`. */
  category: string;
  /** File size in bytes. */
  bytes: number;
  /** Whether the queried team has this SOP installed. */
  installed: boolean;
}

/**
 * Resolve the catalog directory (`<configDir>/sops`). `<configDir>` mirrors the
 * convention used by other services (`<cwd>/config`), overridable via
 * `CREWLY_CONFIG_DIR`.
 *
 * @returns Absolute path to the SOP catalog directory.
 */
export function sopCatalogDir(): string {
  const configDir = process.env.CREWLY_CONFIG_DIR
    ? path.resolve(process.env.CREWLY_CONFIG_DIR)
    : path.resolve(process.cwd(), 'config');
  return path.join(configDir, 'sops');
}

/**
 * Resolve a team's installed-SOP store from its vault path. The store is a
 * sibling of the vault (`<vault>/../sops`), matching the overlay resolver.
 *
 * @param vaultPath - Absolute path to the team vault (`.../teams/<id>/wiki`).
 * @returns Absolute path to the team's installed-SOP directory.
 */
export function teamSopsDir(vaultPath: string): string {
  return path.resolve(vaultPath, '..', 'sops');
}

/** Recursively collect `.md` files under `root`, returned as root-relative POSIX paths. */
async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(rel);
      }
    }
  };
  await walk(root, '');
  return out;
}

/** Pull a human title from a SOP's frontmatter `title:`, falling back to the filename. */
async function titleFor(absFile: string, relPath: string): Promise<string> {
  try {
    const head = (await fs.readFile(absFile, 'utf8')).slice(0, 600);
    const m = head.match(/^\s*title:\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  } catch {
    // ignore — fall through to filename
  }
  return path
    .basename(relPath, '.md')
    .replace(/\.v\d+$/, '')
    .replace(/[-_]/g, ' ');
}

/**
 * Reject relative paths that are unsafe (absolute, traversal, or non-markdown).
 *
 * @param relPath - Candidate catalog-relative SOP path.
 * @throws Error when the path is empty, not `.md`, or escapes its root.
 */
function assertSafeRel(relPath: string): string {
  const normalized = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || !normalized.endsWith('.md')) {
    throw new Error('sopPath must be a .md file');
  }
  if (normalized.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error('sopPath escapes catalog root');
  }
  return normalized;
}

/**
 * The SOP catalog service. Stateless; methods take the team vault path so the
 * same instance serves any team.
 */
export class SopCatalogService {
  /**
   * List the catalog, annotated with whether the given team has each installed.
   *
   * @param vaultPath - The team vault path (to resolve its installed store).
   * @returns Catalog entries sorted by category then path.
   */
  async list(vaultPath: string): Promise<SopCatalogEntry[]> {
    const catalogRoot = sopCatalogDir();
    const installedSet = new Set(await listMarkdown(teamSopsDir(vaultPath)));
    const rels = await listMarkdown(catalogRoot);
    const entries = await Promise.all(
      rels.map(async (rel) => {
        const abs = path.join(catalogRoot, rel);
        let bytes = 0;
        try {
          bytes = (await fs.stat(abs)).size;
        } catch {
          // ignore
        }
        const category = rel.includes('/') ? rel.split('/')[0] : 'general';
        return {
          path: rel,
          title: await titleFor(abs, rel),
          category,
          bytes,
          installed: installedSet.has(rel),
        } satisfies SopCatalogEntry;
      }),
    );
    return entries.sort(
      (a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path),
    );
  }

  /**
   * Install a catalog SOP into the team's store (copy, preserving the relative
   * path). Idempotent — re-installing refreshes the copy to the catalog version.
   *
   * @param vaultPath - The team vault path.
   * @param sopPath - Catalog-relative SOP path (e.g. `pm/progress-tracking.md`).
   * @returns `{ installed: true, path }`.
   * @throws Error when the path is unsafe or the catalog file is missing.
   */
  async install(vaultPath: string, sopPath: string): Promise<{ installed: true; path: string }> {
    const rel = assertSafeRel(sopPath);
    const src = path.join(sopCatalogDir(), rel);
    await fs.access(src); // throws if the catalog file doesn't exist
    const dest = path.join(teamSopsDir(vaultPath), rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    return { installed: true, path: rel };
  }

  /**
   * Remove a SOP from the team's store. The catalog original is untouched.
   * Idempotent — removing a not-installed SOP is a no-op.
   *
   * @param vaultPath - The team vault path.
   * @param sopPath - Catalog-relative SOP path.
   * @returns `{ installed: false, path }`.
   * @throws Error when the path is unsafe.
   */
  async uninstall(vaultPath: string, sopPath: string): Promise<{ installed: false; path: string }> {
    const rel = assertSafeRel(sopPath);
    const root = teamSopsDir(vaultPath);
    const dest = path.join(root, rel);
    try {
      await fs.unlink(dest);
    } catch {
      // already absent — idempotent
    }
    // Prune now-empty parent dirs (e.g. an emptied `pm/`) up to the store root
    // so the wiki tree doesn't show hollow category folders.
    let dir = path.dirname(dest);
    while (dir.startsWith(root + path.sep) && dir !== root) {
      try {
        await fs.rmdir(dir); // throws if non-empty — stop pruning then
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
    return { installed: false, path: rel };
  }
}
