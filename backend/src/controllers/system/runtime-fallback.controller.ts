/**
 * Runtime fallback + runtime smoke test endpoints.
 *
 * - `GET  /api/system/runtime-fallback` — settings, runtime availability,
 *   exhausted runtimes and active overrides
 * - `PUT  /api/system/runtime-fallback/settings` — partial settings update
 * - `POST /api/system/runtime-smoke-test { runtime }` — start a smoke test
 *   (`?wait=1` waits for the result, ≤ 5 min)
 * - `GET  /api/system/runtime-smoke-test/:jobId` — a smoke test job
 * - `POST /api/system/runtime-fallback/claude-accounts { name }` — add one of
 *   the owner's other Claude Code accounts and send its sign-in link to the
 *   owner's Slack DM (also: `…/claude-accounts/:name/login` to sign in again)
 * - `DELETE /api/system/runtime-fallback/claude-accounts/:name` — remove it
 *   (its login, its config dir, and its entries in the fallback orders)
 *
 * The snapshot routes also return `claudeAccounts` (issue #942).
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module controllers/system/runtime-fallback.controller
 */

import type { Request, Response, Router } from 'express';
import { RUNTIME_FALLBACK_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import {
	ClaudeAccountNameError,
	describeClaudeAccounts,
	ensureClaudeAccountDir,
	removeClaudeAccount,
	requireClaudeAccountName,
	runtimeTarget,
	type ClaudeAccountInfo,
} from '../../services/harness/claude-accounts.js';
import { getHarnessReloginService, type OwnerLoginOptions, type OwnerLoginResult } from '../../services/harness/harness-relogin.service.js';
import type { HarnessId } from '../../services/harness/harness.types.js';
import { getApiToken } from '../../services/core/api-token.service.js';
import { ensureOwnerCaller } from './system-control.controller.js';
import { getRuntimeFallbackService, type RuntimeFallbackService } from '../../services/runtime-fallback/runtime-fallback.service.js';
import { RuntimeFallbackSettingsError, type RuntimeFallbackSettings } from '../../services/runtime-fallback/runtime-fallback.types.js';
import { LocalSmokeApi, RuntimeSmokeTestService } from '../../services/runtime-fallback/runtime-smoke-test.service.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';
import {
	getRuntimeTermsConsentService,
	reportRuntimeTermsScreen,
	type RuntimeTermsConsentService,
} from '../../services/runtime-terms/runtime-terms-consent.service.js';

/** The owner's other Claude Code accounts (issue #942). */
export interface ClaudeAccountsDeps {
	list: () => ClaudeAccountInfo[];
	/** Create the account's config dir */
	ensure: (name: string) => void;
	remove: (name: string) => void;
	/** Start the phone sign-in for an account (the re-login coordinator) */
	startLogin: (harnessId: HarnessId, options: OwnerLoginOptions) => OwnerLoginResult;
}

/** Dependencies (tests inject fakes). */
export interface RuntimeFallbackControllerDeps {
	fallback: () =>
		| (Pick<RuntimeFallbackService, 'snapshot' | 'updateSettings'> & Partial<Pick<RuntimeFallbackService, 'getSettings' | 'invalidateAvailability'>>)
		| null;
	/** Claude Code accounts (absent in tests that do not need them) */
	accounts?: () => ClaudeAccountsDeps;
	smoke: () => Pick<RuntimeSmokeTestService, 'start' | 'get'>;
	/** Runtime Terms consent (absent in tests that do not need it) */
	terms?: () => Pick<RuntimeTermsConsentService, 'reportTermsScreen' | 'supports' | 'blockedReason'> | null;
}

let smokeService: RuntimeSmokeTestService | null = null;

/**
 * The backend's smoke test service (one per process, shared with the
 * runtime Terms consent flow).
 *
 * @returns The service
 */
export function getRuntimeSmokeTestService(): RuntimeSmokeTestService {
	smokeService ??= new RuntimeSmokeTestService({
		api: new LocalSmokeApi(getLocalApiBaseUrl, getApiToken),
		crewlyAgentModel: () => getRuntimeFallbackService()?.getSettings().crewlyAgentModel ?? RUNTIME_FALLBACK_CONSTANTS.DEFAULT_CREWLY_AGENT_MODEL,
		// A Terms screen asks the owner with a Slack card (specs/2026-10-01-runtime-terms-consent.md).
		onTermsScreen: (runtime, report) => reportRuntimeTermsScreen(runtime, { source: 'smoke_test', ownerInitiated: report.ownerInitiated }),
	});
	return smokeService;
}

/** Default dependencies: the backend's services. */
function defaultDeps(): RuntimeFallbackControllerDeps {
	return {
		fallback: () => getRuntimeFallbackService(),
		smoke: getRuntimeSmokeTestService,
		terms: getRuntimeTermsConsentService,
		accounts: () => ({
			list: () => describeClaudeAccounts(),
			ensure: (name) => void ensureClaudeAccountDir(name),
			remove: (name) => removeClaudeAccount(name),
			startLogin: (harnessId, options) => getHarnessReloginService().startOwnerLogin(harnessId, options),
		}),
	};
}

/**
 * The snapshot plus the owner's other Claude Code accounts.
 *
 * @param fallback - The service
 * @param deps - Dependencies
 * @returns Snapshot with `claudeAccounts`
 */
async function fullSnapshot(
	fallback: Pick<RuntimeFallbackService, 'snapshot'>,
	deps: RuntimeFallbackControllerDeps,
): Promise<Awaited<ReturnType<RuntimeFallbackService['snapshot']>> & { claudeAccounts: Array<Omit<ClaudeAccountInfo, 'configDir'>> }> {
	let claudeAccounts: Array<Omit<ClaudeAccountInfo, 'configDir'>> = [];
	try {
		claudeAccounts = (deps.accounts?.().list() ?? []).map(({ name, target, signedIn }) => ({ name, target, signedIn }));
	} catch {
		claudeAccounts = [];
	}
	return { ...(await fallback.snapshot()), claudeAccounts };
}

/**
 * A runtime the owner re-added to a fallback order after "Don't agree" (or
 * a failed setup): ask about its Terms again.
 *
 * @param deps - Dependencies
 * @param before - Settings before the update
 * @param after - Settings after it
 */
function askAgainForReAdded(deps: RuntimeFallbackControllerDeps, before: RuntimeFallbackSettings, after: RuntimeFallbackSettings): void {
	const terms = deps.terms?.();
	if (!terms) return;
	const had = new Set([...before.chain, ...Object.values(before.memberChains).flat()]);
	const now = new Set([...after.chain, ...Object.values(after.memberChains).flat()]);
	for (const runtime of now) {
		if (had.has(runtime) || !terms.supports(runtime) || !terms.blockedReason(runtime)) continue;
		void terms.reportTermsScreen(runtime, { source: 'chain', ownerInitiated: true }).catch(() => undefined);
	}
}

/**
 * Register the routes.
 *
 * @param router - The /api router
 * @param deps - Dependencies (default: the backend's)
 */
export function registerRuntimeFallbackRoutes(router: Router, deps: RuntimeFallbackControllerDeps = defaultDeps()): void {
	router.get('/system/runtime-fallback', async (_req: Request, res: Response) => {
		const fallback = deps.fallback();
		if (!fallback) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		try {
			res.json({ success: true, data: await fullSnapshot(fallback, deps) });
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.put('/system/runtime-fallback/settings', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'PUT /system/runtime-fallback/settings')) return;
		const fallback = deps.fallback();
		if (!fallback) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		try {
			const before = fallback.getSettings?.();
			const after = fallback.updateSettings(req.body);
			if (before && after) askAgainForReAdded(deps, before, after);
			res.json({ success: true, data: await fullSnapshot(fallback, deps) });
		} catch (err) {
			if (err instanceof RuntimeFallbackSettingsError) {
				res.status(400).json({ success: false, error: err.message });
				return;
			}
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	/**
	 * Start the phone sign-in of an account and answer with the snapshot.
	 *
	 * @param res - Response
	 * @param name - Account name (valid)
	 * @param status - HTTP status on success
	 */
	const signInAccount = async (res: Response, name: string, status: number): Promise<void> => {
		const fallback = deps.fallback();
		const accounts = deps.accounts?.();
		if (!fallback || !accounts) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		try {
			accounts.ensure(name);
			fallback.invalidateAvailability?.();
			const login = accounts.startLogin(RUNTIME_TYPES.CLAUDE_CODE as HarnessId, { account: name, requestedBy: 'dashboard' });
			const dmAvailable = login.status !== 'no_broker_login' && login.dmAvailable;
			res.status(status).json({
				success: true,
				data: {
					...(await fullSnapshot(fallback, deps)),
					login: {
						account: name,
						target: runtimeTarget(RUNTIME_TYPES.CLAUDE_CODE, name),
						status: login.status,
						dmAvailable,
						next: dmAvailable
							? 'The sign-in link is in your Slack DM. Open it on your phone and reply with the code.'
							: 'Slack is not connected, so the sign-in link cannot reach you. Connect Slack, then sign the account in again.',
					},
				},
			});
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	};

	router.post('/system/runtime-fallback/claude-accounts', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'POST /system/runtime-fallback/claude-accounts')) return;
		let name: string;
		try {
			name = requireClaudeAccountName(req.body?.name);
		} catch (err) {
			res.status(400).json({ success: false, error: err instanceof ClaudeAccountNameError ? err.message : String(err) });
			return;
		}
		await signInAccount(res, name, 201);
	});

	router.post('/system/runtime-fallback/claude-accounts/:name/login', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'POST /system/runtime-fallback/claude-accounts/:name/login')) return;
		let name: string;
		try {
			name = requireClaudeAccountName(req.params.name);
		} catch (err) {
			res.status(400).json({ success: false, error: err instanceof ClaudeAccountNameError ? err.message : String(err) });
			return;
		}
		if (!(deps.accounts?.().list() ?? []).some((a) => a.name === name)) {
			res.status(404).json({ success: false, error: `No Claude Code account "${name}"` });
			return;
		}
		await signInAccount(res, name, 202);
	});

	router.delete('/system/runtime-fallback/claude-accounts/:name', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'DELETE /system/runtime-fallback/claude-accounts/:name')) return;
		const fallback = deps.fallback();
		const accounts = deps.accounts?.();
		if (!fallback || !accounts) {
			res.status(503).json({ success: false, error: 'Runtime fallback is not ready yet — Crewly is still starting.' });
			return;
		}
		let name: string;
		try {
			name = requireClaudeAccountName(req.params.name);
		} catch (err) {
			res.status(400).json({ success: false, error: err instanceof ClaudeAccountNameError ? err.message : String(err) });
			return;
		}
		try {
			const target = runtimeTarget(RUNTIME_TYPES.CLAUDE_CODE, name);
			const on = (await fallback.snapshot()).overrides.filter((o) => o.runtime === target);
			if (on.length > 0) {
				res.status(409).json({
					success: false,
					error: `${on.length} agent${on.length === 1 ? ' runs' : 's run'} on this account right now (${on.map((o) => o.sessionName).join(', ')}). Remove it once they have switched back.`,
				});
				return;
			}
			// Out of every fallback order first, so no agent is moved onto it meanwhile.
			const settings = fallback.getSettings?.();
			if (settings) {
				const memberChains: Record<string, string[] | null> = {};
				for (const [memberId, chain] of Object.entries(settings.memberChains)) {
					const next = chain.filter((r) => r !== target);
					memberChains[memberId] = next.length > 0 ? next : null;
				}
				fallback.updateSettings({ chain: settings.chain.filter((r) => r !== target), memberChains });
			}
			accounts.remove(name);
			fallback.invalidateAvailability?.();
			res.json({ success: true, data: await fullSnapshot(fallback, deps) });
		} catch (err) {
			res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.post('/system/runtime-smoke-test', async (req: Request, res: Response) => {
		if (!ensureOwnerCaller(req, res, 'POST /system/runtime-smoke-test')) return;
		const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime : '';
		let started: ReturnType<RuntimeSmokeTestService['start']>;
		try {
			// The owner pressed Test: a Terms screen asks again even after "Don't agree".
			started = deps.smoke().start(runtime, { ownerInitiated: true });
		} catch (err) {
			res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const wait = req.query.wait === '1' || req.query.wait === 'true';
		if (!wait) {
			res.status(202).json({ success: true, data: started.job });
			return;
		}
		const result = await started.done;
		res.json({ success: true, data: { ...started.job, state: 'done', result } });
	});

	router.get('/system/runtime-smoke-test/:jobId', (req: Request, res: Response) => {
		const job = deps.smoke().get(req.params.jobId);
		if (!job) {
			res.status(404).json({ success: false, error: 'No such smoke test' });
			return;
		}
		res.json({ success: true, data: job });
	});
}
