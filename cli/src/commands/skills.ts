/**
 * `crewly skills setup <id> [--check]` — run (or check) a skill's setup block.
 *
 * Installs what the skill's `skill.json` → `setup` declares (system commands,
 * files such as models, Python packages) with the same idempotent runner the
 * backend uses for `install-skill` (specs/skill-auto-install.md). Works on
 * bundled skills and marketplace skills already installed on this machine,
 * without a running backend and without the network (except for what the
 * setup itself downloads). The person at the terminal is the owner, so there
 * is no trust gate here.
 *
 * @module cli/commands/skills
 */

import chalk from 'chalk';
import { SkillDiscoveryService, type ResolvedSkill } from '../../../backend/src/services/skill-setup/skill-discovery.service.js';
import {
	SkillSetupRunner,
	type SetupProgressEvent,
	type SetupResult,
	type StepStatus,
} from '../../../backend/src/services/skill-setup/skill-setup-runner.service.js';

/** Options for `crewly skills setup`. */
export interface SkillsSetupOptions {
	/** Only check; install nothing */
	check?: boolean;
}

/** Injectable dependencies (tests). */
export interface SkillsCommandDeps {
	discovery?: Pick<SkillDiscoveryService, 'resolveLocal'>;
	runner?: Pick<SkillSetupRunner, 'runSetup'>;
	log?: (line: string) => void;
}

/** Symbol + colour per final step status. */
const STATUS_STYLE: Record<StepStatus, (text: string) => string> = {
	satisfied: (t) => chalk.green(`  ✓ ${t}`),
	installed: (t) => chalk.green(`  ✓ ${t}`),
	missing: (t) => chalk.yellow(`  ✗ ${t}`),
	failed: (t) => chalk.red(`  ✗ ${t}`),
	skipped: (t) => chalk.gray(`  - ${t}`),
};

/**
 * Format one progress event as a terminal line (null = print nothing).
 *
 * @param event - Progress event
 * @returns Line or null
 */
export function formatProgress(event: SetupProgressEvent): string | null {
	if (event.stepId === 'setup') return event.phase === 'waiting' ? chalk.yellow(`  … ${event.message}`) : null;
	if (event.phase === 'checking') return null;
	if (event.phase === 'installing' || event.phase === 'downloading' || event.phase === 'waiting') {
		return chalk.blue(`  … ${event.stepId}: ${event.message}`);
	}
	const style = STATUS_STYLE[event.phase as StepStatus];
	return style ? style(`${event.stepId} — ${event.message}`) : null;
}

/**
 * Print a finished setup's summary.
 *
 * @param skill - The skill
 * @param result - Setup result
 * @param log - Line printer
 */
function printSummary(skill: ResolvedSkill, result: SetupResult, log: (line: string) => void): void {
	log('');
	if (result.success) {
		log(chalk.green(result.checkOnly ? `${skill.id}: everything is installed.` : `${skill.id} is set up (${Math.round(result.durationMs / 1000)}s).`));
	} else if (result.checkOnly) {
		const missing = result.steps.filter((s) => s.status === 'missing' && !s.optional).map((s) => s.id);
		log(chalk.yellow(`${skill.id}: missing ${missing.join(', ')}. Run: crewly skills setup ${skill.id}`));
	} else {
		log(chalk.red(`${skill.id} setup failed: ${result.error ?? 'unknown error'}`));
	}
	if (result.logFile) log(chalk.gray(`Log: ${result.logFile}`));
}

/**
 * Run or check the setup of one skill on this machine.
 *
 * @param id - Skill id (or directory name)
 * @param options - `--check` for a dry check
 * @param deps - Injectable dependencies
 * @returns Exit code: 0 ok, 1 failed/missing, 2 unknown skill
 *
 * @example
 * ```ts
 * process.exitCode = await skillsSetupCommand('transcribe-audio', { check: true });
 * ```
 */
export async function skillsSetupCommand(id: string, options: SkillsSetupOptions = {}, deps: SkillsCommandDeps = {}): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const discovery = deps.discovery ?? new SkillDiscoveryService();
	const runner = deps.runner ?? new SkillSetupRunner();

	const skill = await discovery.resolveLocal(id);
	if (!skill) {
		log(chalk.red(`Skill "${id}" is not on this machine.`));
		log(chalk.gray(`Install it first: crewly install ${id}   (or search: crewly search ${id})`));
		return 2;
	}
	if (skill.manifestError) {
		log(chalk.red(`${skill.id} has an invalid setup block: ${skill.manifestError}`));
		return 1;
	}
	if (!skill.manifest) {
		log(chalk.green(`${skill.id} declares no setup — nothing to install.`));
		return 0;
	}

	const where = skill.source === 'bundled' ? 'bundled with Crewly' : skill.skillDir;
	log(chalk.blue(`${options.check ? 'Checking' : 'Setting up'} ${skill.id} (${where})…`));
	const result = await runner.runSetup({
		skillId: skill.id,
		skillDir: skill.skillDir ?? '',
		manifest: skill.manifest,
		checkOnly: options.check === true,
		onProgress: (event) => {
			const line = formatProgress(event);
			if (line) log(line);
		},
	});
	printSummary(skill, result, log);
	return result.success ? 0 : 1;
}

/**
 * `crewly skills <action> [id]` dispatcher.
 *
 * @param action - `setup` (with `--check` to only check) or `check`
 * @param id - Skill id
 * @param options - Command options
 * @param deps - Injectable dependencies
 * @returns Exit code
 */
export async function skillsCommand(action: string, id: string | undefined, options: SkillsSetupOptions = {}, deps: SkillsCommandDeps = {}): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	if (action !== 'setup' && action !== 'check') {
		log(chalk.red(`Unknown action "${action}". Use: crewly skills setup <id> [--check]`));
		return 2;
	}
	if (!id) {
		log(chalk.red('Please give a skill id, e.g. crewly skills setup transcribe-audio'));
		return 2;
	}
	return skillsSetupCommand(id, { check: action === 'check' || options.check === true }, deps);
}
