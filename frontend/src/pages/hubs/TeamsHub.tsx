/**
 * Teams page (specs/2026-10-02-ui-redesign.md §Teams): the teams list and
 * the Goals tab (former Missions, `/missions`), in `?tab=`.
 *
 * The header carries each tab's primary action: "New team" on Teams,
 * "New goal" (plus Refresh in "⋯") on Goals. The panels own their modals;
 * the hub opens them through controlled props. Tab pills show the counts
 * the panels report; Goals turns attention-coloured while proposals wait for
 * the owner's approval.
 *
 * @module pages/hubs/TeamsHub
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Button, PageHeader, UnderlineTabs } from '@crewly/ui';
import { OverflowMenu } from '@crewly/ui/OverflowMenu';
import { Teams } from '../Teams';
import { Missions, type GoalCounts } from '../Missions';
import { useTabParam } from '../../hooks/useTabParam';
import { TEAMS_TABS, type TeamsTab } from '../../constants/routes.constants';

const LABELS: Record<TeamsTab, string> = { teams: 'Teams', goals: 'Goals' };

const SUBTITLES: Record<TeamsTab, string> = {
	teams: 'Your crews and the goals they work toward',
	goals: 'Company → team → project goals and their key results',
};

/** Teams page with its two tabs. */
export const TeamsHub: React.FC = () => {
	const [tab, setTab] = useTabParam(TEAMS_TABS);
	const [searchParams, setSearchParams] = useSearchParams();
	const [createTeam, setCreateTeam] = useState(false);
	const [createGoal, setCreateGoal] = useState(false);
	const [goalsRefreshKey, setGoalsRefreshKey] = useState(0);
	const [teamCount, setTeamCount] = useState<number | null>(null);
	const [goalCounts, setGoalCounts] = useState<GoalCounts | null>(null);

	// `?create=true` (the Dashboard's "New team") opens the create dialog of
	// the current tab once, then leaves the URL.
	useEffect(() => {
		if (searchParams.get('create') !== 'true') return;
		if (tab === 'goals') setCreateGoal(true);
		else setCreateTeam(true);
		const next = new URLSearchParams(searchParams);
		next.delete('create');
		setSearchParams(next, { replace: true });
	}, [searchParams, setSearchParams, tab]);

	const onTeamCount = useCallback((n: number) => setTeamCount(n), []);
	const onGoalCounts = useCallback((c: GoalCounts) => setGoalCounts(c), []);

	const actions =
		tab === 'teams' ? (
			<Button variant="primary" icon={Plus} onClick={() => setCreateTeam(true)} data-testid="teams-new">
				New team
			</Button>
		) : (
			<>
				<Button variant="primary" icon={Plus} onClick={() => setCreateGoal(true)} data-testid="missions-new">
					New goal
				</Button>
				<OverflowMenu
					icon={MoreHorizontal}
					label="More goal actions"
					buttonClassName="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border-soft text-text-2 transition-colors hover:bg-surface-hover hover:text-text"
					items={[{ label: 'Refresh', onClick: () => setGoalsRefreshKey((k) => k + 1) }]}
				/>
			</>
		);

	return (
		<div className="p-6 max-w-5xl mx-auto">
			<PageHeader
				title="Teams"
				subtitle={SUBTITLES[tab]}
				actions={actions}
				tabs={
					<UnderlineTabs
						aria-label="Teams views"
						idPrefix="teams"
						value={tab}
						onChange={(v) => setTab(v as TeamsTab)}
						tabs={TEAMS_TABS.map((id) => ({
							value: id,
							label: LABELS[id],
							count: id === 'teams' ? teamCount : goalCounts ? (goalCounts.pending > 0 ? goalCounts.pending : goalCounts.total) : null,
							attention: id === 'goals' && (goalCounts?.pending ?? 0) > 0,
						}))}
					/>
				}
			/>
			<div role="tabpanel" id={`teams-panel-${tab}`} aria-labelledby={`teams-tab-${tab}`} data-testid={`teams-panel-${tab}`}>
				{tab === 'teams' && <Teams createOpen={createTeam} onCreateOpenChange={setCreateTeam} onCount={onTeamCount} />}
				{tab === 'goals' && (
					<Missions
						createOpen={createGoal}
						onCreateOpenChange={setCreateGoal}
						refreshKey={goalsRefreshKey}
						onCounts={onGoalCounts}
					/>
				)}
			</div>
		</div>
	);
};

export default TeamsHub;
