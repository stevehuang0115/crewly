/**
 * Projects (specs/2026-10-02-ui-redesign.md §Projects, simplify level).
 *
 * One job: which projects exist and how far along each is. Compact rows
 * (name, "75 of 78 tasks done · team · updated", status), one Filter button
 * (status) and a search box; completed projects sit in a collapsed section.
 * Pin / archive are in each row's "⋯"; the folder path is in the row tooltip
 * and on the project page.
 *
 * @module pages/Projects
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ProjectCreator } from '@/components/Modals/ProjectCreator';
import { Project, Team } from '@/types';
import { apiService } from '@/services/api.service';
import { Plus, Folder, Sparkles } from 'lucide-react';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Button, EmptyState, PageHeader, FilterButton, ShowAll, CollapsibleSection, type FilterValue } from '@crewly/ui';
import { usePinnedFavorites } from '@/hooks/usePinnedFavorites';
import { assignDefaultAvatars } from '@/utils/team.utils';
import { logSilentError } from '@/utils/error-handling';
import { ProjectRow, type ProjectProgress } from '@/components/Projects/ProjectRow';
import { ListSearch } from '@/components/common/ListSearch';
import { LINKS, ROUTES } from '@/constants/routes.constants';

/** Rows visible before "Show all" (simplify rule: about five per list). */
export const PROJECTS_VISIBLE = 6;

/**
 * Statuses each filter option matches. "Idle" covers both `paused` and
 * `stopped`, the two statuses the rows label Idle.
 */
export const STATUS_MATCHES: Record<string, readonly string[]> = {
  active: ['active'],
  paused: ['paused', 'stopped'],
  completed: ['completed'],
};

/** Status filter options (Completed lives in its own collapsed section). */
const STATUS_OPTIONS = [
  { value: 'active', label: 'Running' },
  { value: 'paused', label: 'Idle' },
  { value: 'completed', label: 'Completed' },
] as const;

export const Projects: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isPinned, togglePin } = usePinnedFavorites();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filters, setFilters] = useState<FilterValue>({ status: [] });
  const filterStatus = filters.status?.[0] ?? 'all';
  const [showCreator, setShowCreator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, ProjectProgress & { active: number }>>({});
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
      navigate(LINKS.project(newProject.id));
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
    navigate(LINKS.project(projectId));
  };

  // Filter projects based on search term and status
  const filteredProjects = useMemo(() => projects.filter(project => {
    const matchesSearch = project.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         project.path.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || (STATUS_MATCHES[filterStatus] ?? [filterStatus]).includes(project.status);

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
        <Button variant="primary" onClick={loadProjects}>
          Retry
        </Button>
      </div>
    );
  }

  const renderRow = (project: Project) => (
    <ProjectRow
      key={project.id}
      project={project}
      assignedTeams={teamsMap[project.id] || []}
      progress={progressMap[project.id]}
      onOpen={navigateToProject}
      onArchive={handleArchiveProject}
      isPinned={isPinned(project.id)}
      onTogglePin={() => togglePin({ id: project.id, name: project.name, type: 'project' })}
    />
  );

  const filtering = !!searchTerm || filterStatus !== 'all';
  const count = (option: string) => projects.filter((p) => (STATUS_MATCHES[option] ?? [option]).includes(p.status)).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Projects"
        subtitle="Code, docs and each project's board"
        actions={
          <>
            {projects.length > 0 && (
              <Button variant="secondary" icon={Sparkles} data-testid="generate-tasks-cta" onClick={() => navigate(ROUTES.chat)}>
                Generate Tasks
              </Button>
            )}
            <Button variant="primary" icon={Plus} onClick={() => setShowCreator(true)}>
              New Project
            </Button>
          </>
        }
      />

      {/* One Filter button + search */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="projects-toolbar">
        <FilterButton
          value={filters}
          onChange={setFilters}
          groups={[
            {
              id: 'status',
              label: 'Status',
              single: true,
              options: STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: count(o.value) })),
            },
          ]}
        />
        <ListSearch label="Search projects" value={searchTerm} onChange={setSearchTerm} />
      </div>

      {activeProjects.length > 0 ? (
        <div className="rounded-2xl border border-border-soft" data-testid="projects-list">
          <ShowAll limit={PROJECTS_VISIBLE} data-testid="projects-show-all">
            {activeProjects.map(renderRow)}
          </ShowAll>
        </div>
      ) : completedProjects.length === 0 ? (
        <EmptyState
          icon={Folder}
          title={filtering ? 'No projects found' : 'No projects yet'}
          description={filtering
            ? 'Try adjusting your search or filter criteria'
            : 'Create your first project to get started with Crewly'}
          action={!filtering ? (
            <Button variant="primary" icon={Plus} onClick={() => setShowCreator(true)}>
              Create Project
            </Button>
          ) : undefined}
          className="py-16"
        />
      ) : null}

      {/* Completed projects: collapsed (open when the filter asks for them) */}
      {completedProjects.length > 0 && (
        <CollapsibleSection
          key={filterStatus === 'completed' ? 'completed-open' : 'completed'}
          title={`Completed (${completedProjects.length})`}
          defaultOpen={filterStatus === 'completed'}
          className="mt-8"
          data-testid="archived-section"
        >
          <div className="rounded-2xl border border-border-soft" data-testid="archived-grid">
            {completedProjects.map(renderRow)}
          </div>
        </CollapsibleSection>
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
