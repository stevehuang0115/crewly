import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

export const TASK_STATUSES = ['open', 'in_progress', 'review', 'done', 'blocked'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

/** Folder names that indicate a status-partitioned milestone directory. */
const STATUS_FOLDERS: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'blocked'];

export function isValidTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isValidTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  milestone: string;
  milestoneId: string;
  tasks: string[];
  acceptanceCriteria: string[];
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  name: string;
  title: string;
  tasks: Task[];
}

export class TaskService {
  private tasksDir: string;

  constructor(projectPath?: string) {
    this.tasksDir = projectPath
      ? path.join(path.resolve(projectPath), '.crewly', 'tasks')
      : path.join(process.cwd(), '.crewly', 'tasks');
  }

  private parseMarkdownContent(content: string): {
    title: string;
    status: string;
    priority: string;
    assignee?: string;
    milestone: string;
    description: string;
    tasks: string[];
    acceptanceCriteria: string[];
  } {
    const lines = content.split('\n');
    let title = '';
    // Use empty string as the "unset" sentinel — readTaskFile narrows this
    // through `isValidTaskStatus`/`isValidTaskPriority` and applies the real
    // defaults. A non-empty sentinel like 'pending' here would be misleading
    // because 'pending' is not a valid TaskStatus.
    let status = '';
    let priority = '';
    let assignee = '';
    let milestone = '';
    let description = '';
    let tasks: string[] = [];
    let acceptanceCriteria: string[] = [];

    let currentSection = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Extract title from first h1
      if (trimmedLine.startsWith('# ') && !title) {
        title = trimmedLine.substring(2).trim();
        continue;
      }

      // Extract metadata
      if (trimmedLine.startsWith('**Status:**')) {
        status = trimmedLine.replace('**Status:**', '').trim();
        continue;
      }
      if (trimmedLine.startsWith('**Priority:**')) {
        priority = trimmedLine.replace('**Priority:**', '').trim();
        continue;
      }
      if (trimmedLine.startsWith('**Assignee:**')) {
        assignee = trimmedLine.replace('**Assignee:**', '').trim();
        continue;
      }
      if (trimmedLine.startsWith('**Milestone:**')) {
        milestone = trimmedLine.replace('**Milestone:**', '').trim();
        continue;
      }

      // Track sections
      if (trimmedLine.startsWith('## Description')) {
        currentSection = 'description';
        continue;
      }
      if (trimmedLine.startsWith('## Tasks')) {
        currentSection = 'tasks';
        continue;
      }
      if (trimmedLine.startsWith('## Acceptance Criteria')) {
        currentSection = 'acceptanceCriteria';
        continue;
      }
      if (trimmedLine.startsWith('## ')) {
        currentSection = '';
        continue;
      }

      // Extract content based on current section
      if (currentSection === 'description' && trimmedLine && !trimmedLine.startsWith('#')) {
        description += (description ? '\n' : '') + trimmedLine;
      }
      if (currentSection === 'tasks' && trimmedLine.startsWith('- ')) {
        tasks.push(trimmedLine.substring(2).trim());
      }
      if (currentSection === 'acceptanceCriteria' && trimmedLine.startsWith('- ')) {
        acceptanceCriteria.push(trimmedLine.substring(2).trim());
      }
    }

    return {
      title,
      status: status.toLowerCase(),
      priority: priority.toLowerCase(),
      assignee: assignee || undefined,
      milestone,
      description,
      tasks,
      acceptanceCriteria
    };
  }

  /**
   * Read one task markdown file and build a {@link Task}. Returns `null`
   * when the file can't be read (corrupt, permission denied, missing).
   *
   * Status resolution falls back to `statusOverride` when the file's own
   * `status:` front-matter is missing or invalid — this lets callers
   * encode status in the folder layout (`milestone/open/foo.md`) without
   * losing the type narrowing.
   */
  private async readTaskFile(
    filePath: string,
    milestoneId: string,
    statusOverride?: TaskStatus,
  ): Promise<Task | null> {
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      // Defensive: bail on anything that isn't a regular file (symlinks
      // to directories, FIFOs, etc.). Reader loops upstream assume `.md`
      // names map to files — this guard keeps that assumption honest.
      if (!stats.isFile()) return null;
      const parsed = this.parseMarkdownContent(content);
      const fileBase = path.basename(filePath, '.md');

      const resolvedStatus: TaskStatus = statusOverride
        ?? (isValidTaskStatus(parsed.status) ? parsed.status : 'open');
      const resolvedPriority: TaskPriority = isValidTaskPriority(parsed.priority)
        ? parsed.priority
        : 'medium';

      // Real filesystem timestamps so consumers that sort/cache by
      // createdAt/updatedAt get stable values across reads. birthtimeMs
      // falls back to mtime on filesystems that don't track creation time.
      const createdAt = new Date(stats.birthtimeMs || stats.mtimeMs).toISOString();
      const updatedAt = new Date(stats.mtimeMs).toISOString();

      return {
        id: fileBase,
        title: parsed.title || fileBase.replace(/_/g, ' '),
        description: parsed.description,
        status: resolvedStatus,
        priority: resolvedPriority,
        assignee: parsed.assignee,
        milestone: parsed.milestone || milestoneId,
        milestoneId,
        tasks: parsed.tasks,
        acceptanceCriteria: parsed.acceptanceCriteria,
        filePath,
        createdAt,
        updatedAt,
      };
    } catch {
      return null;
    }
  }

  async getAllTasks(): Promise<Task[]> {
    if (!existsSync(this.tasksDir)) {
      return [];
    }

    const tasks: Task[] = [];
    let milestones: string[];
    try {
      milestones = await fs.readdir(this.tasksDir);
    } catch {
      return [];
    }

    for (const milestone of milestones) {
      const milestonePath = path.join(this.tasksDir, milestone);
      try {
        const stat = await fs.stat(milestonePath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Check if this is a status-based structure (has status folders) or direct markdown files
      let items: string[];
      try {
        items = await fs.readdir(milestonePath);
      } catch {
        continue;
      }
      const hasStatusFolders = items.some(item => (STATUS_FOLDERS as readonly string[]).includes(item));

      if (hasStatusFolders) {
        // Status-based structure: milestone/status/task.md
        for (const statusFolder of STATUS_FOLDERS) {
          const statusPath = path.join(milestonePath, statusFolder);
          if (!existsSync(statusPath)) continue;
          try {
            const statusStat = await fs.stat(statusPath);
            if (!statusStat.isDirectory()) continue;
          } catch {
            continue;
          }

          let statusFiles: string[];
          try {
            statusFiles = await fs.readdir(statusPath);
          } catch {
            continue;
          }
          const markdownFiles = statusFiles.filter(file => file.endsWith('.md'));

          for (const file of markdownFiles) {
            const task = await this.readTaskFile(path.join(statusPath, file), milestone, statusFolder);
            if (task) tasks.push(task);
          }
        }
      } else {
        // Direct structure: milestone/task.md
        const markdownFiles = items.filter(file => file.endsWith('.md'));

        for (const file of markdownFiles) {
          const task = await this.readTaskFile(path.join(milestonePath, file), milestone);
          if (task) tasks.push(task);
        }
      }
    }

    return tasks.sort((a, b) => {
      // Sort by milestone first, then by task ID
      if (a.milestoneId !== b.milestoneId) {
        return a.milestoneId.localeCompare(b.milestoneId);
      }
      return a.id.localeCompare(b.id);
    });
  }

  async getMilestones(): Promise<Milestone[]> {
    const tasks = await this.getAllTasks();
    const milestoneMap = new Map<string, Milestone>();

    for (const task of tasks) {
      if (!milestoneMap.has(task.milestoneId)) {
        milestoneMap.set(task.milestoneId, {
          id: task.milestoneId,
          name: task.milestoneId,
          title: task.milestoneId.replace(/_/g, ' ').replace(/^m\d+\s+/, '').replace(/^\w/, c => c.toUpperCase()),
          tasks: []
        });
      }
      milestoneMap.get(task.milestoneId)!.tasks.push(task);
    }

    return Array.from(milestoneMap.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async getTasksByStatus(status: string): Promise<Task[]> {
    const tasks = await this.getAllTasks();
    return tasks.filter(task => task.status === status);
  }

  async getTasksByMilestone(milestoneId: string): Promise<Task[]> {
    const tasks = await this.getAllTasks();
    return tasks.filter(task => task.milestoneId === milestoneId);
  }
}