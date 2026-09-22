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
export type BrowserSessionStatus = 'navigating' | 'reading' | 'acting' | 'stopped' | 'done';

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
