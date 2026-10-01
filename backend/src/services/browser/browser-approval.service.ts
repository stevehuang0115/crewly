/**
 * Owner approval of held browser actions.
 *
 * When `BrowserSessionService.authorize` holds an irreversible click (send,
 * submit, pay, delete…), this service:
 *
 * 1. persists the hold under CREWLY_HOME ({@link HeldActionStore});
 * 2. asks the owner with a Slack decision card (kind `browser_action`,
 *    "Let it" / "No", never auto-approved) posted by the agent's own bot in
 *    the thread of the work item it is on;
 * 3. applies the answer, whichever place it came from — the card's button,
 *    a reaction, a thread reply (批准 / 可以 / yes, 不行 / no), the decisions
 *    dashboard, or the Browser page of the dashboard / portal — to the one
 *    held action, and tells the agent;
 * 4. at the deadline ({@link BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS}) the
 *    answer is No;
 * 5. after a restart, re-attaches a hold whose tab comes back in the
 *    extension's tab inventory, and expires the rest (card updated, agent
 *    told to redo the step).
 *
 * Approval works exactly like the dashboard's approve always has: it grants
 * the agent ONE pass for its next attempt and tells it to go ahead. Crewly
 * does not replay the click itself — the agent knows what it was in the
 * middle of, and after a wait the page may have changed.
 *
 * Every outcome is applied in one place, {@link BrowserApprovalService.onSettled},
 * which the decision service calls when a `browser_action` card settles.
 * Paths without a card (no Slack, card not created yet) apply it directly.
 *
 * @module services/browser/browser-approval.service
 */

import { BROWSER_APPROVAL_CONSTANTS } from '../../constants.js';
import type { BrowserActionSubject, DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import type { DecisionKindHandler, PrebuiltAsk } from '../decisions/decision.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { BrowserHoldListener, BrowserSession, BrowserSessionService, PendingConfirmation } from './browser-session.service.js';
import type { ExtensionTabDescriptor } from './browser-bridge.service.js';
import { HeldActionStore, type HeldBrowserAction, type HeldActionStatus } from './held-action-store.js';

const APPROVE_KEY = 'a';
const REJECT_KEY = 'b';

/** The slice of the decision service used here. */
export interface BrowserApprovalDecisions {
	askPrebuilt(ask: PrebuiltAsk): Promise<OwnerDecision>;
	chooseFromDashboard(id: string, optionKey: string): Promise<OwnerDecision>;
	expire(id: string): Promise<OwnerDecision | null>;
	cancelWhere(filter: (d: OwnerDecision) => boolean, note?: string): Promise<number>;
}

/** Collaborators. */
export interface BrowserApprovalDeps {
	store: HeldActionStore;
	sessions: Pick<BrowserSessionService, 'getSession' | 'resolvePending' | 'restorePending'>;
	/** The decision service, once it runs */
	decisions: () => BrowserApprovalDecisions | null;
	/** Whether a card can be posted now (decision service up, Slack connected) */
	canAskInSlack: () => boolean;
	/** Deliver a line to an agent (paths without a card) */
	tellAgent: (agentSession: string, text: string) => Promise<unknown>;
	/** Display name of an agent ("Vera") */
	agentNameOf?: (agentSession: string) => Promise<string | undefined>;
	/** The tab an agent is bound to */
	boundTabOf?: (agentSession: string) => { tabId: number; instanceId?: string } | undefined;
	/** Re-bind an agent to an existing tab (after a restart) */
	adoptTab?: (agentSession: string, tabId: number, instanceId?: string) => boolean;
	now?: () => number;
	logger?: ComponentLogger;
}

/** How a held action ended. */
type Outcome = 'approve' | 'reject' | 'timeout' | 'expire' | 'drop';

/**
 * Strip a URL to "host/path" for the card.
 *
 * @param url - URL the agent targeted
 * @returns "visa.careerengine.us/subscribe", or undefined
 */
export function placeOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		const p = u.pathname.replace(/\/+$/, '');
		return `${u.host}${p}`;
	} catch {
		return undefined;
	}
}

/**
 * The visible name of what a click targets, from its params: the text the
 * agent passed, else a quoted name in the selector (`:has-text("Submit")`,
 * `[aria-label="Send"]`, `text=Pay`), else the selector itself.
 *
 * @param params - Params of the call
 * @returns Button text / selector, or undefined
 */
export function controlName(params: Record<string, unknown> | undefined): string | undefined {
	const text = typeof params?.text === 'string' ? params.text.trim() : '';
	if (text) return text;
	const selector = typeof params?.selector === 'string' ? params.selector.trim() : '';
	if (!selector) return undefined;
	const quoted =
		/:(?:has-text|text|contains)\(\s*["'](.+?)["']\s*\)/i.exec(selector) ??
		/\[(?:aria-label|title|value|name)\s*[*^$~|]?=\s*["'](.+?)["']\s*\]/i.exec(selector) ??
		/^text\s*=\s*["']?(.+?)["']?$/i.exec(selector);
	return quoted ? quoted[1].trim() : selector;
}

/**
 * What the agent wants to do, in a few words: `click "Submit"`, `press Enter`.
 *
 * @param tool - Tool it called
 * @param params - Params it called it with
 * @returns Short phrase (≤ 100 characters)
 */
export function describeTarget(tool: string, params: Record<string, unknown> | undefined): string {
	const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
	const name = controlName(params);
	switch (tool) {
		case 'click':
			return name ? `click "${clip(name)}"` : 'click on the page';
		case 'pressKey':
			return `press ${clip(String(params?.key ?? 'Enter'))}`;
		case 'selectOption':
			return name ? `choose an option in "${clip(name)}"` : 'choose an option';
		case 'setFileInput':
			return 'attach a file';
		case 'executeJs':
		case 'executeScript':
			return 'run a script that acts on the page';
		default:
			return clip(tool);
	}
}

/**
 * The card's question: "Vera wants to click "Submit" on visa.careerengine.us/subscribe — it looks like submitting and can't be undone."
 *
 * @param agentName - Agent display name
 * @param action - Held action
 * @returns One line (≤ 280 characters)
 */
export function approvalQuestion(agentName: string, action: Pick<HeldBrowserAction, 'target' | 'where' | 'matched'>): string {
	const q = `${agentName} wants to ${action.target}${action.where ? ` on ${action.where}` : ''} — it looks like ${action.matched} and can't be undone.`;
	return q.length > 280 ? `${q.slice(0, 279)}…` : q;
}

/** The line a held agent is given about where the owner answers. */
export const CARD_ASKED_LINE = `Say exactly: "${BROWSER_APPROVAL_CONSTANTS.AGENT_SAYS}" Then stop.`;

/**
 * Asks the owner about held browser actions and applies the answer.
 */
export class BrowserApprovalService implements BrowserHoldListener, DecisionKindHandler {
	private static instance: BrowserApprovalService | null = null;

	private readonly deps: BrowserApprovalDeps;
	private readonly logger: ComponentLogger;
	private readonly now: () => number;
	/** Holds restored from disk, waiting for their tab to come back: pendingId → since (ms) */
	private readonly awaitingRebind = new Map<string, number>();
	/** In-flight async work started from sync hooks (tests wait on it) */
	private readonly inflight = new Set<Promise<unknown>>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	private restored = false;

	/**
	 * @param deps - Collaborators
	 */
	constructor(deps: BrowserApprovalDeps) {
		this.deps = deps;
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('BrowserApproval');
		this.now = deps.now ?? (() => Date.now());
	}

	/** @returns The process-wide instance, or null before wiring */
	static getInstance(): BrowserApprovalService | null {
		return BrowserApprovalService.instance;
	}

	/** @param service - Instance to install (null clears) */
	static setInstance(service: BrowserApprovalService | null): void {
		BrowserApprovalService.instance = service;
	}

	/** Start the retry / expiry tick. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), BROWSER_APPROVAL_CONSTANTS.TICK_MS);
		this.timer.unref?.();
	}

	/** Stop the tick. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Wait for work started by the sync hooks (tests). */
	async idle(): Promise<void> {
		while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
	}

	private track(p: Promise<unknown>): void {
		const wrapped = p.catch((err) => this.logger.warn('Browser approval step failed', { error: errText(err) }));
		this.inflight.add(wrapped);
		void wrapped.finally(() => this.inflight.delete(wrapped));
	}

	// ---------------------------------------------------------------------------
	// Holding
	// ---------------------------------------------------------------------------

	/**
	 * An action was held: persist it and ask the owner with a card.
	 *
	 * @param session - Session holding it (`pending` set)
	 * @param params - Params of the held call (not persisted)
	 * @returns What the agent is told about where the owner answers
	 */
	onHeld(session: BrowserSession, params: Record<string, unknown> | undefined): string | undefined {
		const pending = session.pending;
		if (!pending) return undefined;
		const bound = this.deps.boundTabOf?.(session.agentSession);
		const paramTab = typeof params?.tabId === 'number' ? params.tabId : undefined;
		const action: HeldBrowserAction = {
			pendingId: pending.id,
			agentSession: session.agentSession,
			...(session.agentName ? { agentName: session.agentName } : {}),
			tool: pending.tool,
			description: pending.description,
			matched: pending.matched,
			target: describeTarget(pending.tool, params),
			...(placeOf(session.url) ? { where: placeOf(session.url) } : {}),
			...(session.url ? { url: session.url } : {}),
			...(typeof (paramTab ?? session.tabId ?? bound?.tabId) === 'number' ? { tabId: (paramTab ?? session.tabId ?? bound?.tabId) as number } : {}),
			...(bound?.instanceId ? { instanceId: bound.instanceId } : {}),
			raisedAt: pending.raisedAt,
			status: 'pending',
		};
		const asking = this.deps.canAskInSlack();
		this.track(
			(async () => {
				await this.deps.store.put(action);
				if (asking) await this.createCard(action);
			})(),
		);
		return asking ? CARD_ASKED_LINE : undefined;
	}

	/**
	 * Create the card for a held action.
	 *
	 * @param action - The held action
	 */
	private async createCard(action: HeldBrowserAction): Promise<void> {
		const decisions = this.deps.decisions();
		if (!decisions) return;
		await this.deps.store.update(action.pendingId, () => ({ cardTriedAt: this.now() }));
		const agentName = action.agentName ?? (await this.deps.agentNameOf?.(action.agentSession).catch(() => undefined)) ?? action.agentSession;
		const options: DecisionOption[] = [
			{ key: APPROVE_KEY, label: BROWSER_APPROVAL_CONSTANTS.APPROVE_LABEL, detail: 'do exactly this, once' },
			{ key: REJECT_KEY, label: BROWSER_APPROVAL_CONSTANTS.REJECT_LABEL, detail: "don't do it" },
		];
		const subject: BrowserActionSubject = {
			agentSession: action.agentSession,
			agentName,
			pendingId: action.pendingId,
			...(action.where ? { where: action.where } : {}),
			target: action.target,
			matched: action.matched,
		};
		const decision = await decisions.askPrebuilt({
			kind: 'browser_action',
			asker: action.agentSession,
			question: approvalQuestion(agentName, action),
			options,
			defaultKey: REJECT_KEY,
			yesKey: APPROVE_KEY,
			deadline: new Date(action.raisedAt + BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS),
			sensitive: 'browser_action',
			browser: subject,
		});
		const linked = await this.deps.store.update(action.pendingId, (a) => (a.status === 'pending' ? { decisionId: decision.id, agentName } : null));
		if (!linked) {
			// Answered (e.g. on the Browser page) while the card was being made.
			await decisions.cancelWhere((d) => d.id === decision.id, 'browser action already settled');
			return;
		}
		this.logger.info('Asked the owner about a held browser action', { pendingId: action.pendingId, decisionId: decision.id, posted: !!decision.card });
	}

	/**
	 * A hold was dropped without an answer: withdraw its card.
	 *
	 * @param _agentSession - Agent
	 * @param pendingId - The dropped hold
	 */
	onDropped(_agentSession: string, pendingId: string): void {
		this.track(
			(async () => {
				const action = await this.deps.store.settle(pendingId, 'dropped');
				const decisions = this.deps.decisions();
				if (action?.decisionId && decisions) await decisions.cancelWhere((d) => d.id === action.decisionId, 'browser hold dropped');
			})(),
		);
	}

	// ---------------------------------------------------------------------------
	// Answers
	// ---------------------------------------------------------------------------

	/**
	 * A `browser_action` decision settled (button, reaction, reply, decisions
	 * dashboard, Browser page via {@link answerFromBrowserPage}, deadline,
	 * expiry or withdrawal). Applies it to the held action.
	 *
	 * @param decision - The settled decision
	 * @returns Note for the agent, or null
	 */
	async onSettled(decision: OwnerDecision): Promise<string | null> {
		const pendingId = decision.browser?.pendingId;
		if (!pendingId) return null;
		const action = await this.deps.store.get(pendingId);
		if (!action || action.status !== 'pending') return null;
		let outcome: Outcome;
		if (decision.status === 'resolved') outcome = decision.chosenKey === APPROVE_KEY ? 'approve' : 'reject';
		else if (decision.status === 'defaulted') outcome = 'timeout';
		else if (decision.status === 'expired') outcome = 'expire';
		else if (decision.status === 'cancelled') outcome = 'drop';
		else return null;
		return this.apply(action, outcome);
	}

	/**
	 * The owner answered on the Browser page (dashboard or portal). With a
	 * card, the answer goes through the card so it is updated too; without
	 * one it is applied directly.
	 *
	 * @param agentSession - Session holding the action
	 * @param pendingId - The hold being answered
	 * @param answer - What the owner chose
	 * @returns The updated session, or undefined when no such hold is waiting
	 */
	async answerFromBrowserPage(agentSession: string, pendingId: string, answer: 'approve' | 'reject'): Promise<BrowserSession | undefined> {
		const held = this.deps.sessions.getSession(agentSession)?.pending;
		if (!held || held.id !== pendingId) return undefined;
		const action = await this.deps.store.get(pendingId);
		const decisions = this.deps.decisions();
		if (action?.status === 'pending' && action.decisionId && decisions) {
			try {
				await decisions.chooseFromDashboard(action.decisionId, answer === 'approve' ? APPROVE_KEY : REJECT_KEY);
				const after = await this.deps.store.get(pendingId);
				if (after?.status !== 'pending') return this.deps.sessions.getSession(agentSession);
			} catch (err) {
				this.logger.warn('Could not answer the browser card from the Browser page — applying directly', { pendingId, error: errText(err) });
			}
		}
		const fallback: HeldBrowserAction = action ?? {
			pendingId,
			agentSession,
			tool: held.tool,
			description: held.description,
			matched: held.matched,
			target: held.description,
			raisedAt: held.raisedAt,
			status: 'pending',
		};
		if (!action) await this.deps.store.put(fallback);
		const note = await this.apply(fallback, answer);
		if (note) await this.deps.tellAgent(agentSession, note).catch(() => undefined);
		if (fallback.decisionId && decisions) await decisions.cancelWhere((d) => d.id === fallback.decisionId, 'answered on the Browser page');
		return this.deps.sessions.getSession(agentSession);
	}

	/**
	 * Apply an outcome to a held action (once) and say what the agent is told.
	 */
	private async apply(action: HeldBrowserAction, outcome: Outcome): Promise<string | null> {
		const status: Record<Outcome, Exclude<HeldActionStatus, 'pending'>> = {
			approve: 'approved',
			reject: 'rejected',
			timeout: 'timed_out',
			expire: 'expired',
			drop: 'dropped',
		};
		const settled = await this.deps.store.settle(action.pendingId, status[outcome]);
		if (!settled) return null;
		this.awaitingRebind.delete(action.pendingId);
		const what = `${action.target}${action.where ? ` on ${action.where}` : ''}`;
		const held = this.deps.sessions.getSession(action.agentSession)?.pending;
		const live = held?.id === action.pendingId;
		this.logger.info('Held browser action settled', { pendingId: action.pendingId, agentSession: action.agentSession, outcome, live });

		if (outcome === 'approve') {
			if (!live) {
				return `[BROWSER] The owner said Let it to: ${what} — but Crewly restarted and that held action is no longer attached to your tab. Redo the step: look at the page again, then retry it; it will be asked again.`;
			}
			// Exactly the dashboard's approve: one pass for the agent's next attempt.
			this.deps.sessions.resolvePending(action.agentSession, action.pendingId, 'approve');
			return `[BROWSER] The owner said Let it: ${what}. Go ahead with exactly that, once — retry the same call now.`;
		}
		if (live) this.deps.sessions.resolvePending(action.agentSession, action.pendingId, 'reject');
		switch (outcome) {
			case 'reject':
				return `[BROWSER] The owner said No to: ${what}. Do not do it and do not work around it. Say in the thread what you will do instead, or ask.`;
			case 'timeout':
				return `[BROWSER] No answer from the owner within ${Math.round(BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS / 3_600_000)} hours, so the answer is No: ${what}. Do not do it. If it is still needed later, redo the step and it will be asked again.`;
			case 'expire':
				return `[BROWSER] Crewly restarted and your held action (${what}) could not be re-attached to its tab, so it expired. Redo the step: look at the page again, then retry it — the owner will be asked again with a new card.`;
			default:
				return null;
		}
	}

	// ---------------------------------------------------------------------------
	// Restart
	// ---------------------------------------------------------------------------

	/**
	 * After a restart: wait for the tab of each pending hold to come back
	 * (tab inventory); holds without a known tab expire right away.
	 *
	 * @returns How many holds are waiting for their tab
	 */
	async restore(): Promise<number> {
		if (this.restored) return this.awaitingRebind.size;
		this.restored = true;
		const pending = await this.deps.store.list((a) => a.status === 'pending');
		const now = this.now();
		for (const action of pending) {
			if (this.deps.sessions.getSession(action.agentSession)?.pending?.id === action.pendingId) continue;
			if (typeof action.tabId !== 'number' || !this.deps.adoptTab) {
				await this.expire(action);
				continue;
			}
			this.awaitingRebind.set(action.pendingId, now);
		}
		if (pending.length > 0) this.logger.info('Held browser actions found after restart', { pending: pending.length, waitingForTab: this.awaitingRebind.size });
		return this.awaitingRebind.size;
	}

	/**
	 * A tab inventory arrived: re-bind each restored hold whose tab is in it.
	 *
	 * @param tabs - Tabs the extension reports
	 * @param instanceId - Browser instance that sent it (undefined = direct WS)
	 */
	onTabInventory(tabs: ExtensionTabDescriptor[], instanceId?: string): void {
		if (this.awaitingRebind.size === 0) return;
		const ids = new Set(tabs.map((t) => t.tabId));
		this.track(
			(async () => {
				for (const pendingId of [...this.awaitingRebind.keys()]) {
					const action = await this.deps.store.get(pendingId);
					if (!action || action.status !== 'pending') {
						this.awaitingRebind.delete(pendingId);
						continue;
					}
					if ((action.instanceId ?? undefined) !== instanceId || typeof action.tabId !== 'number' || !ids.has(action.tabId)) continue;
					const bound = this.deps.boundTabOf?.(action.agentSession);
					const ok = bound ? bound.tabId === action.tabId : !!this.deps.adoptTab?.(action.agentSession, action.tabId, action.instanceId);
					if (!ok) continue;
					this.awaitingRebind.delete(pendingId);
					const pending: PendingConfirmation = {
						id: action.pendingId,
						tool: action.tool,
						description: action.description,
						matched: action.matched,
						raisedAt: action.raisedAt,
					};
					this.deps.sessions.restorePending({
						agentSession: action.agentSession,
						...(action.agentName ? { agentName: action.agentName } : {}),
						...(action.url ? { url: action.url } : {}),
						tabId: action.tabId,
						pending,
						...(action.decisionId ? { where: CARD_ASKED_LINE } : {}),
					});
					this.logger.info('Re-attached a held browser action to its tab', { pendingId, agentSession: action.agentSession, tabId: action.tabId });
				}
			})(),
		);
	}

	/** Expire a hold: through its card when it has one (the card says so), else directly. */
	private async expire(action: HeldBrowserAction): Promise<void> {
		const decisions = this.deps.decisions();
		if (action.decisionId && decisions) {
			const expired = await decisions.expire(action.decisionId).catch((err) => {
				this.logger.warn('Could not expire the browser card', { pendingId: action.pendingId, error: errText(err) });
				return null;
			});
			if (expired) return;
		}
		const note = await this.apply(action, 'expire');
		if (note) await this.deps.tellAgent(action.agentSession, note).catch(() => undefined);
	}

	// ---------------------------------------------------------------------------
	// Tick
	// ---------------------------------------------------------------------------

	/**
	 * One pass: expire restored holds whose tab never came back, create cards
	 * that could not be created, time out holds without a card, prune.
	 *
	 * @returns Ids acted on
	 */
	async tick(): Promise<string[]> {
		if (this.ticking) return [];
		this.ticking = true;
		const acted: string[] = [];
		try {
			const now = this.now();
			for (const [pendingId, since] of [...this.awaitingRebind]) {
				if (now - since < BROWSER_APPROVAL_CONSTANTS.REBIND_GRACE_MS) continue;
				this.awaitingRebind.delete(pendingId);
				const action = await this.deps.store.get(pendingId);
				if (action?.status === 'pending') {
					await this.expire(action);
					acted.push(pendingId);
				}
			}
			for (const action of await this.deps.store.list((a) => a.status === 'pending' && !a.decisionId)) {
				if (this.awaitingRebind.has(action.pendingId)) continue;
				if (now >= action.raisedAt + BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS) {
					// No card ever made it: the deadline still applies, and the answer is No.
					const note = await this.apply(action, 'timeout');
					if (note) await this.deps.tellAgent(action.agentSession, note).catch(() => undefined);
					acted.push(action.pendingId);
					continue;
				}
				if (!this.deps.canAskInSlack()) continue;
				if (action.cardTriedAt && now - action.cardTriedAt < BROWSER_APPROVAL_CONSTANTS.CARD_RETRY_MS) continue;
				await this.createCard(action);
				acted.push(action.pendingId);
			}
			await this.deps.store.prune().catch(() => 0);
		} catch (err) {
			this.logger.warn('Browser approval tick failed', { error: errText(err) });
		} finally {
			this.ticking = false;
		}
		return acted;
	}
}

/**
 * Message of an unknown error.
 *
 * @param err - Thrown value
 * @returns Text
 */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** @returns The process-wide approval service, or null before wiring */
export function getBrowserApprovals(): BrowserApprovalService | null {
	return BrowserApprovalService.getInstance();
}
