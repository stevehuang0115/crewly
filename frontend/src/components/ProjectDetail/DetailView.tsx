/**
 * DetailView — the project page's Detail tab (redesign, simplify level).
 *
 * One sentence of progress ("96% done — 75 of 78 tasks · 1 team"), linking
 * to the Tasks and Teams tabs, then the specification rows: Project goal and
 * User journey (Add or Edit) and Generate tasks (opens the orchestrator
 * chat). The old metric tiles are the same three numbers, now in that
 * sentence.
 *
 * @module components/ProjectDetail/DetailView
 */

import React, { useState, useEffect } from 'react';
import { FileText, Map as MapIcon, Sparkles } from 'lucide-react';
import { Button } from '@crewly/ui';
import { listProjectTickets } from '../../services/project-tickets.service';
import { ROUTES } from '../../constants/routes.constants';
import { DetailViewProps } from './types';

interface ProjectStats {
  mdFileCount: number;
  taskCount: number;
  hasProjectMd: boolean;
  hasUserJourneyMd: boolean;
  hasInitialGoalMd: boolean;
  hasInitialUserJourneyMd: boolean;
}

/** One specification row: icon, title, one quiet line, one action. */
const SpecRow: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action: React.ReactNode;
  testId: string;
}> = ({ icon: Icon, title, description, action, testId }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-soft py-3.5 sm:flex-nowrap" data-testid={testId}>
    <Icon className="h-5 w-5 shrink-0 text-text-3" aria-hidden="true" />
    <div className="min-w-0 flex-1 basis-56">
      <h5 className="text-[15px] font-semibold leading-[22px] text-text">{title}</h5>
      <p className="text-[13px] leading-[18px] text-text-2">{description}</p>
    </div>
    <div className="shrink-0">{action}</div>
  </div>
);

const DetailView: React.FC<DetailViewProps> = ({
  project,
  onAddGoal,
  onEditGoal,
  onAddUserJourney,
  onEditUserJourney,
  availableTeams,
  onShowTab,
  onOpenChat,
}) => {
  const [projectStats, setProjectStats] = useState<ProjectStats>({
    mdFileCount: 0,
    taskCount: 0,
    hasProjectMd: false,
    hasUserJourneyMd: false,
    hasInitialGoalMd: false,
    hasInitialUserJourneyMd: false,
  });
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState({ progressPercent: 0, tasksCompleted: 0, tasksTotal: 0, assignedTeams: 0 });

  useEffect(() => {
    loadProjectStats();
  }, [project.id]);

  const loadProjectStats = async () => {
    try {
      setLoading(true);

      // Spec file stats (which of the initial spec files exist)
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

  const linkClass = 'font-semibold text-primary-text hover:underline underline-offset-2';
  const tasksText = `${metrics.tasksCompleted} of ${metrics.tasksTotal} task${metrics.tasksTotal === 1 ? '' : 's'}`;
  const teamsText = `${metrics.assignedTeams} team${metrics.assignedTeams === 1 ? '' : 's'}`;
  const openChat = onOpenChat ?? (() => window.location.assign(ROUTES.chat));

  return (
    <div className="flex flex-col gap-8" data-testid="project-detail-view">
      {/* Progress — the three old metrics in one sentence */}
      <section aria-label="Project progress">
        {loading ? (
          <p className="text-[15px] text-text-2">Loading project metrics...</p>
        ) : (
          <p className="text-[15px] leading-[22px] text-text-2" data-testid="project-metrics">
            <span className="font-semibold text-text">{metrics.progressPercent}% done</span>
            <span className="text-text-3"> — </span>
            {onShowTab ? (
              <button type="button" className={linkClass} onClick={() => onShowTab('tasks')}>{tasksText}</button>
            ) : (
              <span>{tasksText}</span>
            )}
            <span className="text-text-3"> · </span>
            {onShowTab ? (
              <button type="button" className={linkClass} onClick={() => onShowTab('teams')}>{teamsText}</button>
            ) : (
              <span>{teamsText}</span>
            )}
          </p>
        )}
      </section>

      {/* Specification */}
      <section aria-labelledby="project-spec-h">
        <h4 id="project-spec-h" className="mb-1 text-[13px] font-semibold text-text-2">Specification</h4>
        <SpecRow
          icon={FileText}
          title="Project Goal"
          description="Define project objectives and success criteria"
          testId="spec-goal"
          action={
            projectStats.hasInitialGoalMd ? (
              <Button variant="secondary" size="sm" icon={FileText} onClick={onEditGoal}>Edit</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onAddGoal}>Add Goal</Button>
            )
          }
        />
        <SpecRow
          icon={MapIcon}
          title="User Journey"
          description="Map user interactions and experience flows"
          testId="spec-journey"
          action={
            projectStats.hasInitialUserJourneyMd ? (
              <Button variant="secondary" size="sm" icon={FileText} onClick={onEditUserJourney}>Edit</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={onAddUserJourney}>Add User Journey</Button>
            )
          }
        />
        <SpecRow
          icon={Sparkles}
          title="Generate Project Tasks"
          description="Talk it through with the orchestrator; the tasks land on this project's board"
          testId="spec-generate"
          action={
            <Button variant="secondary" size="sm" onClick={openChat}>
              Open Chat to Generate Tasks
            </Button>
          }
        />
      </section>
    </div>
  );
};

// Default and named exports for flexibility
export default DetailView;
export { DetailView };
