import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ProjectCard } from '@/components/Cards/ProjectCard';
import { CreateCard } from '@/components/Cards/CreateCard';
import { ProjectCreator } from '@/components/Modals/ProjectCreator';
import { Project, Team } from '@/types';
import { apiService } from '@/services/api.service';
import { Plus, Search, Filter, Folder, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { LoadingSpinner } from '@/components/UI/LoadingSpinner';
import { usePinnedFavorites } from '@/hooks/usePinnedFavorites';
import { assignDefaultAvatars } from '@/utils/team.utils';
import { logSilentError } from '@/utils/error-handling';

export const Projects: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isPinned, togglePin } = usePinnedFavorites();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [showCreator, setShowCreator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [progressMap, setProgressMap] = useState<Record<string, {
    percent: number;
    active: number;
    total: number;
    open: number;
    inProgress: number;
    pending: number;
    done: number;
    blocked: number;
  }>>({});
  const [teamsMap, setTeamsMap] = useState<Record<string, Team[]>>({});

  useEffect(() => {
    loadProjects();

    // Check if we should show creator modal
    if (searchParams.get('create') === 'true') {
      setShowCreator(true);
      // Remove the create param from URL
      searchParams.delete('create');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await apiService.getProjects();
      setProjects(list);
      // Calculate progress and teams asynchronously
      calculateProgressForProjects(list).catch(err => logSilentError(err, { context: 'Progress calc failed' }));
      loadTeamsForProjects(list).catch(err => logSilentError(err, { context: 'Teams loading failed' }));
    } catch (err) {
      logSilentError(err, { context: 'Loading projects', level: 'error' });
      setError('Failed to load projects. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const calculateProgressForProjects = async (list: Project[]) => {
    const entries = await Promise.all(list.map(async (p) => {
      try {
        const tasks = await apiService.getAllTasks(p.id);
        const total = tasks.length;
        if (total === 0) return [p.id, { percent: 0, active: 0, total: 0, open: 0, inProgress: 0, pending: 0, done: 0, blocked: 0 }] as const;
        const open = tasks.filter((t: { status?: string }) => t.status === 'open').length;
        const inProgress = tasks.filter((t: { status?: string }) => t.status === 'in_progress').length;
        const pending = tasks.filter((t: { status?: string }) => t.status === 'pending').length;
        const done = tasks.filter((t: { status?: string }) => t.status === 'done' || t.status === 'completed').length;
        const blocked = tasks.filter((t: { status?: string }) => t.status === 'blocked').length;
        const active = open + inProgress + pending;
        const percent = Math.round((done / total) * 100);
        return [p.id, { percent, active, total, open, inProgress, pending, done, blocked }] as const;
      } catch (e) {
        logSilentError(e, { context: `Loading tasks for project ${p.id}`, level: 'warn' });
        return [p.id, { percent: 0, active: 0, total: 0, open: 0, inProgress: 0, pending: 0, done: 0, blocked: 0 }] as const;
      }
    }));
    setProgressMap(Object.fromEntries(entries));
  };

  const loadTeamsForProjects = async (list: Project[]) => {
    try {
      const allTeams = await apiService.getTeams();

      const migratedTeams = allTeams.map(team => ({
        ...team,
        members: assignDefaultAvatars(team.members),
      }));

      const entries = list.map(project => {
        const assignedTeams = migratedTeams.filter(team => {
          const matchesById = team.projectIds?.includes(project.id);
          const matchesByName = team.projectIds?.includes(project.name);
          return matchesById || matchesByName;
        });
        return [project.id, assignedTeams] as const;
      });

      setTeamsMap(Object.fromEntries(entries));
    } catch (err) {
      logSilentError(err, { context: 'Loading teams for projects' });
    }
  };

  const handleProjectCreate = async (path: string) => {
    try {
      const newProject = await apiService.createProject(path);
      setProjects(prev => [newProject, ...prev]);
      setShowCreator(false);
      navigate(`/projects/${newProject.id}`);
    } catch (err) {
      logSilentError(err, { context: 'Creating project', level: 'error' });
      throw err;
    }
  };

  /**
   * Archive a project by setting its status to 'completed'.
   *
   * @param projectId - The ID of the project to archive
   */
  const handleArchiveProject = async (projectId: string) => {
    try {
      const updated = await apiService.updateProject(projectId, { status: 'completed' });
      setProjects(prev =>
        prev.map(p => p.id === projectId ? updated : p)
      );
    } catch (err) {
      logSilentError(err, { context: 'Archiving project', level: 'error' });
    }
  };

  const navigateToProject = (projectId: string) => {
    navigate(`/projects/${projectId}`);
  };

  // Filter projects based on search term and status
  const filteredProjects = useMemo(() => projects.filter(project => {
    const matchesSearch = project.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         project.path.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || project.status === filterStatus;

    return matchesSearch && matchesStatus;
  }), [projects, searchTerm, filterStatus]);

  /** Active (non-completed) projects from the filtered list */
  const activeProjects = useMemo(
    () => filteredProjects.filter(p => p.status !== 'completed'),
    [filteredProjects],
  );

  /** Completed projects from the filtered list */
  const completedProjects = useMemo(
    () => filteredProjects.filter(p => p.status === 'completed'),
    [filteredProjects],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="xl" text="Loading projects..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-center">
        <p className="text-red-400 mb-4">{error}</p>
        <button
          onClick={loadProjects}
          className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const renderProjectCard = (project: Project, withArchive = false) => (
    <ProjectCard
      key={project.id}
      project={project}
      showStatus
      showTeams
      assignedTeams={teamsMap[project.id] || []}
      onClick={() => navigateToProject(project.id)}
      onArchive={withArchive ? () => handleArchiveProject(project.id) : undefined}
      isPinned={isPinned(project.id)}
      onTogglePin={() => togglePin({ id: project.id, name: project.name, type: 'project' })}
      progressPercent={progressMap[project.id]?.percent}
      progressLabel={typeof progressMap[project.id]?.total === 'number' ? `${progressMap[project.id]?.done || 0} of ${progressMap[project.id]?.total || 0} completed` : undefined}
      progressBreakdown={progressMap[project.id] ? {
        open: progressMap[project.id].open,
        inProgress: progressMap[project.id].inProgress,
        pending: progressMap[project.id].pending,
        done: progressMap[project.id].done,
        blocked: progressMap[project.id].blocked,
        total: progressMap[project.id].total,
      } : undefined}
    />
  );

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="page-title text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-text-secondary-dark mt-1">Manage and monitor your Crewly projects</p>
        </div>

        <div className="flex items-center gap-3">
          {projects.length > 0 && (
            <button
              className="bg-gradient-to-r from-primary to-primary/80 text-white px-4 py-2 rounded-lg hover:from-primary/90 hover:to-primary/70 transition-colors flex items-center gap-2"
              data-testid="generate-tasks-cta"
              onClick={() => navigate('/chat')}
            >
              <Sparkles className="w-5 h-5" />
              Generate Tasks
            </button>
          )}
          <button
            className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
            onClick={() => setShowCreator(true)}
          >
            <Plus className="w-5 h-5" />
            New Project
          </button>
        </div>
      </div>

      {/* Search and Filter Controls */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
        <div className="relative w-full md:w-auto md:flex-grow max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary-dark w-5 h-5" />
          <input
            type="text"
            placeholder="Search projects..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-surface-dark border border-border-dark rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          />
        </div>

        <div className="flex items-center gap-4">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bg-surface-dark border border-border-dark rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>

      {/* Active Projects Grid */}
      <div>
        {activeProjects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {activeProjects.map((project) => renderProjectCard(project, true))}
            <CreateCard
              title="Add Project"
              onClick={() => setShowCreator(true)}
            />
          </div>
        ) : completedProjects.length === 0 ? (
          <div className="text-center py-16">
            <div className="flex justify-center mb-4">
              <Folder className="w-12 h-12 text-text-secondary-dark/50" strokeWidth={1.5} />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              {searchTerm || filterStatus !== 'all' ? 'No projects found' : 'No projects yet'}
            </h3>
            <p className="text-sm text-text-secondary-dark mb-6">
              {searchTerm || filterStatus !== 'all'
                ? 'Try adjusting your search or filter criteria'
                : 'Create your first project to get started with Crewly'
              }
            </p>
            {!searchTerm && filterStatus === 'all' && (
              <button
                className="bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90 transition-colors inline-flex items-center gap-2"
                onClick={() => setShowCreator(true)}
              >
                <Plus className="w-5 h-5" />
                Create Project
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* Completed Projects Section */}
      {completedProjects.length > 0 && (
        <div className="mt-8" data-testid="archived-section">
          <button
            className="flex items-center gap-2 text-text-secondary-dark hover:text-text-primary-dark transition-colors mb-4"
            onClick={() => setArchivedExpanded(!archivedExpanded)}
            data-testid="archived-toggle"
          >
            {archivedExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className="text-sm font-semibold">Completed Projects ({completedProjects.length})</span>
          </button>
          <div
            className={archivedExpanded ? '' : 'sr-only'}
            data-testid="archived-grid"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {completedProjects.map((project) => renderProjectCard(project))}
            </div>
          </div>
        </div>
      )}

      {/* Project Creator Modal */}
      {showCreator && (
        <ProjectCreator
          onSave={handleProjectCreate}
          onClose={() => setShowCreator(false)}
        />
      )}
    </div>
  );
};
