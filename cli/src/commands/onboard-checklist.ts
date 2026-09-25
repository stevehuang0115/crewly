/**
 * `crewly onboard` steps after the harness (specs/onboarding-harness-login.md,
 * Phase 3): pick the first team, send it a first task, and point the owner at
 * Crewly Cloud and Slack.
 *
 * Mirrors the web setup page and uses the same backend pieces:
 * - starters are the templates marked `onboarding` (Personal Assistant is
 *   the default), plus Blank (the orchestrator only);
 * - the first task goes to `POST /api/onboarding/first-task` when this
 *   user's backend is running; otherwise it is kept in
 *   `<crewlyHome>/onboarding.json` and the backend hands it to the
 *   orchestrator when it starts;
 * - Cloud and Slack never block: the CLI prints links that work on a phone.
 *
 * @module cli/commands/onboard-checklist
 */

import chalk from 'chalk';
import { CLI_CONSTANTS } from '../constants.js';
import { ONBOARDING_CONSTANTS, HARNESS_CONSTANTS } from '../../../backend/src/constants.js';
import { OnboardingStateStore } from '../../../backend/src/services/onboarding/onboarding-state.store.js';
import { buildTokenPageSignInUrl } from '../../../backend/src/services/onboarding/onboarding-checklist.service.js';
import type { TeamTemplate } from '../utils/templates.js';
import { defaultHttpJson, isBackendRunning, localBackendUrl, type HttpJson } from '../utils/harness-engine.js';

/** Question asker (readline in the wizard). */
export type Ask = (question: string) => Promise<string>;

/** Output line writer. */
export type Log = (line: string) => void;

/** What the owner picked for the first team. */
export type StarterChoice = { kind: 'template'; template: TeamTemplate } | { kind: 'blank' };

/**
 * Step header, e.g. `Step 4/7: First team`.
 *
 * @param step - Step number
 * @param title - Step title
 * @returns Header text
 */
export function stepHeader(step: number, title: string): string {
	return chalk.bold(`  Step ${step}/${CLI_CONSTANTS.ONBOARD.TOTAL_STEPS}: ${title}`);
}

/**
 * Ask which starter team to create. Enter picks the recommended one
 * (the Personal Assistant).
 *
 * @param ask - Question asker
 * @param starters - Starter templates, in display order
 * @param log - Output
 * @returns The choice
 */
export async function chooseStarter(
	ask: Ask,
	starters: Array<TeamTemplate & { onboarding: NonNullable<TeamTemplate['onboarding']> }>,
	log: Log = (line) => console.log(line),
): Promise<StarterChoice> {
	log('  Choose your first team (you can add more later):\n');
	starters.forEach((t, i) => {
		const tag = t.onboarding.recommended ? chalk.green(' (recommended / 推荐)') : '';
		log(`    ${i + 1}. ${chalk.bold(`${t.onboarding.label} · ${t.name}`)}${tag}`);
		log(chalk.gray(`       ${t.onboarding.tagline}`));
		log(chalk.gray(`       Members: ${t.members.map((m) => m.name).join(', ')}\n`));
	});
	const blankIndex = starters.length + 1;
	const blank = ONBOARDING_CONSTANTS.BLANK_STARTER;
	log(`    ${blankIndex}. ${chalk.bold(`${blank.LABEL} · ${blank.NAME}`)}`);
	log(chalk.gray(`       ${blank.TAGLINE}\n`));

	const recommended = Math.max(0, starters.findIndex((t) => t.onboarding.recommended));
	const defaultChoice = starters.length > 0 ? recommended + 1 : blankIndex;
	for (;;) {
		const answer = (await ask(`  Enter choice (1-${blankIndex}) [${defaultChoice}]: `)).trim().toLowerCase();
		const num = answer === '' ? defaultChoice : Number.parseInt(answer, 10);
		if (num >= 1 && num <= starters.length) {
			log(chalk.green(`  ✓ Selected: ${starters[num - 1].name}\n`));
			return { kind: 'template', template: starters[num - 1] };
		}
		if (num === blankIndex || answer === 'blank') {
			log(chalk.green('  ✓ Blank: just the orchestrator for now\n'));
			return { kind: 'blank' };
		}
		log(chalk.yellow(`  Please enter 1-${blankIndex}.`));
	}
}

/**
 * Record that the owner chose Blank, which completes the checklist's team step.
 *
 * @param store - State store
 * @param now - Clock
 */
export async function recordBlankChoice(store: OnboardingStateStore = new OnboardingStateStore(), now: Date = new Date()): Promise<void> {
	await store.update((cur) => ({ blankChosenAt: cur.blankChosenAt ?? now.toISOString() }));
}

/**
 * Example first tasks for a starter (Blank has its own).
 *
 * @param template - The chosen template, or null for Blank
 * @returns Three suggestions
 */
export function starterSuggestions(template: TeamTemplate | null): string[] {
	return [...(template?.onboarding?.suggestions ?? ONBOARDING_CONSTANTS.BLANK_STARTER.SUGGESTIONS)];
}

/**
 * Ask for the first task ("派第一件事"). A number picks a suggestion, Enter skips.
 *
 * @param ask - Question asker
 * @param suggestions - Example tasks
 * @param log - Output
 * @returns The task text, or null when skipped
 */
export async function askFirstTask(ask: Ask, suggestions: readonly string[], log: Log = (line) => console.log(line)): Promise<string | null> {
	log('  What should your team do first? (派第一件事) For example:\n');
	suggestions.forEach((s, i) => log(`    ${i + 1}. ${s}`));
	log('');
	for (;;) {
		const answer = (await ask(`  Type a task, 1-${suggestions.length} for an example, or Enter to skip: `)).trim();
		if (answer === '') {
			log(chalk.gray('  Skipped. Send it any time from the dashboard or Slack.\n'));
			return null;
		}
		const num = /^\d+$/.test(answer) ? Number.parseInt(answer, 10) : NaN;
		if (Number.isFinite(num)) {
			if (num >= 1 && num <= suggestions.length) return suggestions[num - 1];
			log(chalk.yellow(`  Please enter 1-${suggestions.length}, a task, or Enter.`));
			continue;
		}
		if (answer.length > ONBOARDING_CONSTANTS.FIRST_TASK_MAX_LENGTH) {
			log(chalk.yellow(`  Keep it under ${ONBOARDING_CONSTANTS.FIRST_TASK_MAX_LENGTH} characters.`));
			continue;
		}
		return answer;
	}
}

/** How the first task was handled. */
export type FirstTaskOutcome =
	| { status: 'sent'; queued: boolean }
	| { status: 'pending' }
	| { status: 'failed'; message: string };

/** Dependencies of {@link deliverFirstTask} (tests). */
export interface FirstTaskDeps {
	isRunning?: () => Promise<boolean>;
	http?: HttpJson;
	baseUrl?: string;
	store?: OnboardingStateStore;
	now?: () => Date;
}

/**
 * Hand the first task to the orchestrator: through this user's running
 * backend, or kept for the backend to deliver when it starts.
 *
 * @param text - The owner's words
 * @param teamId - Team it is for, or null for the orchestrator itself
 * @param deps - Backend probe, HTTP client, state store (tests)
 * @returns What happened
 */
export async function deliverFirstTask(text: string, teamId: string | null, deps: FirstTaskDeps = {}): Promise<FirstTaskOutcome> {
	const isRunning = deps.isRunning ?? (() => isBackendRunning());
	if (await isRunning()) {
		const http = deps.http ?? defaultHttpJson;
		try {
			const { status, body } = await http('POST', `${deps.baseUrl ?? localBackendUrl()}${CLI_CONSTANTS.ONBOARD.FIRST_TASK_ENDPOINT}`, {
				text,
				...(teamId ? { teamId } : {}),
			});
			const data = body as { success?: boolean; error?: string; data?: { queued?: boolean } } | null;
			if (status < 300 && data?.success) return { status: 'sent', queued: data.data?.queued === true };
			return { status: 'failed', message: data?.error ?? `HTTP ${status}` };
		} catch (error) {
			return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
	}
	const store = deps.store ?? new OnboardingStateStore();
	const createdAt = (deps.now ?? (() => new Date()))().toISOString();
	await store.update(() => ({ pendingFirstTask: { text: text.trim(), teamId, createdAt } }));
	return { status: 'pending' };
}

/**
 * Print how the first task was handled.
 *
 * @param outcome - Delivery outcome
 * @param log - Output
 */
export function reportFirstTask(outcome: FirstTaskOutcome, log: Log = (line) => console.log(line)): void {
	if (outcome.status === 'sent') {
		log(chalk.green(outcome.queued ? '  ✓ Sent to the orchestrator; it picks it up as soon as it is running.\n' : '  ✓ Sent to the orchestrator.\n'));
	} else if (outcome.status === 'pending') {
		log(chalk.green('  ✓ Saved. The orchestrator gets it when Crewly starts.\n'));
	} else {
		log(chalk.yellow(`  ⚠ Could not send it: ${outcome.message}`));
		log(chalk.gray('    Send it from the dashboard (Setup → 派第一件事) or Slack instead.\n'));
	}
}

/** Links that finish Cloud and Slack from a phone. */
export interface ConnectLinks {
	/** Google sign-in on Crewly Cloud that ends on the portal's token page */
	cloudSignInUrl: string;
	/** This machine's setup page at the Cloud step (carries the API token) */
	cloudSetupUrl: string;
	/** This machine's setup page at the Slack step (carries the API token) */
	slackSetupUrl: string;
}

/**
 * Build the phone links for Cloud and Slack.
 *
 * @param host - Host the phone can reach (LAN address)
 * @param port - Backend port
 * @param apiToken - API token non-loopback callers need (consumed once by the web app)
 * @returns Links
 */
export function buildConnectLinks(host: string, port: number, apiToken: string | null): ConnectLinks {
	const setup = (step: string): string => {
		const params = new URLSearchParams({ [ONBOARDING_CONSTANTS.WEB_STEP_QUERY]: step });
		if (apiToken) params.set('token', apiToken);
		return `http://${host}:${port}${HARNESS_CONSTANTS.WEB_SETUP_PATH}?${params.toString()}`;
	};
	return {
		cloudSignInUrl: buildTokenPageSignInUrl(),
		cloudSetupUrl: setup(ONBOARDING_CONSTANTS.STEP_IDS.CLOUD),
		slackSetupUrl: setup(ONBOARDING_CONSTANTS.STEP_IDS.SLACK),
	};
}

/** Cloud / Slack state, when the backend could be asked. */
export interface ConnectState {
	cloud: boolean;
	slack: boolean;
}

/**
 * Read Cloud / Slack state from this user's running backend.
 *
 * @param deps - Backend probe and HTTP client (tests)
 * @returns The state, or null when the backend is not running or did not answer
 */
export async function readConnectState(deps: { isRunning?: () => Promise<boolean>; http?: HttpJson; baseUrl?: string } = {}): Promise<ConnectState | null> {
	const isRunning = deps.isRunning ?? (() => isBackendRunning());
	if (!(await isRunning())) return null;
	try {
		const { status, body } = await (deps.http ?? defaultHttpJson)('GET', `${deps.baseUrl ?? localBackendUrl()}${CLI_CONSTANTS.ONBOARD.CHECKLIST_ENDPOINT}`);
		const steps = (body as { data?: { steps?: Array<{ id: string; done: boolean }> } } | null)?.data?.steps;
		if (status !== 200 || !Array.isArray(steps)) return null;
		const done = (id: string): boolean => steps.some((s) => s.id === id && s.done);
		return { cloud: done(ONBOARDING_CONSTANTS.STEP_IDS.CLOUD), slack: done(ONBOARDING_CONSTANTS.STEP_IDS.SLACK) };
	} catch {
		return null;
	}
}

/**
 * Print the Cloud and Slack step: done marks when known, otherwise links
 * that work from a phone. Never waits for the owner.
 *
 * @param links - Phone links
 * @param state - Known state, or null
 * @param log - Output
 */
export function printConnectSteps(links: ConnectLinks, state: ConnectState | null, log: Log = (line) => console.log(line)): void {
	log(chalk.gray('  Optional, and all doable from your phone. Setup does not wait for them.\n'));
	if (state?.cloud) {
		log(chalk.green('  ✓ Crewly Cloud connected'));
	} else {
		log(`  ${chalk.bold('Crewly Cloud')} (remote access, backups, Slack):`);
		log(`    Open Setup → Cloud on your phone, scan or tap the link it shows, and approve:`);
		log(`       ${chalk.cyan(links.cloudSetupUrl)}`);
		log(chalk.gray('       (Or run `crewly cloud login` here — it prints a link to approve from your phone.)'));
		log(chalk.gray(`       Fallback: sign in and paste the tokens: ${links.cloudSignInUrl}`));
	}
	if (state?.slack) {
		log(chalk.green('  ✓ Slack connected\n'));
	} else {
		log(`  ${chalk.bold('Slack')} (talk to your team from Slack, after Cloud):`);
		log(`    ${chalk.cyan(links.slackSetupUrl)}\n`);
	}
}
