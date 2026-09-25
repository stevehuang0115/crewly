/**
 * Archive Creator
 *
 * Creates tar.gz archives of skill packages and generates checksums
 * and registry entry metadata for marketplace publishing.
 *
 * @module cli/utils/archive-creator
 */

import path from 'path';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import * as tar from 'tar';
import type { SkillManifest } from './package-validator.js';
import { readSkillManifest } from '../../../config/skills/marketplace-registry.js';

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
  };
}

/**
 * Creates a tar.gz archive of a skill directory.
 *
 * The archive is named `{id}-{version}.tar.gz` and placed in the outputDir.
 * Files are stored under a top-level directory named after the skill ID.
 *
 * @param skillDir - Path to the skill directory to archive
 * @param outputDir - Directory to write the archive to
 * @param manifest - The validated manifest (validatePackage().manifest). When
 *   omitted it is read from SKILL.md frontmatter or skill.json
 * @returns Absolute path to the created archive
 * @throws Error when no manifest is given and none can be read
 *
 * @example
 * ```ts
 * const archivePath = await createSkillArchive('./my-skill', './dist');
 * ```
 */
export async function createSkillArchive(
  skillDir: string,
  outputDir: string,
  manifest?: Pick<SkillManifest, 'id' | 'version'>,
): Promise<string> {
  const absSkillDir = path.resolve(skillDir);
  const absOutputDir = path.resolve(outputDir);

  if (!manifest) {
    // Same reader and id rule as validatePackage: SKILL.md frontmatter or
    // skill.json, id defaulting to the directory name
    const read = readSkillManifest(absSkillDir);
    if (!read?.version) {
      throw new Error(`Cannot archive ${absSkillDir}: no SKILL.md frontmatter or skill.json with a version`);
    }
    manifest = { id: read.id || path.basename(absSkillDir), version: read.version };
  }

  const archiveName = `${manifest.id}-${manifest.version}.tar.gz`;
  const archivePath = path.join(absOutputDir, archiveName);

  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: path.dirname(absSkillDir),
      prefix: manifest.id,
    },
    [path.basename(absSkillDir)]
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
 * @param manifest - Validated manifest (validatePackage().manifest; SKILL.md or skill.json)
 * @param archivePath - Path to the tar.gz archive
 * @param checksum - Checksum string (sha256:hex)
 * @returns A complete registry entry
 *
 * @example
 * ```ts
 * const { manifest } = validatePackage('./my-skill'); // SKILL.md or skill.json
 * if (!manifest) throw new Error('invalid skill');
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
    },
  };
}
