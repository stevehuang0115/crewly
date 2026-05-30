/**
 * TeamsGridCard Component
 *
 * Standardized team card for grid view with consistent layout:
 * Initials avatar + status badge + member count + project link +
 * Start/Stop controls + Last Activity timestamp.
 *
 * @module components/Teams/TeamsGridCard
 */
import React, { useState } from 'react';
import { Users, FolderOpen, Play, Square, Clock, Pin, PinOff, Network, GitBranch } from 'lucide-react';
import { Team } from '@/types';
import { OverflowMenu } from '@/components/UI/OverflowMenu';
import { MemberAvatar } from '@/components/common/MemberAvatar';
import { ConfirmDialog } from '@/components/UI/ConfirmDialog';
import { formatRelativeTimeCompact } from '@/utils/time';

export interface TeamsGridCardProps {
  team: Team;
  projectName?: string;
  subTeamCount?: number;
  onClick?: () => void;
  onViewTeam?: (teamId: string) => void;
  onEditTeam?: (teamId: string) => void;
  onDeleteTeam?: (teamId: string) => void;
  onStartTeam?: (teamId: string) => void;
  onStopTeam?: (teamId: string) => void;
  /** Open this team's conversation in the consolidated chat. */
  onOpenChat?: (teamId: string) => void;
  /** Open this team's wiki vault. */
  onOpenWiki?: (teamId: string) => void;
  /** Whether this team is currently pinned as a favorite */
  isPinned?: boolean;
  /** Callback to toggle pin state. If undefined, pin button is not shown. */
  onTogglePin?: () => void;
}

/**
 * Standardized team grid card with consistent layout.
 */
export const TeamsGridCard: React.FC<TeamsGridCardProps> = ({
  team, projectName, subTeamCount, onClick,
  onViewTeam, onEditTeam, onDeleteTeam, onStartTeam, onStopTeam,
  onOpenChat, onOpenWiki,
  isPinned, onTogglePin,
}) => {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const members = team.members || [];
  const avatars = members.slice(0, 3);
  const extra = Math.max(members.length - 3, 0);
  const hasActiveMembers = members.some(m => m.agentStatus === 'active');
  const hasNoProject = !team.projectIds || team.projectIds.length === 0;

  const lastActivity = members.reduce<string | null>((latest, m) => {
    const ts = m.readyAt || m.updatedAt;
    if (!ts) return latest;
    if (!latest) return ts;
    return new Date(ts) > new Date(latest) ? ts : latest;
  }, null);

  const handleStart = (e: React.MouseEvent) => { e.stopPropagation(); onStartTeam?.(team.id); };
  const handleStopClick = (e: React.MouseEvent) => { e.stopPropagation(); setShowStopConfirm(true); };
  const handleStopConfirm = () => { setShowStopConfirm(false); onStopTeam?.(team.id); };

  return (
    <>
      <div
        className="group relative bg-surface-dark border border-border-dark rounded-2xl p-5 hover:border-primary/50 transition-colors cursor-pointer flex flex-col min-h-[200px]"
        onClick={onClick}
        data-testid={`team-card-${team.id}`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-lg font-semibold truncate">{team.name}</div>
            {hasActiveMembers ? (
              <span className="shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-green-500/10 text-green-400">Active</span>
            ) : (
              <span className="shrink-0 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-500/10 text-gray-400">Idle</span>
            )}
          </div>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {onTogglePin && (
              <button
                onClick={() => onTogglePin()}
                className={`p-1.5 rounded-lg transition-colors ${isPinned ? 'text-yellow-400 hover:text-yellow-300' : 'text-gray-500 opacity-0 group-hover:opacity-100 hover:text-yellow-400'}`}
                title={isPinned ? 'Unpin from favorites' : 'Pin to favorites'}
                aria-label={isPinned ? 'Unpin from favorites' : 'Pin to favorites'}
                data-testid={`pin-btn-${team.id}`}
              >
                {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
              </button>
            )}
            {hasActiveMembers ? (
              onStopTeam && (
                <button onClick={handleStopClick} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors" title="Stop team" data-testid={`stop-btn-${team.id}`}>
                  <Square className="w-4 h-4" />
                </button>
              )
            ) : (
              onStartTeam && (
                <button onClick={handleStart} className="p-1.5 rounded-lg text-green-400 hover:bg-green-500/10 transition-colors" title="Start team" data-testid={`start-btn-${team.id}`}>
                  <Play className="w-4 h-4" />
                </button>
              )
            )}
            <OverflowMenu align="bottom-right" items={[
              { label: 'Edit Team', onClick: () => onEditTeam?.(team.id) },
              { label: 'View Team', onClick: () => onViewTeam?.(team.id) },
              ...(onOpenChat ? [{ label: 'Open Chat', onClick: () => onOpenChat(team.id) }] : []),
              ...(onOpenWiki ? [{ label: 'Open Wiki', onClick: () => onOpenWiki(team.id) }] : []),
              ...(onDeleteTeam ? [{ label: 'Delete Team', danger: true, onClick: () => onDeleteTeam(team.id) }] : []),
            ]} />
          </div>
        </div>

        {hasNoProject ? (
          (() => {
            // Detect orchestrator or hierarchical teams by role or name patterns
            const isOrchestrator = members.some(m => m.role === 'orchestrator' || m.role === 'auditor');
            const isHierarchical = (team as Team & { parentTeamId?: string }).parentTeamId != null
              || (subTeamCount !== undefined && subTeamCount > 0);
            if (isOrchestrator) {
              return (
                <div className="flex items-center gap-2 text-text-secondary-dark text-sm mb-4" data-testid="system-team-label">
                  <Network className="w-4 h-4" /><span>System team</span>
                </div>
              );
            }
            if (isHierarchical) {
              return (
                <div className="flex items-center gap-2 text-text-secondary-dark text-sm mb-4" data-testid="parent-team-label">
                  <GitBranch className="w-4 h-4" /><span>Parent team</span>
                </div>
              );
            }
            return (
              <div className="flex items-center gap-2 text-amber-400/80 text-sm mb-4" data-testid="assign-project-cta">
                <FolderOpen className="w-4 h-4" /><span>Assign a project to get started</span>
              </div>
            );
          })()
        ) : projectName ? (
          <div className="flex items-center gap-2 text-text-secondary-dark text-sm mb-4">
            <FolderOpen className="w-4 h-4" /><span>{projectName}</span>
          </div>
        ) : null}

        {subTeamCount !== undefined && subTeamCount > 0 ? (
          <div className="flex items-center gap-2 text-text-secondary-dark text-sm mb-4">
            <Users className="w-4 h-4" />
            <span>{subTeamCount} sub-team{subTeamCount !== 1 ? 's' : ''} &middot; {members.length} member{members.length !== 1 ? 's' : ''}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-text-secondary-dark text-sm mb-4">
            <Users className="w-4 h-4" />
            <span>{members.length} member{members.length !== 1 ? 's' : ''}</span>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between">
          <div className="flex items-center">
            {avatars.map((m, idx) => (
              <div key={m.id} style={{ marginLeft: idx === 0 ? 0 : -6 }}>
                <MemberAvatar name={m.name} avatar={m.avatar} size="sm" showStatus status={m.agentStatus === 'active' ? 'active' : 'inactive'} ringClass="ring-2 ring-surface-dark" />
              </div>
            ))}
            {extra > 0 && (
              <div className="w-8 h-8 rounded-full bg-background-dark border border-border-dark flex items-center justify-center text-xs text-text-secondary-dark ring-2 ring-surface-dark" style={{ marginLeft: -6 }}>+{extra}</div>
            )}
          </div>
          {lastActivity && (
            <div className="flex items-center gap-1 text-xs text-text-secondary-dark" title={`Last activity: ${new Date(lastActivity).toLocaleString()}`}>
              <Clock className="w-3 h-3" /><span>{formatRelativeTimeCompact(lastActivity)}</span>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog isOpen={showStopConfirm} onCancel={() => setShowStopConfirm(false)} onConfirm={handleStopConfirm}
        title="Stop Team" message={`Are you sure you want to stop all agents in "${team.name}"? Active work will be interrupted.`}
        confirmLabel="Stop Team" confirmVariant="danger" />
    </>
  );
};

export default TeamsGridCard;
