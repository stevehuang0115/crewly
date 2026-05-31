import React from 'react';
import { Terminal, Play, Square, MessageSquare, BookOpen } from 'lucide-react';
import { Button } from '../UI/Button';
import { OverflowMenu } from '../UI/OverflowMenu';
import { TeamHeaderProps } from './types';

export const TeamHeader: React.FC<TeamHeaderProps> = ({
  team,
  teamStatus,
  orchestratorSessionActive,
  onStartTeam,
  onStopTeam,
  onViewTerminal,
  onDeleteTeam,
  onEditTeam,
  onOpenChat,
  onOpenWiki,
  isStoppingTeam = false,
  isStartingTeam = false,
}) => {
  const isOrchestratorTeam = team?.id === 'orchestrator' || team?.name === 'Orchestrator Team';
  const members = team?.members || [];
  const activeMembers = members.filter(m => m.agentStatus === 'active' || m.sessionName).length;

  return (
    <div className="page-header">
      <div className="header-info">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="page-title mb-0">{team.name}</h1>
        </div>
      </div>
      <div className="header-controls">
        {teamStatus === 'idle' && !isStartingTeam ? (
          <Button variant="success" onClick={onStartTeam} icon={Play}>
            {isOrchestratorTeam ? 'Start Orchestrator' : 'Start Team'}
          </Button>
        ) : isStartingTeam ? (
          <Button variant="success" loading={true} disabled={true}>
            Starting...
          </Button>
        ) : (
          <Button
            variant="danger"
            onClick={onStopTeam}
            icon={Square}
            loading={isStoppingTeam}
          >
            {isStoppingTeam ? 'Stopping...' : isOrchestratorTeam ? 'Stop Orchestrator' : 'Stop Team'}
          </Button>
        )}
        {isOrchestratorTeam && teamStatus === 'active' && (
          <Button variant="primary" onClick={onViewTerminal} icon={Terminal}>
            View Terminal
          </Button>
        )}
        {/* Chat / Wiki deep-links — real teams only (orchestrator has neither
            a team workspace nor a team wiki vault). */}
        {!isOrchestratorTeam && onOpenChat && (
          <Button variant="secondary" onClick={onOpenChat} icon={MessageSquare}>
            Chat
          </Button>
        )}
        {!isOrchestratorTeam && onOpenWiki && (
          <Button variant="secondary" onClick={onOpenWiki} icon={BookOpen}>
            Wiki
          </Button>
        )}
        {/* Three-dot menu with edit/delete actions - hidden for orchestrator */}
        {!isOrchestratorTeam && (
          <OverflowMenu
            align="bottom-right"
            items={[
              { label: 'Edit Team', onClick: onEditTeam },
              { label: 'Delete Team', danger: true, onClick: onDeleteTeam }
            ]}
          />
        )}
      </div>
    </div>
  );
};
