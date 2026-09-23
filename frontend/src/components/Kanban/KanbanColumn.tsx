import React from 'react';
import { KanbanCard } from './KanbanCard';
import { KanbanTask } from './KanbanBoard';

interface KanbanColumnProps {
  title: string;
  /** Tailwind background class for the column's colour indicator */
  color: string;
  tasks: KanbanTask[];
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onTaskEdit: (task: KanbanTask) => void;
  onTaskDelete: (taskId: string) => void;
  onDragStart: (task: KanbanTask) => void;
  onDragEnd: () => void;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  title,
  color,
  tasks,
  onDragOver,
  onDrop,
  onTaskEdit,
  onTaskDelete,
  onDragStart,
  onDragEnd
}) => {
  return (
    <div
      className="kanban-column"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="column-header">
        <div className="column-title">
          <div className={`column-indicator w-2.5 h-2.5 rounded-full ${color}`} />
          <h3>{title}</h3>
          <span className="task-count">{tasks.length}</span>
        </div>
      </div>

      <div className="column-content">
        {tasks.map((task) => (
          <KanbanCard
            key={task.id}
            task={task}
            onEdit={() => onTaskEdit(task)}
            onDelete={() => onTaskDelete(task.id)}
            onDragStart={() => onDragStart(task)}
            onDragEnd={onDragEnd}
          />
        ))}

        {tasks.length === 0 && (
          <div className="empty-column">
            <p>No tasks</p>
          </div>
        )}
      </div>
    </div>
  );
};