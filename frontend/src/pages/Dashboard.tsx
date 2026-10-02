/**
 * Dashboard Page
 *
 * The page the owner opens first. Its one job: what needs me, and is my
 * crew OK (specs/2026-10-02-ui-redesign.md, Dashboard):
 *
 * - "Get started" first-run checklist (until done or hidden)
 * - "Waiting on you": open owner decisions as compact rows
 * - "Your crew right now": who is working on what; idle agents on one line
 *
 * Problems (orchestrator down, sign-in needed, runtime out of usage,
 * update) are shown once, app-wide, by the system status bar above every
 * page, so the Dashboard does not repeat them.
 *
 * What used to sit here and where it went: the 3D Factory, "New project"
 * and "New team" are in the header's "⋯" menu; the project and team cards
 * (with their pin / archive / start / edit menus) are on Projects and
 * Teams; the counts are on those pages and Tickets.
 *
 * @module pages/Dashboard
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, FolderPlus, MoreHorizontal, UserPlus } from 'lucide-react';
import { PageHeader } from '@crewly/ui/PageHeader';
import { OverflowMenu } from '@crewly/ui/OverflowMenu';
import type { Team } from '@/types';
import { apiService } from '@/services/api.service';
import { GettingStartedCard } from '@/components/Onboarding/GettingStartedCard';
import { WaitingOnYouCard } from '@/components/Dashboard/WaitingOnYouCard';
import { CrewNowSection } from '@/components/Dashboard/CrewNowSection';
import { buildAgentDirectory, buildCrewSnapshot, type RunningItem } from '@/components/Dashboard/dashboard.utils';
import { ROUTES } from '@/constants/routes.constants';
import { logSilentError } from '@/utils/error-handling';

/** How often the crew list is refreshed (ms). */
export const CREW_POLL_MS = 30_000;

/** Runs that are being worked on right now. */
export const RUNNING_ITEMS_API = '/api/task-pool/items?status=running';

/** Where the header "⋯" actions go. */
export const DASHBOARD_LINKS = {
  factory: '/factory',
  newProject: `${ROUTES.projects}?create=true`,
  newTeam: `${ROUTES.teams}?create=true`,
} as const;

/**
 * Runs in progress (best-effort: an empty list when unavailable).
 *
 * @returns Running work items
 */
export async function fetchRunningItems(): Promise<RunningItem[]> {
  try {
    const res = await fetch(RUNNING_ITEMS_API);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body?.data) ? (body.data as RunningItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Dashboard component - main application landing page.
 *
 * @returns Dashboard component
 */
export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [teams, setTeams] = useState<Team[]>([]);
  const [running, setRunning] = useState<RunningItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [teamList, items] = await Promise.all([apiService.getTeams(), fetchRunningItems()]);
      setTeams(teamList);
      setRunning(items);
      setError(null);
    } catch (err) {
      logSilentError(err, { context: 'Loading dashboard crew', level: 'error' });
      setError("Couldn't load your crew.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), CREW_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const directory = useMemo(() => buildAgentDirectory(teams), [teams]);
  const crew = useMemo(() => buildCrewSnapshot(teams, running), [teams, running]);

  const menu = (
    <OverflowMenu
      icon={MoreHorizontal}
      label="More dashboard actions"
      buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-[var(--crewly-radius-sm)] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      menuClassName="w-52"
      items={[
        { label: 'Open the 3D Factory', icon: Box, onClick: () => navigate(DASHBOARD_LINKS.factory) },
        { label: 'New project', icon: FolderPlus, onClick: () => navigate(DASHBOARD_LINKS.newProject), separator: true },
        { label: 'New team', icon: UserPlus, onClick: () => navigate(DASHBOARD_LINKS.newTeam) },
      ]}
    />
  );

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-8 pb-12 md:pt-4" data-testid="dashboard">
      <PageHeader title="Dashboard" actions={menu} className="mb-0" />

      {/* First-run checklist ("Get started") until every step is done or it is hidden */}
      <div className="empty:hidden">
        <GettingStartedCard />
      </div>

      <WaitingOnYouCard directory={directory} showEmpty />

      {error ? (
        <p className="text-[13px] text-text-2 md:px-4" role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load()} className="font-bold text-primary-text hover:text-text">
            Retry
          </button>
        </p>
      ) : (
        loaded && <CrewNowSection crew={crew} />
      )}
    </div>
  );
};

export default Dashboard;
