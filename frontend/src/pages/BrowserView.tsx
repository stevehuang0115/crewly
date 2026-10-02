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
import { EmptyState, PageHeader } from '@crewly/ui';
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

	const liveCount = sessions.filter((s) => s.status !== 'done' && s.status !== 'stopped').length;

	return (
		<div className="max-w-4xl" data-testid="browser-page">
			<PageHeader
				title="Browser"
				subtitle="What your agents are doing in Chrome right now. Open one to watch the page live."
				actions={
					loaded && sessions.length > 0 ? (
						<span className="text-[13px] text-text-2" data-testid="browser-live-count">
							{liveCount === 1 ? '1 live session' : `${liveCount} live sessions`}
						</span>
					) : undefined
				}
			/>

			{!loaded && <p className="text-sm text-text-2">Loading…</p>}

			{loaded && sessions.length === 0 && (
				<EmptyState
					icon={Globe}
					title="No agent is using the browser."
					description="A session appears here as soon as an agent navigates, reads or clicks through Crewly in Chrome."
				/>
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
