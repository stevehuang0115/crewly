import * as fs from 'fs/promises';
import * as path from 'path';
import type { StorageService } from '../core/storage.service.js';

/**
 * Represents a single search result from a project search query
 */
export interface ProjectSearchResult {
  /** Project ID */
  id: string;
  /** Project name */
  name: string;
  /** Whether the match was on the project name or a task filename */
  matchType: 'project_name' | 'task_name';
  /** The human-readable task name (only for task_name matches) */
  taskName?: string;
  /** Relative path to the task file within .crewly/tasks/ (only for task_name matches) */
  taskPath?: string;
  /** Parent milestone folder name (only for task_name matches) */
  milestone?: string;
}

/**
 * Service for searching across project names and task filenames.
 *
 * Scans the storage-backed project list and each project's `.crewly/tasks/`
 * directory to find matches against a user-supplied query string.
 */
export class ProjectSearchService {
  private storageService: StorageService;

  /**
   * Creates a new ProjectSearchService instance
   *
   * @param storageService - The storage service used to retrieve project metadata
   */
  constructor(storageService: StorageService) {
    this.storageService = storageService;
  }

  /**
   * Searches project names and task filenames for the given query.
   *
   * The search is case-insensitive. Results are sorted so that project_name
   * matches appear before task_name matches.
   *
   * @param query - The search term to match against project names and task filenames
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
      // Check project name
      if (project.name.toLowerCase().includes(lowerQuery)) {
        results.push({
          id: project.id,
          name: project.name,
          matchType: 'project_name',
        });
      }

      // Scan task files
      const taskResults = await this.searchTaskFiles(project.id, project.name, project.path, lowerQuery);
      results.push(...taskResults);
    }

    // Sort: project_name matches first, then task_name matches
    results.sort((a, b) => {
      if (a.matchType === b.matchType) return 0;
      return a.matchType === 'project_name' ? -1 : 1;
    });

    return results;
  }

  /**
   * Scans a project's .crewly/tasks/ directory recursively for .md files
   * whose filenames match the query.
   *
   * @param projectId - The project ID to associate with results
   * @param projectName - The project name to associate with results
   * @param projectPath - Absolute filesystem path to the project root
   * @param lowerQuery - The lowercased search query
   * @returns Array of task_name search results
   */
  private async searchTaskFiles(
    projectId: string,
    projectName: string,
    projectPath: string,
    lowerQuery: string,
  ): Promise<ProjectSearchResult[]> {
    const tasksDir = path.join(projectPath, '.crewly', 'tasks');
    const results: ProjectSearchResult[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir, { recursive: true }) as unknown as string[];
    } catch {
      // Directory may not exist — gracefully return empty
      return results;
    }

    for (const entry of entries) {
      // Only consider .md files
      if (!entry.endsWith('.md')) continue;

      const fileName = path.basename(entry, '.md');
      // Derive human-readable task name: strip trailing timestamp pattern (_YYYYMMDD_HHmmss or similar)
      const taskName = fileName.replace(/_\d{8,}.*$/, '').replace(/_/g, ' ');

      if (fileName.toLowerCase().includes(lowerQuery) || taskName.toLowerCase().includes(lowerQuery)) {
        // Derive milestone from parent folder path
        const parentDir = path.dirname(entry);
        const parts = parentDir.split(path.sep);
        // The milestone is the first directory component (e.g., m0_defining_project)
        const milestone = parts[0] && parts[0] !== '.' ? parts[0] : undefined;

        results.push({
          id: projectId,
          name: projectName,
          matchType: 'task_name',
          taskName,
          taskPath: entry,
          milestone,
        });
      }
    }

    return results;
  }
}
