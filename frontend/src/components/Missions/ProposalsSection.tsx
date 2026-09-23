/**
 * Proposals section for the Mission detail page: child missions proposed by
 * an agent that are awaiting the owner's decision
 * (GET /api/missions/:id/proposals), each with Approve / Reject.
 *
 * Renders nothing when there are no pending proposals so the page stays
 * quiet for the common case.
 *
 * @module components/Missions/ProposalsSection
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { Card } from '@crewly/ui/Card';
import { Badge } from '@crewly/ui/Badge';
import { LevelBadge } from './OkrBadges';
import { ApprovalActions } from './ApprovalActions';
import { apiService } from '../../services/api.service';
import { type Mission } from '../../types/mission.types';

export interface ProposalsSectionProps {
  /** Parent mission whose pending child proposals are listed. */
  parentMissionId: string;
  /** Called after a proposal is approved or rejected. */
  onDecided?: (mission: Mission) => void;
}

/**
 * Pending child proposals with approve / reject controls.
 *
 * @param props - See {@link ProposalsSectionProps}
 */
export const ProposalsSection: React.FC<ProposalsSectionProps> = ({ parentMissionId, onDecided }) => {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<Mission[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setProposals(await apiService.getProposals(parentMissionId));
    } catch {
      // Non-fatal: the section simply stays hidden.
      setProposals([]);
    } finally {
      setLoaded(true);
    }
  }, [parentMissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDecided = (updated: Mission): void => {
    setProposals((prev) => prev.filter((p) => p.id !== updated.id));
    onDecided?.(updated);
  };

  if (!loaded || proposals.length === 0) return null;

  return (
    <Card variant="default" padding="md" className="border border-yellow-500/40" data-testid="proposals-section">
      <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <Inbox className="h-4 w-4 text-yellow-400" />
        Proposals awaiting approval ({proposals.length})
      </h2>
      <ul className="space-y-2">
        {proposals.map((p) => (
          <li
            key={p.id}
            className="rounded-lg border border-border-dark px-3 py-2"
            data-testid={`proposal-${p.id}`}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {p.level && <LevelBadge level={p.level} />}
                  <button
                    type="button"
                    onClick={() => navigate(`/missions/${p.id}`)}
                    className="text-sm font-medium text-text-primary-dark hover:text-primary text-left"
                    data-testid={`proposal-link-${p.id}`}
                  >
                    {p.objective}
                  </button>
                </div>
                <div className="flex items-center gap-2 flex-wrap text-[11px] text-text-secondary-dark">
                  <Badge variant="default" size="sm">Team: {p.ownerTeamId.slice(0, 16)}</Badge>
                  {p.approval?.proposedBy && <span>Proposed by {p.approval.proposedBy}</span>}
                  {(p.keyResults?.length ?? 0) > 0 && (
                    <span>{p.keyResults?.length} KR{p.keyResults?.length === 1 ? '' : 's'}</span>
                  )}
                </div>
                {p.successCriteria?.length > 0 && (
                  <ul className="mt-1 text-xs text-text-secondary-dark list-disc pl-4">
                    {p.successCriteria.slice(0, 3).map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                )}
              </div>
              <ApprovalActions missionId={p.id} onDecided={handleDecided} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
};

export default ProposalsSection;
