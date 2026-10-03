/**
 * Any run's timeline (`/tickets/traces/:traceId`): the page `trace-read` and
 * retros link to when a run has no request or experiment page
 * (specs/2026-10-03-autonomy-metrics.md §UI). The trace id stays in the URL;
 * the page is titled with what started the run.
 *
 * @module pages/TraceDetail
 */

import React, { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '@crewly/ui';
import { LINKS } from '../constants/routes.constants';
import { TraceTimeline, formatClock } from '../components/TraceTimeline';
import { useTeams } from '../components/Tickets/useTeams';
import { agentDisplayName } from '../components/Tickets/board.utils';
import type { TraceRoot, TraceTimelineData } from '../types/trace.types';

/** What started a run, in words. */
const ROOT_KIND_LABELS: Record<TraceRoot['kind'], string> = {
	request: 'Request',
	goal: 'Goal',
	experiment: 'Experiment',
	owner_message: 'Your message',
};

/** Run timeline page. */
export const TraceDetail: React.FC = () => {
	const { traceId = '' } = useParams<{ traceId: string }>();
	const { names } = useTeams();
	const [root, setRoot] = useState<TraceRoot | null>(null);
	const nameOf = useCallback((session: string) => agentDisplayName(session, names) ?? session, [names]);
	const handleLoaded = useCallback((data: TraceTimelineData) => setRoot(data.root), []);

	return (
		<div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-4 sm:p-6" data-testid="trace-detail">
			<PageHeader
				className="mb-0"
				eyebrow={
					<nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
						<Link to={LINKS.ticketsBoard()} className="text-text-2 hover:text-text">
							Tickets
						</Link>
						<span className="text-text-3">/</span>
						<span className="text-text-2">Run timeline</span>
					</nav>
				}
				title={root?.summary ?? 'Run timeline'}
				subtitle={root ? `${ROOT_KIND_LABELS[root.kind]} · started ${formatClock(root.createdAt)}` : undefined}
			/>
			<TraceTimeline traceId={traceId} nameOf={nameOf} onLoaded={handleLoaded} />
		</div>
	);
};

TraceDetail.displayName = 'TraceDetail';

export default TraceDetail;
