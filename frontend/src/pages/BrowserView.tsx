/**
 * Browser — what your agents are doing in Chrome, as it happens.
 *
 * Lists every agent that has touched the browser, most recent first, and
 * expands to a live picture of the page. The first session opens by default,
 * because a page that makes you click before it shows you anything is a page
 * you stop opening.
 *
 * @module pages/BrowserView
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { BrowserSessionCard } from '../components/Browser/BrowserSessionCard';
import {
	fetchBrowserSessions,
	stopBrowserSession,
	type BrowserSession,
} from '../services/browser-session.service';

/** How often the session list refreshes. */
const LIST_POLL_MS = 2000;

/**
 * The live browser page.
 *
 * @returns The page element
 */
export const BrowserView: React.FC = () => {
	const [sessions, setSessions] = useState<BrowserSession[]>([]);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	// Whether the user has picked a card themselves. Until they do we keep the
	// newest one open; after that we leave their choice alone, so a card does
	// not close under them when another agent becomes more recent.
	const userChose = useRef(false);

	const load = useCallback(async () => {
		const next = await fetchBrowserSessions();
		setSessions(next);
		setLoaded(true);
		if (!userChose.current && next.length > 0) {
			setExpandedId(next[0].id);
		}
	}, []);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), LIST_POLL_MS);
		return () => clearInterval(id);
	}, [load]);

	const handleToggle = useCallback((id: string) => {
		userChose.current = true;
		setExpandedId((current) => (current === id ? null : id));
	}, []);

	const handleStop = useCallback(
		async (id: string) => {
			await stopBrowserSession(id);
			await load();
		},
		[load],
	);

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<header className="mb-5">
				<h1 className="text-xl font-semibold text-text-primary-dark">Browser</h1>
				<p className="text-sm text-text-secondary-dark mt-1">
					What your agents are doing in Chrome right now. Open one to watch the page live.
				</p>
			</header>

			{!loaded && <p className="text-sm text-text-secondary-dark">Loading…</p>}

			{loaded && sessions.length === 0 && (
				<div className="rounded-lg border border-dashed border-border-dark px-4 py-10 text-center">
					<Globe className="w-6 h-6 mx-auto text-text-secondary-dark/60" />
					<p className="mt-3 text-sm text-text-secondary-dark">No agent is using the browser.</p>
					<p className="mt-1 text-xs text-text-secondary-dark/70">
						A session appears here as soon as an agent navigates, reads or clicks through Crewly in
						Chrome.
					</p>
				</div>
			)}

			<div className="space-y-3">
				{sessions.map((session) => (
					<BrowserSessionCard
						key={session.id}
						session={session}
						expanded={expandedId === session.id}
						onToggle={() => handleToggle(session.id)}
						onStop={handleStop}
						onChanged={load}
					/>
				))}
			</div>
		</div>
	);
};

export default BrowserView;
