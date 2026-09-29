/**
 * CLI Security Command
 *
 * Usage:
 *   crewly security scrub-logs            # dry run: count secrets on disk
 *   crewly security scrub-logs --apply    # mask them in place
 *   crewly security scrub-logs --no-shell-history
 *
 * Masks API keys and tokens that older Crewly versions typed into agent
 * shells, wherever they were persisted: ~/.crewly/logs/sessions/*.log, the
 * gzipped rotations in ~/.crewly/logs/archive/, and ~/.bash_history /
 * ~/.zsh_history. Same redactor as the live session-log writer. Prints
 * counts only — never a secret value or a matched line. Idempotent: a second
 * run finds nothing.
 *
 * @module cli/commands/security
 */

import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import { scrubSecretsOnDisk, type ScrubSummary } from '../../../backend/src/services/security/secret-scrub.service.js';

/** Options accepted by `crewly security`. */
export interface SecurityOptions {
	/** Rewrite files (default: dry run) */
	apply?: boolean;
	/** commander sets shellHistory=false for --no-shell-history */
	shellHistory?: boolean;
}

/** Supported `crewly security` actions. */
const ACTIONS = ['scrub-logs'] as const;

/**
 * Shortens a path under the home directory to `~/…` for display.
 *
 * @param p - Absolute path
 * @returns Display path
 */
function displayPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * Renders a scrub summary as lines of text (counts only).
 *
 * @param summary - Scrub result
 * @returns Lines to print
 */
export function formatScrubSummary(summary: ScrubSummary): string[] {
	const lines: string[] = [];
	const verb = summary.applied ? 'masked' : 'found';
	for (const f of summary.files) {
		if (f.error) {
			lines.push(`  ${chalk.red('error')}  ${displayPath(f.path)} (${f.error})`);
		} else if (f.secrets > 0) {
			lines.push(`  ${String(f.secrets).padStart(5)} ${verb}  ${displayPath(f.path)}`);
		}
	}
	lines.push(
		`${summary.applied ? 'Applied' : 'Dry run'}: ${summary.filesScanned} file(s) scanned, ` +
			`${summary.secrets} secret(s) ${verb} in ${summary.filesWithSecrets} file(s)` +
			(summary.applied ? `, ${summary.filesRewritten} rewritten` : '') +
			(summary.errors ? `, ${summary.errors} error(s)` : '') +
			'.'
	);
	if (!summary.applied && summary.secrets > 0) {
		lines.push(chalk.yellow('Run again with --apply to mask them in place. Rotate any key that was exposed.'));
	}
	return lines;
}

/**
 * Entry point for `crewly security <action>`.
 *
 * @param action - Sub-command (scrub-logs)
 * @param options - Command options from Commander.js
 * @returns Process exit code (0 ok, 1 errors or bad action)
 */
export async function securityCommand(action: string, options: SecurityOptions = {}): Promise<number> {
	if (!(ACTIONS as readonly string[]).includes(action)) {
		console.error(chalk.red(`Unknown action "${action}". Use: ${ACTIONS.join(' | ')}`));
		return 1;
	}
	const summary = await scrubSecretsOnDisk({
		apply: options.apply === true,
		includeShellHistory: options.shellHistory !== false,
	});
	for (const line of formatScrubSummary(summary)) console.log(line);
	return summary.errors > 0 ? 1 : 0;
}
