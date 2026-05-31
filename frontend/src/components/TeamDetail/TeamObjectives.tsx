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

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, BookOpen, ScrollText } from 'lucide-react';
import { apiService } from '../../services/api.service';
import {
  getMissionStatusType,
  getMissionStatusLabel,
  type MissionStatus,
} from '../../types/mission.types';
import { StatusBadge } from '../UI/StatusBadge';
import { TEAM_QUERY_PARAM } from '../../utils/team-chat.utils';

/** Minimal mission shape this panel renders (subset of the Missions page type). */
interface TeamMission {
  id: string;
  objective: string;
  ownerTeamId: string;
  status: MissionStatus;
  keyResults?: Array<{ id: string; title: string; status: string }>;
}

export interface TeamObjectivesProps {
  /** The team whose missions + wiki to surface. */
  teamId: string;
}

/**
 * Mission/OKR + wiki-knowledge panel for the team detail page.
 *
 * @param props.teamId - Team id used to filter missions and scope wiki links.
 * @returns The objectives panel.
 */
export function TeamObjectives({ teamId }: TeamObjectivesProps): JSX.Element {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<TeamMission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = (await apiService.getMissions()) as TeamMission[];
        if (!cancelled) {
          setMissions(all.filter((m) => m && m.ownerTeamId === teamId));
        }
      } catch {
        // Non-fatal — the page still renders the knowledge links.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const wikiHref = `/wiki?${TEAM_QUERY_PARAM}=${teamId}`;
  // Deep-link straight to the relevant canonical folder in the team wiki.
  const normsHref = `${wikiHref}&focus=team-norm`;
  const sopsHref = `${wikiHref}&focus=sop`;

  return (
    <div className="space-y-4">
      {/* Mission / OKR */}
      <div className="rounded-2xl border border-border-dark bg-surface-dark p-5" data-testid="team-objectives-okr">
        <div className="mb-3 flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Mission / OKR</h3>
        </div>

        {loading ? (
          <p className="text-sm text-text-secondary-dark">Loading…</p>
        ) : missions.length === 0 ? (
          <p className="text-sm text-text-secondary-dark">
            No missions own­ed by this team yet.{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => navigate('/missions')}
            >
              Open Missions
            </button>
          </p>
        ) : (
          <ul className="space-y-2">
            {missions.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/missions/${m.id}`)}
                  data-testid={`team-mission-${m.id}`}
                  className="flex w-full items-start justify-between gap-2 rounded-lg border border-transparent px-2 py-2 text-left hover:border-border-dark hover:bg-background-dark"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary-dark">{m.objective}</span>
                    <span className="text-xs text-text-secondary-dark">
                      {(m.keyResults?.length ?? 0)} key result{(m.keyResults?.length ?? 0) === 1 ? '' : 's'}
                    </span>
                  </span>
                  <StatusBadge status={getMissionStatusType(m.status)}>
                    {getMissionStatusLabel(m.status)}
                  </StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Team Knowledge — norms + SOPs live in the team wiki */}
      <div className="rounded-2xl border border-border-dark bg-surface-dark p-5" data-testid="team-knowledge">
        <h3 className="mb-3 text-lg font-semibold text-text-primary-dark">Team Knowledge</h3>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => navigate(normsHref)}
            data-testid="team-norms-link"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-text-primary-dark hover:bg-background-dark"
          >
            <BookOpen className="h-4 w-4 text-text-secondary-dark" />
            Team Norms
            <span className="ml-auto text-xs text-text-secondary-dark">in wiki →</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(sopsHref)}
            data-testid="team-sops-link"
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-text-primary-dark hover:bg-background-dark"
          >
            <ScrollText className="h-4 w-4 text-text-secondary-dark" />
            SOPs
            <span className="ml-auto text-xs text-text-secondary-dark">in wiki →</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default TeamObjectives;
