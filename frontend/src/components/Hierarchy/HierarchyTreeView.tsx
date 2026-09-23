/**
 * HierarchyTreeView Component
 *
 * Renders a tree visualization of team hierarchy:
 * Orchestrator -> Team Leaders -> Workers.
 *
 * Each node displays agent name, role, agentStatus, and workingStatus.
 * TL nodes can be expanded/collapsed to show their subordinates.
 * Status is color-coded: active=green, idle=yellow, inactive=gray.
 *
 * @module components/Hierarchy/HierarchyTreeView
 */

import React, { useState, useCallback, useMemo } from 'react';
import { ChevronRight, ChevronDown, User, Crown, Shield } from 'lucide-react';
import type { TeamMember } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface HierarchyTreeViewProps {
  /** All members of the team */
  members: TeamMember[];
  /** Optional callback when a node is clicked */
  onNodeClick?: (member: TeamMember) => void;
  /** Additional CSS classes */
  className?: string;
}

/** A node in the hierarchy tree with computed children */
export interface HierarchyNode {
  member: TeamMember;
  children: HierarchyNode[];
  depth: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Map agentStatus to a Tailwind color class for the status dot */
const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-400',
  started: 'bg-emerald-400',
  starting: 'bg-yellow-400',
  activating: 'bg-yellow-400',
  idle: 'bg-yellow-400',
  suspended: 'bg-orange-400',
  inactive: 'bg-text-secondary-dark',
};

/** Map role to display icon */
const ROLE_ICONS: Record<string, React.FC<{ className?: string; size?: string | number }>> = {
  orchestrator: Crown,
  'team-leader': Shield,
};

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Build a tree of HierarchyNode from a flat list of TeamMembers.
 * Members without a parentMemberId are treated as roots (level 0).
 *
 * @param members - Flat list of team members
 * @returns Array of root hierarchy nodes
 */
export function buildHierarchyTree(members: TeamMember[]): HierarchyNode[] {
  if (members.length === 0) return [];

  const memberMap = new Map<string, TeamMember>();
  for (const m of members) {
    memberMap.set(m.id, m);
  }

  const childrenMap = new Map<string, TeamMember[]>();
  const roots: TeamMember[] = [];

  for (const m of members) {
    if (!m.parentMemberId) {
      roots.push(m);
    } else {
      const siblings = childrenMap.get(m.parentMemberId) ?? [];
      siblings.push(m);
      childrenMap.set(m.parentMemberId, siblings);
    }
  }

  function buildNode(member: TeamMember, depth: number): HierarchyNode {
    const childMembers = childrenMap.get(member.id) ?? [];
    return {
      member,
      depth,
      children: childMembers.map(c => buildNode(c, depth + 1)),
    };
  }

  return roots.map(r => buildNode(r, 0));
}

/**
 * Get the CSS class for a member's agent status dot.
 *
 * @param status - The agentStatus value
 * @returns Tailwind class string
 */
export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'bg-text-secondary-dark';
}

/**
 * Get a human-readable label for workingStatus.
 *
 * @param workingStatus - The workingStatus value
 * @returns Display label
 */
export function getWorkingStatusLabel(workingStatus: string): string {
  if (workingStatus === 'in_progress') return 'Working';
  return workingStatus.charAt(0).toUpperCase() + workingStatus.slice(1);
}

// =============================================================================
// Sub-components
// =============================================================================

interface TreeNodeProps {
  node: HierarchyNode;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onNodeClick?: (member: TeamMember) => void;
}

/**
 * Renders a single node in the hierarchy tree with optional expand/collapse.
 */
const TreeNode: React.FC<TreeNodeProps> = ({ node, expandedIds, onToggle, onNodeClick }) => {
  const { member, children, depth } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(member.id);
  const IconComponent = ROLE_ICONS[member.role] ?? User;
  const statusColor = getStatusColor(member.agentStatus);
  const workingLabel = getWorkingStatusLabel(member.workingStatus);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(member.id);
    },
    [member.id, onToggle]
  );

  const handleClick = useCallback(() => {
    onNodeClick?.(member);
  }, [member, onNodeClick]);

  return (
    <div data-testid={`tree-node-${member.id}`}>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-background-dark/50 cursor-pointer transition-colors"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
        onClick={handleClick}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-level={depth + 1}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="p-0.5 rounded hover:bg-background-dark text-text-secondary-dark"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        {/* Role icon */}
        <IconComponent size={16} className="text-text-secondary-dark shrink-0" />

        {/* Status dot */}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`}
          title={member.agentStatus}
        />

        {/* Name and role */}
        <span className="text-sm font-medium text-text-primary-dark truncate">
          {member.name}
        </span>
        <span className="text-xs text-text-secondary-dark">
          {member.role}
        </span>

        {/* Working status badge */}
        <span
          className={`ml-auto text-xs px-1.5 py-0.5 rounded-full ${
            member.workingStatus === 'in_progress'
              ? 'bg-blue-500/10 text-blue-400'
              : 'bg-background-dark text-text-secondary-dark'
          }`}
        >
          {workingLabel}
        </span>
      </div>

      {/* Render children when expanded */}
      {hasChildren && isExpanded && (
        <div role="group">
          {children.map(child => (
            <TreeNode
              key={child.member.id}
              node={child}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onNodeClick={onNodeClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

TreeNode.displayName = 'TreeNode';

// =============================================================================
// Main component
// =============================================================================

/**
 * HierarchyTreeView renders a collapsible tree of team members organized
 * by their hierarchy (Orchestrator -> TL -> Workers).
 *
 * @param members - All team members (flat list, hierarchy derived from parentMemberId)
 * @param onNodeClick - Optional callback when a member node is clicked
 * @param className - Additional CSS classes
 * @returns Tree view component
 *
 * @example
 * ```tsx
 * <HierarchyTreeView members={team.members} onNodeClick={(m) => selectMember(m)} />
 * ```
 */
export const HierarchyTreeView: React.FC<HierarchyTreeViewProps> = ({
  members,
  onNodeClick,
  className = '',
}) => {
  // All TL nodes expanded by default
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const tlIds = new Set<string>();
    for (const m of members) {
      if (m.canDelegate || m.role === 'team-leader' || m.role === 'orchestrator') {
        tlIds.add(m.id);
      }
    }
    return tlIds;
  });

  const handleToggle = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const tree = useMemo(() => buildHierarchyTree(members), [members]);

  if (members.length === 0) {
    return (
      <div className={`text-sm text-text-secondary-dark p-4 ${className}`}>
        No team members to display.
      </div>
    );
  }

  return (
    <div className={`${className}`} role="tree" aria-label="Team hierarchy">
      {tree.map(rootNode => (
        <TreeNode
          key={rootNode.member.id}
          node={rootNode}
          expandedIds={expandedIds}
          onToggle={handleToggle}
          onNodeClick={onNodeClick}
        />
      ))}
    </div>
  );
};

HierarchyTreeView.displayName = 'HierarchyTreeView';
