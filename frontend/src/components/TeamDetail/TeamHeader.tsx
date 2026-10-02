/**
 * TeamHeader — the team page header (redesign, `simple/TeamDetail`).
 *
 * Breadcrumb, team name, one line: status (colour + word) and the team's
 * goal sentence ("Goal: …" or "No goal yet … Set a goal"). Actions: Chat
 * (primary) and Start team while idle; everything else in "⋯": stop, wiki,
 * edit, change project, delete. The orchestrator team has no chat, wiki,
 * edit or delete: Start / View terminal, and Stop in "⋯".
 *
 * @module components/TeamDetail/TeamHeader
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MessageSquare, MoreHorizontal, Play, Terminal } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { OverflowMenu, type OverflowMenuItem } from '@crewly/ui/OverflowMenu';
import { PageHeader, StatusLabel } from '@crewly/ui';
import { ROUTES } from '../../constants/routes.constants';
import { TeamHeaderProps } from './types';

/** Trigger style of the header "⋯". */
const MENU_BUTTON =
  'inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-border-soft text-text-2 transition-colors hover:bg-surface-hover hover:text-text';

/** Is this the orchestrator's system team? */
export function isOrchestratorTeam(team: { id?: string; name?: string } | null | undefined): boolean {
  return team?.id === 'orchestrator' || team?.name === 'Orchestrator Team';
}

export const TeamHeader: React.FC<TeamHeaderProps> = ({
  team,
  teamStatus,
  onStartTeam,
  onStopTeam,
  onViewTerminal,
  onDeleteTeam,
  onEditTeam,
  onOpenChat,
  onOpenWiki,
  isStoppingTeam = false,
  isStartingTeam = false,
  goal,
  moreGoals = 0,
  onOpenGoal,
  onSetGoal,
  onChangeProject,
}) => {
  const isOrc = isOrchestratorTeam(team);
  const active = teamStatus === 'active';
  const idle = teamStatus === 'idle';

  const statusLabel = isStartingTeam ? 'Starting…' : isStoppingTeam ? 'Stopping…' : active ? 'Active' : 'Idle';
  const statusTone = isStartingTeam ? 'primary' : isStoppingTeam ? 'attention' : active ? 'success' : 'neutral';

  const linkClass = 'font-semibold text-primary-text hover:underline underline-offset-2';
  let goalLine: React.ReactNode = null;
  if (isOrc) {
    goalLine = <span>Coordinates every team</span>;
  } else if (goal) {
    goalLine = (
      <span className="min-w-0 truncate" data-testid="team-goal">
        Goal:{' '}
        {onOpenGoal ? (
          <button type="button" className="text-text hover:underline underline-offset-2" onClick={() => onOpenGoal(goal.id)}>
            {goal.objective}
          </button>
        ) : (
          <span className="text-text">{goal.objective}</span>
        )}
        {moreGoals > 0 && <span className="text-text-3"> +{moreGoals} more</span>}
      </span>
    );
  } else if (goal === null) {
    goalLine = (
      <span className="text-attention" data-testid="team-no-goal">
        No goal yet, so its tickets don't add up to anything.{' '}
        {onSetGoal && (
          <button type="button" className={linkClass} onClick={onSetGoal}>
            Set a goal
          </button>
        )}
      </span>
    );
  }

  const menu: OverflowMenuItem[] = [];
  if (isOrc) {
    if (!idle) menu.push({ label: isStoppingTeam ? 'Stopping…' : 'Stop Orchestrator', onClick: onStopTeam, disabled: isStoppingTeam });
  } else {
    if (!idle) menu.push({ label: isStoppingTeam ? 'Stopping…' : 'Stop Team', onClick: onStopTeam, disabled: isStoppingTeam });
    if (onOpenWiki) menu.push({ label: 'Open wiki', onClick: onOpenWiki });
    menu.push({ label: 'Edit Team', onClick: onEditTeam });
    if (onChangeProject) menu.push({ label: 'Change project', onClick: onChangeProject });
    menu.push({ label: 'Delete Team', danger: true, separator: true, onClick: onDeleteTeam });
  }

  const startButton = (idle || isStartingTeam) && (
    <Button
      variant={isOrc || !onOpenChat ? 'primary' : 'secondary'}
      onClick={onStartTeam}
      icon={Play}
      loading={isStartingTeam}
      disabled={isStartingTeam}
    >
      {isStartingTeam ? 'Starting...' : isOrc ? 'Start Orchestrator' : 'Start Team'}
    </Button>
  );

  const actions = (
    <>
      {isOrc
        ? active && !isStartingTeam && (
            <Button variant="primary" onClick={onViewTerminal} icon={Terminal}>
              View Terminal
            </Button>
          )
        : onOpenChat && (
            <Button variant="primary" onClick={onOpenChat} icon={MessageSquare}>
              Chat
            </Button>
          )}
      {startButton}
      {menu.length > 0 && (
        <OverflowMenu
          align="bottom-right"
          icon={MoreHorizontal}
          label="More team actions"
          buttonClassName={MENU_BUTTON}
          items={menu}
        />
      )}
    </>
  );

  return (
    <PageHeader
      data-testid="team-header"
      eyebrow={
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <Link to={ROUTES.teams} className="text-text-2 hover:text-text">Teams</Link>
          <ChevronRight className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
          <span className="text-text-2">{team.name}</span>
        </nav>
      }
      title={team.name}
      subtitle={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <StatusLabel tone={statusTone} data-testid="team-status">{statusLabel}</StatusLabel>
          {goalLine && <span className="text-text-3">·</span>}
          {goalLine}
        </span>
      }
      actions={actions}
    />
  );
};
