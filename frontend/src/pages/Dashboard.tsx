/**
 * Dashboard Page
 *
 * Main landing page with stat cards, projects overview, and teams grid.
 * Features a rich layout with progress tracking and 3D Factory access.
 *
 * @module pages/Dashboard
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ProjectCard } from '@/components/Cards/ProjectCard';
import TeamsGridCard from '@/components/Teams/TeamsGridCard';
import { CreateCard } from '@/components/Cards/CreateCard';
import { Team, Project } from '@/types';
import { apiService } from '@/services/api.service';
import { HealthBar } from '@/components/Dashboard/HealthBar';
import { assignDefaultAvatars } from '@/utils/team.utils';
import { logSilentError } from '@/utils/error-handling';
import { ScoreCard, ScoreCardGrid } from '@/components/UI/ScoreCard';
import { Alert } from '@/components/UI/Alert';
import { Button } from '@/components/UI/Button';


/**
 * Hard upper bound on initial-load latency. If `loadData` hasn't settled
 * by this deadline, we drop the skeleton and show an error so the user
 * isn't staring at a frozen loader. Tuned to cover reasonably slow
 * networks while still surfacing genuinely stuck requests.
 *
 * Exported for tests that want to pin the contract without hardcoding
 * the value.
 */
export const SAFETY_TIMEOUT_MS = 15_000;

interface ProjectProgress {
  projectId: string;
  progressPercent: number;
  progressLabel: string;
  progressBreakdown: {
    open: number;
    inProgress: number;
    pending: number;
    done: number;
    blocked: number;
    total: number;
  };
}

/**
 * Dashboard component - main application landing page
 *
 * Features:
 * - Stat cards showing counts and quick access to 3D Factory
 * - Projects section with progress tracking
 * - Teams grid with member avatars
 *
 * @returns Dashboard component
 */
export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsMap, setTeamsMap] = useState<Record<string, Team[]>>({});
  const [projectProgress, setProjectProgress] = useState<Record<string, ProjectProgress>>({});
  const [intentTaskStats, setIntentTaskStats] = useState<{ inProgress: number; completed: number }>({ inProgress: 0, completed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Count projects that have at least one running agent in their assigned teams.
   * A project is "active" when any team member assigned to it has agentStatus === 'active',
   * rather than relying on the project.status field which requires explicit startProject calls.
   */
  const activeProjectCount = useMemo(() => {
    return projects.filter(project => {
      const assignedTeams = teamsMap[project.id] || [];
      return assignedTeams.some(team =>
        team.members.some(member => member.agentStatus === 'active')
      );
    }).length;
  }, [projects, teamsMap]);

  useEffect(() => {
    loadData();
  }, []);

  /**
   * Safety timeout: if loading exceeds SAFETY_TIMEOUT_MS, bail out of the
   * skeleton and surface an error. Cleanup cancels the timer the moment
   * loading flips false, so the happy path pays nothing.
   */
  useEffect(() => {
    if (!loading) return;

    const timer = setTimeout(() => {
      setLoading(false);
      setError('Dashboard took too long to load. Please try again.');
    }, SAFETY_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [loading]);

  const calculateProjectProgress = async (projectId: string): Promise<ProjectProgress> => {
    try {
      const tasks = await apiService.getAllTasks(projectId);

      // Count tasks by status
      const breakdown = {
        open: 0,
        inProgress: 0,
        pending: 0,
        done: 0,
        blocked: 0,
        total: tasks.length
      };

      tasks.forEach(task => {
        const status = task.status?.toLowerCase() || 'pending';
        if (status === 'open') breakdown.open++;
        else if (status === 'in_progress' || status === 'in-progress') breakdown.inProgress++;
        else if (status === 'done' || status === 'completed') breakdown.done++;
        else if (status === 'blocked') breakdown.blocked++;
        else breakdown.pending++;
      });

      // Calculate progress percentage (done tasks / total tasks)
      const progressPercent = breakdown.total > 0
        ? Math.round((breakdown.done / breakdown.total) * 100)
        : 0;

      const progressLabel = `${breakdown.done} of ${breakdown.total} completed`;

      return {
        projectId,
        progressPercent,
        progressLabel,
        progressBreakdown: breakdown
      };
    } catch (err) {
      logSilentError(err, { context: `Calculating progress for project ${projectId}` });
      return {
        projectId,
        progressPercent: 0,
        progressLabel: 'No tasks',
        progressBreakdown: { open: 0, inProgress: 0, pending: 0, done: 0, blocked: 0, total: 0 }
      };
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [projectList, teamList] = await Promise.all([
        apiService.getProjects(),
        apiService.getTeams()
      ]);

      setProjects(projectList);

      // Calculate progress for each project
      const progressPromises = projectList.map(project => calculateProjectProgress(project.id));
      const progressResults = await Promise.all(progressPromises);

      const progressMap = progressResults.reduce((acc, progress) => {
        acc[progress.projectId] = progress;
        return acc;
      }, {} as Record<string, ProjectProgress>);

      setProjectProgress(progressMap);

      // Migrate teams without avatars using shared utility
      const migratedTeams = teamList.map(team => ({
        ...team,
        members: assignDefaultAvatars(team.members),
      }));

      setTeams(migratedTeams);

      // Fetch intent task statistics for the HealthBar
      try {
        const intentStats = await apiService.getIntentTaskStatistics();
        if (intentStats.byStatus) {
          setIntentTaskStats({
            inProgress: intentStats.byStatus['in_progress'] || 0,
            completed: intentStats.byStatus['completed'] || 0,
          });
        }
      } catch {
        // Intent task stats are non-critical
      }

      // Create teams map for projects (reuse migratedTeams)
      const teamsMapping = projectList.reduce((acc, project) => {
        const assignedTeams = migratedTeams.filter(team => {
          const matchesById = team.projectIds?.includes(project.id);
          const matchesByName = team.projectIds?.includes(project.name);
          return matchesById || matchesByName;
        });
        acc[project.id] = assignedTeams;
        return acc;
      }, {} as Record<string, Team[]>);
      setTeamsMap(teamsMapping);
      // Clear any error that was set by the safety timeout before this
      // (slow) request eventually succeeded — otherwise the user would
      // see fresh data sitting under a stale "took too long" banner.
      setError(null);
    } catch (err) {
      logSilentError(err, { context: 'Loading dashboard data', level: 'error' });
      setError('Failed to load dashboard data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const navigateToProject = (projectId: string) => navigate(`/projects/${projectId}`);
  const navigateToTeam = (teamId: string) => navigate(`/teams/${teamId}`);

  const openProjectCreator = () => {
    navigate('/projects?create=true');
  };

  const openTeamCreator = () => {
    navigate('/teams?create=true');
  };

  const navigateToFactory = () => navigate('/factory');

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent"></div>
        <p className="ml-3 text-text-secondary-dark">Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <Alert variant="error" title="Dashboard failed to load" onClose={() => setError(null)}>
          {error}
          <Button variant="ghost" size="sm" onClick={loadData} className="mt-2">Retry</Button>
        </Alert>
      </div>
    );
  }

  // Show top 2 projects and more teams on dashboard
  const topProjects = projects.slice(0, 2);
  const topTeams = teams.slice(0, 6);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary-dark">Dashboard</h1>
          <p className="text-sm text-text-secondary-dark">Welcome back. Here's a summary of your teams and projects.</p>
        </div>
      </div>

      {/* Health Bar — compact system overview */}
      <div className="mb-6">
        <HealthBar
          runningAgents={teams.flatMap(t => t.members).filter(m => m.agentStatus === 'active').length}
          projectCount={projects.length}
          teamCount={teams.length}
          tasksInProgress={Object.values(projectProgress).reduce((sum, p) => sum + p.progressBreakdown.inProgress, 0) + intentTaskStats.inProgress}
          tasksCompleted={Object.values(projectProgress).reduce((sum, p) => sum + p.progressBreakdown.done, 0) + intentTaskStats.completed}
          onFactoryClick={navigateToFactory}
        />
      </div>

      <ScoreCardGrid variant="horizontal" className="grid-cols-2 lg:grid-cols-4 mb-6">
        <ScoreCard label="Projects" value={projects.length} />
        <ScoreCard label="Teams" value={teams.length} />
        <ScoreCard label="Active Projects" value={activeProjectCount} />
        <ScoreCard label="Running Agents">
          <span className="text-emerald-400">{teams.flatMap(t => t.members).filter(m => m.agentStatus === 'active').length}</span>
        </ScoreCard>
      </ScoreCardGrid>


      <div className="space-y-10">
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold">Projects</h3>
            <Link to="/projects" className="text-sm font-semibold text-primary hover:underline">View All</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {topProjects.map(project => {
              const progress = projectProgress[project.id];
              return (
                <ProjectCard
                  key={project.id}
                  project={project}
                  showStatus
                  showTeams
                  assignedTeams={teamsMap[project.id] || []}
                  onClick={() => navigateToProject(project.id)}
                  progressPercent={progress?.progressPercent}
                  progressLabel={progress?.progressLabel}
                  progressBreakdown={progress?.progressBreakdown}
                />
              );
            })}
            <CreateCard
              title="Create New Project"
              onClick={openProjectCreator}
            />
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold">Teams</h3>
            <Link to="/teams" className="text-sm font-semibold text-primary hover:underline">View All</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {topTeams.map(team => (
              <TeamsGridCard
                key={team.id}
                team={team}
                onClick={() => navigateToTeam(team.id)}
              />
            ))}
            <CreateCard
              title="Create New Team"
              onClick={openTeamCreator}
            />
          </div>
        </section>
      </div>
    </div>
  );
};

export default Dashboard;
