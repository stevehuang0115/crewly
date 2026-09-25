/**
 * CLI Marketplace Utilities
 *
 * Self-contained marketplace logic for the CLI. Fetches the registry from the
 * marketing site, downloads and installs skill archives, and manages the local
 * installed-items manifest. Does not depend on the backend server being running.
 *
 * @module cli/utils/marketplace
 */

import path from 'path';
import os from 'os';
import { readFile, writeFile, mkdir, copyFile, rm } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
/**
 * Returns the directory of the CLI entry point, or CWD as fallback.
 *
 * The entry is realpath'd: a global install runs through a `bin` symlink whose
 * own directory is outside the package, so walking up from it never finds
 * the package root.
 */
function getCliDir(): string {
  const entry = process.argv[1];
  if (!entry) return process.cwd();
  try {
    return path.dirname(realpathSync(entry));
  } catch {
    return path.dirname(path.resolve(entry));
  }
}
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import { MARKETPLACE_CONSTANTS } from '../../../config/constants.js';

/** Regex for valid marketplace item IDs (lowercase alphanumeric + hyphens, must start with alphanumeric) */
const VALID_ID_PATTERN = /^[a-z0-9][a-z0-9\-]*$/;

/** Returns the absolute path to the marketplace data directory (~/.crewly/marketplace). */
function getMarketplaceDir(): string {
  return path.join(os.homedir(), '.crewly', MARKETPLACE_CONSTANTS.DIR_NAME);
}

/** Returns the absolute path to the installed-items manifest file. */
function getManifestPath(): string {
  return path.join(getMarketplaceDir(), MARKETPLACE_CONSTANTS.MANIFEST_FILE);
}

// ========================= Types =========================

/** A single item in the marketplace registry */
export interface MarketplaceItem {
  id: string;
  type: 'skill' | 'model' | 'role';
  name: string;
  description: string;
  author: string;
  version: string;
  category: string;
  tags: string[];
  license: string;
  icon?: string;
  downloads: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
  assets: {
    archive?: string;
    checksum?: string;
    sizeBytes?: number;
    model?: string;
  };
  metadata?: Record<string, unknown>;
  /**
   * The public-registry entry this item replaced, when a premium entry with
   * the same id took priority. Installed instead if the premium source fails.
   * Set by fetchRegistry; never present in registry JSON.
   */
  fallback?: MarketplaceItem;
}

/** One skill that could not be installed, and why. */
export interface SkillInstallFailure {
  id: string;
  name: string;
  message: string;
}

/** Outcome of installing every skill in the registry. */
export interface InstallAllResult {
  total: number;
  installed: number;
  failed: SkillInstallFailure[];
}

/**
 * Skill manifests the installer accepts, in order of preference. Skills moved
 * from skill.json to SKILL.md (8339f728); older ones still ship skill.json.
 * A skill needs at least one of them.
 */
export const SKILL_MANIFEST_FILES = ['SKILL.md', 'skill.json'] as const;

/** Files fetched for a GitHub-directory skill when its entry lists none. */
export const DEFAULT_SKILL_FILES = ['SKILL.md', 'execute.sh', 'skill.json', 'instructions.md'] as const;

/** The full registry response */
export interface MarketplaceRegistry {
  schemaVersion: number;
  lastUpdated: string;
  cdnBaseUrl: string;
  items: MarketplaceItem[];
}

/** A record of an installed item */
export interface InstalledItemRecord {
  id: string;
  type: string;
  name: string;
  version: string;
  installedAt: string;
  installPath: string;
  checksum?: string;
}

/** The on-disk manifest of installed items */
export interface InstalledItemsManifest {
  schemaVersion: number;
  items: InstalledItemRecord[];
}

// ========================= Registry =========================

/**
 * Fetches the marketplace registry from both public (GitHub) and premium (stevesprompt) sources.
 * Merges results, with premium items taking priority on ID conflict.
 * Both sources are fetched in parallel for efficiency.
 *
 * @returns The full marketplace registry
 * @throws Error if both fetches fail
 */
export async function fetchRegistry(): Promise<MarketplaceRegistry> {
  const items = new Map<string, MarketplaceItem>();

  const premiumUrl = `${MARKETPLACE_CONSTANTS.PREMIUM_BASE_URL}${MARKETPLACE_CONSTANTS.PREMIUM_REGISTRY_ENDPOINT}`;

  // Fetch public and premium registries in parallel
  const [publicResult, premiumResult] = await Promise.allSettled([
    fetch(MARKETPLACE_CONSTANTS.PUBLIC_REGISTRY_URL, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.REGISTRY_FETCH_TIMEOUT) })
      .then(async (res) => (res.ok ? ((await res.json()) as MarketplaceRegistry) : null)),
    fetch(premiumUrl, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.REGISTRY_FETCH_TIMEOUT) })
      .then(async (res) => (res.ok ? ((await res.json()) as MarketplaceRegistry) : null)),
  ]);

  // Process public registry results first (so premium overrides on conflict)
  if (publicResult.status === 'fulfilled' && publicResult.value) {
    for (const item of publicResult.value.items || []) {
      items.set(item.id, item);
    }
  }

  // Process premium registry results (takes priority). Keep the public entry
  // it replaces as a fallback: premium archives can be missing from the CDN
  // while the public copy of the same skill installs fine.
  if (premiumResult.status === 'fulfilled' && premiumResult.value) {
    for (const item of premiumResult.value.items || []) {
      const replaced = items.get(item.id);
      const sameSource = replaced
        && (replaced.assets.archive ?? replaced.assets.model) === (item.assets.archive ?? item.assets.model);
      items.set(item.id, replaced && !sameSource ? { ...item, fallback: replaced } : item);
    }
  }

  if (items.size === 0) {
    throw new Error('Failed to fetch registry: both public and premium sources unavailable');
  }

  return {
    schemaVersion: MARKETPLACE_CONSTANTS.SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    cdnBaseUrl: MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE,
    items: Array.from(items.values()),
  };
}

// ========================= Manifest =========================

/**
 * Loads the installed-items manifest from disk.
 * Returns an empty manifest if the file doesn't exist.
 *
 * @returns The installed items manifest
 */
export async function loadManifest(): Promise<InstalledItemsManifest> {
  try {
    const data = await readFile(getManifestPath(), 'utf-8');
    return JSON.parse(data) as InstalledItemsManifest;
  } catch {
    return { schemaVersion: 1, items: [] };
  }
}

/**
 * Saves the installed-items manifest to disk.
 *
 * @param manifest - The manifest to persist
 */
export async function saveManifest(manifest: InstalledItemsManifest): Promise<void> {
  await mkdir(getMarketplaceDir(), { recursive: true });
  await writeFile(getManifestPath(), JSON.stringify(manifest, null, 2) + '\n');
}

// ========================= Install =========================

/**
 * Returns the local install path for a marketplace item.
 *
 * @param type - Item type (skill, model, role)
 * @param id - Item ID (must be lowercase alphanumeric with hyphens)
 * @returns Absolute path to the install directory
 * @throws Error if id contains invalid characters (path traversal prevention)
 */
export function getInstallPath(type: 'skill' | 'model' | 'role', id: string): string {
  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(`Invalid marketplace item ID: "${id}". IDs must match /^[a-z0-9][a-z0-9\\-]*$/.`);
  }
  const typeDir = type === 'skill' ? 'skills' : type === 'model' ? 'models' : 'roles';
  return path.join(getMarketplaceDir(), typeDir, id);
}

/**
 * Downloads and installs a single marketplace item.
 *
 * For skill archives (.tar.gz), extracts the contents into the install directory.
 * After installation, ensures _common/lib.sh files are present.
 * Cleans up partial installs on failure.
 *
 * @param item - The marketplace item to install
 * @returns Object with success status and message
 */
export async function downloadAndInstall(item: MarketplaceItem): Promise<{ success: boolean; message: string }> {
  const primary = await installFromSource(item);
  if (primary.success || !item.fallback) return primary;

  const fallback = await installFromSource(item.fallback);
  if (fallback.success) {
    return {
      success: true,
      message: `${fallback.message} (from the public registry; premium source failed: ${primary.message})`,
    };
  }
  return {
    success: false,
    message: `premium source failed: ${primary.message}; public source failed: ${fallback.message}`,
  };
}

/**
 * Installs one item from exactly the source its entry names, with no fallback.
 *
 * @param item - The marketplace item to install
 * @returns Object with success status and message
 */
async function installFromSource(item: MarketplaceItem): Promise<{ success: boolean; message: string }> {
  const installPath = getInstallPath(item.type, item.id);

  const assetPath = item.assets.archive || item.assets.model;
  if (!assetPath) {
    return { success: false, message: `No downloadable asset for ${item.id}` };
  }

  // GitHub-sourced skills (directory path, not archive)
  const isGitHubSource = assetPath.startsWith('config/skills/') && !assetPath.endsWith('.tar.gz');

  await mkdir(installPath, { recursive: true });

  try {
    if (isGitHubSource) {
      // Download individual files from GitHub raw content in parallel. Always
      // try both manifests (SKILL.md preferred, skill.json for older skills),
      // whatever the entry lists: registry `metadata.files` lists can be stale.
      const metadataFiles = item.metadata?.files as string[] | undefined;
      const listed = metadataFiles && Array.isArray(metadataFiles) && metadataFiles.length > 0
        ? metadataFiles
        : [...DEFAULT_SKILL_FILES];
      const filesToDownload = Array.from(new Set([...SKILL_MANIFEST_FILES, ...listed]));

      const results = await Promise.allSettled(
        filesToDownload.map(async (file) => {
          const url = `${MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE}/${assetPath}/${file}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.GITHUB_FILE_TIMEOUT) });
          return { file, res };
        }),
      );

      // Only a manifest is required; every other file is best-effort.
      const manifestOutcome = new Map<string, string>();
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const fileName = filesToDownload[i];
        const isManifest = (SKILL_MANIFEST_FILES as readonly string[]).includes(fileName);

        if (result.status === 'rejected') {
          if (isManifest) manifestOutcome.set(fileName, String(result.reason));
          continue;
        }
        const { file, res } = result.value;
        if (!res.ok) {
          if (isManifest) manifestOutcome.set(file, `${res.status} ${res.statusText}`.trim());
          continue;
        }
        const content = Buffer.from(await res.arrayBuffer());
        await writeFile(path.join(installPath, file), content);
        if (isManifest) manifestOutcome.set(file, 'ok');
      }

      if (![...manifestOutcome.values()].includes('ok')) {
        await rm(installPath, { recursive: true, force: true }).catch(() => {});
        const why = SKILL_MANIFEST_FILES.map((f) => `${f}: ${manifestOutcome.get(f) ?? 'not fetched'}`).join(', ');
        return {
          success: false,
          message: `No skill manifest at ${MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE}/${assetPath} (${why})`,
        };
      }
    } else {
      // Archive-based install (premium CDN or local)
      const url = `${MARKETPLACE_CONSTANTS.PREMIUM_BASE_URL}${MARKETPLACE_CONSTANTS.ASSETS_ENDPOINT}/${assetPath}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.DOWNLOAD_TIMEOUT) });
      if (!res.ok) {
        // Clean up partial install
        await rm(installPath, { recursive: true, force: true }).catch(() => {});
        return { success: false, message: `Download failed: ${res.status} ${res.statusText} (${url})` };
      }

      const data = Buffer.from(await res.arrayBuffer());

      // Verify checksum if provided
      if (item.assets.checksum) {
        const colonIdx = item.assets.checksum.indexOf(':');
        if (colonIdx === -1) {
          await rm(installPath, { recursive: true, force: true }).catch(() => {});
          return { success: false, message: `Invalid checksum format: ${item.assets.checksum}` };
        }
        const algo = item.assets.checksum.slice(0, colonIdx);
        const expected = item.assets.checksum.slice(colonIdx + 1);
        if (algo !== 'sha256') {
          await rm(installPath, { recursive: true, force: true }).catch(() => {});
          return { success: false, message: `Unsupported checksum algorithm "${algo}"` };
        }
        const actual = createHash('sha256').update(data).digest('hex');
        if (actual !== expected) {
          // Clean up partial install
          await rm(installPath, { recursive: true, force: true }).catch(() => {});
          return { success: false, message: `Checksum mismatch for ${item.id}` };
        }
      }

      if (item.assets.archive && assetPath.endsWith('.tar.gz')) {
        try {
          const readable = Readable.from(data);
          await pipeline(readable, tar.x({ cwd: installPath, strip: 1 }));
        } catch (err) {
          // Clean up partial install
          await rm(installPath, { recursive: true, force: true }).catch(() => {});
          return { success: false, message: `Extraction failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}` };
        }
      } else {
        const filename = path.basename(assetPath);
        await writeFile(path.join(installPath, filename), data);
      }
    }

    // Ensure _common/lib.sh for skills
    if (item.type === 'skill') {
      await ensureCommonLibs();
    }

    // Update manifest
    const record: InstalledItemRecord = {
      id: item.id,
      type: item.type,
      name: item.name,
      version: item.version,
      installedAt: new Date().toISOString(),
      installPath,
      checksum: item.assets.checksum,
    };

    const manifest = await loadManifest();
    manifest.items = manifest.items.filter((r) => r.id !== item.id);
    manifest.items.push(record);
    await saveManifest(manifest);

    return { success: true, message: `Installed ${item.name} v${item.version}` };
  } catch (error) {
    // Clean up partial install on any unexpected error
    await rm(installPath, { recursive: true, force: true }).catch(() => {});
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Installation failed for ${item.id}: ${msg}` };
  }
}

// ========================= Common Libs =========================

/**
 * Finds the Crewly package root by walking up from a starting directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Absolute path to the package root, or null if not found
 */
function findPackageRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'crewly') {
          return current;
        }
      } catch {
        // keep searching
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Ensures _common/lib.sh files exist in the marketplace directory.
 *
 * Copies the agent-level and root-level _common/lib.sh from the bundled
 * package into the marketplace directory so installed skills can source them.
 */
export async function ensureCommonLibs(): Promise<void> {
  const packageRoot = findPackageRoot(getCliDir()) || findPackageRoot(process.cwd());
  if (!packageRoot) {
    return;
  }

  const mpBase = path.join(os.homedir(), '.crewly', MARKETPLACE_CONSTANTS.DIR_NAME);

  // Copy agent _common/lib.sh
  const agentCommonSrc = path.join(packageRoot, 'config', 'skills', 'agent', '_common', 'lib.sh');
  const agentCommonDest = path.join(mpBase, 'skills', '_common');
  if (existsSync(agentCommonSrc)) {
    await mkdir(agentCommonDest, { recursive: true });
    await copyFile(agentCommonSrc, path.join(agentCommonDest, 'lib.sh'));
  }

  // Copy root _common/lib.sh
  const rootCommonSrc = path.join(packageRoot, 'config', 'skills', '_common', 'lib.sh');
  const rootCommonDest = path.join(mpBase, '_common');
  if (existsSync(rootCommonSrc)) {
    await mkdir(rootCommonDest, { recursive: true });
    await copyFile(rootCommonSrc, path.join(rootCommonDest, 'lib.sh'));
  }
}

// ========================= Convenience =========================

/**
 * Checks how many marketplace skills are installed locally.
 *
 * Compares the remote registry against the local manifest to determine
 * how many skills are already present.
 *
 * @returns Object with `installed` and `total` counts
 */
export async function checkSkillsInstalled(): Promise<{ installed: number; total: number }> {
  const manifest = await loadManifest();
  const registry = await fetchRegistry();
  const skills = registry.items.filter((i) => i.type === 'skill');
  const installedIds = new Set(manifest.items.filter((r) => r.type === 'skill').map((r) => r.id));
  const installed = skills.filter((s) => installedIds.has(s.id)).length;
  return { installed, total: skills.length };
}

/**
 * Installs all skills from the marketplace registry.
 *
 * Downloads and installs each skill sequentially. An optional progress
 * callback is invoked after each skill to allow callers to display progress.
 * Every failure is returned with the skill and the reason, so callers can
 * show it: the onboarding wizard used to print only the success count, which
 * hid 29 of 31 skills failing.
 *
 * @param onProgress - Optional callback invoked with (skillName, currentIndex, totalCount)
 * @returns Totals plus one entry per skill that failed
 */
export async function installAllSkills(
  onProgress?: (name: string, index: number, total: number) => void,
): Promise<InstallAllResult> {
  const registry = await fetchRegistry();
  const skills = registry.items.filter((i) => i.type === 'skill');
  let installed = 0;
  const failed: SkillInstallFailure[] = [];

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    try {
      const result = await downloadAndInstall(skill);
      if (result.success) installed++;
      else failed.push({ id: skill.id, name: skill.name, message: result.message });
    } catch (error) {
      failed.push({ id: skill.id, name: skill.name, message: error instanceof Error ? error.message : String(error) });
    }
    if (onProgress) {
      onProgress(skill.name, i + 1, skills.length);
    }
  }

  return { total: skills.length, installed, failed };
}

// ========================= Bundled Skills =========================

/**
 * Counts the number of bundled core agent skills shipped with the Crewly package.
 *
 * Looks in config/skills/agent/core/ for subdirectories.
 * Used as a fallback when the marketplace is unreachable.
 *
 * @returns The number of bundled core skill directories
 */
export function countBundledSkills(): number {
  const packageRoot = findPackageRoot(getCliDir()) || findPackageRoot(process.cwd());
  if (!packageRoot) return 0;

  const coreSkillsDir = path.join(packageRoot, 'config', 'skills', 'agent', 'core');
  try {
    const entries = readdirSync(coreSkillsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// ========================= Formatting =========================

/**
 * Formats a byte count into a human-readable string.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string like "18.4 KB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
