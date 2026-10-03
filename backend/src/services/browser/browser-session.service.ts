/**
 * Browser Session Service
 *
 * Makes an agent's browser work watchable. Every `/api/browser/*` action an
 * agent takes is folded into a per-agent {@link BrowserSession} — what it is
 * doing, where, and a recent picture of the page — so the owner can follow
 * along instead of reading a transcript of tool calls after the fact.
 *
 * Why this exists as its own object rather than a log line: an agent driving
 * a browser is the one activity where the interesting state lives outside
 * Crewly entirely. Without a picture, an agent that cannot see what it is
 * doing will describe the page confidently and wrongly, and the owner has no
 * way to catch it. The most damaging version of that already happened here —
 * an agent that could not attach an image to Slack published a screenshot of
 * a half-filled account-transfer form to a public URL instead.
 *
 * Which leads to the rule this module enforces by construction:
 *
 *   **Frames are owner-surface only.** They live in memory, are never written
 *   to disk, never attached to a chat message, and never posted to Slack or
 *   any other multi-party surface. The only way to read one is an authenticated
 *   fetch of {@link BrowserSessionService.getFrame} by someone already looking
 *   at this Crewly instance. A screenshot of whatever the owner happened to be
 *   logged into is exactly the kind of thing that must not be broadcast.
 *
 * Capture cadence is driven by whether anyone is actually looking. A session
 * nobody is watching refreshes rarely and only after the agent did something;
 * a session being watched refreshes at roughly a frame a second. There is no
 * subscribe/unsubscribe protocol to leak — a viewer is simply someone who
 * fetched a frame recently, which self-expires.
 *
 * @module services/browser/browser-session.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { BROWSER_SESSION_CONSTANTS, BROWSER_OUTBOUND_GUARD } from '../../constants.js';
import {
	actionFingerprint,
	draftTextOf,
	isActivateKey,
	isPasteKey,
	isSearchField,
	isSocialOrMessagingSite,
	matchOutbound,
	pageOf,
	scriptActs,
	scriptEditsContent,
	type OutboundContext,
} from './browser-outbound-guard.js';

/**
 * Whether an action does something to the page (as opposed to reading it):
 * a click, a selection, a file, a submitting key, or a script that acts
 * beyond writing text (writing text is the draft itself).
 *
 * @param tool - Browser tool
 * @param params - Its params
 * @returns True when it acts
 */
function actsOnPage(tool: string, params?: Record<string, unknown>): boolean {
	if (tool === 'click' || tool === 'selectOption' || tool === 'setFileInput') return true;
	if (tool === 'executeJs' || tool === 'executeScript') {
		const code = typeof params?.code === 'string' ? params.code : '';
		if (!scriptActs(code)) return /click|submit|press|dispatch/i.test(String(params?.operation ?? ''));
		// Writing the draft text alone is drafting, not sending.
		const onlyEdits = scriptEditsContent(code) && !scriptActs(code.replace(/execCommand\s*\(\s*['"`]insertText[^)]*\)|\.(innerText|textContent|innerHTML|value)\s*=(?!=)|new\s+InputEvent\b/gi, ''));
		return !onlyEdits;
	}
	return false;
}

/** What an agent is doing with the browser right now. */
export type BrowserSessionStatus =
	| 'navigating'
	| 'reading'
	| 'acting'
	/** Blocked on the owner: either they took the wheel, or the agent reached
	 *  something it is not allowed to do by itself. */
	| 'waiting_owner'
	| 'stopped'
	| 'done';

/** Who is allowed to drive this browser tab right now. */
export type BrowserControl = 'agent' | 'owner';

/** An action the agent asked to take that needs the owner to decide. */
export interface PendingConfirmation {
	/** Stable id the owner's approve/reject refers to */
	id: string;
	/** Tool the agent tried to use */
	tool: string;
	/** What it was about to do, in words */
	description: string;
	/** Why it was held */
	matched: string;
	/** When it was raised (epoch ms) */
	raisedAt: number;
	/**
	 * Text the action would put out (typed into the page earlier, or in the
	 * call itself), shown to the owner on the card. Clipped.
	 */
	draftText?: string;
	/**
	 * Identity of the held action (tool + target + text). An approval admits
	 * only a retry with this same fingerprint.
	 */
	fingerprint?: string;
}

/**
 * Who hears about held actions: the approval service, which asks the owner
 * with a Slack decision card and persists the hold across restarts.
 */
export interface BrowserHoldListener {
	/**
	 * An action was just held.
	 *
	 * @param session - The session (a copy) holding it, `pending` set
	 * @param params - Params of the held call (never persisted)
	 * @returns The line to give the agent about where the owner answers, or
	 *          undefined to keep the default
	 */
	onHeld(session: BrowserSession, params: Record<string, unknown> | undefined): string | undefined;
	/**
	 * A hold disappeared without an answer (the owner took the wheel and
	 * gave it back, which drops it).
	 *
	 * @param agentSession - Agent whose hold was dropped
	 * @param pendingId - The dropped hold
	 */
	onDropped(agentSession: string, pendingId: string): void;
}

/** What the agent is told when no card could be posted: the dashboard is the only place. */
export const HELD_ACTION_FALLBACK_LINE =
	'The owner answers it on the Browser page of the Crewly dashboard. Tell them plainly what you are waiting on.';

/** A captured picture of the page, held in memory only. */
export interface BrowserFrame {
	/** Base64-encoded image bytes, as the extension returned them */
	base64: string;
	/** `image/jpeg` or `image/png`, derived from what the extension sent */
	mimeType: string;
	/** When the capture completed (epoch ms) */
	capturedAt: number;
	/** Device pixel ratio the capture was taken at, when reported */
	devicePixelRatio?: number;
	/**
	 * Downscale the capture was asked for. Set: the extension clipped the
	 * viewport at this scale, and the frame is CSS px × scale (no DPR).
	 * Absent: an unclipped capture, which is in device pixels.
	 */
	scale?: number;
}

/** One agent's live browser activity. */
export interface BrowserSession {
	/** Stable id; one live session per agent session */
	id: string;
	/** Owning agent session (`X-Agent-Session`) */
	agentSession: string;
	/** Display name for the UI, when the agent sent one */
	agentName?: string;
	/** What the agent said it is trying to accomplish, from the takeover banner */
	goal?: string;
	/** Chrome tab the agent is bound to, when known */
	tabId?: number;
	/** Last URL we saw the agent target */
	url?: string;
	/** Current activity */
	status: BrowserSessionStatus;
	/** Human-readable description of the most recent action */
	lastAction: string;
	/** When that action happened (epoch ms) */
	lastActionAt: number;
	/** When the agent first touched the browser in this session (epoch ms) */
	startedAt: number;
	/** When the session finished or was stopped (epoch ms) */
	endedAt?: number;
	/**
	 * Who may drive the tab. An agent whose session is under `owner` control
	 * is refused, so the two can never fight over the same page.
	 */
	control: BrowserControl;
	/** Set while the owner holds the wheel, so the agent can be told why */
	controlTakenAt?: number;
	/** An irreversible action the agent is blocked on, awaiting the owner */
	pending?: PendingConfirmation;
	/** Capture time of the frame currently held, if any (epoch ms) */
	frameAt?: number;
	/** Why the last capture attempt failed, if it did */
	frameError?: string;
}

/**
 * How a capture is actually performed.
 *
 * Injected rather than imported so this service does not reach into the
 * bridge/proxy dispatch logic — the controller already owns that decision
 * (direct WS vs relay vs proxy) and hands us a closure over it.
 *
 * @param agentSession - The agent whose bound tab should be captured
 * @param options - Encoding controls passed through to the extension
 * @returns The extension's screenshot result
 */
export type FrameCapturer = (
	agentSession: string,
	options: { format: string; quality: number; scale?: number },
) => Promise<{ base64?: string; format?: string; devicePixelRatio?: number } | null>;

/** Frame-capture error recorded when the agent holds no tab. */
export const NO_BOUND_TAB_FRAME_ERROR = 'No tab is bound to this agent';

/**
 * What a {@link createBoundTabCapturer} needs from the transport layer.
 */
export interface BoundTabCapturerDeps {
	/** The tab bound to an agent, if it holds one. */
	getBoundTabId: (agentSession: string) => number | undefined;
	/**
	 * Send one `screenshot` command with exactly these params over whichever
	 * transport is up. Resolves to the extension's response, or null when no
	 * transport is available.
	 */
	sendScreenshot: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Build a capturer that only ever pictures the agent's own bound tab.
 *
 * A capture without a tabId lets the extension pick a tab itself, and its
 * pick is the tab navigated last by anyone, so an agent whose binding had
 * lapsed showed another agent's page in the live view. With no bound tab
 * this throws instead, which leaves the session with no frame and a
 * readable `frameError`. It also never auto-binds: watching an agent must
 * not open a tab for it.
 *
 * @param deps - Binding lookup and transport
 * @returns A {@link FrameCapturer}
 * @throws From the returned capturer, when the agent has no bound tab
 *
 * @example
 * ```typescript
 * sessions.setCapturer(createBoundTabCapturer({
 *   getBoundTabId: (s) => bridge.getBinding(s)?.tabId,
 *   sendScreenshot: (params) => bridge.sendCommand('screenshot', params),
 * }));
 * ```
 */
export function createBoundTabCapturer(deps: BoundTabCapturerDeps): FrameCapturer {
	return async (agentSession, options) => {
		const tabId = deps.getBoundTabId(agentSession);
		if (typeof tabId !== 'number') throw new Error(NO_BOUND_TAB_FRAME_ERROR);

		const response = await deps.sendScreenshot({ ...options, tabId });
		const result = (response as { result?: unknown } | null | undefined)?.result as
			| { base64?: string; format?: string; devicePixelRatio?: number }
			| undefined;
		return result ?? null;
	};
}

/** Tool names grouped by the activity they represent. */
const NAVIGATION_TOOLS = new Set(['navigate']);
const READ_TOOLS = new Set([
	'readText',
	'screenshot',
	'fullPageScreenshot',
	'getElement',
	'getInteractiveElements',
	'searchText',
	'listOptions',
	'getCookies',
	'getLocalStorage',
	'getConsoleMessages',
	'waitForSelector',
	'getTabs',
]);
const TERMINAL_TOOLS = new Set(['unbindTab']);

/**
 * Turns a tool call into a sentence a person can read.
 *
 * @param tool - Tool name as dispatched to the extension
 * @param params - Params sent with it
 * @returns A short description, e.g. `Clicked “Sign in”`
 */
export function describeAction(tool: string, params?: Record<string, unknown>): string {
	const p = params ?? {};
	const selector = typeof p.selector === 'string' ? p.selector : undefined;
	const text = typeof p.text === 'string' ? p.text : undefined;

	switch (tool) {
		case 'navigate':
			return typeof p.url === 'string' ? `Opening ${p.url}` : 'Opening a page';
		case 'click':
			return selector ? `Clicked ${selector}` : 'Clicked the page';
		case 'fill':
		case 'type':
		case 'insertText':
			// Never echo what was typed — it is frequently a credential.
			return selector ? `Typed into ${selector}` : 'Typed into the page';
		case 'selectOption':
			return selector ? `Chose an option in ${selector}` : 'Chose an option';
		case 'setFileInput':
			return 'Attached a file';
		case 'pressKey':
			return typeof p.key === 'string' ? `Pressed ${p.key}` : 'Pressed a key';
		case 'scroll':
		case 'scrollInElement':
			return 'Scrolled the page';
		case 'hover':
			return selector ? `Hovered ${selector}` : 'Hovered the page';
		case 'readText':
			return 'Reading page';
		case 'searchText':
			return text ? `Looking for “${text}”` : 'Searching the page';
		case 'screenshot':
		case 'fullPageScreenshot':
			return 'Taking a screenshot';
		case 'getInteractiveElements':
			return 'Looking at what is on the page';
		case 'waitForSelector':
			return selector ? `Waiting for ${selector}` : 'Waiting for the page';
		case 'executeJs':
		case 'executeScript':
			return 'Running a script on the page';
		case 'unbindTab':
			return 'Finished with this tab';
		case 'bindTab':
			return 'Opening a browser tab';
		default:
			return tool;
	}
}

/**
 * Tools that write into the page. Only these can be irreversible; reading a
 * page never is.
 */
const WRITING_TOOLS = new Set([
	'click',
	'pressKey',
	'selectOption',
	'setFileInput',
	'executeJs',
	'executeScript',
	// Typing only matters when it submits (a newline, or a submit flag) —
	// see browser-outbound-guard.ts.
	'type',
	'fill',
	'insertText',
]);

/**
 * Decide whether an action looks irreversible and outward-facing.
 *
 * Delegates to the outbound guard (browser-outbound-guard.ts, 2026-10-03):
 * submit labels and words in selectors and in a script's string literals
 * (never its identifiers — `x.send()` is not "sending"), every submitting
 * key, newline-terminated typing, form submits, writing requests, and on
 * social and messaging sites clicks that name no control. The session adds
 * the draft rule (see authorize).
 *
 * @param tool - Tool the agent wants to use
 * @param params - Params it wants to use
 * @param context - Where it happens (page URL), when known
 * @returns A short label for what it looks like, or null
 *
 * @example
 * ```typescript
 * matchIrreversible('click', { selector: 'button[aria-label="Send"]' }); // 'sending'
 * matchIrreversible('readText', {});                                     // null
 * ```
 */
export function matchIrreversible(tool: string, params?: Record<string, unknown>, context: OutboundContext = {}): string | null {
	if (!WRITING_TOOLS.has(tool)) return null;
	return matchOutbound(tool, params, context);
}


/**
 * Maps a tool to the status it puts the session into.
 *
 * @param tool - Tool name
 * @returns The status to show
 */
export function statusForTool(tool: string): BrowserSessionStatus {
	if (TERMINAL_TOOLS.has(tool)) return 'done';
	if (NAVIGATION_TOOLS.has(tool)) return 'navigating';
	if (READ_TOOLS.has(tool)) return 'reading';
	return 'acting';
}

/**
 * Tracks what each agent is doing in the browser and keeps a recent frame.
 *
 * @example
 * ```typescript
 * const sessions = BrowserSessionService.getInstance();
 * sessions.setCapturer(capture);
 * sessions.noteAction({ agentSession: 'pia', tool: 'navigate', params: { url } });
 * ```
 */
export class BrowserSessionService {
	private static instance: BrowserSessionService | null = null;

	private readonly logger: ComponentLogger;
	private readonly sessions: Map<string, BrowserSession> = new Map();
	/** Frame bytes, held apart from the session so metadata stays cheap to copy. */
	private readonly frames: Map<string, BrowserFrame> = new Map();
	/**
	 * Sessions whose extension predates the scroll-aware clip and `wheel`
	 * (before 0.4.23). Their scaled captures come back white once the page
	 * scrolls, so they are captured unscaled instead.
	 */
	private readonly legacyExtension: Set<string> = new Set();
	/** Last time someone fetched this session's frame (epoch ms). */
	private readonly lastViewedAt: Map<string, number> = new Map();
	/** Sessions that acted since their last capture. */
	private readonly dirty: Set<string> = new Set();
	/** Sessions with a capture in flight, so ticks cannot pile up on a slow page. */
	private readonly capturing: Set<string> = new Set();
	/**
	 * Sessions holding a one-shot approval from the owner.
	 *
	 * Consumed by the next matching action, so approving "send this email"
	 * lets exactly that through rather than opening the gate for good.
	 */
	private readonly approvedOnce: Map<string, string> = new Map();
	/** Last text each session typed into a page — what a later "Post" click would publish */
	private readonly lastDraft: Map<string, { text: string; page: string; tabId?: number }> = new Map();
	/**
	 * Whether irreversible actions are held for the owner.
	 *
	 * On by default. An owner who wants an agent to work unattended can turn
	 * it off, but that has to be a decision someone makes, not the state we
	 * ship in.
	 */
	private confirmBeforeIrreversible = true;

	private capturer: FrameCapturer | null = null;
	private holdListener: BrowserHoldListener | null = null;
	/** Makes hold ids unique within the process */
	private holdSeq = 0;
	/** Per agent: where the owner answers its current hold (what the agent is told). */
	private readonly holdWhere: Map<string, string> = new Map();
	private timer: ReturnType<typeof setInterval> | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('BrowserSession');
	}

	/**
	 * Get the shared instance.
	 *
	 * @returns The singleton service
	 */
	static getInstance(): BrowserSessionService {
		if (!BrowserSessionService.instance) {
			BrowserSessionService.instance = new BrowserSessionService();
		}
		return BrowserSessionService.instance;
	}

	/** Drops the singleton and stops its timer (tests). */
	static resetInstance(): void {
		BrowserSessionService.instance?.stop();
		BrowserSessionService.instance = null;
	}

	/**
	 * Provide the function used to capture a frame.
	 *
	 * Until this is set the service still tracks actions; it simply has no
	 * pictures, which is the correct behaviour on an install with no browser
	 * extension connected.
	 *
	 * @param capturer - How to capture, or null to disable capture
	 */
	setCapturer(capturer: FrameCapturer | null): void {
		this.capturer = capturer;
	}

	/**
	 * Provide who hears about held actions (the approval service).
	 *
	 * @param listener - Listener, or null to remove it
	 */
	setHoldListener(listener: BrowserHoldListener | null): void {
		this.holdListener = listener;
	}

	/**
	 * Put a held action back after a restart, once its tab was re-bound.
	 *
	 * @param input - The agent, where it was, and the hold
	 * @returns The restored session (a copy)
	 */
	restorePending(input: {
		agentSession: string;
		agentName?: string;
		url?: string;
		tabId?: number;
		pending: PendingConfirmation;
		/** Where the owner answers, as the agent is told */
		where?: string;
	}): BrowserSession {
		const now = Date.now();
		const existing = this.sessions.get(input.agentSession);
		const session: BrowserSession = existing ?? {
			id: input.agentSession,
			agentSession: input.agentSession,
			status: 'waiting_owner',
			control: 'agent',
			lastAction: input.pending.description,
			lastActionAt: now,
			startedAt: now,
		};
		session.pending = { ...input.pending };
		session.status = 'waiting_owner';
		if (input.where) this.holdWhere.set(input.agentSession, input.where);
		delete session.endedAt;
		if (input.agentName) session.agentName = input.agentName;
		if (input.url) session.url = input.url;
		if (typeof input.tabId === 'number') session.tabId = input.tabId;
		this.sessions.set(input.agentSession, session);
		this.dirty.add(input.agentSession);
		this.logger.info('Restored a held browser action after a restart', {
			agentSession: input.agentSession,
			pendingId: input.pending.id,
		});
		return { ...session };
	}

	/**
	 * Turn the irreversible-action hold on or off.
	 *
	 * @param enabled - Whether to hold irreversible actions for the owner
	 */
	setConfirmBeforeIrreversible(enabled: boolean): void {
		this.confirmBeforeIrreversible = enabled;
		this.logger.info('Irreversible-action hold changed', { enabled });
	}

	/**
	 * Whether irreversible actions are currently held.
	 *
	 * @returns True when the hold is on
	 */
	isConfirmBeforeIrreversible(): boolean {
		return this.confirmBeforeIrreversible;
	}

	/** Starts the capture loop. Safe to call twice. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, BROWSER_SESSION_CONSTANTS.TICK_INTERVAL_MS);
		this.timer.unref?.();
		this.logger.info('Browser session tracking started', {
			tickMs: BROWSER_SESSION_CONSTANTS.TICK_INTERVAL_MS,
		});
	}

	/** Stops the capture loop. Sessions and frames are left in place. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Record that an agent performed a browser action.
	 *
	 * Called from the single dispatch choke point in the browser controller,
	 * so every tool is covered without each handler having to remember.
	 *
	 * @param input - The action that just succeeded
	 */
	noteAction(input: {
		agentSession: string;
		tool: string;
		params?: Record<string, unknown>;
		agentName?: string;
		goal?: string;
		tabId?: number;
	}): void {
		const { agentSession, tool, params } = input;
		if (!agentSession) return;

		const now = Date.now();
		let session = this.sessions.get(agentSession);
		if (!session) {
			session = {
				id: agentSession,
				agentSession,
				status: 'reading',
				control: 'agent',
				lastAction: '',
				lastActionAt: now,
				startedAt: now,
			};
			this.sessions.set(agentSession, session);
		}

		// A finished session that acts again is a new piece of work, not a
		// resurrection of the old one — reset its clock and clear the stale
		// picture so the UI never shows a frame from a previous task.
		if (session.status === 'done' || session.status === 'stopped') {
			session.startedAt = now;
			delete session.endedAt;
			this.frames.delete(agentSession);
			delete session.frameAt;
		}

		session.status = statusForTool(tool);
		session.lastAction = describeAction(tool, params);
		session.lastActionAt = now;
		if (input.agentName) session.agentName = input.agentName;
		if (input.goal) session.goal = input.goal;
		if (typeof input.tabId === 'number') session.tabId = input.tabId;
		if (typeof params?.url === 'string') session.url = params.url;
		if (session.status === 'done') session.endedAt = now;

		this.dirty.add(agentSession);
	}

	/**
	 * Decide whether the agent may take this action, and hold it if not.
	 *
	 * Two things are checked, in order:
	 *
	 * 1. Whether the owner has taken the wheel. If so the agent is refused
	 *    outright — the two must never drive the same page at once, and the
	 *    owner is frequently mid-way through typing a password.
	 * 2. Whether the action looks irreversible and outward-facing. Sending a
	 *    message, submitting a form, paying, deleting: things that cannot be
	 *    taken back and that reach other people.
	 *
	 * The second check exists because of a real incident. An owner asked for
	 * an email to be *drafted*; the agent produced one and sent it. Nothing
	 * in the system could have stopped that, because at the browser layer
	 * "send an email" is a click on a button, indistinguishable from any
	 * other click. Every guard we had lived at the skill layer, and driving a
	 * browser goes around all of them.
	 *
	 * A held action is not an error. The agent is told to wait, the owner is
	 * shown what it wanted to do, and their answer decides.
	 *
	 * @param agentSession - Agent asking to act
	 * @param tool - Tool it wants to use
	 * @param params - Params it wants to use
	 * @returns `allow`, or a refusal carrying the reason to hand the agent
	 */
	authorize(
		agentSession: string,
		tool: string,
		params?: Record<string, unknown>,
		context: OutboundContext = {},
	): { allow: true } | { allow: false; code: string; reason: string; pendingId?: string } {
		const session = this.sessions.get(agentSession);
		// Where the tab really is now (read from the browser by the caller):
		// the agent may have clicked its way there, or work in a tab the owner
		// opened, so the last navigate is not enough.
		if (context.url && session) session.url = context.url;

		if (session?.control === 'owner') {
			return {
				allow: false,
				code: 'owner_has_control',
				reason:
					'The owner has taken control of this browser. Do not retry — wait, and you will be told when control comes back.',
			};
		}

		// An action already held must not be re-attempted under a new id.
		if (session?.pending) {
			return {
				allow: false,
				code: 'awaiting_owner',
				reason: `Still waiting for the owner to approve: ${session.pending.description}. ${this.holdWhere.get(agentSession) ?? HELD_ACTION_FALLBACK_LINE} Do not retry, do not try another way round it, and do not tell anyone to approve it in Chrome — you will get a [BROWSER] message with their answer.`,
				pendingId: session.pending.id,
			};
		}

		if (!this.confirmBeforeIrreversible) return { allow: true };

		const url = context.url ?? session?.url ?? (typeof params?.url === 'string' ? params.url : undefined);
		const page = pageOf(url);
		const tabId = context.tabId ?? (typeof params?.tabId === 'number' ? params.tabId : undefined);

		// A draft belongs to the page (and tab) it was typed on: navigating to
		// another page — or finding the tab on another page — ends it.
		const held = this.lastDraft.get(agentSession);
		if (held) {
			const navigatedAway = tool === 'navigate' && typeof params?.url === 'string' && pageOf(params.url) !== held.page;
			const sameTab = held.tabId === undefined || tabId === undefined || held.tabId === tabId;
			const elsewhereNow = !!page && sameTab && page !== held.page;
			if (navigatedAway || elsewhereNow) this.lastDraft.delete(agentSession);
		}

		// Remember what the agent typed (or wrote into the page with a script,
		// or pasted): a later click on "Post" publishes it, and the owner must
		// see that text on the card. A search query is not a draft.
		const typed = draftTextOf(tool, params);
		const code = typeof params?.code === 'string' ? params.code : '';
		const record = (text: string): void => {
			this.lastDraft.set(agentSession, { text, page, ...(tabId !== undefined ? { tabId } : {}) });
		};
		if (typed && (tool === 'type' || tool === 'fill' || tool === 'insertText') && !isSearchField(params)) {
			record(typed);
		} else if (typed && (tool === 'executeJs' || tool === 'executeScript') && scriptEditsContent(code)) {
			record(typed);
		} else if (tool === 'pressKey' && isPasteKey(params)) {
			record('(pasted from the clipboard — the text is not visible to Crewly)');
		}

		let matched = matchIrreversible(tool, params, { url });
		// Once the agent has written a draft on a social or mail site, any
		// action on that page may be the one that sends it — a Post button
		// named `#ember345`, Gmail's `div.T-I.J-J5-Ji.aoO`, `buttons[7].click()`,
		// Space on a focused button. Hold every acting step in that site and
		// tab until the owner approves (2026-10-03 reviews).
		const draft = this.lastDraft.get(agentSession);
		const draftHere = !!draft && draft.page === page && (draft.tabId === undefined || tabId === undefined || draft.tabId === tabId);
		if (!matched && draftHere && isSocialOrMessagingSite(url)) {
			if (actsOnPage(tool, params) || (tool === 'pressKey' && isActivateKey(params))) {
				matched = 'acting on the page after typing a draft on a social or mail site';
			}
		}
		if (!matched) return { allow: true };

		// Spend an approval the owner already gave — only on the very action
		// they approved. Approvals used to be keyed on the session alone, so
		// any next call (a screenshot) spent it, or a different irreversible
		// action rode on it.
		const fingerprint = actionFingerprint(tool, params);
		if (this.approvedOnce.get(agentSession) === fingerprint) {
			this.approvedOnce.delete(agentSession);
			return { allow: true };
		}

		const draftText = typed ?? (draftHere ? draft?.text : undefined);
		const max = BROWSER_OUTBOUND_GUARD.CARD_DRAFT_MAX_CHARS;
		const pending: PendingConfirmation = {
			// Unique even for two holds in the same millisecond: the id is also the
			// key of the persisted record and its Slack card.
			id: `${agentSession}:${Date.now()}:${++this.holdSeq}`,
			tool,
			description: describeAction(tool, params),
			matched,
			raisedAt: Date.now(),
			...(draftText ? { draftText: draftText.length > max ? `${draftText.slice(0, max - 1)}…` : draftText } : {}),
			fingerprint,
		};

		// Raising a hold creates the session if the agent had not acted yet,
		// so the owner can see the request either way.
		this.noteAction({ agentSession, tool, params });
		const target = this.sessions.get(agentSession);
		if (target) {
			target.pending = pending;
			target.status = 'waiting_owner';
			this.dirty.add(agentSession);
		}

		this.logger.warn('Held an irreversible browser action for the owner', {
			agentSession,
			tool,
			matched,
			description: pending.description,
		});

		// The listener asks the owner with a card in the agent's work thread.
		// Without one (no approval service), the dashboard is the only place.
		let where: string | undefined;
		if (target && this.holdListener) {
			try {
				where = this.holdListener.onHeld({ ...target, pending: { ...pending } }, params);
				if (where) this.holdWhere.set(agentSession, where);
				else this.holdWhere.delete(agentSession);
			} catch (err) {
				this.logger.warn('Hold listener failed', { agentSession, error: err instanceof Error ? err.message : String(err) });
			}
		}

		return {
			allow: false,
			code: 'awaiting_owner',
			reason: `This looks irreversible (${matched}) and needs the owner's OK. ${where ?? HELD_ACTION_FALLBACK_LINE} Do not retry, do not look for another way to do it, and do not tell anyone to approve it in Chrome — you will get a [BROWSER] message with their answer.`,
			pendingId: pending.id,
		};
	}

	/**
	 * Hand the wheel to the owner.
	 *
	 * @param agentSession - Session to take over
	 * @returns The updated session, or undefined when there is none
	 */
	takeControl(agentSession: string): BrowserSession | undefined {
		const session = this.sessions.get(agentSession);
		if (!session) return undefined;
		session.control = 'owner';
		session.controlTakenAt = Date.now();
		session.status = 'waiting_owner';
		this.dirty.add(agentSession);
		this.logger.info('Owner took control of a browser session', { agentSession });
		return { ...session };
	}

	/**
	 * Record something the owner did while holding the wheel.
	 *
	 * The description is written by the caller and must already be safe to
	 * show: for typing that means a character count, never the text — the
	 * owner is usually entering a password. Status and control are left as
	 * they are; the owner still has the browser.
	 *
	 * @param agentSession - Session the owner is driving
	 * @param description - What they did, e.g. `You typed 12 characters`
	 * @param url - Where the page is going, for a navigation
	 * @returns The updated session, or undefined when there is none or the
	 *          owner does not hold it
	 */
	noteOwnerAction(agentSession: string, description: string, url?: string): BrowserSession | undefined {
		const session = this.sessions.get(agentSession);
		if (!session || session.control !== 'owner') return undefined;
		session.lastAction = description;
		session.lastActionAt = Date.now();
		if (url) session.url = url;
		this.dirty.add(agentSession);
		return { ...session };
	}

	/**
	 * Give the wheel back to the agent.
	 *
	 * Any action that was held is dropped rather than resumed: the owner has
	 * been driving, so the page is no longer the one the agent was looking at
	 * and re-running its click blind would be worse than making it look again.
	 *
	 * @param agentSession - Session to release
	 * @returns The updated session, or undefined when there is none
	 */
	releaseControl(agentSession: string): BrowserSession | undefined {
		const session = this.sessions.get(agentSession);
		if (!session) return undefined;
		const dropped = session.pending?.id;
		session.control = 'agent';
		delete session.controlTakenAt;
		delete session.pending;
		if (dropped && this.holdListener) {
			try {
				this.holdListener.onDropped(agentSession, dropped);
			} catch {
				// Best-effort: the card is withdrawn on the next tick at worst.
			}
		}
		session.status = 'reading';
		this.dirty.add(agentSession);
		this.logger.info('Owner gave control back to the agent', { agentSession });
		return { ...session };
	}

	/**
	 * Resolve a held action.
	 *
	 * Approving clears the hold so the agent's next attempt goes through;
	 * it deliberately does not replay the action itself, because the agent
	 * is the one that knows what it was in the middle of.
	 *
	 * @param agentSession - Session holding the action
	 * @param pendingId - The hold being answered
	 * @param decision - What the owner chose
	 * @returns The updated session, or undefined when the id does not match
	 */
	resolvePending(
		agentSession: string,
		pendingId: string,
		decision: 'approve' | 'reject',
	): BrowserSession | undefined {
		const session = this.sessions.get(agentSession);
		if (!session?.pending || session.pending.id !== pendingId) return undefined;

		if (decision === 'approve') {
			// Keyed on the session (the retry gets a new hold id) and on the
			// action itself: only a retry of exactly the approved action gets
			// through. A held action never approves itself.
			const fingerprint = session.pending.fingerprint;
			if (fingerprint) this.approvedOnce.set(agentSession, fingerprint);
		}
		this.lastDraft.delete(agentSession);
		delete session.pending;
		session.status = decision === 'approve' ? 'acting' : 'reading';
		this.dirty.add(agentSession);
		this.logger.info('Owner resolved a held browser action', { agentSession, pendingId, decision });
		return { ...session };
	}

	/**
	 * Mark a session as finished.
	 *
	 * @param agentSession - The agent whose session ended
	 * @param reason - `done` when the agent finished, `stopped` when a person
	 *                 ended it
	 */
	endSession(agentSession: string, reason: 'done' | 'stopped' = 'done'): void {
		const session = this.sessions.get(agentSession);
		if (!session) return;
		session.status = reason;
		session.endedAt = Date.now();
		this.dirty.delete(agentSession);
	}

	/**
	 * All sessions, newest activity first.
	 *
	 * @param includeFinished - Include sessions that are done or stopped
	 * @returns Copies of the session records; frames are not included
	 */
	listSessions(includeFinished = true): BrowserSession[] {
		const all = Array.from(this.sessions.values())
			.filter((s) => includeFinished || (s.status !== 'done' && s.status !== 'stopped'))
			.sort((a, b) => b.lastActionAt - a.lastActionAt);
		return all.map((s) => ({ ...s }));
	}

	/**
	 * One session by id.
	 *
	 * @param id - Session id (the agent session name)
	 * @returns A copy, or undefined
	 */
	getSession(id: string): BrowserSession | undefined {
		const s = this.sessions.get(id);
		return s ? { ...s } : undefined;
	}

	/**
	 * Read the current frame, registering the caller as a viewer.
	 *
	 * Fetching a frame is what marks a session as watched, which is what
	 * raises its capture rate. There is no separate subscribe call to get out
	 * of sync, and interest expires on its own when nobody fetches.
	 *
	 * @param id - Session id
	 * @returns The frame, or undefined when none has been captured
	 */
	getFrame(id: string): BrowserFrame | undefined {
		this.lastViewedAt.set(id, Date.now());
		return this.frames.get(id);
	}

	/**
	 * Whether anyone has looked at this session recently.
	 *
	 * @param id - Session id
	 * @param now - Clock override for tests
	 * @returns True when a frame was fetched inside the watch window
	 */
	isWatched(id: string, now = Date.now()): boolean {
		const seen = this.lastViewedAt.get(id);
		return seen !== undefined && now - seen <= BROWSER_SESSION_CONSTANTS.WATCH_WINDOW_MS;
	}

	/**
	 * Decide whether a session is due for a capture.
	 *
	 * Watched sessions refresh on a short interval whether or not the agent
	 * did anything, because the page can change on its own. Unwatched ones
	 * refresh only after an action, and slowly — a picture nobody is looking
	 * at is pure cost on the agent's browser.
	 *
	 * @param id - Session id
	 * @param now - Clock override for tests
	 * @returns True when a frame should be captured now
	 */
	shouldCapture(id: string, now = Date.now()): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === 'done' || session.status === 'stopped') return false;
		if (this.capturing.has(id)) return false;

		const age = now - (session.frameAt ?? 0);
		if (this.isWatched(id, now)) {
			return age >= BROWSER_SESSION_CONSTANTS.WATCHED_FRAME_INTERVAL_MS;
		}
		return this.dirty.has(id) && age >= BROWSER_SESSION_CONSTANTS.IDLE_FRAME_INTERVAL_MS;
	}

	/**
	 * One pass of the capture loop.
	 *
	 * @returns How many sessions were captured
	 */
	async tick(): Promise<number> {
		if (!this.capturer) return 0;

		const now = Date.now();
		const due = Array.from(this.sessions.keys()).filter((id) => this.shouldCapture(id, now));
		if (due.length === 0) return 0;

		await Promise.all(due.map((id) => this.captureFrame(id)));
		return due.length;
	}

	/**
	 * Capture one session's frame.
	 *
	 * A failure is recorded on the session and otherwise swallowed: a page
	 * that cannot be captured (a restricted URL, a tab the user closed) must
	 * not stop the agent or the loop.
	 *
	 * @param id - Session id
	 * @returns True when a new frame was stored
	 */
	async captureFrame(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session || !this.capturer || this.capturing.has(id)) return false;

		this.capturing.add(id);
		try {
			const scale = this.legacyExtension.has(id) ? undefined : BROWSER_SESSION_CONSTANTS.FRAME_SCALE;
			const shot = await this.capturer(session.agentSession, {
				format: BROWSER_SESSION_CONSTANTS.FRAME_FORMAT,
				quality: BROWSER_SESSION_CONSTANTS.FRAME_QUALITY,
				...(scale !== undefined ? { scale } : {}),
			});

			if (!shot?.base64) {
				session.frameError = 'No image returned';
				return false;
			}

			this.frames.set(id, {
				base64: shot.base64,
				mimeType: shot.format === 'jpeg' ? 'image/jpeg' : 'image/png',
				capturedAt: Date.now(),
				...(shot.devicePixelRatio !== undefined ? { devicePixelRatio: shot.devicePixelRatio } : {}),
				...(scale !== undefined ? { scale } : {}),
			});
			session.frameAt = Date.now();
			delete session.frameError;
			this.dirty.delete(id);
			return true;
		} catch (err) {
			session.frameError = err instanceof Error ? err.message : String(err);
			// Do not retry immediately — clearing dirty stops a broken page
			// from being hammered once per tick.
			this.dirty.delete(id);
			return false;
		} finally {
			this.capturing.delete(id);
		}
	}

	/**
	 * Note that a session's extension is too old for scaled, clipped frames
	 * and for `wheel` (it answered "Unknown tool: wheel"). From now on its
	 * frames are captured unscaled — bigger, but never white — and owner
	 * scrolling skips `wheel`.
	 *
	 * @param id - Session id
	 */
	markLegacyExtension(id: string): void {
		this.legacyExtension.add(id);
	}

	/**
	 * Whether a session's extension was found to be too old for `wheel`.
	 *
	 * @param id - Session id
	 * @returns True after {@link markLegacyExtension}
	 */
	isLegacyExtension(id: string): boolean {
		return this.legacyExtension.has(id);
	}

	/**
	 * Forget every "too old" mark — the extension was just reloaded, possibly
	 * into a newer build, so each session finds out again.
	 */
	clearLegacyExtensionMarks(): void {
		this.legacyExtension.clear();
	}

	/**
	 * Forget sessions that finished a while ago, and their frames.
	 *
	 * @param now - Clock override for tests
	 * @returns How many sessions were dropped
	 */
	prune(now = Date.now()): number {
		let dropped = 0;
		for (const [id, session] of this.sessions) {
			const ended = session.endedAt;
			if (ended !== undefined && now - ended > BROWSER_SESSION_CONSTANTS.RETAIN_FINISHED_MS) {
				this.sessions.delete(id);
				this.frames.delete(id);
				this.lastViewedAt.delete(id);
				this.dirty.delete(id);
				this.legacyExtension.delete(id);
				dropped += 1;
			}
		}
		return dropped;
	}

	/** Drops all state (tests). */
	clear(): void {
		this.sessions.clear();
		this.holdWhere.clear();
		this.frames.clear();
		this.lastViewedAt.clear();
		this.dirty.clear();
		this.capturing.clear();
		this.legacyExtension.clear();
	}
}

/**
 * Convenience accessor for the shared browser session service.
 *
 * @returns The singleton instance
 */
export function getBrowserSessions(): BrowserSessionService {
	return BrowserSessionService.getInstance();
}
