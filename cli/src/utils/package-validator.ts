/**
 * Package Validator
 *
 * Validates skill packages before publishing to the marketplace.
 * Accepts both skill layouts:
 * - current: SKILL.md (YAML frontmatter + instructions body) and execute.sh
 * - legacy:  skill.json, instructions.md and execute.sh
 *
 * Metadata is read with readSkillManifest() from config/skills/marketplace-registry.ts,
 * the same reader the public registry is generated with, so what publish accepts
 * is what the registry will list.
 *
 * @module cli/utils/package-validator
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { parseFrontmatter, readSkillManifest } from '../../../config/skills/marketplace-registry.js';

/** Result of a package validation */
export interface ValidationResult {
  /** Whether the package is valid for publishing */
  valid: boolean;
  /** Blocking errors that prevent publishing */
  errors: string[];
  /** Non-blocking warnings about best practices */
  warnings: string[];
  /** Which layout the package uses, when a descriptor was found */
  layout?: SkillLayout;
  /**
   * The manifest publish should use (archive name, registry entry, submission),
   * present when the package is valid. For SKILL.md skills without an `id`
   * in the frontmatter, the id is the directory name, as in the registry.
   */
  manifest?: SkillManifest;
}

/** The two accepted skill package layouts */
export type SkillLayout = 'SKILL.md' | 'skill.json';

/** Expected shape of skill.json */
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  assignableRoles: string[];
  tags: string[];
  skillType?: string;
  execution?: {
    type: string;
    script?: {
      file: string;
      interpreter: string;
      timeoutMs?: number;
    };
  };
  promptFile?: string;
  triggers?: string[];
  license?: string;
  author?: string;
}

/** Descriptor file of the current layout */
const SKILL_MD_FILE = 'SKILL.md';

/** Descriptor file of the legacy layout */
const SKILL_JSON_FILE = 'skill.json';

/** Files each layout requires besides its descriptor */
const REQUIRED_FILES_BY_LAYOUT: Record<SkillLayout, readonly string[]> = {
  'SKILL.md': ['execute.sh'],
  'skill.json': ['execute.sh', 'instructions.md'],
};

/** Error shown when a directory has neither descriptor */
export const NO_DESCRIPTOR_ERROR =
  'No skill descriptor found. Expected one of these layouts:\n' +
  '    - SKILL.md (YAML frontmatter + instructions) and execute.sh\n' +
  '    - legacy: skill.json, instructions.md and execute.sh';

/** Valid categories for marketplace skills */
const VALID_CATEGORIES = [
  'development',
  'task-management',
  'communication',
  'testing',
  'deployment',
  'documentation',
  'design',
  'devops',
  'productivity',
  'utility',
];

/** Pattern for valid kebab-case IDs */
const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Loose semver pattern (major.minor.patch) */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Validates a skill package directory for publishing.
 *
 * Checks:
 * - A descriptor exists: SKILL.md (current) or skill.json (legacy). With
 *   neither, the error names both accepted layouts.
 * - The files that layout requires exist (execute.sh; instructions.md for legacy)
 * - The descriptor parses (SKILL.md frontmatter, or skill.json as JSON)
 * - ID is kebab-case (SKILL.md: frontmatter `id`, else the directory name)
 * - Version is semver
 * - Category is from the allowed list
 * - assignableRoles and tags are non-empty arrays
 *
 * When both descriptors exist, SKILL.md frontmatter wins field by field and
 * skill.json fills the rest, exactly as the registry generator merges them.
 *
 * @param skillDir - Absolute or relative path to the skill directory
 * @returns Validation result with errors, warnings, the layout and (when valid) the manifest
 *
 * @example
 * ```ts
 * const result = validatePackage('/path/to/my-skill');
 * if (!result.valid) console.error(result.errors);
 * ```
 */
export function validatePackage(skillDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const absDir = path.resolve(skillDir);

  // Check directory exists
  if (!existsSync(absDir)) {
    return { valid: false, errors: [`Directory does not exist: ${absDir}`], warnings };
  }

  const skillMdPath = path.join(absDir, SKILL_MD_FILE);
  const layout: SkillLayout | null = existsSync(skillMdPath)
    ? 'SKILL.md'
    : existsSync(path.join(absDir, SKILL_JSON_FILE))
      ? 'skill.json'
      : null;

  if (!layout) {
    return { valid: false, errors: [NO_DESCRIPTOR_ERROR], warnings };
  }

  // Check the files this layout requires
  for (const file of REQUIRED_FILES_BY_LAYOUT[layout]) {
    if (!existsSync(path.join(absDir, file))) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  // The frontmatter must parse on its own: readSkillManifest would otherwise
  // silently fall back to skill.json alone when both files exist
  if (layout === 'SKILL.md') {
    try {
      if (!parseFrontmatter(readFileSync(skillMdPath, 'utf-8'))) {
        errors.push('SKILL.md has no YAML frontmatter (it must start with a --- block)');
        return { valid: false, errors, warnings, layout };
      }
    } catch (err) {
      errors.push(`Invalid YAML frontmatter in SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, errors, warnings, layout };
    }
  }

  let read: ReturnType<typeof readSkillManifest>;
  try {
    read = readSkillManifest(absDir);
  } catch (err) {
    errors.push(`Invalid JSON in skill.json: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings, layout };
  }
  const manifest = { ...(read ?? {}) } as Partial<SkillManifest>;
  if (layout === 'SKILL.md' && !manifest.id) {
    manifest.id = path.basename(absDir);
  }

  /** Field labels name the file the value comes from */
  const src = layout === 'SKILL.md' ? 'SKILL.md frontmatter' : 'skill.json';

  // Validate required fields
  if (!manifest.id) {
    errors.push(`${src} missing required field: id`);
  } else if (!KEBAB_CASE_RE.test(manifest.id)) {
    errors.push(`${src} id must be kebab-case: "${manifest.id}"`);
  }

  if (!manifest.name) {
    errors.push(`${src} missing required field: name`);
  }

  if (!manifest.description) {
    errors.push(`${src} missing required field: description`);
  }

  if (!manifest.version) {
    errors.push(`${src} missing required field: version`);
  } else if (!SEMVER_RE.test(String(manifest.version))) {
    errors.push(`${src} version must be semver (x.y.z): "${manifest.version}"`);
  }

  if (!manifest.category) {
    errors.push(`${src} missing required field: category`);
  } else if (!VALID_CATEGORIES.includes(manifest.category)) {
    warnings.push(`${src} category "${manifest.category}" is not in the standard list: ${VALID_CATEGORIES.join(', ')}`);
  }

  if (!manifest.assignableRoles || !Array.isArray(manifest.assignableRoles) || manifest.assignableRoles.length === 0) {
    errors.push(`${src} must have a non-empty assignableRoles array`);
  }

  if (!manifest.tags || !Array.isArray(manifest.tags) || manifest.tags.length === 0) {
    errors.push(`${src} must have a non-empty tags array`);
  }

  // Warnings for optional best practices
  if (!manifest.author) {
    warnings.push(`${src} is missing optional field: author`);
  }

  if (!manifest.license) {
    warnings.push(`${src} is missing optional field: license`);
  }

  if (!manifest.triggers || manifest.triggers.length === 0) {
    warnings.push(`${src} has no triggers — skill discovery may be limited`);
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    layout,
    ...(valid ? { manifest: manifest as SkillManifest } : {}),
  };
}

