/**
 * Browser session client.
 *
 * Talks to `/api/browser/sessions`, which reports what each agent is doing in
 * the browser and hands back a recent picture of the page.
 *
 * Frames are deliberately not fetched as JSON here. The endpoint returns image
 * bytes so a plain `<img src>` can point at it, which keeps the picture out of
 * application state — nothing to accidentally log, serialise into a chat
 * message or persist.
 *
 * @module services/browser-session.service
 */

/** What an agent is doing with the browser right now. */
export type BrowserSessionStatus =
	| 'navigating'
	| 'reading'
	| 'acting'
	| 'waiting_owner'
	| 'stopped'
	| 'done';

/** Who is allowed to drive the tab. */
export type BrowserControl = 'agent' | 'owner';

/** Something the agent wants to do that needs the owner to decide. */
export interface PendingConfirmation {
	id: string;
	tool: string;
	description: string;
	matched: string;
	raisedAt: number;
}

/** One agent's live browser activity, as the backend reports it. */
export interface BrowserSession {
	id: string;
	agentSession: string;
	agentName?: string;
	goal?: string;
	tabId?: number;
	url?: string;
	status: BrowserSessionStatus;
	lastAction: string;
	lastActionAt: number;
	startedAt: number;
	endedAt?: number;
	frameAt?: number;
	frameError?: string;
	control: BrowserControl;
	controlTakenAt?: number;
	pending?: PendingConfirmation;
}

/**
 * Fetch every tracked browser session.
 *
 * @param activeOnly - Leave out sessions that already finished
 * @returns The sessions, most recent activity first; empty on any failure
 */
export async function fetchBrowserSessions(activeOnly = false): Promise<BrowserSession[]> {
	try {
		const res = await fetch(`/api/browser/sessions${activeOnly ? '?active=1' : ''}`);
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: { sessions?: BrowserSession[] } };
		return body.data?.sessions ?? [];
	} catch {
		return [];
	}
}

/**
 * URL for a session's current frame.
 *
 * `frameAt` is folded into the query string as a cache-buster so the browser
 * refetches exactly when a new frame exists and not otherwise — the endpoint
 * is `no-store`, but without a changing URL React would not remount the image.
 *
 * @param id - Session id
 * @param frameAt - Capture timestamp of the frame currently on offer
 * @returns A URL suitable for an `<img src>`
 */
export function frameUrl(id: string, frameAt?: number): string {
	return `/api/browser/sessions/${encodeURIComponent(id)}/frame?t=${frameAt ?? 0}`;
}

/**
 * Fetch the session's current frame as an image.
 *
 * Returns null for anything that is not a picture — a 404 before the first
 * capture, an error, an empty body — so the caller can keep showing the last
 * good frame instead of a broken or blank one.
 *
 * @param id - Session id
 * @param frameAt - Capture time the caller knows of (cache key)
 * @param nonce - Bumped on every poll so each one is a fresh request
 * @returns The frame and its capture time, or null
 */
export async function fetchBrowserFrame(id: string, frameAt: number | undefined, nonce: number): Promise<FetchedFrame | null> {
	try {
		const res = await fetch(`${frameUrl(id, frameAt)}&p=${nonce}`, { cache: 'no-store' });
		if (!res.ok) return null;
		const blob = await res.blob();
		if (!(blob.size > 0 && blob.type.startsWith('image/'))) return null;
		const at = Number(res.headers.get('X-Frame-Captured-At'));
		return { blob, ...(Number.isFinite(at) && at > 0 ? { capturedAt: at } : {}) };
	} catch {
		return null;
	}
}

/**
 * Turn a base64 frame (as the input reply carries it) into a Blob.
 *
 * @param frame - The frame
 * @returns The image as a Blob
 */
export function frameToBlob(frame: BrowserFramePayload): Blob {
	const bin = atob(frame.base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: frame.mimeType });
}

/**
 * Take the wheel from the agent.
 *
 * @param id - Session id
 * @returns True when the backend accepted it
 */
export async function takeBrowserControl(id: string): Promise<boolean> {
	return postSession(id, 'take-control');
}

/**
 * Give the wheel back to the agent.
 *
 * @param id - Session id
 * @returns True when the backend accepted it
 */
export async function releaseBrowserControl(id: string): Promise<boolean> {
	return postSession(id, 'release-control');
}

/**
 * Answer an action the agent is held on.
 *
 * @param id - Session id
 * @param pendingId - The hold being answered
 * @param decision - What the owner chose
 * @returns True when the backend accepted it
 */
export async function resolveBrowserPending(
	id: string,
	pendingId: string,
	decision: 'approve' | 'reject',
): Promise<boolean> {
	try {
		const res = await fetch(
			`/api/browser/sessions/${encodeURIComponent(id)}/pending/${encodeURIComponent(pendingId)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ decision }),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * POST a session sub-resource with no body.
 *
 * @param id - Session id
 * @param action - Path segment under the session
 * @returns True when the backend accepted it
 */
async function postSession(id: string, action: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/browser/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Mark a session stopped by its owner.
 *
 * Ends the watchable session; it does not yet interrupt the agent mid-action.
 *
 * @param id - Session id
 * @returns True when the backend accepted it
 */
export async function stopBrowserSession(id: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/browser/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
		return res.ok;
	} catch {
		return false;
	}
}

/** A key the owner can press from the control bar. */
export type OwnerBrowserKey = 'Enter' | 'Tab' | 'Backspace' | 'Escape' | 'ArrowUp' | 'ArrowDown';

/** One thing the owner does to a browser they have taken over. */
export type OwnerBrowserInput =
	| { kind: 'tap'; x: number; y: number; frameWidth: number; frameHeight: number }
	| { kind: 'type'; text: string }
	| { kind: 'key'; key: OwnerBrowserKey }
	| { kind: 'scroll'; dy: number }
	/**
	 * A drag on the frame: start point and finger travel in frame pixels. A
	 * finger dragged up (negative dy) scrolls the page down.
	 */
	| { kind: 'swipe'; x: number; y: number; dx: number; dy: number; frameWidth: number; frameHeight: number }
	| { kind: 'navigate'; url: string }
	| { kind: 'back' };

/** A frame as the input reply carries it. */
export interface BrowserFramePayload {
	base64: string;
	mimeType: string;
	capturedAt: number;
}

/** What {@link sendBrowserInput} reports back. */
export interface BrowserInputResult {
	ok: boolean;
	/** Why it failed, in the backend's words */
	error?: string;
	/** Capture time of the fresh frame taken after the action, if any */
	frameAt?: number;
	/** That frame itself, so it can be shown without waiting for a poll */
	frame?: BrowserFramePayload;
}

/** A polled frame, with its capture time when the backend sent one. */
export interface FetchedFrame {
	blob: Blob;
	/** From `X-Frame-Captured-At`; undefined when absent */
	capturedAt?: number;
}

/**
 * Drive the browser as the owner, while the owner holds the wheel.
 *
 * The body is sent and forgotten: nothing here keeps it, because for `type`
 * it is usually a password.
 *
 * @param id - Session id
 * @param input - What the owner did
 * @returns Whether the backend carried it out
 */
export async function sendBrowserInput(id: string, input: OwnerBrowserInput): Promise<BrowserInputResult> {
	try {
		const res = await fetch(`/api/browser/sessions/${encodeURIComponent(id)}/input`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(input),
		});
		const body = (await res.json().catch(() => ({}))) as {
			error?: string;
			data?: { frame?: Partial<BrowserFramePayload>; session?: { frameAt?: number } };
		};
		if (!res.ok) return { ok: false, error: body.error ?? `Failed (${res.status})` };
		const frameAt = body.data?.frame?.capturedAt ?? body.data?.session?.frameAt;
		const f = body.data?.frame;
		const frame =
			f?.base64 && f.mimeType && typeof f.capturedAt === 'number'
				? { base64: f.base64, mimeType: f.mimeType, capturedAt: f.capturedAt }
				: undefined;
		return { ok: true, ...(frameAt ? { frameAt } : {}), ...(frame ? { frame } : {}) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
