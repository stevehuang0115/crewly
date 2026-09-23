import React, { useState, useEffect } from 'react';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { FormGroup, FormInput, FormLabel, FormRow, FormSelect, FormTextarea } from '@crewly/ui/Form';
import { Modal, ModalFooter } from '@crewly/ui/Modal';
import { KanbanTask } from './KanbanBoard';

interface TaskModalProps {
  task?: KanbanTask | null;
  onSubmit: (taskData: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onClose: () => void;
}

/**
 * Create / edit dialog for a Kanban task.
 *
 * @param props - The task being edited (if any), submit and close handlers
 * @returns The task dialog
 */
export const TaskModal: React.FC<TaskModalProps> = ({ task, onSubmit, onClose }) => {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    status: 'todo' as KanbanTask['status'],
    priority: 'medium' as KanbanTask['priority'],
    assignee: '',
    tags: [] as string[],
    dueDate: '',
    teamId: '',
    projectId: ''
  });
  const [tagInput, setTagInput] = useState('');
  const [availableAssignees, setAvailableAssignees] = useState<string[]>([]);
  const [availableTeams, setAvailableTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [availableProjects, setAvailableProjects] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    fetchAvailableOptions();
    
    if (task) {
      setFormData({
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee || '',
        tags: task.tags,
        dueDate: task.dueDate ? task.dueDate.split('T')[0] : '',
        teamId: task.teamId || '',
        projectId: task.projectId || ''
      });
    }
  }, [task]);

  const fetchAvailableOptions = async () => {
    try {
      // Fetch available assignees (team members)
      const assigneesResponse = await fetch('/api/users');
      if (assigneesResponse.ok) {
        const assigneesData = await assigneesResponse.json();
        setAvailableAssignees(assigneesData.map((user: any) => user.name));
      }

      // Fetch available teams
      const teamsResponse = await fetch('/api/teams');
      if (teamsResponse.ok) {
        const teamsData = await teamsResponse.json();
        setAvailableTeams(teamsData);
      }

      // Fetch available projects
      const projectsResponse = await fetch('/api/projects');
      if (projectsResponse.ok) {
        const projectsData = await projectsResponse.json();
        setAvailableProjects(projectsData);
      }
    } catch (error) {
      console.error('Error fetching available options:', error);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      if (!formData.tags.includes(tagInput.trim())) {
        setFormData(prev => ({
          ...prev,
          tags: [...prev.tags, tagInput.trim()]
        }));
      }
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.filter(tag => tag !== tagToRemove)
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) return;

    onSubmit({
      ...formData,
      dueDate: formData.dueDate || undefined
    });
  };

  return (
    <Modal isOpen onClose={onClose} title={task ? 'Edit Task' : 'Create New Task'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormGroup>
          <FormLabel htmlFor="title" required>Title</FormLabel>
          <FormInput
            type="text"
            id="title"
            name="title"
            value={formData.title}
            onChange={handleInputChange}
            placeholder="Task title"
            required
          />
        </FormGroup>

        <FormGroup>
          <FormLabel htmlFor="description">Description</FormLabel>
          <FormTextarea
            id="description"
            name="description"
            value={formData.description}
            onChange={handleInputChange}
            placeholder="Task description"
            rows={4}
          />
        </FormGroup>

        <FormRow>
          <FormGroup>
            <FormLabel htmlFor="status">Status</FormLabel>
            <FormSelect id="status" name="status" value={formData.status} onChange={handleInputChange}>
              <option value="todo">To Do</option>
              <option value="in-progress">In Progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </FormSelect>
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="priority">Priority</FormLabel>
            <FormSelect id="priority" name="priority" value={formData.priority} onChange={handleInputChange}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </FormSelect>
          </FormGroup>
        </FormRow>

        <FormRow>
          <FormGroup>
            <FormLabel htmlFor="assignee">Assignee</FormLabel>
            <FormSelect id="assignee" name="assignee" value={formData.assignee} onChange={handleInputChange}>
              <option value="">Unassigned</option>
              {availableAssignees.map((assignee) => (
                <option key={assignee} value={assignee}>
                  {assignee}
                </option>
              ))}
            </FormSelect>
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="dueDate">Due Date</FormLabel>
            <FormInput
              type="date"
              id="dueDate"
              name="dueDate"
              value={formData.dueDate}
              onChange={handleInputChange}
            />
          </FormGroup>
        </FormRow>

        <FormRow>
          <FormGroup>
            <FormLabel htmlFor="teamId">Team</FormLabel>
            <FormSelect id="teamId" name="teamId" value={formData.teamId} onChange={handleInputChange}>
              <option value="">Select Team</option>
              {availableTeams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </FormSelect>
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor="projectId">Project</FormLabel>
            <FormSelect id="projectId" name="projectId" value={formData.projectId} onChange={handleInputChange}>
              <option value="">Select Project</option>
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </FormSelect>
          </FormGroup>
        </FormRow>

        <FormGroup>
          <FormLabel htmlFor="tags">Tags</FormLabel>
          <FormInput
            type="text"
            id="tags"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleAddTag}
            placeholder="Type tag and press Enter"
          />
          {formData.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {formData.tags.map((tag) => (
                <Badge key={tag} variant="primary" className="gap-1">
                  {tag}
                  <button
                    type="button"
                    className="hover:text-text-primary-dark"
                    onClick={() => handleRemoveTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </FormGroup>

        <ModalFooter className="px-0 pb-0 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!formData.title.trim()}>
            {task ? 'Update Task' : 'Create Task'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
};