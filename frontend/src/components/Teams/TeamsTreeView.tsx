/**
 * TeamsTreeView Component
 *
 * Renders teams in a hierarchical tree view based on parent-child relationships.
 * Parent teams are shown at the top level with their children indented below.
 * Teams without a parent appear as top-level entries.
 *
 * @module components/Teams/TeamsTreeView
 */
import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Users, FolderOpen } from 'lucide-react';
import { Team } from '@/types';
import { MemberAvatar } from '@/components/common/MemberAvatar';

export interface TeamsTreeViewProps {
  /** All teams (flat list — component builds hierarchy) */
  teams: Team[];
  /** Map of projectId to project name */
  projectMap: Record<string, string>;
  /** Navigate to team detail */
  onTeamClick: (teamId: string) => void;
}

/**
 * Build a parent → children map from a flat team list.
 *
 * @param teams - Flat array of all teams
 * @returns Map of parentTeamId to child teams
 */
function buildChildrenMap(teams: Team[]): Map<string, Team[]> {
  const map = new Map<string, Team[]>();
  for (const t of teams) {
    if (t.parentTeamId) {
      const siblings = map.get(t.parentTeamId) || [];
      siblings.push(t);
      map.set(t.parentTeamId, siblings);
    }
  }
  return map;
}

/**
 * Recursive tree node for a single team.
 */
const TreeNode: React.FC<{
  team: Team;
  depth: number;
  childrenMap: Map<string, Team[]>;
  projectMap: Record<string, string>;
  onTeamClick: (teamId: string) => void;
}> = ({ team, depth, childrenMap, projectMap, onTeamClick }) => {
  const children = childrenMap.get(team.id) || [];
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const members = team.members || [];
  const hasActive = members.some(m => m.agentStatus === 'active');
  const projectName = team.projectIds?.[0] ? projectMap[team.projectIds[0]] : undefined;

  return (
    <div data-testid={`tree-node-${team.id}`}>
      {/* Node row */}
      <div
        className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-background-dark cursor-pointer transition-colors group"
        style={{ paddingLeft: `${depth * 24 + 12}px` }}
        onClick={() => onTeamClick(team.id)}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-0.5 text-text-secondary-dark hover:text-text-primary-dark"
            data-testid={`toggle-${team.id}`}
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        ) : (
          <span className="w-5" /> /* spacer */
        )}

        {/* Team name + status */}
        <span className="font-medium text-sm truncate">{team.name}</span>
        {hasActive && (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-500/10 text-green-400">
            Active
          </span>
        )}

        {/* Member count */}
        <span className="text-xs text-text-secondary-dark ml-auto flex items-center gap-1">
          <Users className="w-3 h-3" />
          {members.length}
        </span>

        {/* Project link */}
        {projectName && (
          <span className="text-xs text-text-secondary-dark flex items-center gap-1 ml-2">
            <FolderOpen className="w-3 h-3" />
            {projectName}
          </span>
        )}

        {/* Member avatars */}
        <div className="flex items-center ml-2">
          {members.slice(0, 3).map((m, idx) => (
            <div key={m.id} style={{ marginLeft: idx === 0 ? 0 : -4 }}>
              <MemberAvatar
                name={m.name}
                avatar={m.avatar}
                size="xs"
                ringClass="ring-1 ring-surface-dark"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div data-testid={`children-${team.id}`}>
          {children.map(child => (
            <TreeNode
              key={child.id}
              team={child}
              depth={depth + 1}
              childrenMap={childrenMap}
              projectMap={projectMap}
              onTeamClick={onTeamClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Teams tree view component.
 *
 * Renders teams as a hierarchical tree based on parentTeamId relationships.
 * Root teams (no parentTeamId) appear at top level.
 *
 * @param props - {@link TeamsTreeViewProps}
 * @returns TeamsTreeView JSX element
 */
export const TeamsTreeView: React.FC<TeamsTreeViewProps> = ({ teams, projectMap, onTeamClick }) => {
  const childrenMap = useMemo(() => buildChildrenMap(teams), [teams]);
  const rootTeams = useMemo(() => teams.filter(t => !t.parentTeamId), [teams]);

  if (rootTeams.length === 0) {
    return (
      <div className="text-center py-8 text-text-secondary-dark text-sm">
        No teams to display
      </div>
    );
  }

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl p-2" data-testid="teams-tree-view">
      {rootTeams.map(team => (
        <TreeNode
          key={team.id}
          team={team}
          depth={0}
          childrenMap={childrenMap}
          projectMap={projectMap}
          onTeamClick={onTeamClick}
        />
      ))}
    </div>
  );
};

export default TeamsTreeView;
