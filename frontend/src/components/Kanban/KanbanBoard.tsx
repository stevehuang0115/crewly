import React, { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { KanbanColumn } from './KanbanColumn';
// import { KanbanCard } from './KanbanCard';
import { TaskModal } from './TaskModal';

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
  assignee?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  dueDate?: string;
  teamId?: string;
  projectId?: string;
}

interface KanbanBoardProps {
  projectId?: string;
  teamId?: string;
  onTaskUpdate?: (task: KanbanTask) => void;
  onTaskCreate?: (task: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onTaskDelete?: (taskId: string) => void;
}

const columns = [
  { id: 'todo', title: 'To Do', color: 'bg-text-secondary-dark' },
  { id: 'in-progress', title: 'In Progress', color: 'bg-blue-500' },
  { id: 'review', title: 'Review', color: 'bg-amber-500' },
  { id: 'done', title: 'Done', color: 'bg-emerald-500' }
];

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  projectId,
  teamId,
  onTaskUpdate,
  onTaskCreate,
  onTaskDelete
}) => {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [draggedTask, setDraggedTask] = useState<KanbanTask | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<KanbanTask | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTasks();
  }, [projectId, teamId]);

  const fetchTasks = async () => {
    try {
      let url = '/api/tasks';
      const params = new URLSearchParams();
      if (projectId) params.append('projectId', projectId);
      if (teamId) params.append('teamId', teamId);
      if (params.toString()) url += `?${params.toString()}`;

      const response = await fetch(url);
      if (response.ok) {
        const tasksData = await response.json();
        setTasks(tasksData);
      }
    } catch (error) {
      console.error('Error fetching tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTaskUpdate = async (updatedTask: KanbanTask) => {
    try {
      const response = await fetch(`/api/tasks/${updatedTask.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedTask),
      });

      if (response.ok) {
        const savedTask = await response.json();
        setTasks(prev => prev.map(task => 
          task.id === savedTask.id ? savedTask : task
        ));
        if (onTaskUpdate) {
          onTaskUpdate(savedTask);
        }
      }
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  const handleTaskCreate = async (taskData: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...taskData,
          projectId,
          teamId,
        }),
      });

      if (response.ok) {
        const newTask = await response.json();
        setTasks(prev => [...prev, newTask]);
        if (onTaskCreate) {
          onTaskCreate(taskData);
        }
      }
    } catch (error) {
      console.error('Error creating task:', error);
    }
  };

  const handleTaskDelete = async (taskId: string) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setTasks(prev => prev.filter(task => task.id !== taskId));
        if (onTaskDelete) {
          onTaskDelete(taskId);
        }
      }
    } catch (error) {
      console.error('Error deleting task:', error);
    }
  };

  const handleDragStart = (task: KanbanTask) => {
    setDraggedTask(task);
  };

  const handleDragEnd = () => {
    setDraggedTask(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, newStatus: KanbanTask['status']) => {
    e.preventDefault();
    if (draggedTask && draggedTask.status !== newStatus) {
      const updatedTask = {
        ...draggedTask,
        status: newStatus,
        updatedAt: new Date().toISOString()
      };
      handleTaskUpdate(updatedTask);
    }
  };

  const handleTaskEdit = (task: KanbanTask) => {
    setEditingTask(task);
    setIsModalOpen(true);
  };

  const handleModalSubmit = (taskData: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingTask) {
      const updatedTask = {
        ...editingTask,
        ...taskData,
        updatedAt: new Date().toISOString()
      };
      handleTaskUpdate(updatedTask);
    } else {
      handleTaskCreate(taskData);
    }
    setIsModalOpen(false);
    setEditingTask(null);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setEditingTask(null);
  };

  const getTasksByStatus = (status: KanbanTask['status']) => {
    return tasks.filter(task => task.status === status);
  };

  if (loading) {
    return (
      <div className="kanban-board">
        <div className="kanban-header">
          <h2>Task Board</h2>
        </div>
        <div className="loading-state">Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="kanban-board">
      <div className="kanban-header">
        <h2>Task Board</h2>
        <Button size="sm" icon={Plus} onClick={() => setIsModalOpen(true)}>
          Add Task
        </Button>
      </div>

      <div className="kanban-columns">
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            title={column.title}
            color={column.color}
            tasks={getTasksByStatus(column.id as KanbanTask['status'])}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, column.id as KanbanTask['status'])}
            onTaskEdit={handleTaskEdit}
            onTaskDelete={handleTaskDelete}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {isModalOpen && (
        <TaskModal
          task={editingTask}
          onSubmit={handleModalSubmit}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
};