/**
 * TaskFlowView Component
 *
 * Visualizes the task flow from delegation to completion in a hierarchical
 * task tree. Shows parent tasks decomposed into child tasks, with status
 * indicators and delegation paths.
 *
 * @module components/Hierarchy/TaskFlowView
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Loader2,
  CircleDot,
  PauseCircle,
} from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Minimal task type mirroring backend InProgressTask for the frontend */
export interface TaskFlowItem {
  id: string;
  taskName: string;
  status: string;
  assignedSessionName: string;
  assignedTeamMemberId: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  delegatedBy?: string;
  delegatedBySession?: string;
  assigneeHierarchyLevel?: number;
  priority?: 'low' | 'medium' | 'high';
  completedAt?: string;
  assignedAt: string;
}

export interface TaskFlowViewProps {
  /** All tasks to visualize */
  tasks: TaskFlowItem[];
  /** Optional callback when a task node is clicked */
  onTaskClick?: (task: TaskFlowItem) => void;
  /** Additional CSS classes */
  className?: string;
}

/** A node in the task tree with computed children */
export interface TaskFlowNode {
  task: TaskFlowItem;
  children: TaskFlowNode[];
  depth: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Map task status to an icon component */
const STATUS_ICONS: Record<string, React.FC<{ className?: string; size?: string | number }>> = {
  completed: CheckCircle2,
  assigned: Clock,
  active: Loader2,
  working: Loader2,
  submitted: CircleDot,
  input_required: AlertCircle,
  verifying: PauseCircle,
  blocked: AlertCircle,
  failed: XCircle,
  cancelled: XCircle,
  pending_assignment: Clock,
};

/** Map task status to text color */
const STATUS_COLORS: Record<string, string> = {
  completed: 'text-emerald-400',
  assigned: 'text-yellow-400',
  active: 'text-blue-400',
  working: 'text-blue-400',
  submitted: 'text-primary',
  input_required: 'text-orange-400',
  verifying: 'text-cyan-400',
  blocked: 'text-orange-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-500',
  pending_assignment: 'text-gray-400',
};

/** Map priority to badge color */
const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/10 text-red-400 border-red-500/20',
  medium: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  low: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
};

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Build a tree of TaskFlowNode from a flat list of tasks.
 * Tasks without a parentTaskId are treated as roots.
 *
 * @param tasks - Flat list of tasks
 * @returns Array of root task flow nodes
 */
export function buildTaskTree(tasks: TaskFlowItem[]): TaskFlowNode[] {
  if (tasks.length === 0) return [];

  const childrenMap = new Map<string, TaskFlowItem[]>();
  const roots: TaskFlowItem[] = [];

  for (const t of tasks) {
    if (!t.parentTaskId) {
      roots.push(t);
    } else {
      const siblings = childrenMap.get(t.parentTaskId) ?? [];
      siblings.push(t);
      childrenMap.set(t.parentTaskId, siblings);
    }
  }

  function buildNode(task: TaskFlowItem, depth: number): TaskFlowNode {
    const childTasks = childrenMap.get(task.id) ?? [];
    return {
      task,
      depth,
      children: childTasks.map(c => buildNode(c, depth + 1)),
    };
  }

  return roots.map(r => buildNode(r, 0));
}

/**
 * Get a human-readable label for a task status.
 *
 * @param status - Task status string
 * @returns Display label
 */
export function getTaskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    completed: 'Completed',
    assigned: 'Assigned',
    active: 'Active',
    working: 'Working',
    submitted: 'Submitted',
    input_required: 'Input Required',
    verifying: 'Verifying',
    blocked: 'Blocked',
    failed: 'Failed',
    cancelled: 'Cancelled',
    pending_assignment: 'Pending',
  };
  return labels[status] ?? status;
}

/**
 * Compute completion percentage for a task tree node.
 *
 * @param node - Task flow node
 * @returns Percentage 0-100
 */
export function computeCompletionPercent(node: TaskFlowNode): number {
  if (node.children.length === 0) {
    return node.task.status === 'completed' ? 100 : 0;
  }
  const completedCount = node.children.filter(c => c.task.status === 'completed').length;
  return Math.round((completedCount / node.children.length) * 100);
}

// =============================================================================
// Sub-components
// =============================================================================

interface TaskNodeProps {
  node: TaskFlowNode;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onTaskClick?: (task: TaskFlowItem) => void;
}

/**
 * Renders a single task node in the flow tree.
 */
const TaskNode: React.FC<TaskNodeProps> = ({ node, expandedIds, onToggle, onTaskClick }) => {
  const { task, children, depth } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(task.id);
  const StatusIcon = STATUS_ICONS[task.status] ?? CircleDot;
  const statusColor = STATUS_COLORS[task.status] ?? 'text-gray-400';
  const statusLabel = getTaskStatusLabel(task.status);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle(task.id);
    },
    [task.id, onToggle]
  );

  const handleClick = useCallback(() => {
    onTaskClick?.(task);
  }, [task, onTaskClick]);

  const completionPercent = hasChildren ? computeCompletionPercent(node) : null;

  return (
    <div data-testid={`task-node-${task.id}`}>
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

        {/* Status icon */}
        <StatusIcon size={16} className={`shrink-0 ${statusColor}`} />

        {/* Task name */}
        <span className="text-sm font-medium text-text-primary-dark truncate">
          {task.taskName}
        </span>

        {/* Assignee */}
        <span className="text-xs text-text-secondary-dark">
          {task.assignedSessionName}
        </span>

        {/* Priority badge */}
        {task.priority && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full border ${PRIORITY_COLORS[task.priority] ?? ''}`}
          >
            {task.priority}
          </span>
        )}

        {/* Status label + completion */}
        <span className={`ml-auto text-xs ${statusColor}`}>
          {statusLabel}
          {completionPercent !== null && ` (${completionPercent}%)`}
        </span>
      </div>

      {/* Render children when expanded */}
      {hasChildren && isExpanded && (
        <div role="group">
          {children.map(child => (
            <TaskNode
              key={child.task.id}
              node={child}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onTaskClick={onTaskClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

TaskNode.displayName = 'TaskNode';

// =============================================================================
// Main component
// =============================================================================

/**
 * TaskFlowView renders a collapsible tree of tasks organized by their
 * parent/child relationships, showing the delegation flow from top-level
 * goals to decomposed sub-tasks.
 *
 * @param tasks - All tasks (flat list, tree derived from parentTaskId)
 * @param onTaskClick - Optional callback when a task is clicked
 * @param className - Additional CSS classes
 * @returns Task flow view component
 *
 * @example
 * ```tsx
 * <TaskFlowView tasks={allTasks} onTaskClick={(t) => openTaskDetail(t)} />
 * ```
 */
export const TaskFlowView: React.FC<TaskFlowViewProps> = ({
  tasks,
  onTaskClick,
  className = '',
}) => {
  // All parent tasks expanded by default
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const parentIds = new Set<string>();
    for (const t of tasks) {
      if (t.childTaskIds && t.childTaskIds.length > 0) {
        parentIds.add(t.id);
      }
    }
    return parentIds;
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

  const tree = useMemo(() => buildTaskTree(tasks), [tasks]);

  if (tasks.length === 0) {
    return (
      <div className={`text-sm text-text-secondary-dark p-4 ${className}`}>
        No tasks to display.
      </div>
    );
  }

  return (
    <div className={`${className}`} role="tree" aria-label="Task flow">
      {tree.map(rootNode => (
        <TaskNode
          key={rootNode.task.id}
          node={rootNode}
          expandedIds={expandedIds}
          onToggle={handleToggle}
          onTaskClick={onTaskClick}
        />
      ))}
    </div>
  );
};

TaskFlowView.displayName = 'TaskFlowView';
