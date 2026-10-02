/**
 * Tickets — the home of all work (specs/2026-10-02-ui-redesign.md §Tickets):
 * Board · Requests (former `/tasks`) · Runs (former `/workitems`), in
 * `?tab=`.
 *
 * Interim container: each tab renders the existing page unchanged so every
 * old screen stays reachable while the Tickets redesign is built. The
 * Tickets page work replaces the panels (and this note).
 *
 * @module pages/hubs/TicketsHub
 */
import React from 'react';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import { Tickets } from '../Tickets';
import { RequestsPage } from '../RequestsPage';
import { WorkItems } from '../WorkItems';
import { useTabParam } from '../../hooks/useTabParam';
import { TICKETS_TABS, type TicketsTab } from '../../constants/routes.constants';

const LABELS: Record<TicketsTab, string> = { board: 'Board', requests: 'Requests', runs: 'Runs' };

/** Tickets page with its three tabs. */
export const TicketsHub: React.FC = () => {
	const [tab, setTab] = useTabParam(TICKETS_TABS);
	return (
		<div>
			<PageHeader
				title="Tickets"
				subtitle="Everything your crew is working on"
				tabs={
					<UnderlineTabs
						aria-label="Tickets views"
						idPrefix="tickets"
						value={tab}
						onChange={(v) => setTab(v as TicketsTab)}
						tabs={TICKETS_TABS.map((id) => ({ value: id, label: LABELS[id] }))}
					/>
				}
			/>
			<div role="tabpanel" id={`tickets-panel-${tab}`} aria-labelledby={`tickets-tab-${tab}`} data-testid={`tickets-panel-${tab}`}>
				{tab === 'board' && <Tickets />}
				{tab === 'requests' && <RequestsPage />}
				{tab === 'runs' && <WorkItems />}
			</div>
		</div>
	);
};

export default TicketsHub;
