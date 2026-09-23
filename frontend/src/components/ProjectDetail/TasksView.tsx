import React, { useState, useEffect, useRef } from 'react';
import { Play, Link2, Inbox } from 'lucide-react';
import {
  Button,
  FormPopup,
  FormGroup,
  FormRow,
  FormLabel,
  FormInput,
  FormTextarea,
  FormHelp
} from '@crewly/ui';
import { Alert } from '@crewly/ui/Alert';
import { IconButton } from '@crewly/ui/Button';
import { FilterPill } from '@crewly/ui/FilterPill';
import { FormSelect } from '@crewly/ui/Form';
import { TasksViewProps, TaskColumnProps, TaskFormData, MilestoneFormData } from './types';
import { inProgressTasksService } from '../../services/in-progress-tasks.service';
import { apiService } from '../../services/api.service';
import { logSilentError } from '../../utils/error-handling';

export const TasksView: React.FC<TasksViewProps> = ({
  project,
  tickets,
  onTicketsUpdate,
  onCreateSpecsTasks,
  onCreateDevTasks,
  onCreateE2ETasks,
  loading,
  onTaskClick,
  onTaskAssign,
  onTaskUnblock,
  taskAssignmentLoading,
  taskUnblockLoading
}) => {
  const [selectedMilestoneFilter, setSelectedMilestoneFilter] = useState<string | null>(null);
  const [isCreateTaskModalOpen, setIsCreateTaskModalOpen] = useState(false);
  const [isCreateMilestoneModalOpen, setIsCreateMilestoneModalOpen] = useState(false);
  const [createTaskForm, setCreateTaskForm] = useState<TaskFormData>({
    title: '',
    status: 'open',
    priority: 'medium',
    targetRole: '',
    milestone: '',
    description: ''
  });
  const [createMilestoneForm, setCreateMilestoneForm] = useState<MilestoneFormData>({
    name: '',
    description: ''
  });
  const [taskAssignments, setTaskAssignments] = useState<Map<string, any>>(new Map());
  const milestonesGridRef = useRef<HTMLDivElement>(null);
  const [visibleCounts, setVisibleCounts] = useState<{open: number; in_progress: number; done: number; blocked: number}>({ open: 20, in_progress: 20, done: 20, blocked: 20 });
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Filter tickets based on selected milestone or completed
  const filteredTickets = selectedMilestoneFilter
    ? selectedMilestoneFilter === 'Completed'
      ? tickets.filter(t => t.status === 'done' || t.status === 'completed')
      : tickets.filter(t => (t.milestone || t.milestoneId || 'Uncategorized') === selectedMilestoneFilter)
    : tickets;
  
  // Group tasks by status for kanban board
  const tasksByStatus = {
    open: filteredTickets.filter(t => t.status === 'open' || t.status === 'pending'),
    in_progress: filteredTickets.filter(t => t.status === 'in_progress'),
    done: filteredTickets.filter(t => t.status === 'done' || t.status === 'completed'),
    blocked: filteredTickets.filter(t => t.status === 'blocked')
  };

  // Group tasks by milestone for milestone view
  const tasksByMilestone = tickets.reduce((acc, task) => {
    const milestone = task.milestone || task.milestoneId || 'Uncategorized';
    if (!acc[milestone]) {
      acc[milestone] = [];
    }
    acc[milestone].push(task);
    return acc;
  }, {} as Record<string, any[]>);

  // Helper function to extract sequence number from milestone name
  const getMilestoneSequence = (milestone: string): number => {
    const match = milestone.match(/^m(\d+)/i);
    return match ? parseInt(match[1], 10) : 999; // Put uncategorized at end
  };

  // Sort milestones by sequence number
  const sortedMilestones = Object.entries(tasksByMilestone).sort(([a], [b]) => {
    return getMilestoneSequence(a) - getMilestoneSequence(b);
  });

  // Get available milestones for filter chips and form dropdown
  const availableMilestones = Object.keys(tasksByMilestone);

  // Load task assignment data when tickets change (parallel fetching for efficiency)
  useEffect(() => {
    const loadAssignmentData = async () => {
      // Filter tickets with file paths and fetch assignments in parallel
      const ticketsWithPaths = tickets.filter(t => t.filePath);

      if (ticketsWithPaths.length === 0) {
        setTaskAssignments(new Map());
        return;
      }

      const assignmentPromises = ticketsWithPaths.map(async (ticket) => {
        try {
          const details = await inProgressTasksService.getTaskAssignedMemberDetails(ticket.filePath);
          if (details.memberName || details.sessionName) {
            return { id: ticket.id, details };
          }
          return null;
        } catch {
          // Silent failure for individual assignment lookups
          return null;
        }
      });

      const results = await Promise.all(assignmentPromises);
      const assignments = new Map(
        results
          .filter((r): r is { id: string; details: typeof r extends { details: infer D } ? D : never } => r !== null)
          .map(r => [r.id, r.details])
      );

      setTaskAssignments(assignments);
    };

    if (tickets.length > 0) {
      loadAssignmentData();
    }
  }, [tickets]);

  // Load team avatars to map assignee/sessionName -> avatar
  useEffect(() => {
    const loadAvatars = async () => {
      try {
        // Use cached apiService.getTeams() to reduce redundant API calls
        const teams = await apiService.getTeams();
        const map: Record<string, string> = {};
        teams.forEach((team: any) => {
          (team.members || []).forEach((m: any) => {
            if (m.name) map[m.name.toLowerCase()] = m.avatar || '';
            if (m.sessionName) map[m.sessionName.toLowerCase()] = m.avatar || '';
          });
        });
        setAvatarMap(map);
      } catch (e) {
        logSilentError(e, { context: 'Loading team avatars' });
      }
    };
    loadAvatars();
  }, []);

  // Auto-scroll to first in-progress milestone when tasks load
  useEffect(() => {
    if (!milestonesGridRef.current || sortedMilestones.length === 0) return;

    // Find the first milestone with in-progress tasks
    const firstInProgressMilestoneIndex = sortedMilestones.findIndex(([_, tasks]) => {
      return (tasks as any[]).some((task: any) => task.status === 'in_progress');
    });

    if (firstInProgressMilestoneIndex !== -1) {
      // Wait a bit for the component to fully render
      setTimeout(() => {
        const milestonesGrid = milestonesGridRef.current;
        if (milestonesGrid) {
          const milestoneCards = milestonesGrid.querySelectorAll('.milestone-card');
          const targetCard = milestoneCards[firstInProgressMilestoneIndex] as HTMLElement;

          if (targetCard) {
            // Calculate scroll position to center the target card
            const containerWidth = milestonesGrid.clientWidth;
            const cardLeft = targetCard.offsetLeft;
            const cardWidth = targetCard.clientWidth;
            const scrollPosition = cardLeft - (containerWidth / 2) + (cardWidth / 2);

            // Smooth scroll to the target position
            milestonesGrid.scrollTo({
              left: Math.max(0, scrollPosition),
              behavior: 'smooth'
            });
          }
        }
      }, 100);
    }
  }, [sortedMilestones, tickets]);

  // Handle Create Task
  const handleCreateTask = async () => {
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createTaskForm),
      });

      if (response.ok) {
        setIsCreateTaskModalOpen(false);
        setCreateTaskForm({
          title: '',
          status: 'open',
          priority: 'medium',
          targetRole: '',
          milestone: '',
          description: ''
        });
        onTicketsUpdate(); // Refresh tasks
      } else {
        const errorText = await response.text();
        const message = `Failed to create task: ${errorText || 'Unknown error'}`;
        setErrorMessage(message);
        logSilentError(new Error(message), { context: `Create task for project ${project.id}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create task';
      setErrorMessage(message);
      logSilentError(error, { context: `Create task for project ${project.id}` });
    }
  };

  // Handle Create Milestone
  const handleCreateMilestone = async () => {
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/milestones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createMilestoneForm),
      });

      if (response.ok) {
        setIsCreateMilestoneModalOpen(false);
        setCreateMilestoneForm({
          name: '',
          description: ''
        });
        onTicketsUpdate(); // Refresh tasks
      } else {
        const errorText = await response.text();
        const message = `Failed to create milestone: ${errorText || 'Unknown error'}`;
        setErrorMessage(message);
        logSilentError(new Error(message), { context: `Create milestone for project ${project.id}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create milestone';
      setErrorMessage(message);
      logSilentError(error, { context: `Create milestone for project ${project.id}` });
    }
  };

  return (
    <div className="tasks-view">
      {/* Error banner */}
      {errorMessage && (
        <Alert variant="error" size="sm" className="mb-4" onClose={() => setErrorMessage(null)}>
          {errorMessage}
        </Alert>
      )}

      {/* Milestone filter chips (prototype style) */}
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary-dark flex-shrink-0">Milestones:</span>
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1">
            <FilterPill isActive={!selectedMilestoneFilter} onClick={() => setSelectedMilestoneFilter(null)}>
              All
            </FilterPill>
            {sortedMilestones.map(([milestone, tasks]: [string, any[]]) => {
              const displayName = milestone.replace(/_/g, ' ').replace(/^m\d+\s*/, '').replace(/^\w/, c => c.toUpperCase());
              return (
                <FilterPill
                  key={milestone}
                  isActive={selectedMilestoneFilter === milestone}
                  onClick={() => setSelectedMilestoneFilter(milestone)}
                  count={tasks.length}
                >
                  {displayName}
                </FilterPill>
              );
            })}
            <FilterPill
              isActive={selectedMilestoneFilter === 'Completed'}
              onClick={() => setSelectedMilestoneFilter('Completed')}
            >
              Completed
            </FilterPill>
          </div>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="kanban-section">
        <h4>Task Board</h4>
        <div className="kanban-board">
          <TaskColumn
            title="Open"
            count={tasksByStatus.open.length}
            totalCount={tasksByStatus.open.length}
            tasks={tasksByStatus.open.slice(0, visibleCounts.open)}
            status="open"
            onTaskClick={onTaskClick}
            onTaskAssign={onTaskAssign}
            onTaskUnblock={onTaskUnblock}
            taskAssignmentLoading={taskAssignmentLoading}
            taskUnblockLoading={taskUnblockLoading}
            taskAssignments={taskAssignments}
            onCreateTaskClick={() => setIsCreateTaskModalOpen(true)}
            onLoadMore={tasksByStatus.open.length > visibleCounts.open ? () => setVisibleCounts(v => ({...v, open: v.open + 20})) : undefined}
            avatarMap={avatarMap}
          />
          <TaskColumn
            title="In Progress"
            count={tasksByStatus.in_progress.length}
            totalCount={tasksByStatus.in_progress.length}
            tasks={tasksByStatus.in_progress.slice(0, visibleCounts.in_progress)}
            status="in_progress"
            onTaskClick={onTaskClick}
            onTaskAssign={onTaskAssign}
            onTaskUnblock={onTaskUnblock}
            taskAssignmentLoading={taskAssignmentLoading}
            taskUnblockLoading={taskUnblockLoading}
            taskAssignments={taskAssignments}
            onCreateTaskClick={() => setIsCreateTaskModalOpen(true)}
            onLoadMore={tasksByStatus.in_progress.length > visibleCounts.in_progress ? () => setVisibleCounts(v => ({...v, in_progress: v.in_progress + 20})) : undefined}
            avatarMap={avatarMap}
          />
          <TaskColumn
            title="Done"
            count={tasksByStatus.done.length}
            totalCount={tasksByStatus.done.length}
            tasks={tasksByStatus.done.slice(0, visibleCounts.done)}
            status="done"
            onTaskClick={onTaskClick}
            onTaskAssign={onTaskAssign}
            onTaskUnblock={onTaskUnblock}
            taskAssignmentLoading={taskAssignmentLoading}
            taskUnblockLoading={taskUnblockLoading}
            taskAssignments={taskAssignments}
            onCreateTaskClick={() => setIsCreateTaskModalOpen(true)}
            onLoadMore={tasksByStatus.done.length > visibleCounts.done ? () => setVisibleCounts(v => ({...v, done: v.done + 20})) : undefined}
            avatarMap={avatarMap}
          />
          <TaskColumn
            title="Blocked"
            count={tasksByStatus.blocked.length}
            totalCount={tasksByStatus.blocked.length}
            tasks={tasksByStatus.blocked.slice(0, visibleCounts.blocked)}
            status="blocked"
            onTaskClick={onTaskClick}
            onTaskAssign={onTaskAssign}
            onTaskUnblock={onTaskUnblock}
            taskAssignmentLoading={taskAssignmentLoading}
            taskUnblockLoading={taskUnblockLoading}
            taskAssignments={taskAssignments}
            onCreateTaskClick={() => setIsCreateTaskModalOpen(true)}
            onLoadMore={tasksByStatus.blocked.length > visibleCounts.blocked ? () => setVisibleCounts(v => ({...v, blocked: v.blocked + 20})) : undefined}
            avatarMap={avatarMap}
          />
        </div>
      </div>

      {/* Create Task Modal */}
      <FormPopup
        isOpen={isCreateTaskModalOpen}
        onClose={() => setIsCreateTaskModalOpen(false)}
        onSubmit={handleCreateTask}
        title="Create New Task"
        submitText="Create Task"
      >
        <FormGroup>
          <FormRow>
            <div>
              <FormLabel>Title</FormLabel>
              <FormInput
                type="text"
                value={createTaskForm.title}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, title: e.target.value })}
                placeholder="Enter task title"
                required
              />
            </div>
          </FormRow>
          <FormRow>
            <div>
              <FormLabel>Status</FormLabel>
              <FormSelect
                aria-label="Status"
                value={createTaskForm.status}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, status: e.target.value })}
              >
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
                <option value="blocked">Blocked</option>
              </FormSelect>
            </div>
            <div>
              <FormLabel>Priority</FormLabel>
              <FormSelect
                aria-label="Priority"
                value={createTaskForm.priority}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, priority: e.target.value })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </FormSelect>
            </div>
          </FormRow>
          <FormRow>
            <div>
              <FormLabel>Target Role</FormLabel>
              <FormInput
                type="text"
                value={createTaskForm.targetRole}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, targetRole: e.target.value })}
                placeholder="e.g., frontend-developer, backend-developer, qa"
              />
            </div>
            <div>
              <FormLabel>Milestone</FormLabel>
              <FormSelect
                aria-label="Milestone"
                value={createTaskForm.milestone}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, milestone: e.target.value })}
              >
                <option value="">Select milestone</option>
                {availableMilestones.map(milestone => (
                  <option key={milestone} value={milestone}>{milestone}</option>
                ))}
              </FormSelect>
            </div>
          </FormRow>
          <FormRow>
            <div>
              <FormLabel>Description</FormLabel>
              <FormTextarea
                value={createTaskForm.description}
                onChange={(e) => setCreateTaskForm({ ...createTaskForm, description: e.target.value })}
                placeholder="Enter task description"
                rows={4}
              />
            </div>
          </FormRow>
        </FormGroup>
      </FormPopup>

      {/* Create Milestone Modal */}
      <FormPopup
        isOpen={isCreateMilestoneModalOpen}
        onClose={() => setIsCreateMilestoneModalOpen(false)}
        onSubmit={handleCreateMilestone}
        title="Create New Milestone"
        submitText="Create Milestone"
      >
        <FormGroup>
          <FormRow>
            <div>
              <FormLabel>Milestone Name</FormLabel>
              <FormInput
                type="text"
                value={createMilestoneForm.name}
                onChange={(e) => setCreateMilestoneForm({ ...createMilestoneForm, name: e.target.value })}
                placeholder="e.g., m1_foundation, m2_development"
                required
              />
              <FormHelp>
                Use format like m0_*, m1_*, etc. This will create the folder structure for task organization.
              </FormHelp>
            </div>
          </FormRow>
          <FormRow>
            <div>
              <FormLabel>Description</FormLabel>
              <FormTextarea
                value={createMilestoneForm.description}
                onChange={(e) => setCreateMilestoneForm({ ...createMilestoneForm, description: e.target.value })}
                placeholder="Describe the milestone objectives"
                rows={3}
              />
            </div>
          </FormRow>
        </FormGroup>
      </FormPopup>
    </div>
  );
};

// Task Column Component for the new task system
export const TaskColumn: React.FC<TaskColumnProps> = ({
  title,
  count,
  tasks,
  status,
  onTaskClick,
  onTaskAssign,
  onTaskUnblock,
  taskAssignmentLoading,
  taskUnblockLoading,
  taskAssignments,
  onCreateTaskClick,
  onLoadMore,
  totalCount,
  avatarMap
}) => {
  return (
    <div className={`task-column task-column--${status}`} style={{ maxHeight: 'calc(100vh - 22rem)' }}>
      <div className="column-header">
        <div className="flex items-center gap-2">
          <h4 className="column-title">{title}</h4>
          <span className="task-count">{count}</span>
        </div>
      </div>
      <div className="column-content overflow-y-auto">
        {tasks.map(task => (
          <div
            key={task.id}
            className={`bg-surface-dark p-4 rounded-lg border border-border-dark hover:border-primary/50 cursor-pointer shadow-sm transition-all ${task.status === 'done' || task.status === 'completed' ? 'opacity-70' : ''} ${task.status === 'blocked' ? 'border-red-500/50 hover:border-red-500/80' : ''}`}
            onClick={() => onTaskClick(task)}
          >
            <p className={`font-semibold text-sm leading-snug ${task.status === 'done' || task.status === 'completed' ? 'line-through text-text-secondary-dark' : ''}`}>{task.title}</p>
            <div className="flex items-center justify-between mt-3 gap-2">
              <div className="flex items-center gap-2">
                {task.priority && (
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    task.priority === 'high' || task.priority === 'critical' ? 'bg-red-500/20 text-red-400' :
                    task.priority === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-green-500/20 text-green-400'
                  }`}>
                    {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                  </span>
                )}
                <span
                  className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/20 text-primary/80 border border-primary/30"
                  title={task.milestoneId?.replace(/_/g, ' ').replace(/^m\d+\s*/, '').split(':')[0] || 'General'}
                >
                  {(() => {
                    const milestone = task.milestoneId?.replace(/_/g, ' ').replace(/^m\d+\s*/, '').split(':')[0] || 'General';
                    // Truncate long milestone names
                    return milestone.length > 10 ? milestone.substring(0, 10) + '...' : milestone;
                  })()}
                </span>
                {((task as any).linksCount || (task as any).links?.length) && (
                  <div className="flex items-center gap-1 text-primary" title={`${(task as any).linksCount || (task as any).links?.length} dependencies`}>
                    <Link2 className="w-3 h-3" />
                    <span className="text-xs font-medium">{(task as any).linksCount || (task as any).links?.length}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {(() => {
                  const assignment = taskAssignments.get(task.id);
                  const displayName = assignment?.memberName || task.assignee || '';
                  const sessionName = assignment?.sessionName || '';
                  const key1 = displayName.toLowerCase();
                  const key2 = sessionName.toLowerCase();
                  const avatarValue = (avatarMap && (avatarMap[key1] || avatarMap[key2])) || '';
                  if (avatarValue && (avatarValue.startsWith('http') || avatarValue.startsWith('data:'))) {
                    return <img className="w-6 h-6 rounded-full bg-cover bg-center ring-2 ring-surface-dark" src={avatarValue} alt={displayName} title={displayName || sessionName} />;
                  }
                  if (avatarValue) {
                    return <div className="w-6 h-6 rounded-full bg-surface-dark border border-border-dark flex items-center justify-center text-xs text-text-secondary-dark ring-2 ring-surface-dark" title={displayName || sessionName}>{avatarValue}</div>;
                  }
                  const avatarText = (displayName || sessionName || '•').charAt(0).toUpperCase();
                  return <div className="w-6 h-6 rounded-full bg-surface-dark border border-border-dark flex items-center justify-center text-xs text-text-secondary-dark ring-2 ring-surface-dark" title={displayName || sessionName}>{avatarText}</div>;
                })()}
                <IconButton
                  icon={Play}
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onTaskAssign && task.status !== 'done' && task.status !== 'completed') {
                      onTaskAssign(task);
                    }
                  }}
                  className="rounded-full hover:bg-primary/10 hover:text-primary"
                  disabled={taskAssignmentLoading === task.id || task.status === 'done' || task.status === 'completed'}
                  aria-label="Start task"
                  title="Start task"
                />
              </div>
            </div>
          </div>
        ))}
        {tasks.length === 0 && (
          <div className="p-4 flex-grow flex flex-col items-center justify-center text-center">
            <div className="flex flex-col items-center justify-center p-6 rounded-lg bg-surface-dark/50 border-2 border-dashed border-border-dark h-full w-full">
              <Inbox className="w-12 h-12 text-text-secondary-dark mb-3" />
              <h4 className="font-semibold mb-1">No {title} Tasks</h4>
              <p className="text-sm text-text-secondary-dark mb-4">{title === 'Open' ? 'All tasks are in progress or completed.' : `No ${title.toLowerCase()} tasks at the moment.`}</p>
              {onCreateTaskClick && (
                <Button size="sm" onClick={onCreateTaskClick}>Create New Task</Button>
              )}
            </div>
          </div>
        )}
      </div>
      {onLoadMore && (
        <div className="p-4 border-t border-border-dark">
          <Button variant="secondary" size="sm" fullWidth onClick={onLoadMore}>
            Load More
          </Button>
        </div>
      )}
    </div>
  );
};

// Default export
export default TasksView;
