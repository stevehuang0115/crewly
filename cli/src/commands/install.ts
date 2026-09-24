/**
 * CLI Install Command
 *
 * Installs skills from the Crewly marketplace. Supports installing a single
 * skill by ID or all agent skills with the --all flag.
 *
 * @module cli/commands/install
 */

import chalk from 'chalk';
import {
  fetchRegistry,
  downloadAndInstall,
  formatBytes,
  type MarketplaceItem,
} from '../utils/marketplace.js';

interface InstallOptions {
  all?: boolean;
}

/**
 * Installs a skill (or all skills) from the Crewly marketplace.
 *
 * When invoked with an ID, downloads and installs a single marketplace item.
 * When invoked with --all, installs all skills from the registry.
 *
 * @param id - Optional marketplace item ID to install
 * @param options - Command options (--all)
 */
export async function installCommand(id?: string, options?: InstallOptions): Promise<void> {
  if (!id && !options?.all) {
    console.log(chalk.red('Please specify a skill ID or use --all to install all skills.'));
    console.log(chalk.gray('Example: crewly install skill-nano-banana'));
    console.log(chalk.gray('         crewly install --all'));
    process.exit(1);
  }

  try {
    console.log(chalk.blue('Fetching marketplace registry...'));
    const registry = await fetchRegistry();
    console.log(chalk.green('  ✓ Fetched marketplace registry'));

    if (options?.all) {
      await installAll(registry.items);
    } else if (id) {
      await installSingle(id, registry.items);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Installation failed: ${msg}`));
    process.exit(1);
  }
}

/**
 * Installs all skill items from the registry.
 *
 * @param items - All registry items
 */
async function installAll(items: MarketplaceItem[]): Promise<void> {
  const skills = items.filter((i) => i.type === 'skill');
  if (skills.length === 0) {
    console.log(chalk.yellow('No skills found in the marketplace.'));
    return;
  }

  console.log(chalk.blue(`\nInstalling ${skills.length} agent skills...`));

  let installed = 0;
  let failed = 0;

  for (const skill of skills) {
    try {
      const result = await downloadAndInstall(skill);
      if (result.success) {
        const size = skill.assets.sizeBytes ? ` (${formatBytes(skill.assets.sizeBytes)})` : '';
        console.log(chalk.green(`  ✓ ${skill.name} v${skill.version}${size}`));
        installed++;
      } else {
        console.log(chalk.red(`  ✗ ${skill.name}: ${result.message}`));
        failed++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  ✗ ${skill.name}: ${msg}`));
      failed++;
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(chalk.green(`Done! ${installed} skills installed.`));
  } else {
    console.log(chalk.yellow(`Done! ${installed} installed, ${failed} failed.`));
    // Scripts and CI must see the failure, not a clean exit.
    process.exitCode = 1;
  }
}

/**
 * Installs a single item by its ID.
 *
 * @param id - The marketplace item ID
 * @param items - All registry items
 */
async function installSingle(id: string, items: MarketplaceItem[]): Promise<void> {
  const item = items.find((i) => i.id === id);
  if (!item) {
    console.log(chalk.red(`Item "${id}" not found in the marketplace.`));
    console.log(chalk.gray('Run `crewly search` to see available items.'));
    process.exit(1);
  }

  const size = item.assets.sizeBytes ? ` (${formatBytes(item.assets.sizeBytes)})` : '';
  console.log(chalk.blue(`\nDownloading ${item.name} v${item.version}${size}...`));

  const result = await downloadAndInstall(item);
  if (result.success) {
    if (item.assets.checksum) {
      console.log(chalk.green('  ✓ Verified checksum'));
    }
    console.log(chalk.green(`  ✓ ${result.message}`));
    console.log(chalk.green('\nDone!'));
  } else {
    console.log(chalk.red(`  ✗ ${result.message}`));
    process.exit(1);
  }
}
