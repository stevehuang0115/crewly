import React, { useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { TeamMember } from '@/types';
import { OverflowMenu } from '@/components/UI/OverflowMenu';

interface TeamMemberRowProps {
  member: TeamMember;
  teamId: string;
  onStart?: (memberId: string) => Promise<void>;
  onStop?: (memberId: string) => Promise<void>;
  onViewTerminal?: (member: TeamMember) => void;
  onViewAgent?: (member: TeamMember) => void;
  /** When true, shows loading state (team is starting) */
  isStartingTeam?: boolean;
}

export const TeamMemberRow: React.FC<TeamMemberRowProps> = ({ member, teamId, onStart, onStop, onViewTerminal, onViewAgent, isStartingTeam }) => {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const isActive = member.agentStatus === 'active';
  const isStarted = member.agentStatus === 'started';
  const isStartingStatus = member.agentStatus === 'starting' || member.agentStatus === 'activating';
  const isRunning = isActive || isStarted || isStartingStatus;
  // Show as loading if: starting/activating status, OR individual start is clicked, OR team is starting (and member not already active/started)
  const isInTransition = isStartingStatus || isStarting || (isStartingTeam && !isActive && !isStarted);
  const isLoading = isStarting || isStopping || (isStartingTeam && !isActive && !isStarted);

  // Determine status display based on agent lifecycle:
  // inactive -> starting -> started -> active
  let statusText = 'Inactive';
  let statusColor = 'bg-gray-500/10 text-gray-300';

  if (isStopping) {
    statusText = 'Stopping...';
    statusColor = 'bg-orange-500/10 text-orange-400';
  } else if (member.agentStatus === 'suspended') {
    statusText = 'Suspended';
    statusColor = 'bg-yellow-500/10 text-yellow-400';
  } else if (isActive) {
    statusText = 'Active';
    statusColor = 'bg-emerald-500/10 text-emerald-400';
  } else if (isStarted) {
    statusText = 'Started';
    statusColor = 'bg-blue-500/10 text-blue-400';
  } else if (isInTransition) {
    statusText = 'Starting...';
    statusColor = 'bg-yellow-500/10 text-yellow-400';
  }

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onStart && !isLoading) {
      setIsStarting(true);
      try {
        await onStart(member.id);
      } finally {
        setIsStarting(false);
      }
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onStop && !isLoading) {
      setIsStopping(true);
      try {
        await onStop(member.id);
      } finally {
        setIsStopping(false);
      }
    }
  };

  const avatar = member.avatar;

  return (
    <div className="member-row">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-background-dark border border-border-dark flex items-center justify-center overflow-hidden">
          {avatar ? (
            avatar.startsWith('http') || avatar.startsWith('data:') ? (
              <img src={avatar} alt={member.name} className="w-full h-full object-cover" />
            ) : (
              <span className="text-sm">{avatar}</span>
            )
          ) : (
            <span className="text-sm">{member.name.charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div>
          <div className="font-semibold">{member.name}</div>
          <div className="text-sm text-text-secondary-dark">Session: {member.sessionName || 'Inactive'}</div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`px-3 py-1 rounded-full text-sm font-medium flex items-center gap-2 ${statusColor}`}>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusText}
        </span>
        <div className="flex items-center gap-2">
          {(isActive || isStarted || isStartingStatus || isStopping) && !isStarting ? (
            <button
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isLoading
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-red-500/20 hover:text-red-400'
              }`}
              title="Stop"
              onClick={handleStop}
              disabled={isLoading}
            >
              {isStopping ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </button>
          ) : (
            <button
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isLoading
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-green-500/20 hover:text-green-400'
              }`}
              title="Start"
              onClick={handleStart}
              disabled={isLoading}
            >
              {isStarting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
            </button>
          )}
          <OverflowMenu
            align="bottom-right"
            buttonClassName="w-9 h-9 rounded-full hover:bg-primary/20 hover:text-primary flex items-center justify-center transition-colors"
            items={[
              ...(onViewAgent ? [
                {
                  label: isRunning ? 'View Agent' : 'Edit Agent',
                  onClick: () => onViewAgent(member)
                }
              ] : []),
              ...(isRunning && member.sessionName && onViewTerminal ? [
                {
                  label: 'View Terminal',
                  onClick: () => onViewTerminal(member)
                }
              ] : [])
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default TeamMemberRow;
