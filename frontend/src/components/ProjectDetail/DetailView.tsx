import React, { useState, useEffect } from 'react';
import { useAlert } from '@crewly/ui/Dialog';
import { FileText } from 'lucide-react';
import { Button } from '@crewly/ui';
import { listProjectTickets } from '../../services/project-tickets.service';
import { DetailViewProps } from './types';

interface ProjectStats {
  mdFileCount: number;
  taskCount: number;
  hasProjectMd: boolean;
  hasUserJourneyMd: boolean;
  hasInitialGoalMd: boolean;
  hasInitialUserJourneyMd: boolean;
}

const DetailView: React.FC<DetailViewProps> = ({ 
  project, 
  onAddGoal, 
  onEditGoal, 
  onAddUserJourney, 
  onEditUserJourney, 
  onBuildSpecs,
  buildSpecsWorkflow,
  alignmentStatus,
  onContinueWithMisalignment,
  onViewAlignment,
  selectedBuildSpecsTeam,
  setSelectedBuildSpecsTeam,
  availableTeams,
}) => {
  const { showSuccess, showError, AlertComponent } = useAlert();
  const [projectStats, setProjectStats] = useState<ProjectStats>({
    mdFileCount: 0,
    taskCount: 0,
    hasProjectMd: false,
    hasUserJourneyMd: false,
    hasInitialGoalMd: false,
    hasInitialUserJourneyMd: false
  });
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState({ progressPercent: 0, tasksCompleted: 0, tasksTotal: 0, assignedTeams: 0 });

  useEffect(() => {
    loadProjectStats();
  }, [project.id]);

  const loadProjectStats = async () => {
    try {
      setLoading(true);
      
      // Get project file stats
      const response = await fetch(`/api/projects/${project.id}/stats`);
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setProjectStats(result.data);
        }
      }

      // Metrics from the project's own backlog (project tickets); cancelled
      // tickets do not count toward the total.
      try {
        const { tickets } = await listProjectTickets(project.id);
        const counted = tickets.filter((t) => t.status !== 'cancelled');
        const total = counted.length;
        const completed = counted.filter((t) => t.status === 'done').length;
        const progress = total ? Math.round((completed / total) * 100) : 0;
        const assigned = (availableTeams || []).filter((t: any) => t.projectIds?.includes(project.id) || t.projectIds?.includes(project.name)).length;
        setMetrics({ progressPercent: progress, tasksCompleted: completed, tasksTotal: total, assignedTeams: assigned });
      } catch (e) {
        console.warn('Failed to compute prototype metrics', e);
      }
    } catch (error) {
      console.error('Error loading project stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenInFinder = async () => {
    try {
      const response = await fetch(`/api/projects/${project.id}/open-finder`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        throw new Error('Failed to open Finder');
      }
      
      const result = await response.json();
      if (result.success) {
        // Show success message briefly
        showSuccess('Project folder opened in Finder');
      } else {
        throw new Error(result.error || 'Failed to open Finder');
      }
    } catch (error) {
      console.error('Error opening Finder:', error);
      showError('Failed to open Finder: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const hasInitialSpecs = () => {
    // Check if both initial_goal.md and initial_user_journey.md exist
    return projectStats.hasInitialGoalMd && projectStats.hasInitialUserJourneyMd;
  };

  const createSpecFile = async (fileName: string, content: string) => {
    try {
      const response = await fetch(`/api/projects/${project.id}/create-spec-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName,
          content
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          showSuccess(`${fileName} created successfully!`);
          // Reload stats to reflect the new file
          loadProjectStats();
        } else {
          throw new Error(result.error || `Failed to create ${fileName}`);
        }
      } else {
        throw new Error(`Failed to create ${fileName}`);
      }
    } catch (error) {
      console.error(`Error creating ${fileName}:`, error);
      showError(`Failed to create ${fileName}: ` + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const getProjectTemplate = () => {
    return `# ${project.name}

## Project Goal

Describe the main objective and purpose of this project.

## Success Criteria

- [ ] Define specific, measurable outcomes
- [ ] Set clear acceptance criteria
- [ ] Establish timeline and milestones

## Technical Requirements

### Core Features
- Feature 1
- Feature 2
- Feature 3

### Technical Stack
- Frontend:
- Backend:
- Database:
- Other tools:

## Resources

- Documentation links
- Reference materials
- External dependencies
`;
  };

  const getUserJourneyTemplate = () => {
    return `# User Journey - ${project.name}

## User Persona

**Primary User**: [Describe the main user type]
- **Role**: 
- **Goals**: 
- **Pain Points**: 

## User Journey Map

### Phase 1: Discovery
**User Action**: 
**User Thoughts**: 
**Pain Points**: 
**Opportunities**: 

### Phase 2: Engagement
**User Action**: 
**User Thoughts**: 
**Pain Points**: 
**Opportunities**: 

### Phase 3: Conversion/Success
**User Action**: 
**User Thoughts**: 
**Pain Points**: 
**Opportunities**: 

## Key Touchpoints

1. **Entry Point**: How users discover the solution
2. **Core Interaction**: Main user flows and interactions
3. **Success State**: What success looks like for the user

## User Stories

- As a [user type], I want [goal] so that [benefit]
- As a [user type], I want [goal] so that [benefit]
- As a [user type], I want [goal] so that [benefit]
`;
  };

  return (
    <div className="detail-view">
      <div className="detail-header">
        <h3>Project Details</h3>
        <p className="detail-description">
          Overview and key metrics for your project
        </p>
      </div>


      {/* Scorecards Section */}
      <div className="detail-section">
        <div className="flex items-center justify-between p-5 border-b border-border-dark">
          <h4>Project Metrics</h4>
        </div>
        {loading ? (
          <div className="loading-stats">
            <p>Loading project metrics...</p>
          </div>
        ) : (
          <div className="scorecards-grid">
            <div className="scorecard">
              <div className="scorecard-header">
                <h5>Overall Progress</h5>
              </div>
              <div className="scorecard-value">{metrics.progressPercent}%</div>
            </div>
            <div className="scorecard">
              <div className="scorecard-header">
                <h5>Tasks Completed</h5>
              </div>
              <div className="scorecard-value">{metrics.tasksCompleted}/{metrics.tasksTotal}</div>
            </div>
            <div className="scorecard">
              <div className="scorecard-header">
                <h5>Assigned Teams</h5>
              </div>
              <div className="scorecard-value">{metrics.assignedTeams}</div>
            </div>
          </div>
        )}
      </div>

      {/* Project Information removed to match prototype */}

      {/* Spec Files Management Section */}
      <div className="detail-section">
        <div className="flex items-center justify-between p-5 border-b border-border-dark">
          <h4>Specification Management</h4>
        </div>
        <div className="spec-management">
          <div className="spec-status-grid">
            <div className="spec-status-item">
              <div className="spec-status-info">
                <FileText className="spec-icon" />
                <div className="spec-details">
                  <h5>Project Goal</h5>
                  <p className="spec-description">Define project objectives and success criteria</p>
                </div>
              </div>
              <div className="spec-status-indicator">
                {projectStats.hasInitialGoalMd ? (
                  <Button
                    variant="secondary"
                    icon={FileText}
                    onClick={onEditGoal}
                  >
                    Edit
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={onAddGoal}
                  >
                    Add Goal
                  </Button>
                )}
              </div>
            </div>
            
            <div className="spec-status-item">
              <div className="spec-status-info">
                <FileText className="spec-icon" />
                <div className="spec-details">
                  <h5>User Journey</h5>
                  <p className="spec-description">Map user interactions and experience flows</p>
                </div>
              </div>
              <div className="spec-status-indicator">
                {projectStats.hasInitialUserJourneyMd ? (
                  <Button
                    variant="secondary"
                    icon={FileText}
                    onClick={onEditUserJourney}
                  >
                    Edit
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={onAddUserJourney}
                  >
                    Add User Journey
                  </Button>
                )}
              </div>
            </div>
          </div>
          
          {/* Generate Project Tasks — redirects to Chat for orchestrator input */}
          <div className="spec-task-actions">
            <h5>Generate Project Tasks</h5>
            <div className="task-creation-buttons">
              <Button onClick={() => window.location.assign('/chat')} className="w-full sm:w-auto flex-1">
                Open Chat to Generate Tasks
              </Button>
            </div>
          </div>
        </div>
      </div>


    </div>
  );
};

// Default and named exports for flexibility
export default DetailView;
export { DetailView };
