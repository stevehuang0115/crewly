/**
 * GitHub CLI Submit Utility
 *
 * Automates skill submission to the Crewly marketplace via GitHub CLI (gh).
 * Handles forking, branching, copying files, and creating PRs without
 * requiring users to clone the entire repository.
 *
 * @module cli/utils/gh-submit
 */

import { execSync } from 'child_process';
import path from 'path';
import { readdirSync } from 'fs';
import os from 'os';
import chalk from 'chalk';
import { MARKETPLACE_CONSTANTS } from '../../../config/constants.js';
import type { SkillManifest } from './package-validator.js';

/** Result of a successful GitHub submission */
export interface GhSubmitResult {
  /** URL of the created pull request */
  prUrl: string;
  /** Branch name used for the submission */
  branch: string;
  /** GitHub username of the submitter */
  username: string;
}

/** Branch prefix for skill submission PRs */
const SKILL_BRANCH_PREFIX = 'skill/';

/** Target directory in the repo for marketplace skills */
const SKILL_TARGET_DIR = 'config/skills/agent/marketplace';

/**
 * Lists the regular files directly inside a skill directory, sorted, for the
 * PR body. Reads the directory rather than assuming a layout, so SKILL.md and
 * legacy skill.json packages both list what is actually submitted.
 *
 * @param skillPath - Absolute skill directory
 * @returns File names
 */
export function listTopLevelFiles(skillPath: string): string[] {
  return readdirSync(skillPath, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * Execute a shell command and return trimmed stdout.
 * Throws on non-zero exit with stderr as message.
 *
 * @param cmd - Shell command to execute
 * @param options - Optional execSync options
 * @returns Trimmed stdout string
 */
function exec(cmd: string, options?: { cwd?: string }): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/**
 * Check that gh CLI is installed and authenticated.
 * Throws descriptive errors if prerequisites are not met.
 */
export function checkGhPrerequisites(): void {
  try {
    exec('gh --version');
  } catch {
    throw new Error(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ and run "gh auth login".'
    );
  }

  try {
    exec('gh auth status');
  } catch {
    throw new Error(
      'GitHub CLI is not authenticated. Run "gh auth login" to authenticate.'
    );
  }
}

/**
 * Get the authenticated GitHub username.
 *
 * @returns GitHub username
 */
export function getGhUsername(): string {
  return exec('gh api user -q .login');
}

/**
 * Submit a skill to the Crewly marketplace by creating a PR via gh CLI.
 *
 * Flow:
 * 1. Verify gh CLI is installed and authenticated
 * 2. Fork the upstream repo (idempotent — no-op if already forked)
 * 3. Clone the fork to a temp directory (shallow, single-branch)
 * 4. Create a branch, copy skill files, commit, push
 * 5. Create a PR against the upstream repo
 *
 * @param skillPath - Absolute path to the local skill directory
 * @param manifest - Validated manifest (validatePackage().manifest; SKILL.md or skill.json)
 * @returns Result with PR URL, branch name, and username
 */
export async function submitToGitHub(
  skillPath: string,
  manifest: SkillManifest,
): Promise<GhSubmitResult> {
  const repo = MARKETPLACE_CONSTANTS.GITHUB_REPO;
  const skillId = manifest.id;
  const branch = `${SKILL_BRANCH_PREFIX}${skillId}`;
  // Read before any side effect (fork, clone, push), so an unreadable skill
  // directory fails the submission up front
  const skillFiles = listTopLevelFiles(skillPath);

  // Step 1: Check prerequisites
  console.log(chalk.blue('\nChecking GitHub CLI prerequisites...'));
  checkGhPrerequisites();
  const username = getGhUsername();
  console.log(chalk.green(`  ✓ Authenticated as ${username}`));

  // Step 2: Fork the repo (idempotent)
  console.log(chalk.blue('Forking repository...'));
  try {
    exec(`gh repo fork ${repo} --clone=false`);
    console.log(chalk.green(`  ✓ Fork ready: ${username}/${repo.split('/')[1]}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "already exists" is expected if previously forked
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to fork repository: ${msg}`);
    }
    console.log(chalk.green(`  ✓ Fork already exists`));
  }

  // Step 3: Clone fork to temp directory (shallow)
  const tmpDir = path.join(os.tmpdir(), `crewly-submit-${skillId}-${Date.now()}`);
  const repoName = repo.split('/')[1];
  console.log(chalk.blue('Cloning fork (shallow)...'));
  exec(`gh repo clone ${username}/${repoName} ${tmpDir} -- --depth=1`);
  console.log(chalk.green(`  ✓ Cloned to ${tmpDir}`));

  try {
    // Step 4: Add upstream remote and create branch from upstream/main
    console.log(chalk.blue(`Creating branch: ${branch}...`));
    exec(`git remote add upstream https://github.com/${repo}.git`, { cwd: tmpDir });
    exec(`git fetch upstream main --depth=1`, { cwd: tmpDir });
    exec(`git checkout -b ${branch} upstream/main`, { cwd: tmpDir });
    console.log(chalk.green(`  ✓ Branch created from upstream/main`));

    // Step 5: Copy skill files
    const targetDir = path.join(tmpDir, SKILL_TARGET_DIR, skillId);
    exec(`mkdir -p ${targetDir}`);
    exec(`cp -r ${skillPath}/* ${targetDir}/`);
    console.log(chalk.green(`  ✓ Skill files copied to ${SKILL_TARGET_DIR}/${skillId}/`));

    // Step 6: Commit
    exec(`git add ${SKILL_TARGET_DIR}/${skillId}`, { cwd: tmpDir });
    const commitMsg = `skill: add ${skillId} v${manifest.version}`;
    exec(`git commit -m "${commitMsg}"`, { cwd: tmpDir });
    console.log(chalk.green(`  ✓ Committed: ${commitMsg}`));

    // Step 7: Push to fork
    console.log(chalk.blue('Pushing to fork...'));
    exec(`git push origin ${branch} --force`, { cwd: tmpDir });
    console.log(chalk.green(`  ✓ Pushed to ${username}/${repoName}:${branch}`));

    // Step 8: Create PR
    console.log(chalk.blue('Creating pull request...'));
    const prTitle = `skill: add ${skillId}`;
    const prBody = [
      `## New Skill: ${manifest.name}`,
      '',
      `**ID:** \`${skillId}\``,
      `**Version:** ${manifest.version}`,
      `**Category:** ${manifest.category}`,
      `**Description:** ${manifest.description}`,
      '',
      `### Files`,
      ...skillFiles.map((f) => `- \`${SKILL_TARGET_DIR}/${skillId}/${f}\``),
      '',
      '_Submitted via `crewly publish --submit`_',
    ].join('\n');

    // Write PR body to a temp file to avoid shell escaping issues
    const prBodyFile = path.join(os.tmpdir(), `crewly-pr-body-${Date.now()}.md`);
    const { writeFileSync, unlinkSync } = await import('fs');
    writeFileSync(prBodyFile, prBody);

    let prUrl: string;
    try {
      prUrl = exec(
        `gh pr create --repo ${repo} --head ${username}:${branch} --title "${prTitle}" --body-file "${prBodyFile}"`,
        { cwd: tmpDir },
      );
    } finally {
      try { unlinkSync(prBodyFile); } catch { /* ignore */ }
    }

    console.log(chalk.green(`  ✓ Pull request created: ${prUrl}`));

    return { prUrl, branch, username };
  } finally {
    // Clean up temp directory
    try {
      exec(`rm -rf ${tmpDir}`);
    } catch { /* ignore cleanup errors */ }
  }
}
