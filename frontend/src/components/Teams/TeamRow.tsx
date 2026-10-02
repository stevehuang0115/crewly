/**
 * TeamRow — one team in the redesigned Teams list
 * (specs/2026-10-02-ui-redesign.md §Teams, simplify rules).
 *
 * One line (team name + status), one quiet meta line (project · members ·
 * last activity), Start or Stop as the visible action, everything else in
 * "⋯": view, edit, chat, wiki, pin, delete. Members waiting on a runtime
 * sign-in show their "Sign-in needed" chip, because that needs the owner.
 *
 * @module components/Teams/TeamRow
 */

import React, { useState } from 'react';
import { Pin } from 'lucide-react';
import { Button, CompactRow, StatusLabel, type OverflowMenuItem } from '@crewly/ui';
import { ConfirmDialog } from '@crewly/ui/ConfirmDialog';
import type { Team } from '@/types';
import { formatRelativeTimeCompact } from '@/utils/time';
import { SignInNeededChip } from '@/components/SignInNeededChip';

export interface TeamRowProps {
  team: Team;
  /** Name of the team's project, when it has one */
  projectName?: string;
  /** Number of child teams (parent teams) */
  subTeamCount?: number;
  onOpen: (teamId: string) => void;
  onEdit?: (teamId: string) => void;
  onStart?: (teamId: string) => void;
  onStop?: (teamId: string) => void;
  onOpenChat?: (teamId: string) => void;
  onOpenWiki?: (teamId: string) => void;
  /** Deletes after the row's own confirm */
  onDelete?: (teamId: string) => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
}

/**
 * Latest member activity (ready or updated time) of a team.
 *
 * @param team - Team
 * @returns ISO timestamp, or null when no member has one
 */
export function teamLastActivity(team: Team): string | null {
  return (team.members ?? []).reduce<string | null>((latest, m) => {
    const ts = m.readyAt || m.updatedAt;
    if (!ts) return latest;
    if (!latest) return ts;
    return new Date(ts) > new Date(latest) ? ts : latest;
  }, null);
}

/**
 * The "where does this team work" part of the meta line.
 *
 * @param team - Team
 * @param projectName - Resolved project name
 * @param subTeamCount - Child team count
 * @returns Label and whether it needs the owner (no project yet)
 */
export function teamPlacement(team: Team, projectName?: string, subTeamCount?: number): { label: string; needsProject: boolean } {
  const members = team.members ?? [];
  const hasProject = (team.projectIds?.length ?? 0) > 0;
  if (hasProject) return { label: projectName ?? 'Project', needsProject: false };
  if (members.some((m) => m.role === 'orchestrator' || m.role === 'auditor')) return { label: 'System team', needsProject: false };
  if (team.parentTeamId || (subTeamCount ?? 0) > 0) return { label: 'Parent team', needsProject: false };
  return { label: 'No project yet', needsProject: true };
}

/**
 * Compact team row.
 *
 * @param props - {@link TeamRowProps}
 * @returns The row (plus its stop/delete confirms)
 */
export const TeamRow: React.FC<TeamRowProps> = ({
  team,
  projectName,
  subTeamCount,
  onOpen,
  onEdit,
  onStart,
  onStop,
  onOpenChat,
  onOpenWiki,
  onDelete,
  isPinned = false,
  onTogglePin,
}) => {
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);
  const members = team.members ?? [];
  const active = members.some((m) => m.agentStatus === 'active');
  const needSignIn = members.filter((m) => m.loginRequired);
  const placement = teamPlacement(team, projectName, subTeamCount);
  const last = teamLastActivity(team);

  const memberText =
    (subTeamCount ?? 0) > 0
      ? `${subTeamCount} sub-team${subTeamCount === 1 ? '' : 's'} · ${members.length} member${members.length === 1 ? '' : 's'}`
      : members.length === 0
        ? 'No members'
        : members.map((m) => m.name).join(', ');

  const meta = (
    <>
      <span className={placement.needsProject ? 'text-attention' : undefined} data-testid={placement.needsProject ? 'assign-project-cta' : undefined}>
        {placement.label}
      </span>
      <span className="text-text-3"> · </span>
      <span>{memberText}</span>
      {last && (
        <>
          <span className="text-text-3"> · </span>
          <span title={`Last activity: ${new Date(last).toLocaleString()}`}>{formatRelativeTimeCompact(last)}</span>
        </>
      )}
    </>
  );

  const overflow: OverflowMenuItem[] = [
    { label: 'View team', onClick: () => onOpen(team.id) },
    ...(onEdit ? [{ label: 'Edit team', onClick: () => onEdit(team.id) }] : []),
    ...(onOpenChat ? [{ label: 'Open chat', onClick: () => onOpenChat(team.id) }] : []),
    ...(onOpenWiki ? [{ label: 'Open wiki', onClick: () => onOpenWiki(team.id) }] : []),
    ...(onTogglePin ? [{ label: isPinned ? 'Unpin from favorites' : 'Pin to favorites', onClick: onTogglePin }] : []),
    ...(onDelete ? [{ label: 'Delete team', danger: true, separator: true, onClick: () => setConfirm('delete') }] : []),
  ];

  const action = active
    ? onStop && (
        <Button key="stop" variant="secondary" size="xs" onClick={() => setConfirm('stop')} data-testid={`stop-btn-${team.id}`}>
          Stop
        </Button>
      )
    : onStart && (
        <Button key="start" variant="secondary" size="xs" onClick={() => onStart(team.id)} data-testid={`start-btn-${team.id}`}>
          Start
        </Button>
      );

  return (
    <>
      <CompactRow
        data-testid={`team-row-${team.id}`}
        onClick={() => onOpen(team.id)}
        primary={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{team.name}</span>
            {isPinned && <Pin className="h-3.5 w-3.5 shrink-0 text-text-3" aria-label="Pinned" />}
          </span>
        }
        meta={meta}
        trailing={
          <span className="flex items-center gap-2">
            {needSignIn.length > 0 && (
              <span className="flex items-center gap-1" data-testid="team-sign-in-needed">
                {needSignIn.map((m) => (
                  <SignInNeededChip
                    key={m.id}
                    loginRequired={m.loginRequired as NonNullable<typeof m.loginRequired>}
                    agentLabel={m.name}
                    runtimeType={m.runtimeType}
                  />
                ))}
              </span>
            )}
            <StatusLabel tone={active ? 'success' : 'neutral'}>{active ? 'Active' : 'Idle'}</StatusLabel>
          </span>
        }
        actions={action ? [action] : undefined}
        overflow={overflow}
        overflowLabel={`More actions for ${team.name}`}
      />
      <ConfirmDialog
        isOpen={confirm === 'stop'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          onStop?.(team.id);
        }}
        title="Stop Team"
        message={`Are you sure you want to stop all agents in "${team.name}"? Active work will be interrupted.`}
        confirmLabel="Stop Team"
        confirmVariant="danger"
      />
      <ConfirmDialog
        isOpen={confirm === 'delete'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          onDelete?.(team.id);
        }}
        title="Delete Team"
        message={`Delete team "${team.name}"? Its members and terminal sessions are removed. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
      />
    </>
  );
};

export default TeamRow;
