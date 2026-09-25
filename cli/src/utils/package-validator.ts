/**
 * Package Validator
 *
 * Validates skill packages before publishing to the marketplace.
 * Checks required files, skill.json schema, and metadata correctness.
 *
 * @module cli/utils/package-validator
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { validateSetupManifest } from '../../../backend/src/services/skill-setup/skill-setup-manifest.js';

/** Result of a package validation */
export interface ValidationResult {
  /** Whether the package is valid for publishing */
  valid: boolean;
  /** Blocking errors that prevent publishing */
  errors: string[];
  /** Non-blocking warnings about best practices */
  warnings: string[];
}

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
  /** Dependency setup block (specs/skill-auto-install.md) */
  setup?: unknown;
}

/** Required files that must exist in a skill package */
const REQUIRED_FILES = ['skill.json', 'execute.sh', 'instructions.md'];

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
 * - Required files exist (skill.json, execute.sh, instructions.md)
 * - skill.json is valid JSON with required fields
 * - ID is kebab-case
 * - Version is semver
 * - Category is from the allowed list
 * - assignableRoles and tags are non-empty arrays
 *
 * @param skillDir - Absolute or relative path to the skill directory
 * @returns Validation result with errors and warnings
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

  // Check required files
  for (const file of REQUIRED_FILES) {
    if (!existsSync(path.join(absDir, file))) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  // If skill.json is missing, we can't validate further
  const skillJsonPath = path.join(absDir, 'skill.json');
  if (!existsSync(skillJsonPath)) {
    return { valid: false, errors, warnings };
  }

  // Parse skill.json
  let manifest: SkillManifest;
  try {
    const raw = readFileSync(skillJsonPath, 'utf-8');
    manifest = JSON.parse(raw) as SkillManifest;
  } catch (err) {
    errors.push(`Invalid JSON in skill.json: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings };
  }

  // Validate required fields
  if (!manifest.id) {
    errors.push('skill.json missing required field: id');
  } else if (!KEBAB_CASE_RE.test(manifest.id)) {
    errors.push(`skill.json id must be kebab-case: "${manifest.id}"`);
  }

  if (!manifest.name) {
    errors.push('skill.json missing required field: name');
  }

  if (!manifest.description) {
    errors.push('skill.json missing required field: description');
  }

  if (!manifest.version) {
    errors.push('skill.json missing required field: version');
  } else if (!SEMVER_RE.test(manifest.version)) {
    errors.push(`skill.json version must be semver (x.y.z): "${manifest.version}"`);
  }

  if (!manifest.category) {
    errors.push('skill.json missing required field: category');
  } else if (!VALID_CATEGORIES.includes(manifest.category)) {
    warnings.push(`skill.json category "${manifest.category}" is not in the standard list: ${VALID_CATEGORIES.join(', ')}`);
  }

  if (!manifest.assignableRoles || !Array.isArray(manifest.assignableRoles) || manifest.assignableRoles.length === 0) {
    errors.push('skill.json must have a non-empty assignableRoles array');
  }

  if (!manifest.tags || !Array.isArray(manifest.tags) || manifest.tags.length === 0) {
    errors.push('skill.json must have a non-empty tags array');
  }

  // A setup block is run on users' machines: it must be valid, and every
  // install script it names must ship with the skill.
  if (manifest.setup !== undefined) {
    const setup = validateSetupManifest(manifest.setup);
    errors.push(...setup.errors.map((e) => `skill.json ${e}`));
    for (const step of setup.manifest?.steps ?? []) {
      if (step.type !== 'command') continue;
      for (const recipe of Object.values(step.install ?? {})) {
        if (recipe?.script && !existsSync(path.join(absDir, recipe.script))) {
          errors.push(`skill.json setup step "${step.id}" names install script ${recipe.script}, which is not in the skill directory`);
        }
      }
    }
  }

  // Warnings for optional best practices
  if (!manifest.author) {
    warnings.push('skill.json is missing optional field: author');
  }

  if (!manifest.license) {
    warnings.push('skill.json is missing optional field: license');
  }

  if (!manifest.triggers || manifest.triggers.length === 0) {
    warnings.push('skill.json has no triggers — skill discovery may be limited');
  }

  return { valid: errors.length === 0, errors, warnings };
}
