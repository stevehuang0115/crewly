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
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { StatusLabel, type StatusTone } from '@crewly/ui';
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

/** Label and status tone per status (status = colour + word). */
const STATUS_STYLE: Record<BrowserSessionStatus, { label: string; tone: StatusTone }> = {
	navigating: { label: 'Navigating', tone: 'primary' },
	reading: { label: 'Reading page', tone: 'primary' },
	acting: { label: 'Acting on page', tone: 'attention' },
	waiting_owner: { label: 'Waiting for you', tone: 'attention' },
	stopped: { label: 'Stopped by you', tone: 'danger' },
	done: { label: 'Finished', tone: 'neutral' },
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

	const takeControl = async (): Promise<void> => {
		await takeBrowserControl(session.id);
		onChanged?.();
	};
	const giveBack = async (): Promise<void> => {
		await releaseBrowserControl(session.id);
		onChanged?.();
	};

	return (
		<article className="rounded-2xl border border-border bg-surface p-4" data-testid="browser-session-card">
			<div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
				<button
					type="button"
					onClick={onToggle}
					className="flex min-w-0 flex-1 basis-56 items-start gap-3 text-left"
					aria-expanded={expanded}
				>
					<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.5rem] bg-surface-2 text-text-2">
						{expanded ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
					</span>
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span className="truncate text-[15px] font-semibold text-text">
								{session.agentName || session.agentSession}
							</span>
							<StatusLabel tone={style.tone} size="sm" pulse={live && style.tone === 'primary'}>
								{style.label}
							</StatusLabel>
						</span>
						<span className="mt-0.5 block truncate text-[13px] text-text-2">
							{session.lastAction}
							{host ? ` · ${host}` : ''}
						</span>
						{session.goal && (
							<span className="mt-0.5 block truncate text-[13px] text-text-3">Goal: {session.goal}</span>
						)}
					</span>
				</button>

				{live && (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{session.control === 'owner' ? (
							<>
								<span className="text-[13px] font-semibold text-attention">You have the browser.</span>
								<Button type="button" onClick={giveBack} variant="outline" size="sm">
									Give control back
								</Button>
							</>
						) : (
							<Button type="button" onClick={takeControl} variant="outline" size="sm">
								Take control of the browser
							</Button>
						)}
						{onStop && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="text-danger"
								onClick={(e) => {
									e.stopPropagation();
									onStop(session.id);
								}}
							>
								Stop
							</Button>
						)}
					</div>
				)}
			</div>

			{expanded && (
				<div className="mt-3">
					{live && session.control === 'agent' && session.status === 'waiting_owner' && !session.pending && (
						<p className="mb-2 text-xs text-attention" data-testid="take-control-hint">
							{session.agentName || session.agentSession} is waiting for you. Take control of the browser,
							then click on the page to act.
						</p>
					)}
					{driving && (
						<p className="mb-2 text-xs text-attention" data-testid="driving-hint">
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
								className={`w-full rounded-[0.5rem] border bg-bg select-none ${
									driving ? 'border-attention/60 cursor-crosshair touch-manipulation' : 'border-border-soft'
								}`}
							/>
							{ripple && (
								<span
									aria-hidden="true"
									data-testid="tap-ripple"
									className="pointer-events-none absolute w-6 h-6 -ml-3 -mt-3 rounded-full border-2 border-attention animate-ping"
									style={{ left: ripple.x, top: ripple.y }}
								/>
							)}
						</div>
					) : (
						<div className="rounded-[0.5rem] border border-dashed border-border-soft px-3 py-6 text-center text-xs text-text-2">
							Waiting for the first frame…
						</div>
					)}

					{session.frameError && (
						<p className="mt-2 flex items-start gap-1.5 text-xs text-attention">
							<AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
							Could not capture this page: {session.frameError}
						</p>
					)}

					{driving && (
						<>
							<BrowserOwnerControls onInput={drive} disabled={busy} />
							{inputError && (
								<p className="mt-2 flex items-start gap-1.5 text-xs text-attention" role="alert">
									<AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
									{inputError}
								</p>
							)}
						</>
					)}

					{session.pending && (
						<div className="mt-3 rounded-[0.5rem] border border-attention/40 bg-attention-soft px-3 py-2">
							<p className="text-xs text-text">
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

					<p className="mt-2 text-xs text-text-3">
						This picture is only ever shown here. It is held in memory, never saved, and never attached
						to a chat message or posted to Slack.
						{session.control === 'owner' && ' While you hold the browser the agent is locked out of it.'}
					</p>
				</div>
			)}
		</article>
	);
};
