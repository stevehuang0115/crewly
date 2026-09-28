import type { StorageService } from '../core/storage.service.js';
import { ProjectTicketService } from '../project-tickets/project-ticket.service.js';

/**
 * Represents a single search result from a project search query
 */
export interface ProjectSearchResult {
  /** Project ID */
  id: string;
  /** Project name */
  name: string;
  /** Whether the match was on the project name or one of its tickets */
  matchType: 'project_name' | 'task_name';
  /** The ticket title (only for task_name matches) */
  taskName?: string;
  /** Ticket file name inside `.crewly/tickets/` (only for task_name matches) */
  taskPath?: string;
  /** Ticket id, e.g. `APP-12` (only for task_name matches) */
  ticketId?: string;
  /** Ticket status (only for task_name matches) */
  status?: string;
}

/** The part of the ticket store the search needs (injectable for tests). */
export type ProjectTicketLister = Pick<ProjectTicketService, 'list'>;

/**
 * Service for searching across project names and project tickets
 * (`<project>/.crewly/tickets/`, specs/2026-09-28-project-tickets.md).
 *
 * The retired `.crewly/tasks/` md files are no longer searched.
 */
export class ProjectSearchService {
  private storageService: StorageService;
  private tickets: ProjectTicketLister;

  /**
   * Creates a new ProjectSearchService instance
   *
   * @param storageService - The storage service used to retrieve project metadata
   * @param tickets - Project ticket store (defaults to the process singleton)
   */
  constructor(storageService: StorageService, tickets: ProjectTicketLister = ProjectTicketService.getInstance()) {
    this.storageService = storageService;
    this.tickets = tickets;
  }

  /**
   * Searches project names and ticket ids / titles for the given query.
   *
   * The search is case-insensitive. Results are sorted so that project_name
   * matches appear before ticket matches.
   *
   * @param query - The search term
   * @returns Array of search results sorted with project_name matches first
   *
   * @example
   * ```typescript
   * const service = new ProjectSearchService(storageService);
   * const results = await service.search('auth');
   * // [{ id: '1', name: 'Auth Service', matchType: 'project_name' }, ...]
   * ```
   */
  async search(query: string): Promise<ProjectSearchResult[]> {
    const projects = await this.storageService.getProjects();
    const lowerQuery = query.toLowerCase();
    const results: ProjectSearchResult[] = [];

    for (const project of projects) {
      if (project.name.toLowerCase().includes(lowerQuery)) {
        results.push({ id: project.id, name: project.name, matchType: 'project_name' });
      }
      results.push(...(await this.searchTickets(project.id, project.name, project.path, lowerQuery)));
    }

    results.sort((a, b) => {
      if (a.matchType === b.matchType) return 0;
      return a.matchType === 'project_name' ? -1 : 1;
    });
    return results;
  }

  /**
   * Match a project's tickets by id or title.
   *
   * @param projectId - The project ID to associate with results
   * @param projectName - The project name to associate with results
   * @param projectPath - Absolute filesystem path to the project root
   * @param lowerQuery - The lowercased search query
   * @returns Ticket matches (an unreadable folder yields none)
   */
  private async searchTickets(
    projectId: string,
    projectName: string,
    projectPath: string,
    lowerQuery: string,
  ): Promise<ProjectSearchResult[]> {
    let list;
    try {
      list = await this.tickets.list(projectPath);
    } catch {
      return [];
    }
    return list.tickets
      .filter((t) => t.id.toLowerCase().includes(lowerQuery) || t.title.toLowerCase().includes(lowerQuery))
      .map((t) => ({
        id: projectId,
        name: projectName,
        matchType: 'task_name' as const,
        taskName: t.title,
        taskPath: t.fileName,
        ticketId: t.id,
        status: t.status,
      }));
  }
}
