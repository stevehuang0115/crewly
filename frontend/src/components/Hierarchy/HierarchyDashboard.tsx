/**
 * HierarchyDashboard Component
 *
 * Hierarchy-aware team status dashboard. Conditionally renders either:
 * - Hierarchy view (HierarchyTreeView) when team.hierarchical is true
 * - Flat member grid when team.hierarchical is false
 *
 * Also shows summary stats: total members, active count, idle count,
 * and hierarchy depth info when in hierarchical mode.
 *
 * @module components/Hierarchy/HierarchyDashboard
 */

import React, { useMemo } from 'react';
import { Users, GitBranch, Activity, Zap } from 'lucide-react';
import type { Team, TeamMember } from '@/types';
import { HierarchyTreeView } from './HierarchyTreeView';

// =============================================================================
// Types
// =============================================================================

export interface HierarchyDashboardProps {
  /** The team to display */
  team: Team;
  /** Optional callback when a member node is clicked */
  onMemberClick?: (member: TeamMember) => void;
  /** Additional CSS classes */
  className?: string;
}

/** Summary stats for the team dashboard */
export interface TeamSummaryStats {
  total: number;
  active: number;
  idle: number;
  inactive: number;
  working: number;
  hierarchyDepth: number;
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Compute summary stats from team members.
 *
 * @param members - Team members
 * @returns Computed stats
 */
export function computeTeamStats(members: TeamMember[]): TeamSummaryStats {
  let active = 0;
  let idle = 0;
  let inactive = 0;
  let working = 0;
  let maxLevel = 0;

  for (const m of members) {
    if (m.agentStatus === 'active' || m.agentStatus === 'started') active++;
    else if (m.agentStatus === 'inactive') inactive++;
    else idle++;

    if (m.workingStatus === 'in_progress') working++;

    if (m.hierarchyLevel !== undefined && m.hierarchyLevel > maxLevel) {
      maxLevel = m.hierarchyLevel;
    }
  }

  return {
    total: members.length,
    active,
    idle: members.length - active - inactive,
    inactive,
    working,
    hierarchyDepth: maxLevel + 1,
  };
}

// =============================================================================
// Sub-components
// =============================================================================

interface StatCardProps {
  label: string;
  value: number;
  icon: React.FC<{ className?: string; size?: string | number }>;
  color: string;
}

/**
 * Small stat card for the dashboard header.
 */
const StatCard: React.FC<StatCardProps> = ({ label, value, icon: Icon, color }) => (
  <div className="flex items-center gap-3 rounded-lg border border-border-dark p-3 bg-background-dark/30">
    <div className={`p-2 rounded-md ${color}`}>
      <Icon size={16} />
    </div>
    <div>
      <p className="text-lg font-semibold text-text-primary-dark">{value}</p>
      <p className="text-xs text-text-secondary-dark">{label}</p>
    </div>
  </div>
);

StatCard.displayName = 'StatCard';

interface FlatMemberCardProps {
  member: TeamMember;
  onClick?: (member: TeamMember) => void;
}

/**
 * Simple member card for flat (non-hierarchical) view.
 */
const FlatMemberCard: React.FC<FlatMemberCardProps> = ({ member, onClick }) => {
  const statusColor =
    member.agentStatus === 'active' || member.agentStatus === 'started'
      ? 'bg-emerald-400'
      : member.agentStatus === 'inactive'
        ? 'bg-gray-500'
        : 'bg-yellow-400';

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border-dark p-3 hover:bg-background-dark/50 cursor-pointer transition-colors"
      onClick={() => onClick?.(member)}
      data-testid={`flat-member-${member.id}`}
    >
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusColor}`} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary-dark truncate">{member.name}</p>
        <p className="text-xs text-text-secondary-dark">{member.role}</p>
      </div>
      <span
        className={`ml-auto text-xs px-1.5 py-0.5 rounded-full ${
          member.workingStatus === 'in_progress'
            ? 'bg-blue-500/10 text-blue-400'
            : 'bg-background-dark text-text-secondary-dark'
        }`}
      >
        {member.workingStatus === 'in_progress' ? 'Working' : 'Idle'}
      </span>
    </div>
  );
};

FlatMemberCard.displayName = 'FlatMemberCard';

// =============================================================================
// Main component
// =============================================================================

/**
 * HierarchyDashboard displays team status with conditional rendering:
 * - Hierarchical teams: tree view with hierarchy stats
 * - Flat teams: simple member grid with basic stats
 *
 * @param team - Team to display
 * @param onMemberClick - Optional callback when a member is clicked
 * @param className - Additional CSS classes
 * @returns Dashboard component
 *
 * @example
 * ```tsx
 * <HierarchyDashboard team={selectedTeam} onMemberClick={(m) => openMember(m)} />
 * ```
 */
export const HierarchyDashboard: React.FC<HierarchyDashboardProps> = ({
  team,
  onMemberClick,
  className = '',
}) => {
  const stats = useMemo(() => computeTeamStats(team.members), [team.members]);
  const isHierarchical = team.hierarchical === true;

  return (
    <div className={`space-y-4 ${className}`} data-testid="hierarchy-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isHierarchical ? (
            <GitBranch size={18} className="text-primary" />
          ) : (
            <Users size={18} className="text-primary" />
          )}
          <h3 className="text-lg font-semibold text-text-primary-dark">{team.name}</h3>
          {isHierarchical && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
              Hierarchical
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="stats-row">
        <StatCard label="Total" value={stats.total} icon={Users} color="bg-blue-500/10 text-blue-400" />
        <StatCard label="Active" value={stats.active} icon={Activity} color="bg-emerald-500/10 text-emerald-400" />
        <StatCard label="Working" value={stats.working} icon={Zap} color="bg-primary/10 text-primary" />
        {isHierarchical ? (
          <StatCard label="Depth" value={stats.hierarchyDepth} icon={GitBranch} color="bg-primary/10 text-primary" />
        ) : (
          <StatCard label="Inactive" value={stats.inactive} icon={Users} color="bg-gray-500/10 text-gray-400" />
        )}
      </div>

      {/* Members view */}
      {isHierarchical ? (
        <div className="rounded-lg border border-border-dark p-3" data-testid="hierarchy-view">
          <HierarchyTreeView
            members={team.members}
            onNodeClick={onMemberClick}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="flat-view">
          {team.members.length === 0 ? (
            <p className="text-sm text-text-secondary-dark col-span-2 p-4">No team members.</p>
          ) : (
            team.members.map(m => (
              <FlatMemberCard key={m.id} member={m} onClick={onMemberClick} />
            ))
          )}
        </div>
      )}
    </div>
  );
};

HierarchyDashboard.displayName = 'HierarchyDashboard';
