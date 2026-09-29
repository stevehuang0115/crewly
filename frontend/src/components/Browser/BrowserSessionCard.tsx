/**
 * BrowserSessionCard — one agent's browser work, with a live picture.
 *
 * An agent driving a browser is the one activity whose real state lives
 * entirely outside Crewly. Without a picture you are reading a list of tool
 * calls and taking the agent's word for what the page said, which is exactly
 * how an agent ends up confidently describing a page it misread.
 *
 * The card polls the frame endpoint while it is on screen. Fetching a frame is
 * what tells the backend someone is watching, which is what raises the capture
 * rate — so an off-screen or closed card costs nothing within a few seconds,
 * with no unsubscribe to get wrong.
 *
 * Once the owner takes the wheel the picture becomes something they can use:
 * clicking (or tapping, on a phone) the frame clicks that spot on the page,
 * and a control bar underneath types, presses keys, scrolls, goes back and
 * opens an address. The frame refreshes faster while they drive.
 *
 * @module components/Browser/BrowserSessionCard
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, AlertTriangle } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import {
	frameUrl,
	takeBrowserControl,
	releaseBrowserControl,
	resolveBrowserPending,
	sendBrowserInput,
	type OwnerBrowserInput,
	type BrowserSession,
	type BrowserSessionStatus,
} from '../../services/browser-session.service';
import { frameTapFromEvent } from '../../utils/browser-tap';
import { BrowserOwnerControls } from './BrowserOwnerControls';

/** How often an expanded card asks for a fresh frame. */
const FRAME_POLL_MS = 1500;
/** How often it asks while the owner is driving, so their actions show quickly. */
export const OWNER_FRAME_POLL_MS = 600;
/** How long the tap ripple stays on screen (ms). */
const RIPPLE_MS = 600;

/** Label and dot colour per status. */
const STATUS_STYLE: Record<BrowserSessionStatus, { label: string; dot: string }> = {
	navigating: { label: 'Navigating', dot: 'bg-sky-400' },
	reading: { label: 'Reading page', dot: 'bg-sky-400' },
	acting: { label: 'Acting on page', dot: 'bg-amber-400' },
	waiting_owner: { label: 'Waiting for you', dot: 'bg-amber-400' },
	stopped: { label: 'Stopped by you', dot: 'bg-red-400' },
	done: { label: 'Finished', dot: 'bg-text-secondary-dark' },
};

/**
 * Strip a URL down to its host for display.
 *
 * The full URL routinely carries a session token or an account id in the
 * query string, and this label sits in a list someone may screen-share.
 *
 * @param url - Full URL, when known
 * @returns The hostname, or an empty string
 */
export function hostOf(url?: string): string {
	if (!url) return '';
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

/** Props for {@link BrowserSessionCard}. */
export interface BrowserSessionCardProps {
	/** The session to render */
	session: BrowserSession;
	/** Whether the live picture is shown and polled */
	expanded: boolean;
	/** Called when the header is clicked */
	onToggle: () => void;
	/** Called when the owner stops the session */
	onStop?: (id: string) => void;
	/** Called after any control action, so the list can refresh */
	onChanged?: () => void;
}

/**
 * Renders one browser session.
 *
 * @param props - See {@link BrowserSessionCardProps}
 * @returns The card element
 */
export const BrowserSessionCard: React.FC<BrowserSessionCardProps> = ({
	session,
	expanded,
	onToggle,
	onStop,
	onChanged,
}) => {
	// Bumped on a timer while expanded; folded into the image URL so the
	// browser refetches on our schedule rather than caching the first frame.
	const [tick, setTick] = useState(0);
	const [busy, setBusy] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);

	const live = session.status !== 'done' && session.status !== 'stopped';
	const driving = live && session.control === 'owner';

	useEffect(() => {
		if (!expanded) return;
		const id = setInterval(() => setTick((t) => t + 1), driving ? OWNER_FRAME_POLL_MS : FRAME_POLL_MS);
		return () => clearInterval(id);
	}, [expanded, driving]);

	/**
	 * Carry out one owner input and pull a fresh picture straight away.
	 *
	 * @param input - What the owner did
	 * @returns Whether the backend carried it out
	 */
	const drive = useCallback(
		async (input: OwnerBrowserInput): Promise<boolean> => {
			setBusy(true);
			setInputError(null);
			const result = await sendBrowserInput(session.id, input);
			setBusy(false);
			if (!result.ok) setInputError(result.error ?? 'That did not go through');
			setTick((t) => t + 1);
			onChanged?.();
			return result.ok;
		},
		[session.id, onChanged],
	);

	/** A click or tap on the frame clicks the same spot on the page. */
	const onFrameClick = (e: React.MouseEvent<HTMLImageElement>): void => {
		if (!driving || !imgRef.current) return;
		const hit = frameTapFromEvent(e.clientX, e.clientY, imgRef.current);
		if (!hit) return;
		const id = Date.now();
		setRipple({ x: hit.renderedX, y: hit.renderedY, id });
		setTimeout(() => setRipple((r) => (r?.id === id ? null : r)), RIPPLE_MS);
		void drive({ kind: 'tap', ...hit.tap });
	};

	const style = STATUS_STYLE[session.status] ?? STATUS_STYLE.reading;
	const host = hostOf(session.url);

	return (
		<Card padding="md">
			<button
				type="button"
				onClick={onToggle}
				className="w-full flex items-start gap-3 text-left"
				aria-expanded={expanded}
			>
				<div className="mt-0.5 rounded-md bg-background-dark p-2">
					<Globe className="w-4 h-4 text-text-secondary-dark" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium text-text-primary-dark truncate">
							{session.agentName || session.agentSession}
						</span>
						<span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
							<span className={`inline-block w-1.5 h-1.5 rounded-full ${style.dot}`} />
							{style.label}
						</span>
					</div>
					<p className="text-xs text-text-secondary-dark mt-0.5 truncate">
						{session.lastAction}
						{host ? ` · ${host}` : ''}
					</p>
					{session.goal && (
						<p className="text-xs text-text-secondary-dark/70 mt-0.5 truncate">Goal: {session.goal}</p>
					)}
				</div>
				{live && onStop && (
					<span
						role="button"
						tabIndex={0}
						onClick={(e) => {
							e.stopPropagation();
							onStop(session.id);
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.stopPropagation();
								onStop(session.id);
							}
						}}
						className="text-xs px-2 py-1 rounded border border-border-dark text-text-secondary-dark hover:text-text-primary-dark"
					>
						Stop
					</span>
				)}
			</button>

			{expanded && (
				<div className="mt-3">
					{live && session.control === 'agent' && session.status === 'waiting_owner' && !session.pending && (
						<p className="mb-2 text-xs text-amber-300" data-testid="take-control-hint">
							{session.agentName || session.agentSession} is waiting for you. Take control of the browser,
							then click on the page to act.
						</p>
					)}
					{driving && (
						<p className="mb-2 text-xs text-amber-300" data-testid="driving-hint">
							You are driving. Click the picture to click that spot on the page; use the bar below to type.
						</p>
					)}
					{session.frameAt ? (
						<div className="relative">
							<img
								ref={imgRef}
								// `tick` forces a refetch on our cadence; `frameAt` makes a
								// genuinely new frame land immediately.
								src={`${frameUrl(session.id, session.frameAt)}&p=${tick}`}
								alt={`What ${session.agentName || session.agentSession} sees`}
								onClick={driving ? onFrameClick : undefined}
								draggable={false}
								className={`w-full rounded-md border bg-background-dark select-none ${
									driving ? 'border-amber-400/60 cursor-crosshair touch-manipulation' : 'border-border-dark'
								}`}
							/>
							{ripple && (
								<span
									aria-hidden="true"
									data-testid="tap-ripple"
									className="pointer-events-none absolute w-6 h-6 -ml-3 -mt-3 rounded-full border-2 border-amber-300 animate-ping"
									style={{ left: ripple.x, top: ripple.y }}
								/>
							)}
						</div>
					) : (
						<div className="rounded-md border border-dashed border-border-dark px-3 py-6 text-center text-xs text-text-secondary-dark">
							Waiting for the first frame…
						</div>
					)}

					{session.frameError && (
						<p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
							<AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
							Could not capture this page: {session.frameError}
						</p>
					)}

					{driving && (
						<>
							<BrowserOwnerControls onInput={drive} disabled={busy} />
							{inputError && (
								<p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300" role="alert">
									<AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
									{inputError}
								</p>
							)}
						</>
					)}

					{session.pending && (
						<div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
							<p className="text-xs text-amber-200">
								<strong>{session.agentName || session.agentSession} is waiting on you.</strong> It wants
								to do something that cannot be undone: {session.pending.description} (
								{session.pending.matched}).
							</p>
							<div className="mt-2 flex gap-2">
								<Button
									type="button"
									onClick={async () => {
										await resolveBrowserPending(session.id, session.pending!.id, 'approve');
										onChanged?.();
									}}
									variant="warning"
									size="xs"
								>
									Let it
								</Button>
								<Button
									type="button"
									onClick={async () => {
										await resolveBrowserPending(session.id, session.pending!.id, 'reject');
										onChanged?.();
									}}
									variant="outline"
									size="xs"
								>
									No
								</Button>
							</div>
						</div>
					)}

					{live && (
						<div className="mt-3 flex items-center gap-2">
							{session.control === 'owner' ? (
								<>
									<span className="text-xs text-amber-300">You have the browser.</span>
									<Button
										type="button"
										onClick={async () => {
											await releaseBrowserControl(session.id);
											onChanged?.();
										}}
										variant="outline"
										size="xs"
									>
										Give control back
									</Button>
								</>
							) : (
								<Button
									type="button"
									onClick={async () => {
										await takeBrowserControl(session.id);
										onChanged?.();
									}}
									variant="outline"
									size="xs"
								>
									Take control of the browser
								</Button>
							)}
						</div>
					)}

					<p className="mt-2 text-xs text-text-secondary-dark/70">
						This picture is only ever shown here. It is held in memory, never saved, and never attached
						to a chat message or posted to Slack.
						{session.control === 'owner' && ' While you hold the browser the agent is locked out of it.'}
					</p>
				</div>
			)}
		</Card>
	);
};
