/**
 * Owner consent for a runtime's first-run Terms of Service.
 *
 * The harness never accepts third-party terms on its own. When a runtime's
 * Terms screen is seen (on launch, by the smoke test, or on a probe), ONE
 * decision card per runtime per machine goes to the owner's DM with this
 * machine's orc bot: "Agree, no data sharing" / "Agree + share data" /
 * "Don't agree", 24 h, default Don't agree. On the answer:
 *
 * - agree: launch the runtime in a dedicated PTY session, drive its setup
 *   screens to the choice (data box verified on screen before Done), check
 *   the prompt appears, close the session, run the runtime smoke test and
 *   report both in the card's thread;
 * - don't agree (or no answer): mark the runtime "terms not accepted" so the
 *   fallback order skips it (reason shown in Settings → Runtimes); asked
 *   again only when the owner presses Test, re-adds it, or Accept terms….
 *
 * specs/2026-10-01-runtime-terms-consent.md
 *
 * @module services/runtime-terms/runtime-terms-consent.service
 */

import { RUNTIME_TERMS_CONSTANTS } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import { PENDING_DECISION_STATUSES } from '../decisions/decision-store.js';
import { redactSecrets } from '../harness/login-rules.js';
import type { SmokeTestResult } from '../runtime-fallback/runtime-smoke-test.service.js';
import type { TermsDriveResult, TermsTerminal } from './antigravity-terms-driver.js';
import type { RuntimeTermsRecord, RuntimeTermsStore } from './runtime-terms.store.js';

const C = RUNTIME_TERMS_CONSTANTS;

/** The owner's three answers. */
export type TermsChoice = 'agree_no_data' | 'agree_share_data' | 'decline';

/** Card text of a runtime. */
export interface TermsCardText {
	title: string;
	question: string;
	body: string[];
}

/** What Settings shows next to the inline choices. */
export interface TermsInfo {
	/** One plain-English sentence on what is asked */
	summary: string;
	/** The pre-checked data-sharing item, verbatim */
	dataItem: string;
	links: Array<{ label: string; url: string }>;
}

/** What the service knows about one runtime's Terms screens. */
export interface RuntimeTermsProfile {
	runtime: string;
	label: string;
	info: TermsInfo;
	/** Card text for this machine */
	card(machine: string): TermsCardText;
	/** Drive the setup screens of a freshly launched runtime */
	drive(term: TermsTerminal, shareData: boolean): Promise<TermsDriveResult>;
	/** What a screen shows: the Terms / setup screens, the ready prompt, a refusal, or not yet known */
	classify(screen: string): 'terms' | 'ready' | 'blocked' | 'unknown';
}

/** Result of {@link RuntimeTermsConsentService.probe}. */
export interface TermsProbeResult {
	outcome: 'terms' | 'ready' | 'blocked' | 'unknown';
	record: RuntimeTermsRecord | null;
	/** Screen text at the end (secrets redacted) */
	screen: string;
}

/** A launched dedicated session. */
export interface TermsSession {
	terminal: TermsTerminal;
	/** Leave the runtime and kill the session (always called) */
	close(): Promise<void>;
}

/** The decision-card calls used. */
export interface TermsDecisionApi {
	askSystem(input: SystemAskInput): Promise<OwnerDecision>;
	get(id: string): Promise<OwnerDecision | null>;
	chooseFromDashboard(id: string, optionKey: string): Promise<OwnerDecision>;
	replyInThread(id: string, text: string): Promise<boolean>;
}

/** Dependencies. */
export interface RuntimeTermsDeps {
	store: RuntimeTermsStore;
	decisions: () => TermsDecisionApi | null;
	profiles: Record<string, RuntimeTermsProfile>;
	/** Launch the runtime in the harness's dedicated session */
	launch: (runtime: string) => Promise<TermsSession>;
	/** Kill the dedicated session if it is running (Don't agree) */
	closeSession?: (runtime: string) => Promise<void>;
	runSmokeTest: (runtime: string) => Promise<SmokeTestResult>;
	machineName: () => string;
	/** A runtime's consent changed (availability caches) */
	onChange?: (runtime: string) => void;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	/** How long a probe waits for a recognisable screen */
	probeTimeoutMs?: number;
	logger?: ComponentLogger;
}

/** How a report was triggered. */
export interface TermsReport {
	/** launch | smoke_test | probe | settings | chain */
	source: string;
	/** The owner asked (Test, Accept terms…, re-added): re-ask even after Don't agree */
	ownerInitiated?: boolean;
}

/** A runtime's Terms state as the API shows it. */
export interface RuntimeTermsView extends Omit<RuntimeTermsRecord, 'status' | 'updatedAt'> {
	/** `none` = never seen a Terms screen on this machine */
	status: RuntimeTermsRecord['status'] | 'none';
	updatedAt?: string;
	label: string;
	info: TermsInfo;
	/** Why the runtime is skipped, when it is */
	blockedReason: string | null;
	/** Choices the inline Settings action offers */
	choices: Array<{ choice: TermsChoice; label: string }>;
}

/** Choice ↔ button label. */
export const TERMS_CHOICE_LABELS: Readonly<Record<TermsChoice, string>> = {
	agree_no_data: C.OPTIONS.AGREE_NO_DATA,
	agree_share_data: C.OPTIONS.AGREE_SHARE_DATA,
	decline: C.OPTIONS.DECLINE,
};

/**
 * The choice an option label means.
 *
 * @param label - Button label
 * @returns Choice, or null
 */
export function choiceOfLabel(label: string | undefined): TermsChoice | null {
	const entry = (Object.entries(TERMS_CHOICE_LABELS) as Array<[TermsChoice, string]>).find(([, l]) => l === label);
	return entry ? entry[0] : null;
}

/**
 * Screen text for a Slack code block: secrets redacted, last lines only, no
 * fence breakers.
 *
 * @param screen - Screen text
 * @returns Block text
 */
export function screenForThread(screen: string): string {
	const lines = redactSecrets(screen)
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''));
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	const tail = lines.slice(-C.DRIVE.SCREEN_LINES_IN_THREAD).join('\n').replace(/```/g, "'''");
	return '```\n' + (tail || '(empty screen)') + '\n```';
}

/** The service. */
export class RuntimeTermsConsentService {
	private readonly logger: ComponentLogger;
	private readonly now: () => Date;
	/** Serialises asks per runtime (launch + smoke test can report at once) */
	private readonly asking = new Map<string, Promise<RuntimeTermsRecord | null>>();
	/** Running accept / decline per runtime */
	private readonly running = new Map<string, Promise<void>>();

	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: RuntimeTermsDeps) {
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('RuntimeTerms');
		this.now = deps.now ?? (() => new Date());
	}

	/**
	 * Whether the service handles a runtime.
	 *
	 * @param runtime - Runtime id
	 * @returns True when it has a profile
	 */
	supports(runtime: string): boolean {
		return Boolean(this.deps.profiles[runtime]);
	}

	/**
	 * A runtime's Terms screen was seen: ask the owner, once.
	 *
	 * No new card while one is open or the harness is accepting; none after
	 * Don't agree / a failed attempt unless the owner asked
	 * (`ownerInitiated`).
	 *
	 * @param runtime - Runtime id
	 * @param report - Source
	 * @returns The record, or null for a runtime without a profile
	 */
	reportTermsScreen(runtime: string, report: TermsReport): Promise<RuntimeTermsRecord | null> {
		if (!this.supports(runtime)) return Promise.resolve(null);
		const prev = this.asking.get(runtime) ?? Promise.resolve(null);
		const next = prev.catch(() => null).then(() => this.askOnce(runtime, report));
		this.asking.set(runtime, next);
		return next;
	}

	/**
	 * Settings → Runtimes → Accept terms…: post the card (or return the open one).
	 *
	 * @param runtime - Runtime id
	 * @returns The record
	 * @throws Error for a runtime without Terms handling
	 */
	async requestConsent(runtime: string): Promise<RuntimeTermsRecord> {
		if (!this.supports(runtime)) throw new Error(`Crewly has no Terms flow for ${runtime}`);
		return (await this.reportTermsScreen(runtime, { source: 'settings', ownerInitiated: true })) as RuntimeTermsRecord;
	}

	/**
	 * Probe: launch the runtime in the dedicated session, read (never press
	 * anything) until the screen is recognisable, close it. A Terms screen
	 * asks the owner (the owner asked for the check); a ready prompt means
	 * the Terms were accepted here already (e.g. in a terminal).
	 *
	 * @param runtime - Runtime id
	 * @returns What was on screen and the record after
	 * @throws Error while an answer is being applied, or for a runtime without a profile
	 */
	async probe(runtime: string): Promise<TermsProbeResult> {
		const profile = this.deps.profiles[runtime];
		if (!profile) throw new Error(`Crewly has no Terms flow for ${runtime}`);
		if (this.running.has(runtime) || this.deps.store.get(runtime)?.status === 'accepting') {
			throw new Error('Crewly is already accepting these Terms; wait for it to finish');
		}
		const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		const timeout = this.deps.probeTimeoutMs ?? C.DRIVE.LAUNCH_TIMEOUT_MS;
		let screen = '';
		let outcome: TermsProbeResult['outcome'] = 'unknown';
		const session = await this.deps.launch(runtime);
		try {
			for (let waited = 0; waited <= timeout; waited += C.DRIVE.POLL_MS) {
				screen = String(await session.terminal.capture());
				outcome = profile.classify(screen);
				if (outcome !== 'unknown') break;
				await sleep(C.DRIVE.POLL_MS);
			}
		} finally {
			await session.close().catch(() => undefined);
		}
		if (outcome === 'terms') {
			const record = await this.reportTermsScreen(runtime, { source: 'probe', ownerInitiated: true });
			return { outcome, record, screen: redactSecrets(screen) };
		}
		if (outcome === 'ready') {
			const prev = this.deps.store.get(runtime);
			const record = this.save({ runtime, status: 'accepted', detectedBy: 'probe', ...(prev?.dataSharing !== undefined ? { dataSharing: prev.dataSharing } : {}) });
			return { outcome, record, screen: redactSecrets(screen) };
		}
		return { outcome, record: this.deps.store.get(runtime), screen: redactSecrets(screen) };
	}

	/**
	 * Answer inline from Settings: through the open card when there is one
	 * (so the card updates), else directly.
	 *
	 * @param runtime - Runtime id
	 * @param choice - Owner's choice
	 * @returns The record after the answer was taken (driving continues in the background)
	 */
	async answer(runtime: string, choice: TermsChoice): Promise<RuntimeTermsRecord> {
		if (!this.supports(runtime)) throw new Error(`Crewly has no Terms flow for ${runtime}`);
		const rec = this.deps.store.get(runtime);
		if (rec?.status === 'accepting') throw new Error('Crewly is already accepting these Terms; wait for it to finish');
		const decisions = this.deps.decisions();
		if (rec?.decisionId && decisions) {
			const d = await decisions.get(rec.decisionId);
			const opt = d?.options.find((o) => o.label === TERMS_CHOICE_LABELS[choice]);
			if (d && opt && PENDING_DECISION_STATUSES.has(d.status)) {
				await decisions.chooseFromDashboard(d.id, opt.key);
				return this.deps.store.get(runtime) ?? rec;
			}
		}
		this.start(runtime, choice, undefined, 'owner');
		return this.deps.store.get(runtime) ?? (rec as RuntimeTermsRecord);
	}

	/**
	 * The `runtime_terms` decision-kind handler
	 * (`DecisionService.registerKindHandler`): acts on the answer. No agent
	 * asked, so there is no note for one.
	 *
	 * @param d - Settled decision
	 * @returns null (nothing to deliver)
	 */
	async onSettled(d: OwnerDecision): Promise<null> {
		this.handleSettled(d);
		return null;
	}

	/**
	 * A decision was settled: act on runtime-terms ones.
	 *
	 * @param d - Settled decision
	 */
	handleSettled(d: OwnerDecision): void {
		if (d.kind !== 'runtime_terms' || !d.system) return;
		const runtime = d.system.key;
		const rec = this.deps.store.get(runtime);
		if (!rec || rec.decisionId !== d.id) {
			this.logger.info('Ignoring an old Terms decision', { decisionId: d.id, runtime });
			return;
		}
		if (d.status === 'resolved') {
			const choice = choiceOfLabel(d.options.find((o) => o.key === d.chosenKey)?.label);
			if (choice) this.start(runtime, choice, d.id, 'owner');
			return;
		}
		if (d.status === 'defaulted') {
			this.start(runtime, 'decline', d.id, 'deadline');
			return;
		}
		// Withdrawn / parked: nothing was agreed.
		this.start(runtime, 'decline', d.id, 'withdrawn');
	}

	/**
	 * Why a runtime cannot be used because of its Terms (null = it can).
	 *
	 * @param runtime - Runtime id
	 * @returns Owner-facing reason, or null
	 */
	blockedReason(runtime: string): string | null {
		const rec = this.deps.store.get(runtime);
		if (!rec) return null;
		switch (rec.status) {
			case 'pending':
				return C.MESSAGES.PENDING;
			case 'accepting':
				return 'Accepting its Terms of Service…';
			case 'declined':
				return `${C.MESSAGES.DECLINED_SUFFIX}: ${rec.reason ?? C.MESSAGES.DECLINED_BY_OWNER}`;
			case 'failed':
				return `${C.MESSAGES.DECLINED_SUFFIX}: the setup stopped (${rec.reason ?? 'unknown reason'})`;
			default:
				return null;
		}
	}

	/** @returns Every runtime with a Terms flow, with its record */
	list(): RuntimeTermsView[] {
		const all = this.deps.store.all();
		return Object.values(this.deps.profiles).map((p) => ({
			...(all[p.runtime] ?? { runtime: p.runtime, status: 'none' as const }),
			label: p.label,
			info: p.info,
			blockedReason: this.blockedReason(p.runtime),
			choices: (Object.keys(TERMS_CHOICE_LABELS) as TermsChoice[]).map((choice) => ({ choice, label: TERMS_CHOICE_LABELS[choice] })),
		}));
	}

	/**
	 * Wait for a running accept / decline (tests, the API's `?wait=1`).
	 *
	 * @param runtime - Runtime id
	 */
	async whenIdle(runtime: string): Promise<void> {
		await (this.asking.get(runtime) ?? Promise.resolve()).catch(() => undefined);
		await (this.running.get(runtime) ?? Promise.resolve());
	}

	// ------------------------------------------------------------------ internals

	private async askOnce(runtime: string, report: TermsReport): Promise<RuntimeTermsRecord | null> {
		const profile = this.deps.profiles[runtime];
		const rec = this.deps.store.get(runtime);
		if (rec?.status === 'accepting') return rec;
		const decisions = this.deps.decisions();
		if (rec?.status === 'pending' && rec.decisionId && decisions) {
			const open = await decisions.get(rec.decisionId).catch(() => null);
			if (open && PENDING_DECISION_STATUSES.has(open.status)) return rec;
		}
		if ((rec?.status === 'declined' || rec?.status === 'failed') && !report.ownerInitiated) return rec;

		const machine = this.deps.machineName();
		let decisionId: string | undefined;
		if (decisions) {
			const text = profile.card(machine);
			try {
				const d = await decisions.askSystem({
					kind: 'runtime_terms',
					system: { key: runtime, defaultIsDecline: true },
					title: text.title,
					question: text.question,
					body: text.body,
					options: [C.OPTIONS.AGREE_NO_DATA, C.OPTIONS.AGREE_SHARE_DATA, C.OPTIONS.DECLINE],
					default: C.OPTIONS.DECLINE,
					deadline: new Date(this.now().getTime() + C.DEADLINE_MS),
					sensitive: 'runtime_terms',
				});
				decisionId = d.id;
			} catch (err) {
				this.logger.warn('Could not create the Terms decision card', { runtime, error: err instanceof Error ? err.message : String(err) });
			}
		}
		const saved = this.save({
			runtime,
			status: 'pending',
			...(decisionId ? { decisionId } : {}),
			detectedBy: report.source,
		});
		this.logger.info('Runtime Terms consent asked', { runtime, source: report.source, decisionId });
		return saved;
	}

	private start(runtime: string, choice: TermsChoice, decisionId: string | undefined, why: 'owner' | 'deadline' | 'withdrawn'): void {
		if (this.running.has(runtime)) {
			this.logger.warn('A Terms answer is already being applied; ignoring another', { runtime, choice });
			return;
		}
		const run = (choice === 'decline' ? this.decline(runtime, decisionId, why) : this.accept(runtime, choice === 'agree_share_data', decisionId))
			.catch((err) => this.logger.error('Applying the Terms answer failed', { runtime, error: err instanceof Error ? err.message : String(err) }))
			.finally(() => this.running.delete(runtime));
		this.running.set(runtime, run);
	}

	private async decline(runtime: string, decisionId: string | undefined, why: 'owner' | 'deadline' | 'withdrawn'): Promise<void> {
		const profile = this.deps.profiles[runtime];
		await this.deps.closeSession?.(runtime).catch(() => undefined);
		const reason =
			why === 'deadline' ? C.MESSAGES.DECLINED_BY_DEADLINE : why === 'withdrawn' ? 'The question was withdrawn without an answer' : C.MESSAGES.DECLINED_BY_OWNER;
		this.save({ runtime, status: 'declined', reason, ...(decisionId ? { decisionId } : {}) });
		const machine = this.deps.machineName();
		const lead = why === 'deadline' ? 'No answer within 24 h, so nothing was accepted (the default).' : 'OK, not accepted.';
		await this.reply(
			decisionId,
			`${lead} ${profile.label} is marked "terms not accepted" on ${machine}, and the fallback order skips it. ` +
				`To change your mind: Settings → Runtimes → ${profile.label} → Accept terms…, or press Test.`,
		);
	}

	private async accept(runtime: string, shareData: boolean, decisionId: string | undefined): Promise<void> {
		const profile = this.deps.profiles[runtime];
		const machine = this.deps.machineName();
		this.save({ runtime, status: 'accepting', ...(decisionId ? { decisionId } : {}), dataSharing: shareData });

		let drive: TermsDriveResult;
		let session: TermsSession | null = null;
		try {
			session = await this.deps.launch(runtime);
			drive = await profile.drive(session.terminal, shareData);
		} catch (err) {
			drive = { ok: false, donePressed: false, alreadyAccepted: false, error: `Could not start ${profile.label}: ${err instanceof Error ? err.message : String(err)}`, keys: [], screen: '' };
		} finally {
			await session?.close().catch(() => undefined);
		}
		this.logger.info('Runtime Terms screens driven', { runtime, ok: drive.ok, donePressed: drive.donePressed, alreadyAccepted: drive.alreadyAccepted, keys: drive.keys.length });

		if (!drive.ok) {
			this.save({
				runtime,
				status: 'failed',
				reason: drive.error ?? 'unknown',
				...(decisionId ? { decisionId } : {}),
				...(drive.donePressed ? { dataSharing: drive.dataSharing } : {}),
			});
			const head = drive.donePressed
				? `:warning: Done was pressed on ${machine} (Terms accepted, data sharing ${drive.dataSharing ? 'on' : 'off'}), but then: ${drive.error}.`
				: `:warning: Stopped on ${machine}; nothing was accepted (Done was not pressed): ${drive.error}.`;
			await this.reply(
				decisionId,
				`${head}\nScreen:\n${screenForThread(drive.screen)}\nTo try again: Settings → Runtimes → ${profile.label} → Accept terms….`,
			);
			return;
		}

		this.save({
			runtime,
			status: 'accepted',
			...(decisionId ? { decisionId } : {}),
			...(drive.alreadyAccepted ? {} : { dataSharing: drive.dataSharing ?? shareData }),
		});
		await this.reply(
			decisionId,
			drive.alreadyAccepted
				? `${profile.label} on ${machine} was already set up (it opened straight to its prompt), so nothing was pressed. Running the runtime test…`
				: `:white_check_mark: Accepted on ${machine}: ${profile.label}'s Terms, data sharing ${drive.dataSharing ? 'on' : 'off'} (checked on screen before Done). It opened to its prompt. Running the runtime test…`,
		);

		let smoke: SmokeTestResult;
		try {
			smoke = await this.deps.runSmokeTest(runtime);
		} catch (err) {
			await this.reply(decisionId, `Runtime test could not start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		await this.reply(
			decisionId,
			smoke.passed
				? `Runtime test passed in ${Math.round(smoke.durationMs / 1000)}s: ${profile.label} ran bash and replied.`
				: `Runtime test failed at "${(smoke.failedStep ?? 'unknown').replace(/_/g, ' ')}": ${smoke.error ?? 'no reason given'}` +
						(smoke.screen ? `\nScreen:\n${screenForThread(smoke.screen)}` : ''),
		);
	}

	private async reply(decisionId: string | undefined, text: string): Promise<void> {
		if (!decisionId) return;
		const decisions = this.deps.decisions();
		if (!decisions) return;
		await decisions.replyInThread(decisionId, text).catch((err) => this.logger.warn('Could not reply in the Terms card thread', { decisionId, error: String(err) }));
	}

	private save(fields: Omit<RuntimeTermsRecord, 'updatedAt'>): RuntimeTermsRecord {
		const saved = this.deps.store.set({ ...fields, updatedAt: this.now().toISOString() });
		try {
			this.deps.onChange?.(fields.runtime);
		} catch {
			// cache invalidation only
		}
		return saved;
	}
}

// ----------------------------------------------------------------- singleton

let instance: RuntimeTermsConsentService | null = null;

/** @returns The backend's instance, or null before wiring (and in tests) */
export function getRuntimeTermsConsentService(): RuntimeTermsConsentService | null {
	return instance;
}

/** @param service - Instance to install (null clears) */
export function setRuntimeTermsConsentService(service: RuntimeTermsConsentService | null): void {
	instance = service;
}

/**
 * Report a Terms screen to the backend's service, when wired (fire and forget).
 *
 * @param runtime - Runtime id
 * @param report - Source
 */
export function reportRuntimeTermsScreen(runtime: string, report: TermsReport): void {
	const svc = instance;
	if (!svc) return;
	void svc.reportTermsScreen(runtime, report).catch(() => undefined);
}
