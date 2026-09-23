import React from 'react';
import { CheckCircle, Clock, AlertCircle, Circle, Edit } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Popup } from '@crewly/ui/Popup';

interface TaskDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: any | null;
  onEdit?: (task: any) => void;
  onAssign?: (task: any) => void;
  taskAssignmentLoading?: string | null;
}

const statusInfo = {
  'in_progress': { icon: Clock, color: 'text-primary', label: 'In Progress' },
  'open': { icon: Circle, color: 'text-text-secondary-dark', label: 'Open' },
  'pending': { icon: Circle, color: 'text-text-secondary-dark', label: 'Open' },
  'done': { icon: CheckCircle, color: 'text-green-400', label: 'Done' },
  'completed': { icon: CheckCircle, color: 'text-green-400', label: 'Done' },
  'blocked': { icon: AlertCircle, color: 'text-red-400', label: 'Blocked' },
};

const priorityInfo = {
  'high': { color: 'text-red-400', label: 'High' },
  'critical': { color: 'text-red-500', label: 'Critical' },
  'medium': { color: 'text-yellow-400', label: 'Medium' },
  'low': { color: 'text-green-400', label: 'Low' },
};

/**
 * Read-only task details dialog with optional Edit / Start Task actions.
 *
 * @param props - Dialog props
 * @returns The dialog, or null when closed or no task is selected
 */
export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  isOpen,
  onClose,
  task,
  onEdit,
  onAssign,
  taskAssignmentLoading
}) => {
  if (!isOpen || !task) return null;

  const currentStatus = statusInfo[task.status as keyof typeof statusInfo] || statusInfo.open;
  const currentPriority = priorityInfo[task.priority as keyof typeof priorityInfo] || priorityInfo.medium;
  const StatusIcon = currentStatus.icon;

  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      title={task.title}
      subtitle="In Crewly Project"
      size="xxl"
    >
      {/* Content */}
      <div className="max-h-[70vh] overflow-y-auto">
        {/* Status Bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-6">
            <div>
              <label className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider">Status</label>
              <div className="flex items-center gap-2 mt-1">
                <StatusIcon className={`${currentStatus.color} w-5 h-5`} />
                <p className="text-sm font-medium">{currentStatus.label}</p>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider">Priority</label>
              <div className="flex items-center gap-2 mt-1">
                <div className={`w-3 h-3 rounded-full ${currentPriority.color.replace('text-', 'bg-')}`} />
                <p className="text-sm font-medium">{currentPriority.label}</p>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider">Milestone</label>
              <div className="flex items-center gap-2 mt-1">
                <div className="w-3 h-3 rounded bg-primary/80" />
                <p className="text-sm font-medium">
                  {task.milestoneId?.replace(/_/g, ' ').replace(/^m\d+\s*/, '') || task.milestone || 'General'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onEdit && (
              <Button variant="secondary" size="sm" icon={Edit} onClick={() => onEdit(task)}>
                Edit
              </Button>
            )}
            {onAssign && task.status !== 'done' && task.status !== 'completed' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onAssign(task)}
                loading={taskAssignmentLoading === task.id}
                disabled={taskAssignmentLoading === task.id}
              >
                {taskAssignmentLoading === task.id ? 'Starting...' : 'Start Task'}
              </Button>
            )}
          </div>
        </div>

        {/* Description */}
        <div className="mb-6">
          <h4 className="text-lg font-semibold mb-4">Description</h4>
          <div className="text-text-secondary-dark leading-relaxed prose prose-invert max-w-none text-sm">
            {task.description ? (
              <div>
                {task.description.split('\n').map((line: string, index: number) => (
                  <p key={index} className="mb-2">{line}</p>
                ))}
              </div>
            ) : (
              <p className="italic text-text-secondary-dark">No description provided</p>
            )}
          </div>
        </div>

        {/* Acceptance Criteria */}
        {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
          <div className="mb-6">
            <h4 className="text-lg font-semibold mb-4">Acceptance Criteria ({task.acceptanceCriteria.length})</h4>
            <div className="space-y-2">
              {task.acceptanceCriteria.map((criteria: string, index: number) => (
                <div key={index} className="flex items-start gap-2 p-3 bg-background-dark rounded-2xl">
                  <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
                  <span className="text-sm">{criteria}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Subtasks */}
        {task.tasks && task.tasks.length > 0 && (
          <div className="mb-6">
            <h4 className="text-lg font-semibold mb-4">Subtasks ({task.tasks.length})</h4>
            <div className="space-y-2">
              {task.tasks.map((subtask: string, index: number) => (
                <div key={index} className="flex items-start gap-2 p-3 bg-background-dark rounded-2xl">
                  <Circle className="w-4 h-4 text-text-secondary-dark mt-0.5 flex-shrink-0" />
                  <span className="text-sm">{subtask.replace(/^\[x\]\s*|\[\s*\]\s*/i, '')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Assignment Info */}
        {task.assignee && (
          <div className="mb-6">
            <h4 className="text-lg font-semibold mb-4">Assignment</h4>
            <div className="p-3 bg-background-dark rounded-2xl">
              <p className="text-sm">
                <span className="text-text-secondary-dark">Assigned to:</span>{' '}
                <span className="font-medium">{task.assignee}</span>
              </p>
            </div>
          </div>
        )}

        {/* Structured Output */}
        {task.output && (
          <div className="mb-6">
            <h4 className="text-lg font-semibold mb-4">Structured Deliverable</h4>
            <div className="p-4 bg-background-dark rounded-2xl border border-border-dark overflow-x-auto">
              <pre className="text-xs font-mono text-primary">
                {typeof task.output === 'string' 
                  ? task.output 
                  : JSON.stringify(task.output, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </Popup>
  );
};