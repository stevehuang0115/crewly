#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { upgradeCommand } from './commands/upgrade.js';
import { installCommand } from './commands/install.js';
import { searchCommand } from './commands/search.js';
import { onboardCommand } from './commands/onboard.js';
import { mcpServerCommand } from './commands/mcp-server.js';
import { publishCommand } from './commands/publish.js';
import { seedMarketplaceCommand } from './commands/seed-marketplace.js';
import { serviceCommand } from './commands/service.js';
import { pairCommand } from './commands/pair.js';
import { DEFAULT_WEB_PORT } from './constants.js';
import { getLocalVersion } from './utils/version-check.js';

const program = new Command();

let cliVersion = '1.0.0';
try {
  cliVersion = getLocalVersion();
} catch {
  // Fallback to hardcoded version if package.json lookup fails
}

program
  .name('crewly')
  .description('Crewly - Orchestrate multiple Claude Code instances as AI development teams')
  .version(cliVersion);

program
  .command('start')
  .description('Start Crewly backend and open dashboard')
  .option('-p, --port <port>', 'Web server port', DEFAULT_WEB_PORT.toString())
  .option('--no-browser', 'Don\'t open browser automatically')
  .option('--headless', 'Start in headless/API-only mode (no frontend, no browser)')
  .option('--auto-upgrade', 'Automatically upgrade before starting if a new version is available')
  .action(startCommand);

program
  .command('stop')
  .description('Stop all Crewly services and sessions')
  .option('--force', 'Force kill all processes')
  .action(stopCommand);

program
  .command('status')
  .description('Show status of running Crewly services')
  .option('--verbose', 'Show detailed information')
  .action(statusCommand);

program
  .command('logs')
  .description('View aggregated logs from all services')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(logsCommand);

program
  .command('upgrade')
  .description('Upgrade Crewly to the latest version')
  .option('--check', 'Check for updates without installing')
  .option('--pro', 'Install the Pro addon')
  .option('--token <token>', 'Cloud API token for downloading Pro addon')
  .option('--source <path>', 'Local path to a .tar.gz addon file')
  .action(upgradeCommand);

program
  .command('install [id]')
  .description('Install a skill from the Crewly marketplace')
  .option('--all', 'Install all agent skills')
  .action(installCommand);

program
  .command('search [query]')
  .description('Search the Crewly skill marketplace')
  .option('--type <type>', 'Filter by type (skill, model, role)')
  .action(searchCommand);

program
  .command('init')
  .alias('onboard')
  .description('Interactive setup wizard for new Crewly users')
  .option('-y, --yes', 'Non-interactive mode: use all defaults (CI-friendly)')
  .option('--template <id>', 'Select a team template by ID (e.g. web-dev-team)')
  .action(onboardCommand);

program
  .command('mcp-server')
  .description('Start Crewly MCP server (for Claude Code, Cursor, etc. integration)')
  .action(mcpServerCommand);

program
  .command('publish <path>')
  .description('Validate and package a skill for the Crewly marketplace')
  .option('--dry-run', 'Validate only, do not create archive')
  .option('-o, --output <dir>', 'Output directory for the archive')
  .option('--submit', 'Submit the skill to the marketplace for review')
  .option('--url <url>', 'Backend URL for submission (default: http://localhost:3000)')
  .action(publishCommand);

program
  .command('seed-marketplace')
  .description('Publish built-in skills to the local marketplace registry')
  .option('--dry-run', 'Validate only, do not publish')
  .option('--skills-dir <dir>', 'Skills directory to package from')
  .action(seedMarketplaceCommand);

program
  .command('service <action>')
  .description('Manage Crewly background service (install|uninstall|status|restart|stop|logs)')
  .option('--force', 'Overwrite existing installation')
  .option('--session <name>', 'Tail a specific agent session log (logs action)')
  .option('--app', 'Tail today\'s app log (logs action)')
  .option('-n, --lines <number>', 'Number of log lines to show (default: 50)')
  .option('-f, --follow', 'Follow log output in real-time (logs action)')
  .action(serviceCommand);

program
  .command('pair')
  .description('Pair two Crewly instances via Cloud Relay for remote collaboration')
  .option('--cloud', 'Use Cloud Relay for pairing')
  .option('--code <code>', 'Join an existing pairing session with this code')
  .option('--role <role>', 'Node role: orchestrator or agent')
  .option('--secret <secret>', 'Shared secret for E2EE (prompted if omitted)')
  .option('--disconnect', 'Disconnect from active relay session')
  .option('--devices', 'List paired devices')
  .action(pairCommand);

// Error handling
program.exitOverride();

try {
  program.parse();
} catch (err) {
  console.error(chalk.red('Error:'), err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
}
