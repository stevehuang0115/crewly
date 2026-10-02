/**
 * Teams (specs/2026-10-02-ui-redesign.md §Teams): the teams list and the
 * Goals tab (former Missions, `/missions`), in `?tab=`.
 *
 * Interim container: each tab renders the existing page unchanged so every
 * old screen stays reachable while the Teams redesign is built. The Teams
 * page work replaces the panels (and this note).
 *
 * @module pages/hubs/TeamsHub
 */
import React from 'react';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import { Teams } from '../Teams';
import { Missions } from '../Missions';
import { useTabParam } from '../../hooks/useTabParam';
import { TEAMS_TABS, type TeamsTab } from '../../constants/routes.constants';

const LABELS: Record<TeamsTab, string> = { teams: 'Teams', goals: 'Goals' };

/** Teams page with its two tabs. */
export const TeamsHub: React.FC = () => {
	const [tab, setTab] = useTabParam(TEAMS_TABS);
	return (
		<div>
			<PageHeader
				title="Teams"
				subtitle="Your crews and the goals they work toward"
				tabs={
					<UnderlineTabs
						aria-label="Teams views"
						idPrefix="teams"
						value={tab}
						onChange={(v) => setTab(v as TeamsTab)}
						tabs={TEAMS_TABS.map((id) => ({ value: id, label: LABELS[id] }))}
					/>
				}
			/>
			<div role="tabpanel" id={`teams-panel-${tab}`} aria-labelledby={`teams-tab-${tab}`} data-testid={`teams-panel-${tab}`}>
				{tab === 'teams' && <Teams />}
				{tab === 'goals' && <Missions />}
			</div>
		</div>
	);
};

export default TeamsHub;
