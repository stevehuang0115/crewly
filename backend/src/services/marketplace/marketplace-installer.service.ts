/**
 * Marketplace Installer Service
 *
 * Handles downloading, installing, uninstalling, and updating
 * marketplace items. Manages asset downloads with checksum verification,
 * tar.gz extraction, and updates the local installed-items manifest.
 *
 * For skill items, also ensures the shared _common/lib.sh files are
 * present in the marketplace directory so installed skills can source them.
 *
 * @module services/marketplace/marketplace-installer.service
 */

import path from 'path';
import { homedir } from 'os';
import { mkdir, rm, copyFile, readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import {
  MarketplaceItem,
  MarketplaceOperationResult,
  InstalledItemRecord,
} from '../../types/marketplace.types.js';
import {
  loadManifest,
  saveManifest,
  getInstallPath,
} from './marketplace.service.js';
import { findPackageRoot } from '../../utils/package-root.js';
import { getSkillService } from '../skill/skill.service.js';
import { SkillCatalogService } from '../skill/skill-catalog.service.js';
import { MARKETPLACE_CONSTANTS } from '../../constants.js';

/**
 * Downloads an asset (archive or raw file), verifies its checksum,
 * and extracts/writes it into the given install directory.
 *
 * Shared helper used by both `installItem` and `installToPath` to
 * eliminate duplicated download/verify/extract logic.
 *
 * @param item - The marketplace item whose asset is being downloaded
 * @param installPath - Local directory to write/extract the asset into
 * @param assetPath - Relative path to the asset (archive or model file)
 * @returns Operation result indicating success or failure with a message
 */
async function downloadAndExtractAsset(
  item: MarketplaceItem,
  installPath: string,
  assetPath: string,
): Promise<MarketplaceOperationResult> {
  const localAssetsDir = path.join(homedir(), '.crewly', MARKETPLACE_CONSTANTS.DIR_NAME, 'assets');
  const localAssetPath = path.join(localAssetsDir, assetPath);

  let data: Buffer;
  if (existsSync(localAssetPath)) {
    data = await readFile(localAssetPath);
  } else {
    // Fall back to remote download (premium CDN)
    const url = `${MARKETPLACE_CONSTANTS.PREMIUM_BASE_URL}${MARKETPLACE_CONSTANTS.ASSETS_ENDPOINT}/${assetPath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
      return { success: false, message: `Download failed: ${res.status} ${res.statusText}` };
    }
    data = Buffer.from(await res.arrayBuffer());
  }

  // Verify checksum if provided
  if (item.assets.checksum) {
    const colonIdx = item.assets.checksum.indexOf(':');
    if (colonIdx === -1) {
      return { success: false, message: `Invalid checksum format (expected "algo:hash"): ${item.assets.checksum}` };
    }
    const algo = item.assets.checksum.slice(0, colonIdx);
    const expected = item.assets.checksum.slice(colonIdx + 1);
    if (algo !== 'sha256') {
      return { success: false, message: `Unsupported checksum algorithm "${algo}". Only sha256 is supported.` };
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) {
      return {
        success: false,
        message: `Checksum mismatch: expected ${expected}, got ${actual}`,
      };
    }
  }

  // Write to install path
  await mkdir(installPath, { recursive: true });

  if (item.assets.archive && assetPath.endsWith('.tar.gz')) {
    // Extract tar.gz archive contents into install directory
    const readable = Readable.from(data);
    await pipeline(readable, tar.x({ cwd: installPath, strip: 1 }));
  } else {
    // Non-archive asset (e.g., model file) — write raw
    const filename = path.basename(assetPath);
    await writeFile(path.join(installPath, filename), data);
  }

  return { success: true, message: `Installed ${item.name} v${item.version}` };
}

/**
 * Downloads and installs a marketplace item.
 *
 * Performs the following steps:
 * 1. Resolves the downloadable asset (archive or model)
 * 2. Determines the source type (GitHub directory or CDN archive)
 * 3. Delegates to `installFromGitHub` or `downloadAndExtractAsset`
 * 4. Calls `finalizeInstall` to update manifest and refresh registrations
 * 5. Cleans up partial install on failure
 *
 * @param item - The marketplace item to install
 * @returns Operation result indicating success or failure with a message
 */
export async function installItem(item: MarketplaceItem): Promise<MarketplaceOperationResult> {
  const installPath = getInstallPath(item.type, item.id);

  try {
    const assetPath = item.assets.archive || item.assets.model;
    if (!assetPath) {
      return { success: false, message: `No downloadable asset for ${item.id}` };
    }

    // Determine if this is a GitHub-sourced skill (directory path, not a .tar.gz)
    const isGitHubSource = assetPath.startsWith('config/skills/') && !assetPath.endsWith('.tar.gz');

    if (isGitHubSource) {
      // Download individual skill files from GitHub raw content
      return await installFromGitHub(item, installPath, assetPath);
    }

    // Archive-based install (local assets or premium CDN)
    const downloadResult = await downloadAndExtractAsset(item, installPath, assetPath);
    if (!downloadResult.success) {
      return downloadResult;
    }

    // Post-install: update manifest, ensure common libs, refresh registrations
    return await finalizeInstall(item, installPath);
  } catch (error) {
    // Clean up partial install on failure
    await rm(installPath, { recursive: true, force: true }).catch(() => {});
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Installation failed: ${msg}` };
  }
}

/**
 * Installs a skill by downloading individual files from GitHub raw content
 * in parallel.
 *
 * Public skills in the crewly repo are stored as directories (not archives).
 * This function downloads the essential skill files (SKILL.md, execute.sh)
 * concurrently from GitHub. SKILL.md and execute.sh are required.
 *
 * @param item - The marketplace item to install
 * @param installPath - Local directory to install to
 * @param sourcePath - Relative path in the GitHub repo (e.g. config/skills/agent/code-review)
 * @returns Operation result
 */
async function installFromGitHub(
  item: MarketplaceItem,
  installPath: string,
  sourcePath: string,
): Promise<MarketplaceOperationResult> {
  const baseUrl = MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE;
  // Use custom file list from metadata if available, otherwise default files
  const metadataFiles = item.metadata?.files as string[] | undefined;
  const filesToDownload = metadataFiles && Array.isArray(metadataFiles) && metadataFiles.length > 0
    ? metadataFiles
    : ['SKILL.md', 'execute.sh'];

  await mkdir(installPath, { recursive: true });

  // Download all files in parallel
  const results = await Promise.allSettled(
    filesToDownload.map(async (file) => {
      const url = `${baseUrl}/${sourcePath}/${file}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.GITHUB_FILE_TIMEOUT) });
      if (!res.ok) {
        return { file, ok: false as const, status: res.status, statusText: res.statusText };
      }
      const content = Buffer.from(await res.arrayBuffer());
      return { file, ok: true as const, content };
    })
  );

  // Process results: SKILL.md and execute.sh are required by default.
  // When metadata.files is provided (MCP skills), only SKILL.md is mandatory.
  for (let i = 0; i < filesToDownload.length; i++) {
    const file = filesToDownload[i];
    const result = results[i];
    const isOptional = metadataFiles
      ? file !== 'SKILL.md' && file !== 'skill.json'
      : file !== 'SKILL.md' && file !== 'execute.sh';

    if (result.status === 'rejected') {
      if (!isOptional) {
        return { success: false, message: `Failed to download ${file}: ${result.reason}` };
      }
      continue;
    }

    const value = result.value;
    if (!value.ok) {
      if (!isOptional) {
        return { success: false, message: `Failed to download ${file}: ${value.status} ${value.statusText}` };
      }
      continue;
    }

    await writeFile(path.join(installPath, file), value.content);
  }

  // Post-install: update manifest, ensure common libs, refresh registrations
  return await finalizeInstall(item, installPath);
}

/**
 * Shared post-install steps: update the installed-items manifest,
 * ensure _common/lib.sh files exist for skills, and refresh
 * skill registrations so the item is immediately discoverable.
 *
 * @param item - The marketplace item that was just installed
 * @param installPath - Local directory where the item was installed
 * @returns Operation result indicating success
 */
async function finalizeInstall(
  item: MarketplaceItem,
  installPath: string,
): Promise<MarketplaceOperationResult> {
  if (item.type === 'skill') {
    await ensureCommonLibs();
  }

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

  if (item.type === 'skill') {
    await refreshSkillRegistrations();
  }

  return { success: true, message: `Installed ${item.name} v${item.version}`, item: record };
}

/**
 * Internal uninstall with options. Used by updateItem to skip redundant refreshes.
 *
 * @param id - The ID of the marketplace item to uninstall
 * @param options - Optional flags (skipRefresh: skip skill registration refresh)
 * @returns Operation result indicating success or failure with a message
 */
async function uninstallItemInternal(
  id: string,
  options?: { skipRefresh?: boolean }
): Promise<MarketplaceOperationResult> {
  try {
    const manifest = await loadManifest();
    const record = manifest.items.find((r) => r.id === id);
    if (!record) {
      return { success: false, message: `Item ${id} is not installed` };
    }

    // Remove directory
    await rm(record.installPath, { recursive: true, force: true });

    // Update manifest
    manifest.items = manifest.items.filter((r) => r.id !== id);
    await saveManifest(manifest);

    // Refresh skill service and catalog after removal (unless skipped)
    if (record.type === 'skill' && !options?.skipRefresh) {
      await refreshSkillRegistrations();
    }

    return { success: true, message: `Uninstalled ${record.name}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Uninstall failed: ${msg}` };
  }
}

/**
 * Uninstalls a marketplace item by removing its directory and manifest entry.
 *
 * Performs the following steps:
 * 1. Looks up the item in the local manifest
 * 2. Removes the item's install directory from disk
 * 3. Removes the item's entry from the manifest
 *
 * @param id - The ID of the marketplace item to uninstall
 * @returns Operation result indicating success or failure with a message
 */
export async function uninstallItem(id: string): Promise<MarketplaceOperationResult> {
  return uninstallItemInternal(id);
}

/**
 * Updates a marketplace item to the latest version using a safe
 * install-to-temp-then-swap strategy.
 *
 * Performs the following steps:
 * 1. Installs the new version to a temporary path (suffixed with -update-tmp)
 * 2. On success: uninstalls the old version, renames temp to final path
 * 3. On failure: cleans up the temp path without touching the old version
 *
 * @param item - The marketplace item with the latest version info
 * @returns Operation result indicating success or failure with a message
 */
export async function updateItem(item: MarketplaceItem): Promise<MarketplaceOperationResult> {
  const finalPath = getInstallPath(item.type, item.id);
  const tempPath = finalPath + '-update-tmp';

  // Install new version to temp path by temporarily overriding getInstallPath behavior
  // We create the temp item that installFromTemp will use
  try {
    // Manually perform the install steps to the temp path
    const assetPath = item.assets.archive || item.assets.model;
    if (!assetPath) {
      return { success: false, message: `No downloadable asset for ${item.id}` };
    }

    const isGitHubSource = assetPath.startsWith('config/skills/') && !assetPath.endsWith('.tar.gz');

    let installResult: MarketplaceOperationResult;

    if (isGitHubSource) {
      installResult = await installFromGitHub(item, tempPath, assetPath);
    } else {
      installResult = await downloadAndExtractAsset(item, tempPath, assetPath);
    }

    if (!installResult.success) {
      // Clean up temp path on failure
      await rm(tempPath, { recursive: true, force: true }).catch(() => {});
      return { success: false, message: `Update failed during install: ${installResult.message}` };
    }

    // New version installed successfully to temp path
    // Now uninstall the old version (removes old dir + manifest entry)
    const uninstallResult = await uninstallItemInternal(item.id, { skipRefresh: true });
    if (!uninstallResult.success) {
      // If uninstall fails because item wasn't installed, that's OK for an update
      if (!uninstallResult.message.includes('not installed')) {
        await rm(tempPath, { recursive: true, force: true }).catch(() => {});
        return { success: false, message: `Update failed during uninstall: ${uninstallResult.message}` };
      }
    }

    // Rename temp to final path
    // Remove any existing final path first (in case uninstall didn't fully clean up)
    await rm(finalPath, { recursive: true, force: true }).catch(() => {});
    await rename(tempPath, finalPath);

    // Finalize: update manifest and refresh registrations
    return await finalizeInstall(item, finalPath);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Update failed: ${msg}` };
  }
}

/**
 * Ensures the shared _common/lib.sh files exist in the marketplace directory.
 *
 * Marketplace-installed skills source _common/lib.sh relative to their directory.
 * This function copies both the agent-level and root-level _common/lib.sh from
 * the bundled package into the marketplace directory structure:
 *
 * ```
 * ~/.crewly/marketplace/
 * ├── skills/
 * │   └── _common/
 * │       └── lib.sh    ← agent _common (delegates to root _common)
 * └── _common/
 *     └── lib.sh        ← root shared library
 * ```
 *
 * Safe to call multiple times — only copies if source files exist.
 */
export async function ensureCommonLibs(): Promise<void> {
  let packageRoot: string;
  try {
    packageRoot = findPackageRoot(__dirname);
  } catch {
    // In compiled mode, __dirname may not resolve — try from cwd
    packageRoot = findPackageRoot(process.cwd());
  }

  const mpBase = path.join(homedir(), '.crewly', MARKETPLACE_CONSTANTS.DIR_NAME);

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

/**
 * Refreshes the SkillService cache and regenerates the agent skill catalog
 * after a marketplace install or uninstall operation.
 *
 * This ensures newly installed skills are immediately available to agents
 * without requiring a server restart.
 */
async function refreshSkillRegistrations(): Promise<void> {
  try {
    const skillService = getSkillService();
    await skillService.refresh();
  } catch (error) {
    // Skill service may not be initialized yet (e.g., during CLI usage)
    const msg = error instanceof Error ? error.message : String(error);
    console.debug(`[marketplace] Failed to refresh skill service: ${msg}`);
  }

  try {
    const catalogService = SkillCatalogService.getInstance();
    await catalogService.generateAgentCatalog();
  } catch (error) {
    // Catalog service may not be available in all contexts
    const msg = error instanceof Error ? error.message : String(error);
    console.debug(`[marketplace] Failed to regenerate agent catalog: ${msg}`);
  }
}
