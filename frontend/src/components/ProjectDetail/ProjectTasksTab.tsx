/**
 * ProjectTasksTab — the project page's Tasks tab.
 *
 * In the redesign (specs/2026-10-02-ui-redesign.md §Information
 * architecture) Project › Tasks becomes the Tickets board filtered to this
 * project. The shared board is being rebuilt in parallel
 * (branch `feat/ui-tickets-hub`), so this tab is the single seam where it
 * plugs in:
 *
 * TODO(ui-redesign, tickets-hub): replace ProjectTicketsView below with the
 * shared board from PR #960 (`feat/ui-tickets-hub`) once it is on main. Do
 * not import it before then. Exact usage:
 *
 *   import { TicketBoard } from '../Tickets/TicketBoard';
 *   <TicketBoard
 *     projectId={project.id}
 *     teams={teams}
 *     onCountsChange={({ total }) => onCountChange?.(total)}
 *   />
 *
 * With `projectId` set the board loads only this project's tickets, hides
 * the project/type filters, shows the .crewly/tickets hint and sends New
 * ticket to this project, which covers everything ProjectTicketsView does.
 * Optional props: `showNewTicket` (default true), `refreshKey`,
 * `pollIntervalMs` (default 15s), `now`. Keep this component's props as they
 * are: the project page passes the project, its assigned teams and
 * `onCountChange` (the Tasks tab count pill). Keep the Task Flow section.
 * Until then the tab renders today's project board (ProjectTicketsView) plus
 * the collapsible Task Flow, unchanged.
 *
 * @module components/ProjectDetail/ProjectTasksTab
 */

import React, { useEffect, useState } from 'react';
import { CollapsibleSection } from '@crewly/ui';
import type { Project, Team } from '../../types';
import { ProjectTicketsView } from './ProjectTicketsView';
import { TaskFlowView } from '../Hierarchy';
import type { TaskFlowItem } from '../Hierarchy';
import { inProgressTasksService } from '../../services/in-progress-tasks.service';

export interface ProjectTasksTabProps {
  project: Project;
  /** Teams assigned to the project (ticket assignees) */
  teams: Team[];
  /** Open (not cancelled) ticket count, for the Tasks tab pill */
  onCountChange?: (count: number) => void;
}

/**
 * Map the in-progress task API rows to Task Flow items.
 *
 * @param tasks - Rows from `inProgressTasksService.getInProgressTasks()`
 * @returns Items for `<TaskFlowView>`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTaskFlowItems(tasks: any[]): TaskFlowItem[] {
  return tasks.map((t) => ({
    id: t.id,
    taskName: t.taskName || t.taskPath?.split('/').pop()?.replace('.md', '') || t.id,
    status: t.status || 'assigned',
    assignedSessionName: t.assignedSessionName || '',
    assignedTeamMemberId: t.assignedTeamMemberId || t.assignedMemberId || '',
    parentTaskId: t.parentTaskId,
    childTaskIds: t.childTaskIds,
    delegatedBy: t.delegatedBy,
    delegatedBySession: t.delegatedBySession,
    assigneeHierarchyLevel: t.assigneeHierarchyLevel,
    priority: t.priority,
    completedAt: t.completedAt,
    assignedAt: t.assignedAt || '',
  }));
}

/**
 * Tasks tab body (adapter around the project board).
 *
 * @param props - {@link ProjectTasksTabProps}
 * @returns The tab content
 */
export const ProjectTasksTab: React.FC<ProjectTasksTabProps> = ({ project, teams, onCountChange }) => {
  const [taskFlowItems, setTaskFlowItems] = useState<TaskFlowItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tasks = await inProgressTasksService.getInProgressTasks();
        if (!cancelled) setTaskFlowItems(toTaskFlowItems(tasks));
      } catch {
        // Task flow is supplementary
        if (!cancelled) setTaskFlowItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="project-tasks-tab">
      {taskFlowItems.length > 0 && (
        <CollapsibleSection
          title={`Task Flow (${taskFlowItems.length} active)`}
          summary="Who delegated what to whom"
          className="mb-4 border-t-0 pt-0"
          unmountWhenClosed
          data-testid="project-task-flow"
        >
          <TaskFlowView tasks={taskFlowItems} />
        </CollapsibleSection>
      )}
      <ProjectTicketsView project={project} teams={teams} onCountChange={onCountChange} />
    </div>
  );
};

export default ProjectTasksTab;
