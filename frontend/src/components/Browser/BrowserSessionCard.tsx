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
 * @module components/Browser/BrowserSessionCard
 */

import React, { useEffect, useState } from 'react';
import { Globe, AlertTriangle } from 'lucide-react';
import { Card } from '../UI/Card';
import {
	frameUrl,
	takeBrowserControl,
	releaseBrowserControl,
	resolveBrowserPending,
	type BrowserSession,
	type BrowserSessionStatus,
} from '../../services/browser-session.service';

/** How often an expanded card asks for a fresh frame. */
const FRAME_POLL_MS = 1500;

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

	useEffect(() => {
		if (!expanded) return;
		const id = setInterval(() => setTick((t) => t + 1), FRAME_POLL_MS);
		return () => clearInterval(id);
	}, [expanded]);

	const style = STATUS_STYLE[session.status] ?? STATUS_STYLE.reading;
	const host = hostOf(session.url);
	const live = session.status !== 'done' && session.status !== 'stopped';

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
					{session.frameAt ? (
						<img
							// `tick` forces a refetch on our cadence; `frameAt` makes a
							// genuinely new frame land immediately.
							src={`${frameUrl(session.id, session.frameAt)}&p=${tick}`}
							alt={`What ${session.agentName || session.agentSession} sees`}
							className="w-full rounded-md border border-border-dark bg-background-dark"
						/>
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

					{session.pending && (
						<div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
							<p className="text-xs text-amber-200">
								<strong>{session.agentName || session.agentSession} is waiting on you.</strong> It wants
								to do something that cannot be undone: {session.pending.description} (
								{session.pending.matched}).
							</p>
							<div className="mt-2 flex gap-2">
								<button
									type="button"
									onClick={async () => {
										await resolveBrowserPending(session.id, session.pending!.id, 'approve');
										onChanged?.();
									}}
									className="text-xs px-2 py-1 rounded bg-amber-500/80 text-black font-medium"
								>
									Let it
								</button>
								<button
									type="button"
									onClick={async () => {
										await resolveBrowserPending(session.id, session.pending!.id, 'reject');
										onChanged?.();
									}}
									className="text-xs px-2 py-1 rounded border border-border-dark text-text-secondary-dark"
								>
									No
								</button>
							</div>
						</div>
					)}

					{live && (
						<div className="mt-3 flex items-center gap-2">
							{session.control === 'owner' ? (
								<>
									<span className="text-xs text-amber-300">You have the browser.</span>
									<button
										type="button"
										onClick={async () => {
											await releaseBrowserControl(session.id);
											onChanged?.();
										}}
										className="text-xs px-2 py-1 rounded border border-border-dark text-text-primary-dark"
									>
										Give control back
									</button>
								</>
							) : (
								<button
									type="button"
									onClick={async () => {
										await takeBrowserControl(session.id);
										onChanged?.();
									}}
									className="text-xs px-2 py-1 rounded border border-border-dark text-text-primary-dark"
								>
									Take control of the browser
								</button>
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
