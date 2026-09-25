/**
 * Archive Creator
 *
 * Creates tar.gz archives of skill packages and generates checksums
 * and registry entry metadata for marketplace publishing.
 *
 * @module cli/utils/archive-creator
 */

import path from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import * as tar from 'tar';
import type { SkillManifest } from './package-validator.js';

/** Registry entry shape for a published skill */
export interface RegistryEntry {
  id: string;
  type: 'skill';
  name: string;
  description: string;
  author: string;
  version: string;
  category: string;
  tags: string[];
  license: string;
  downloads: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
  assets: {
    archive: string;
    checksum: string;
    sizeBytes: number;
  };
  metadata: {
    assignableRoles: string[];
    triggers: string[];
    /** Dependency setup block, copied from skill.json (specs/skill-auto-install.md) */
    setup?: unknown;
  };
}

/**
 * Files never packed into a skill archive: tests, test fixtures, packaging
 * hints and OS/editor litter. Mirrors config/skills/marketplace-registry.ts.
 */
export const ARCHIVE_EXCLUDES: ReadonlyArray<RegExp> = [/\.test\./, /^mock-/, /^\.crewlyignore$/, /^\.DS_Store$/, /^__pycache__$/];

/**
 * Whether a path inside the skill directory belongs in the archive.
 *
 * @param entryPath - Path as tar sees it (relative, may include directories)
 * @returns False for excluded names at any depth
 */
export function includeInArchive(entryPath: string): boolean {
  return !entryPath.split('/').some((part) => ARCHIVE_EXCLUDES.some((re) => re.test(part)));
}

/**
 * Creates a tar.gz archive of a skill directory.
 *
 * The archive is named `{id}-{version}.tar.gz` and placed in the outputDir.
 * Files are stored under a top-level directory named after the skill ID.
 *
 * @param skillDir - Path to the skill directory to archive
 * @param outputDir - Directory to write the archive to
 * @returns Absolute path to the created archive
 *
 * @example
 * ```ts
 * const archivePath = await createSkillArchive('./my-skill', './dist');
 * ```
 */
export async function createSkillArchive(skillDir: string, outputDir: string): Promise<string> {
  const absSkillDir = path.resolve(skillDir);
  const absOutputDir = path.resolve(outputDir);

  const manifestRaw = readFileSync(path.join(absSkillDir, 'skill.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw) as SkillManifest;

  const archiveName = `${manifest.id}-${manifest.version}.tar.gz`;
  const archivePath = path.join(absOutputDir, archiveName);

  // Entries are `<id>/<file>`: installers extract with `strip: 1`. (Archiving
  // the directory itself under a `<id>` prefix produced `<id>/<dir>/<file>`,
  // which strip:1 unpacked one level too deep.)
  const entries = readdirSync(absSkillDir).filter((name) => includeInArchive(name)).sort();
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: absSkillDir,
      prefix: manifest.id,
      portable: true,
      filter: (entryPath: string) => includeInArchive(entryPath),
    },
    entries
  );

  return archivePath;
}

/**
 * Generates a SHA-256 checksum string for a file.
 *
 * @param filePath - Absolute path to the file
 * @returns Checksum in the format "sha256:{hex}"
 *
 * @example
 * ```ts
 * const checksum = generateChecksum('/path/to/archive.tar.gz');
 * // "sha256:abc123..."
 * ```
 */
export function generateChecksum(filePath: string): string {
  const data = readFileSync(filePath);
  const hash = createHash('sha256').update(data).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Generates a marketplace registry entry from skill metadata.
 *
 * Creates a complete registry entry suitable for inclusion in the
 * marketplace registry.json file.
 *
 * @param manifest - Parsed skill.json manifest
 * @param archivePath - Path to the tar.gz archive
 * @param checksum - Checksum string (sha256:hex)
 * @returns A complete registry entry
 *
 * @example
 * ```ts
 * const manifest = JSON.parse(readFileSync('skill.json', 'utf-8'));
 * const entry = generateRegistryEntry(manifest, './dist/my-skill-1.0.0.tar.gz', 'sha256:abc');
 * ```
 */
export function generateRegistryEntry(
  manifest: SkillManifest,
  archivePath: string,
  checksum: string
): RegistryEntry {
  const { size } = statSync(archivePath);
  const now = new Date().toISOString();

  return {
    id: manifest.id,
    type: 'skill',
    name: manifest.name,
    description: manifest.description,
    author: manifest.author || 'Crewly Team',
    version: manifest.version,
    category: manifest.category,
    tags: manifest.tags,
    license: manifest.license || 'MIT',
    downloads: 0,
    rating: 0,
    createdAt: now,
    updatedAt: now,
    assets: {
      archive: `skills/${manifest.id}/${path.basename(archivePath)}`,
      checksum,
      sizeBytes: size,
    },
    metadata: {
      assignableRoles: manifest.assignableRoles,
      triggers: manifest.triggers || [],
      ...(manifest.setup !== undefined ? { setup: manifest.setup } : {}),
    },
  };
}
