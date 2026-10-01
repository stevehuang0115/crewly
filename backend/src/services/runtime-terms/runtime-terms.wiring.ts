/**
 * Runtime Terms consent — the Antigravity CLI profile and the wiring with
 * the real decision cards, PTY sessions and smoke test.
 * specs/2026-10-01-runtime-terms-consent.md
 *
 * @module services/runtime-terms/runtime-terms.wiring
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS, RUNTIME_TERMS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { DecisionService } from '../decisions/decision.service.js';
import { driveAntigravityTerms, type TermsTerminal } from './antigravity-terms-driver.js';
import { parseAntigravityTermsScreen } from './antigravity-terms-screens.js';
import {
	RuntimeTermsConsentService,
	setRuntimeTermsConsentService,
	type RuntimeTermsProfile,
	type TermsCardText,
	type TermsSession,
} from './runtime-terms-consent.service.js';
import { RuntimeTermsStore } from './runtime-terms.store.js';

const A = RUNTIME_TERMS_CONSTANTS.ANTIGRAVITY;

/**
 * The card for Antigravity CLI's Terms.
 *
 * @param machine - This machine's name
 * @returns Title, question and body sections (English, Slack mrkdwn)
 */
export function antigravityTermsCard(machine: string): TermsCardText {
	return {
		title: `Antigravity CLI · Terms of Service (${machine})`,
		question: `Antigravity CLI on ${machine} needs Google's Terms of Service accepted once before it can run. Do you agree?`,
		body: [
			`*What you'd agree to:* Google's Antigravity CLI Terms of Service and the Google Privacy Policy. The screen also warns: ${A.SECURITY_NOTE}`,
			`*Links:* <${A.TERMS_URL}|Terms of Service> · <${A.PRIVACY_URL}|Privacy Policy>`,
			`*A separate item, pre-checked on the screen:*\n> ${A.DATA_ITEM_FULL}\n` +
				`*${RUNTIME_TERMS_CONSTANTS.OPTIONS.AGREE_NO_DATA}* unchecks it. *${RUNTIME_TERMS_CONSTANTS.OPTIONS.AGREE_SHARE_DATA}* leaves it checked. ` +
				`*${RUNTIME_TERMS_CONSTANTS.OPTIONS.DECLINE}* accepts nothing, and Crewly stops using Antigravity CLI on this machine.`,
		],
	};
}

/** Antigravity CLI's profile. */
export const ANTIGRAVITY_TERMS_PROFILE: RuntimeTermsProfile = {
	runtime: RUNTIME_TYPES.ANTIGRAVITY_CLI,
	label: 'Antigravity CLI',
	info: {
		summary: `Google's Antigravity CLI Terms of Service and the Google Privacy Policy. The screen also warns: ${A.SECURITY_NOTE}`,
		dataItem: A.DATA_ITEM_FULL,
		links: [
			{ label: 'Terms of Service', url: A.TERMS_URL },
			{ label: 'Privacy Policy', url: A.PRIVACY_URL },
		],
	},
	card: antigravityTermsCard,
	drive: (term: TermsTerminal, shareData: boolean) => driveAntigravityTerms(term, { shareData }),
	classify: (screen) => {
		const kind = parseAntigravityTermsScreen(screen).kind;
		if (kind === 'terms' || kind === 'color_scheme') return 'terms';
		if (kind === 'main_prompt' || kind === 'trust') return 'ready';
		if (kind === 'login') return 'blocked';
		return 'unknown';
	},
};

/**
 * Name of the harness's dedicated session for a runtime.
 *
 * @param runtime - Runtime id
 * @returns Session name
 */
export function termsSessionName(runtime: string): string {
	return `${RUNTIME_TERMS_CONSTANTS.SESSION_PREFIX}${runtime}`;
}

/**
 * Launch Antigravity CLI in a dedicated PTY session, the way agents' PTYs
 * are run: the session backend, the Gemini API key provider set first
 * (never an account login), the key in the spawn environment.
 *
 * @param crewlyHome - CREWLY_HOME (scratch folder for the session)
 * @returns The session
 */
async function launchAntigravity(crewlyHome: string): Promise<TermsSession> {
	const { getSessionBackend, createSessionCommandHelper } = await import('../session/index.js');
	const { AntigravityRuntimeService, resolveAntigravityApiKey } = await import('../agent/antigravity-runtime.service.js');
	const { getHarnessCredentialsStore } = await import('../harness/harness-credentials.store.js');
	const helper = createSessionCommandHelper(await getSessionBackend());
	const name = termsSessionName(RUNTIME_TYPES.ANTIGRAVITY_CLI);
	const workDir = path.join(crewlyHome, 'runtime-terms', RUNTIME_TYPES.ANTIGRAVITY_CLI);
	fs.mkdirSync(workDir, { recursive: true });

	// Same pre-launch guard as an agent: a key, the Gemini provider, the folder trusted.
	await new AntigravityRuntimeService(helper, workDir).prepareLaunch(workDir);
	const key = await resolveAntigravityApiKey();
	const env: Record<string, string> = {
		...getHarnessCredentialsStore().harnessEnvForAgents(process.env, RUNTIME_TYPES.ANTIGRAVITY_CLI),
		...(key ? { [ANTIGRAVITY_CONSTANTS.API_KEY_ENV]: key } : {}),
	};
	if (helper.sessionExists(name)) await helper.killSession(name);
	await helper.createSession(name, workDir, {
		command: '/bin/sh',
		args: ['-c', `exec ${ANTIGRAVITY_CONSTANTS.LAUNCH_COMMAND}`],
		env,
		cols: RUNTIME_TERMS_CONSTANTS.COLS,
		rows: RUNTIME_TERMS_CONSTANTS.ROWS,
	});
	return {
		terminal: {
			write: (data) => helper.writeRaw(name, data),
			capture: () => helper.capturePane(name, RUNTIME_TERMS_CONSTANTS.ROWS * 2),
		},
		close: async () => {
			if (!helper.sessionExists(name)) return;
			// Leave agy (Ctrl+C twice), then kill the session.
			await helper.sendCtrlC(name).catch(() => undefined);
			await helper.sendCtrlC(name).catch(() => undefined);
			await helper.killSession(name).catch(() => undefined);
		},
	};
}

/**
 * Kill a runtime's dedicated session if it is running.
 *
 * @param runtime - Runtime id
 */
async function closeTermsSession(runtime: string): Promise<void> {
	const { getSessionBackend } = await import('../session/index.js');
	const backend = await getSessionBackend();
	const name = termsSessionName(runtime);
	if (backend.sessionExists(name)) await backend.killSession(name);
}

/** What the composition root provides. */
export interface RuntimeTermsWiringInput {
	crewlyHome: string;
	decisions: DecisionService;
	machineName: () => string;
}

/**
 * Build the service, install it and subscribe it to decision cards.
 *
 * @param input - Composition-root hooks
 * @returns The service
 */
export function startRuntimeTerms(input: RuntimeTermsWiringInput): RuntimeTermsConsentService {
	const service = new RuntimeTermsConsentService({
		store: RuntimeTermsStore.inHome(input.crewlyHome),
		decisions: () => input.decisions,
		profiles: { [ANTIGRAVITY_TERMS_PROFILE.runtime]: ANTIGRAVITY_TERMS_PROFILE },
		launch: async (runtime) => {
			if (runtime !== RUNTIME_TYPES.ANTIGRAVITY_CLI) throw new Error(`No Terms flow for ${runtime}`);
			return launchAntigravity(input.crewlyHome);
		},
		closeSession: closeTermsSession,
		runSmokeTest: async (runtime) => {
			const { getRuntimeSmokeTestService } = await import('../../controllers/system/runtime-fallback.controller.js');
			return getRuntimeSmokeTestService().start(runtime).done;
		},
		machineName: input.machineName,
		onChange: () => {
			void import('../runtime-fallback/runtime-fallback.service.js').then((m) => m.getRuntimeFallbackService()?.invalidateAvailability()).catch(() => undefined);
		},
		logger: LoggerService.getInstance().createComponentLogger('RuntimeTerms'),
	});
	DecisionService.registerKindHandler('runtime_terms', service);
	setRuntimeTermsConsentService(service);
	return service;
}
