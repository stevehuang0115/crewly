import React, { useState, useEffect } from 'react';
import { ScoreCard, ScoreCardGrid } from '@crewly/ui/ScoreCard';
import { Button } from '@crewly/ui/Button';
import { FormSelect } from '@crewly/ui/Form';
import { TeamStatsProps } from './types';

interface Project {
  id: string;
  name: string;
}

interface TeamStatsExtendedProps extends TeamStatsProps {
  onProjectChange?: (projectId: string | null) => void;
}

export const TeamStats: React.FC<TeamStatsExtendedProps> = ({
  team,
  teamStatus,
  projectName,
  onProjectChange,
}) => {
  const activeMembers = team?.members?.filter(m => m.sessionName).length || 0;
  const totalMembers = team?.members?.length || 0;

  const [isEditingProject, setIsEditingProject] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch projects when editing starts
  useEffect(() => {
    if (isEditingProject) {
      fetchProjects();
    }
  }, [isEditingProject]);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/projects');
      if (response.ok) {
        const result = await response.json();
        const projectsData = result.success ? (result.data || []) : (result || []);
        setProjects(projectsData);
      }
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleProjectClick = () => {
    if (onProjectChange) {
      setIsEditingProject(true);
    }
  };

  const handleProjectSelect = async (projectId: string | null) => {
    if (onProjectChange) {
      await onProjectChange(projectId);
      setIsEditingProject(false);
    }
  };

  const handleCancel = () => {
    setIsEditingProject(false);
  };

  const ProjectField = () => {
    if (isEditingProject) {
      return (
        <div className="project-edit-container min-w-[200px] space-y-1">
          <FormSelect
            aria-label="Project"
            value={team?.projectIds?.[0] || ''}
            onChange={(e) => handleProjectSelect(e.target.value || null)}
            disabled={loading}
            autoFocus
          >
            <option value="">No project</option>
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </FormSelect>
          <Button variant="ghost" size="xs" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      );
    }

    return (
      <span
        className={onProjectChange ? 'cursor-pointer underline text-primary' : ''}
        onClick={handleProjectClick}
        title={onProjectChange ? 'Click to edit project' : undefined}
      >
        {projectName || 'None'}
      </span>
    );
  };

  return (
    <ScoreCardGrid variant="horizontal">
      <ScoreCard
        label="Team Status"
        variant="horizontal"
      >
        <span className={`status-badge status-${teamStatus}`}>
          {teamStatus?.toUpperCase()}
        </span>
      </ScoreCard>

      <ScoreCard
        label="Active Members"
        variant="horizontal"
      >
        <span className="score-card__value--number">
          {activeMembers} / {totalMembers}
        </span>
      </ScoreCard>

      <ScoreCard
        label="Project"
        variant="horizontal"
      >
        <ProjectField />
      </ScoreCard>

      <ScoreCard
        label="Created"
        value={team?.createdAt ? new Date(team.createdAt).toLocaleDateString() : 'N/A'}
        variant="horizontal"
      />
    </ScoreCardGrid>
  );
};