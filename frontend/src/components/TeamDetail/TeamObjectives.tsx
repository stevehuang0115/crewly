/**
 * TeamObjectives — surfaces a team's strategic context on its detail page:
 *   - Mission / OKR: the team's runtime Missions (owner = this team) + their
 *     Key Results, linking into the Missions surface.
 *   - Team Knowledge: links into the team's wiki for Norms and SOPs (the
 *     canonical home — see the wiki `norms/`/`sop/` folders).
 *
 * Read-only; one network call (GET /api/missions, filtered to this team).
 *
 * @module components/TeamDetail/TeamObjectives
 */

import { LINKS } from '../../constants/routes.constants';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, BookOpen, ScrollText } from 'lucide-react';
import { apiService } from '../../services/api.service';
import {
  getMissionStatusType,
  getMissionStatusLabel,
  countKrStatuses,
  type MissionStatus,
  type MissionLevel,
  type ProposalState,
  type KeyResultSummary,
} from '../../types/mission.types';
import { StatusBadge } from '@crewly/ui/StatusBadge';
import { Button } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { LevelBadge, ApprovalChip, KrStatusCountsRow } from '../Missions/OkrBadges';
import { TEAM_QUERY_PARAM } from '../../utils/team-chat.utils';

/** Minimal mission shape this panel renders (subset of the Missions page type). */
export interface TeamMission {
  id: string;
  objective: string;
  ownerTeamId: string;
  status: MissionStatus;
  level?: MissionLevel;
  approval?: { state: ProposalState };
  keyResults?: Array<Pick<KeyResultSummary, 'id' | 'title' | 'status'>>;
}

export interface TeamObjectivesProps {
  /** The team whose missions + wiki to surface. */
  teamId: string;
  /**
   * This team's goals when the page already loaded them (skips the fetch).
   * Undefined = fetch GET /api/missions here.
   */
  missions?: TeamMission[];
}

/**
 * Mission/OKR + wiki-knowledge panel for the team detail page.
 *
 * @param props.teamId - Team id used to filter missions and scope wiki links.
 * @returns The objectives panel.
 */
export function TeamObjectives({ teamId, missions: given }: TeamObjectivesProps): JSX.Element {
  const navigate = useNavigate();
  const [fetched, setFetched] = useState<TeamMission[]>([]);
  const [fetching, setFetching] = useState(given === undefined);
  const missions = given ?? fetched;
  const loading = given === undefined && fetching;

  useEffect(() => {
    if (given !== undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const all = (await apiService.getMissions()) as TeamMission[];
        if (!cancelled) {
          setFetched(all.filter((m) => m && m.ownerTeamId === teamId));
        }
      } catch {
        // Non-fatal — the page still renders the knowledge links.
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, given]);

  const wikiHref = `/wiki?${TEAM_QUERY_PARAM}=${teamId}`;
  // Deep-link straight to the relevant canonical folder in the team wiki.
  const normsHref = `${wikiHref}&focus=team-norm`;
  const sopsHref = `${wikiHref}&focus=sop`;

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      {/* Goals (missions / OKRs) owned by this team */}
      <div data-testid="team-objectives-okr">
        <div className="mb-2 flex items-center gap-2">
          <Target className="h-4 w-4 text-text-3" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold text-text-2">Goals</h3>
        </div>

        {loading ? (
          <LoadingSpinner size="xs" inline centered={false} text="Loading…" />
        ) : missions.length === 0 ? (
          <p className="text-sm text-text-2">
            No goals owned by this team yet.{' '}
            <Button type="button" variant="link" onClick={() => navigate(LINKS.goals())}>
              Open Goals
            </Button>
          </p>
        ) : (
          <ul className="space-y-2">
            {missions.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => navigate(LINKS.goal(m.id))}
                  data-testid={`team-mission-${m.id}`}
                  className="flex w-full items-start justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      {m.level && <LevelBadge level={m.level} />}
                      <span className="block truncate text-sm text-text">{m.objective}</span>
                    </span>
                    <span className="text-xs text-text-2">
                      {(m.keyResults?.length ?? 0)} key result{(m.keyResults?.length ?? 0) === 1 ? '' : 's'}
                    </span>
                    <KrStatusCountsRow counts={countKrStatuses(m.keyResults)} className="mt-1" />
                  </span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    {m.approval && m.approval.state !== 'approved' && <ApprovalChip state={m.approval.state} />}
                    <StatusBadge status={getMissionStatusType(m.status)}>
                      {getMissionStatusLabel(m.status)}
                    </StatusBadge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Team Knowledge — norms + SOPs live in the team wiki */}
      <div data-testid="team-knowledge">
        <h3 className="mb-2 text-[13px] font-semibold text-text-2">Norms &amp; SOPs</h3>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => navigate(normsHref)}
            data-testid="team-norms-link"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-text hover:bg-surface-hover"
          >
            <BookOpen className="h-4 w-4 text-text-3" />
            Team Norms
            <span className="ml-auto text-xs text-text-2">in wiki →</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(sopsHref)}
            data-testid="team-sops-link"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-text hover:bg-surface-hover"
          >
            <ScrollText className="h-4 w-4 text-text-3" />
            SOPs
            <span className="ml-auto text-xs text-text-2">in wiki →</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default TeamObjectives;
