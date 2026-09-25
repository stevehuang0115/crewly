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
import { BROWSER_SESSION_CONSTANTS } from '../../constants.js';

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
}

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
	options: { format: string; quality: number; scale: number },
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
]);

/**
 * Words that mark a control as doing something that cannot be undone and that
 * reaches other people.
 *
 * Deliberately matched against the selector and any text the agent passed,
 * not against the page — we are judging what the agent asked for, which is
 * the thing we can attribute to it. Kept short and specific: a list that
 * matches everything trains people to click through it, which is worse than
 * no list at all.
 */
const IRREVERSIBLE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bsend\b|发送|送信/i, 'sending'],
	[/\bsubmit\b|提交/i, 'submitting'],
	[/\bpay\b|\bpurchase\b|\bcheckout\b|\border\b|付款|支付|结[账帐]/i, 'paying'],
	[/\bdelete\b|\bremove\b|删除/i, 'deleting'],
	[/\bconfirm\b|\bagree\b|\baccept\b|确认|同意/i, 'confirming'],
	[/\bpublish\b|\bpost\b|发布/i, 'publishing'],
	[/\bsign\b|\bsignature\b|签署|签名/i, 'signing'],
];

/**
 * What makes a page script act rather than read: clicking, submitting a form,
 * dispatching events, or sending a request out of the page.
 */
const SCRIPT_ACTION =
	/\.click\s*\(|\.submit\s*\(|requestSubmit\s*\(|dispatchEvent\s*\(|new\s+(Mouse|Keyboard|Pointer|Submit)Event\b|sendBeacon\s*\(|XMLHttpRequest|fetch\s*\([^)]*method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i;

/**
 * Decide whether an action looks irreversible and outward-facing.
 *
 * @param tool - Tool the agent wants to use
 * @param params - Params it wants to use
 * @returns A short label for what it looks like, or null
 *
 * @example
 * ```typescript
 * matchIrreversible('click', { selector: 'button[aria-label="Send"]' }); // 'sending'
 * matchIrreversible('readText', {});                                     // null
 * ```
 */
export function matchIrreversible(tool: string, params?: Record<string, unknown>): string | null {
	if (!WRITING_TOOLS.has(tool)) return null;

	// `pressKey` is only interesting for the combinations that submit.
	if (tool === 'pressKey') {
		const key = String(params?.key ?? '');
		return /^(Enter|NumpadEnter)$/i.test(key) || /\bMeta\+Enter|Control\+Enter\b/i.test(key)
			? 'submitting with a keystroke'
			: null;
	}

	// A page script is only an action if it does something: clicks, submits a
	// form, fires events or sends a request. A script that only reads the page
	// can mention "submit" all it likes — Ella's read of a form's fields
	// (`button[type=submit]` in a selector) was held for the owner as
	// "submitting" and stalled the job (2026-09-25).
	if ((tool === 'executeJs' || tool === 'executeScript') && typeof params?.code === 'string' && !SCRIPT_ACTION.test(params.code)) {
		return null;
	}

	const haystack = [params?.selector, params?.text, params?.value, params?.code]
		.filter((v): v is string => typeof v === 'string')
		.join(' ');
	if (!haystack) return null;

	for (const [pattern, label] of IRREVERSIBLE_WORDS) {
		if (pattern.test(haystack)) return label;
	}
	return null;
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
	private readonly approvedOnce: Set<string> = new Set();
	/**
	 * Whether irreversible actions are held for the owner.
	 *
	 * On by default. An owner who wants an agent to work unattended can turn
	 * it off, but that has to be a decision someone makes, not the state we
	 * ship in.
	 */
	private confirmBeforeIrreversible = true;

	private capturer: FrameCapturer | null = null;
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
	): { allow: true } | { allow: false; code: string; reason: string; pendingId?: string } {
		const session = this.sessions.get(agentSession);

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
				reason: `Waiting for the owner to approve: ${session.pending.description}. Do not retry and do not try another way round it.`,
				pendingId: session.pending.id,
			};
		}

		if (!this.confirmBeforeIrreversible) return { allow: true };

		// Spend an approval the owner already gave.
		if (this.approvedOnce.has(agentSession)) {
			this.approvedOnce.delete(agentSession);
			return { allow: true };
		}

		const matched = matchIrreversible(tool, params);
		if (!matched) return { allow: true };

		const pending: PendingConfirmation = {
			id: `${agentSession}:${Date.now()}`,
			tool,
			description: describeAction(tool, params),
			matched,
			raisedAt: Date.now(),
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

		return {
			allow: false,
			code: 'awaiting_owner',
			reason: `This looks irreversible (${matched}) and needs the owner to approve it. Stop here and tell the owner what you are waiting on. Do not retry and do not look for another way to do it.`,
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
		session.control = 'agent';
		delete session.controlTakenAt;
		delete session.pending;
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
			// Keyed on the session: the agent will retry, and the retry must
			// get through. Keyed on the hold id it would be held again under a
			// new id and loop forever.
			this.approvedOnce.add(agentSession);
		}
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
			const shot = await this.capturer(session.agentSession, {
				format: BROWSER_SESSION_CONSTANTS.FRAME_FORMAT,
				quality: BROWSER_SESSION_CONSTANTS.FRAME_QUALITY,
				scale: BROWSER_SESSION_CONSTANTS.FRAME_SCALE,
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
				dropped += 1;
			}
		}
		return dropped;
	}

	/** Drops all state (tests). */
	clear(): void {
		this.sessions.clear();
		this.frames.clear();
		this.lastViewedAt.clear();
		this.dirty.clear();
		this.capturing.clear();
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
