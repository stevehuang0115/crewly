/**
 * Tickets — the home of all work (specs/2026-10-02-ui-redesign.md §Tickets):
 * Board · Requests (former `/tasks`) · Runs (former `/workitems`) ·
 * Experiments (experiment cards, specs/2026-10-03-autonomy-metrics.md), in
 * `?tab=`.
 *
 * The header carries "New ticket" for every tab; the Board tab's count pill
 * is the number of tickets waiting for the owner's review, in the attention
 * colour.
 *
 * @module pages/hubs/TicketsHub
 */
import React, { useCallback, useState } from 'react';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import { Tickets } from '../Tickets';
import { RequestsPage } from '../RequestsPage';
import { WorkItems } from '../WorkItems';
import { Experiments } from '../Experiments';
import { NewTicketButton } from '../../components/Tickets/NewTicketButton';
import type { TicketBoardCounts } from '../../components/Tickets/TicketBoard';
import { useTabParam } from '../../hooks/useTabParam';
import { TICKETS_TABS, type TicketsTab } from '../../constants/routes.constants';

const LABELS: Record<TicketsTab, string> = { board: 'Board', requests: 'Requests', runs: 'Runs', experiments: 'Experiments' };

const SUBTITLES: Record<TicketsTab, string> = {
	board: 'Everything your crew is working on',
	requests: 'Everything you asked for, from every channel',
	runs: 'What the agents actually ran',
	experiments: 'Changes that should move a number, and whether they did',
};

/** Tickets page with its tabs. */
export const TicketsHub: React.FC = () => {
	const [tab, setTab] = useTabParam(TICKETS_TABS);
	const [refreshKey, setRefreshKey] = useState(0);
	const [toReview, setToReview] = useState<number | null>(null);

	const handleCounts = useCallback((c: TicketBoardCounts) => setToReview(c.toReview), []);

	return (
		<div>
			<PageHeader
				title="Tickets"
				subtitle={SUBTITLES[tab]}
				actions={<NewTicketButton onCreated={() => setRefreshKey((k) => k + 1)} />}
				tabs={
					<UnderlineTabs
						aria-label="Tickets views"
						idPrefix="tickets"
						value={tab}
						onChange={(v) => setTab(v as TicketsTab)}
						tabs={TICKETS_TABS.map((id) => ({
							value: id,
							label: LABELS[id],
							...(id === 'board' && toReview ? { count: toReview, attention: true } : {}),
						}))}
					/>
				}
			/>
			<div role="tabpanel" id={`tickets-panel-${tab}`} aria-labelledby={`tickets-tab-${tab}`} data-testid={`tickets-panel-${tab}`}>
				{tab === 'board' && <Tickets showNewTicket={false} refreshKey={refreshKey} onCountsChange={handleCounts} />}
				{tab === 'requests' && <RequestsPage />}
				{tab === 'runs' && <WorkItems />}
				{tab === 'experiments' && <Experiments />}
			</div>
		</div>
	);
};

export default TicketsHub;
