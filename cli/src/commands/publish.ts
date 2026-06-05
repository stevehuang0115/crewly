/**
 * CLI Publish Command
 *
 * Validates, packages, and submits a skill package to the marketplace.
 * Produces a tar.gz archive, generates metadata, and optionally submits
 * to the local Crewly backend for review and publishing.
 *
 * @module cli/commands/publish
 */

import path from 'path';
import { mkdirSync } from 'fs';
import chalk from 'chalk';
import { validatePackage } from '../utils/package-validator.js';
import { createSkillArchive, generateChecksum, generateRegistryEntry } from '../utils/archive-creator.js';
import type { SkillManifest } from '../utils/package-validator.js';
import { readFileSync } from 'fs';
import { MARKETPLACE_CONSTANTS } from '../../../config/constants.js';
import { submitToGitHub } from '../utils/gh-submit.js';
import { submitToCloud } from '../utils/cloud-submit.js';

/** Options for the publish command */
interface PublishOptions {
  /** If true, only validate without creating archive */
  dryRun?: boolean;
  /** Output directory for the archive (defaults to cwd) */
  output?: string;
  /** If true, submit the archive to the marketplace via the user's own gh CLI */
  submit?: boolean;
  /** If true, submit via Crewly Cloud (cloud opens the PR using its bot token; requires `crewly cloud login`) */
  cloud?: boolean;
  /** Backend URL for submission (defaults to localhost:3000) */
  url?: string;
}

/**
 * Publishes a skill package by validating, archiving, and optionally
 * submitting to the marketplace for review.
 *
 * Modes:
 * - `--dry-run`: Only validates, no archive created
 * - Default: Creates archive and prints registry entry JSON
 * - `--submit`: Creates archive and submits to the Crewly backend
 *
 * @param skillPath - Path to the skill directory
 * @param options - Command options (--dry-run, --output, --submit, --url)
 */
export async function publishCommand(skillPath?: string, options?: PublishOptions): Promise<void> {
  if (!skillPath) {
    console.log(chalk.red('Please specify the path to a skill directory.'));
    console.log(chalk.gray('Example: crewly publish config/skills/agent/marketplace/my-skill'));
    console.log(chalk.gray('         crewly publish config/skills/agent/marketplace/my-skill --dry-run'));
    console.log(chalk.gray('         crewly publish config/skills/agent/marketplace/my-skill --submit'));
    process.exit(1);
  }

  const absPath = path.resolve(skillPath);
  console.log(chalk.blue(`Validating skill at ${absPath}...`));

  // Validate
  const result = validatePackage(absPath);

  // Print warnings
  for (const warn of result.warnings) {
    console.log(chalk.yellow(`  ! ${warn}`));
  }

  // Print errors
  for (const err of result.errors) {
    console.log(chalk.red(`  ✗ ${err}`));
  }

  if (!result.valid) {
    console.log(chalk.red('\nValidation failed. Fix the errors above before publishing.'));
    process.exit(1);
  }

  console.log(chalk.green('  ✓ Validation passed'));

  if (options?.dryRun) {
    console.log(chalk.blue('\nDry run — no archive created.'));
    return;
  }

  // Create archive
  const outputDir = path.resolve(options?.output || '.');
  mkdirSync(outputDir, { recursive: true });

  console.log(chalk.blue('\nCreating archive...'));
  const archivePath = await createSkillArchive(absPath, outputDir);
  console.log(chalk.green(`  ✓ Archive: ${archivePath}`));

  // Generate checksum
  const checksum = generateChecksum(archivePath);
  console.log(chalk.green(`  ✓ Checksum: ${checksum}`));

  // Generate registry entry
  const manifestRaw = readFileSync(path.join(absPath, 'skill.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw) as SkillManifest;
  const entry = generateRegistryEntry(manifest, archivePath, checksum);

  console.log(chalk.blue('\nRegistry entry:'));
  console.log(JSON.stringify(entry, null, 2));

  // Submit via Crewly Cloud if --cloud flag is set (cloud opens the PR with its
  // bot token; the user only needs to be logged in — no local gh / GitHub account).
  if (options?.cloud) {
    try {
      const result = await submitToCloud(absPath, manifest);
      console.log(chalk.green(`\n${result.updated ? 'Updated existing submission PR!' : 'Submission PR opened!'}`));
      console.log(chalk.blue(`  PR: ${result.prUrl}`));
      console.log(chalk.gray(`  Branch: ${result.branch}`));
      console.log(chalk.gray('  A maintainer will review and merge it. The registry index updates on merge.'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\nCloud submission failed: ${msg}`));
      process.exit(1);
    }
    console.log(chalk.green('\nDone!'));
    return;
  }

  // Submit to marketplace via the user's own gh CLI if --submit flag is set
  if (options?.submit) {
    try {
      const result = await submitToGitHub(absPath, manifest);
      console.log(chalk.green(`\nPull request created successfully!`));
      console.log(chalk.blue(`  PR: ${result.prUrl}`));
      console.log(chalk.gray(`  Branch: ${result.branch}`));
      console.log(chalk.gray('  The registry index will be auto-generated on merge.'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`\nFailed to submit: ${msg}`));
      console.log(chalk.gray('\nYou can submit manually:'));
      console.log(chalk.gray(`  1. Fork: https://github.com/${MARKETPLACE_CONSTANTS.GITHUB_REPO}`));
      console.log(chalk.gray(`  2. Copy: cp -r ${absPath} config/skills/agent/marketplace/${manifest.id}`));
      console.log(chalk.gray(`  3. PR:   gh pr create --repo ${MARKETPLACE_CONSTANTS.GITHUB_REPO} --title "skill: add ${manifest.id}"`));
      process.exit(1);
    }
  }

  console.log(chalk.green('\nDone!'));
}
