/**
 * Wiki canonical-folder overlay resolver.
 *
 * Some schema-frozen folders in a team vault (`sop/`, `team-norm/`) are
 * reserved canonical homes whose content actually lives elsewhere on disk and
 * is read directly by the engine — they were never wired to receive wiki
 * writes, so they always render empty. Rather than copy/migrate that content
 * (which would drift), the wiki tree + page endpoints read THROUGH to the real
 * source so the folders always reflect live content.
 *
 * Overlay sources (both PER-TEAM siblings of the vault, so the wiki shows only
 * what the team actually owns — config/sops/ is a catalog you install FROM,
 * never shown directly in a team folder):
 *   - `sop/`       → `<vault>/../sops/`                  (SOPs the team has installed from the catalog)
 *   - `team-norm/` → `<vault>/../norms/`                 (per-team norms written by update-team-norm)
 *
 * @module services/wiki/wiki-overlay.resolver
 */

import * as path from 'path';

/** Top-level vault folders that read through to a live external source. */
export type OverlayFolder = 'sop' | 'team-norm';

const OVERLAY_FOLDERS: ReadonlySet<string> = new Set<OverlayFolder>(['sop', 'team-norm']);

/**
 * Return the real on-disk directory backing a top-level canonical folder, or
 * null when the folder is not overlayed (the vault's own directory is used).
 * Both overlay folders resolve to a per-team sibling of the vault.
 *
 * @param vaultPath - Absolute path to the vault root (e.g. `.../teams/<id>/wiki`).
 * @param topFolder - The top-level folder name (e.g. `sop`, `team-norm`, `llm-curated`).
 * @returns Absolute source directory for read-through, or null.
 */
export function overlayRootFor(vaultPath: string, topFolder: string): string | null {
  if (!OVERLAY_FOLDERS.has(topFolder)) return null;
  // sop → installed SOPs sibling dir; team-norm → norms sibling dir.
  const sibling = topFolder === 'sop' ? 'sops' : 'norms';
  return path.resolve(vaultPath, '..', sibling);
}

/**
 * Resolve the absolute file path to read for an overlayed page request, with a
 * traversal guard against escaping the overlay source root. Returns null when
 * the relativePath is not under an overlay folder; callers then fall back to
 * the normal in-vault resolution.
 *
 * @param vaultPath - Absolute path to the vault root.
 * @param relativePath - Vault-relative page path, e.g. `sop/pm/progress-tracking.md`.
 * @returns Absolute real file path, or null if not overlayed.
 * @throws Error tagged `overlay_escape` when the path would escape the source root.
 */
export function resolveOverlayFilePath(
  vaultPath: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  if (slash <= 0) return null;
  const topFolder = normalized.slice(0, slash);
  const root = overlayRootFor(vaultPath, topFolder);
  if (!root) return null;
  const subPath = normalized.slice(slash + 1);
  const resolved = path.resolve(root, subPath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    const err = new Error('overlay path escapes source root');
    err.name = 'overlay_escape';
    throw err;
  }
  return resolved;
}
