import React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { KanbanTask } from './KanbanBoard';

interface KanbanCardProps {
  task: KanbanTask;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export const KanbanCard: React.FC<KanbanCardProps> = ({
  task,
  onEdit,
  onDelete,
  onDragStart,
  onDragEnd
}) => {
  const getPriorityColor = (priority: KanbanTask['priority']): string => {
    switch (priority) {
      case 'high': return 'bg-red-500';
      case 'medium': return 'bg-amber-500';
      case 'low': return 'bg-emerald-500';
      default: return 'bg-text-secondary-dark';
    }
  };

  const isOverdue = (dueDate?: string) => {
    if (!dueDate) return false;
    return new Date(dueDate) < new Date();
  };

  const formatDueDate = (dueDate?: string) => {
    if (!dueDate) return null;
    const date = new Date(dueDate);
    const now = new Date();
    const diffTime = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return `${Math.abs(diffDays)} days overdue`;
    } else if (diffDays === 0) {
      return 'Due today';
    } else if (diffDays === 1) {
      return 'Due tomorrow';
    } else if (diffDays <= 7) {
      return `Due in ${diffDays} days`;
    } else {
      return date.toLocaleDateString();
    }
  };

  return (
    <div
      className="kanban-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-header">
        <div className="card-title">
          <h4>{task.title}</h4>
          <div
            className={`priority-indicator w-2.5 h-2.5 rounded-full ${getPriorityColor(task.priority)}`}
            title={`Priority: ${task.priority}`}
          />
        </div>
        
        <div className="card-actions">
          <IconButton
            icon={Pencil}
            size="xs"
            onClick={onEdit}
            title="Edit task"
            aria-label="Edit task"
          />
          <IconButton
            icon={Trash2}
            variant="danger-ghost"
            size="xs"
            onClick={onDelete}
            title="Delete task"
            aria-label="Delete task"
          />
        </div>
      </div>

      {task.description && (
        <div className="card-description">
          <p>{task.description}</p>
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="card-tags">
          {task.tags.map((tag, index) => (
            <span key={index} className="task-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="card-footer">
        <div className="card-meta">
          {task.assignee && (
            <div className="assignee">
              <span className="assignee-avatar">
                {task.assignee.charAt(0).toUpperCase()}
              </span>
              <span className="assignee-name">{task.assignee}</span>
            </div>
          )}
          
          {task.dueDate && (
            <div className={`due-date ${isOverdue(task.dueDate) ? 'overdue' : ''}`}>
              📅 {formatDueDate(task.dueDate)}
            </div>
          )}
        </div>

        <div className="card-timestamp">
          Updated {new Date(task.updatedAt).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
};