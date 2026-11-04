import { spawn, exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService } from '../core/logger.service.js';
import { ConfigService } from '../core/config.service.js';
import { StorageService } from '../core/storage.service.js';
import { isValidGitRefName } from '../../utils/git-ref.utils.js';

const execAsync = promisify(exec);
/** Runs git with an argv array and no shell, for every value that comes from a caller (CREW-967). */
const execFileAsync = promisify(execFile);

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  hasChanges: boolean;
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: Date;
  };
}

export interface GitCommitOptions {
  message?: string;
  autoGenerate?: boolean;
  author?: string;
  co_authors?: string[];
  includeUntracked?: boolean;
  dryRun?: boolean;
}

export interface ScheduledCommitConfig {
  enabled: boolean;
  intervalMinutes: number;
  autoMessage: boolean;
  branchStrategy: 'main' | 'feature' | 'task';
}

export class GitIntegrationService {
  private logger: LoggerService;
  private config: ConfigService;
  private storage: StorageService;
  private projectPath: string;
  private commitTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastCommitTimes: Map<string, Date> = new Map();
  private defaultCommitConfig: ScheduledCommitConfig = {
    enabled: true,
    intervalMinutes: 30,
    autoMessage: true,
    branchStrategy: 'feature'
  };

  constructor(projectPath?: string) {
    this.logger = LoggerService.getInstance();
    this.config = ConfigService.getInstance();
    this.storage = StorageService.getInstance();
    this.projectPath = projectPath ? path.resolve(projectPath) : process.cwd();

    // Cleanup on process exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  /**
   * Get git status for a project
   */
  async getGitStatus(projectPath?: string): Promise<GitStatus> {
    const targetPath = projectPath || this.projectPath;
    try {
      const status: GitStatus = {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        hasChanges: false
      };

      // Check if it's a git repository
      try {
        await execAsync('git rev-parse --git-dir', { cwd: targetPath });
      } catch (error) {
        throw new Error('Not a git repository');
      }

      // Get current branch
      try {
        const branchResult = await execAsync('git branch --show-current', { cwd: targetPath });
        status.branch = branchResult.stdout.trim() || 'main';
      } catch (error) {
        this.logger.warn('Could not determine git branch', { targetPath: targetPath });
      }

      // Get file status counts
      try {
        const statusResult = await execAsync('git status --porcelain', { cwd: targetPath });
        const lines = statusResult.stdout.trim().split('\n').filter(line => line.length > 0);
        
        for (const line of lines) {
          const statusCode = line.substring(0, 2);
          if (statusCode[0] !== ' ' && statusCode[0] !== '?') status.staged++;
          if (statusCode[1] !== ' ') status.unstaged++;
          if (statusCode[0] === '?' && statusCode[1] === '?') status.untracked++;
        }

        status.hasChanges = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;
      } catch (error) {
        this.logger.warn('Could not get git file status', { targetPath: targetPath });
      }

      // Get last commit info
      try {
        const logResult = await execAsync('git log -1 --format="%H|%s|%an|%ai"', { cwd: targetPath });
        const [hash, message, author, date] = logResult.stdout.trim().split('|');
        status.lastCommit = {
          hash,
          message,
          author,
          date: new Date(date)
        };
      } catch (error) {
        // No commits yet - this is fine
      }

      return status;
    } catch (error) {
      this.logger.error(`Failed to get git status for ${targetPath}:`, { error: error instanceof Error ? error.message : String(error), targetPath });
      throw error;
    }
  }

  /**
   * Commit changes with auto-generated or custom message
   */
  async commitChanges(projectPath: string, options: GitCommitOptions = {}): Promise<string> {
    try {
      const status = await this.getGitStatus(projectPath);
      
      if (!status.hasChanges) {
        this.logger.info('No changes to commit', { projectPath: projectPath });
        return 'no-changes';
      }

      // Stage all changes if not already staged
      if (status.unstaged > 0 || status.untracked > 0) {
        await execAsync('git add -A', { cwd: projectPath });
        this.logger.debug('Staged all changes', { projectPath: projectPath });
      }

      // Generate commit message
      const commitMessage = await this.generateCommitMessage(projectPath, options);
      
      // Create commit
      const result = await execFileAsync('git', this.buildCommitArgs(commitMessage, options), { cwd: projectPath });
      
      // Update last commit time
      this.lastCommitTimes.set(projectPath, new Date());
      
      this.logger.info('Successfully created commit', {
        projectPath: projectPath,
        message: commitMessage
      });

      return result.stdout.trim();
    } catch (error) {
      this.logger.error(`Failed to commit changes for ${projectPath}:`, { error: error instanceof Error ? error.message : String(error), projectPath });
      throw error;
    }
  }

  /**
   * Generate intelligent commit message based on changes
   */
  private async generateCommitMessage(projectPath: string, options: GitCommitOptions): Promise<string> {
    if (options.message) {
      return options.message;
    }

    if (!options.autoGenerate) {
      return `Progress: ${new Date().toISOString()}`;
    }

    try {
      // Simple commit message generation
      return `Auto-commit: ${new Date().toISOString()}`;
    } catch (error) {
      this.logger.warn('Failed to generate commit message, using default', { projectPath: projectPath });
      return `Progress: ${new Date().toISOString()}`;
    }
  }

  /**
   * Build the argv for `git commit`. The message and author travel as argv
   * entries and never through a shell, so `$(...)`, backticks and quotes in
   * them stay literal text (CREW-967).
   *
   * @param message - Commit message
   * @param options - Commit options; `author` becomes `--author=<value>`
   * @returns Arguments to pass to `git`
   */
  private buildCommitArgs(message: string, options: GitCommitOptions): string[] {
    const args = ['commit', '-m', message];
    if (options.author) {
      args.push(`--author=${options.author}`);
    }
    return args;
  }

  /**
   * Start scheduled commits for a project
   */
  async startScheduledCommits(projectPath: string, config: Partial<ScheduledCommitConfig> = {}): Promise<void> {
    const commitConfig = { ...this.defaultCommitConfig, ...config };
    
    if (!commitConfig.enabled) {
      this.logger.info('Scheduled commits disabled for project', { projectPath: projectPath });
      return;
    }

    // Stop existing timer if any
    this.stopScheduledCommits(projectPath);

    const intervalMs = commitConfig.intervalMinutes * 60 * 1000;
    const timer = setInterval(async () => {
      try {
        await this.performScheduledCommit(projectPath, commitConfig);
      } catch (error) {
        this.logger.error('Scheduled commit failed:', { error: error instanceof Error ? error.message : String(error) } as Record<string, any>);
      }
    }, intervalMs);

    this.commitTimers.set(projectPath, timer);
    
    this.logger.info('Started scheduled commits', {
      projectPath: projectPath,
      intervalMinutes: commitConfig.intervalMinutes
    } as Record<string, any>);
  }

  /**
   * Stop scheduled commits for a project
   */
  stopScheduledCommits(projectPath: string): void {
    const timer = this.commitTimers.get(projectPath);
    if (timer) {
      clearInterval(timer);
      this.commitTimers.delete(projectPath);
      this.logger.info('Stopped scheduled commits', { projectPath: projectPath });
    }
  }

  /**
   * Perform a scheduled commit
   */
  private async performScheduledCommit(projectPath: string, config: ScheduledCommitConfig): Promise<void> {
    try {
      const status = await this.getGitStatus(projectPath);
      
      if (!status.hasChanges) {
        this.logger.debug('No changes for scheduled commit', { projectPath: projectPath });
        return;
      }

      // Perform the commit
      await this.commitChanges(projectPath, {
        autoGenerate: config.autoMessage,
        co_authors: ['Crewly <noreply@crewly.com>']
      });

      this.logger.info('Scheduled commit completed', { projectPath: projectPath });
    } catch (error) {
      this.logger.error('Scheduled commit failed:', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get projects with scheduled commits
   */
  getScheduledProjects(): string[] {
    return Array.from(this.commitTimers.keys());
  }

  /**
   * Check if a path is a git repository
   */
  async isGitRepository(projectPath?: string): Promise<boolean> {
    try {
      const targetPath = projectPath || this.projectPath;
      await execAsync('git rev-parse --git-dir', { cwd: targetPath });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get repository statistics
   */
  async getRepositoryStats(): Promise<{
    totalCommits: number;
    contributors: number;
    branches: number;
  }> {
    try {
      const [commitsResult, branchesResult] = await Promise.all([
        execAsync('git rev-list --all --count', { cwd: this.projectPath }),
        execAsync('git branch -r', { cwd: this.projectPath })
      ]);

      const totalCommits = parseInt(commitsResult.stdout.trim()) || 0;
      const branches = branchesResult.stdout.trim().split('\n').filter(line => line.trim().length > 0).length;

      // Get unique contributors
      try {
        const contributorsResult = await execAsync('git shortlog -sn', { cwd: this.projectPath });
        const contributors = contributorsResult.stdout.trim().split('\n').filter(line => line.trim().length > 0).length;
        return { totalCommits, contributors, branches };
      } catch {
        return { totalCommits, contributors: 0, branches };
      }
    } catch (error) {
      return { totalCommits: 0, contributors: 0, branches: 0 };
    }
  }

  /**
   * Get last commit information
   */
  async getLastCommitInfo(): Promise<{
    hash: string;
    message: string;
    author: string;
    date: Date;
  } | null> {
    try {
      const logResult = await execAsync('git log -1 --format="%H|%s|%an|%ai"', { cwd: this.projectPath });
      const [hash, message, author, date] = logResult.stdout.trim().split('|');
      return {
        hash,
        message,
        author,
        date: new Date(date)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Commit changes (alias for commitChanges)
   */
  async commit(options: GitCommitOptions = {}): Promise<string> {
    return this.commitChanges(this.projectPath, options);
  }

  /**
   * Initialize git repository
   */
  async initializeGitRepository(): Promise<void> {
    try {
      await execAsync('git init', { cwd: this.projectPath });
      this.logger.info('Initialized git repository', { projectPath: this.projectPath } as Record<string, any>);
    } catch (error) {
      this.logger.error('Failed to initialize git repository:', { error: error instanceof Error ? error.message : String(error) } as Record<string, any>);
      throw error;
    }
  }

  /**
   * Start auto commit timer (alias for startScheduledCommits)
   */
  async startAutoCommitTimer(intervalMinutes: number = 30): Promise<void> {
    return this.startScheduledCommits(this.projectPath, {
      enabled: true,
      intervalMinutes,
      autoMessage: true,
      branchStrategy: 'feature'
    });
  }

  /**
   * Get commit history
   */
  async getCommitHistory(limit: number = 10): Promise<Array<{
    hash: string;
    message: string;
    author: string;
    date: Date;
  }>> {
    try {
      const logResult = await execAsync(`git log -${limit} --format="%H|%s|%an|%ai"`, { cwd: this.projectPath });
      return logResult.stdout.trim().split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [hash, message, author, date] = line.split('|');
          return { hash, message, author, date: new Date(date) };
        });
    } catch (error) {
      this.logger.error('Failed to get commit history:', { error: error instanceof Error ? error.message : String(error) } as Record<string, any>);
      return [];
    }
  }

  /**
   * Create a new branch
   *
   * Both names are validated as git ref names and passed to git as argv, never
   * through a shell (CREW-967).
   *
   * @param branchName - Name of the new branch
   * @param fromBranch - Optional start point
   * @throws Error when either name is not a valid git ref name or git fails
   */
  async createBranch(branchName: string, fromBranch?: string): Promise<void> {
    try {
      if (!isValidGitRefName(branchName)) {
        throw new Error('Invalid branch name');
      }
      if (fromBranch !== undefined && fromBranch !== '' && !isValidGitRefName(fromBranch)) {
        throw new Error('Invalid start point');
      }
      const args = ['checkout', '-b', branchName];
      if (fromBranch) args.push(fromBranch);
      await execFileAsync('git', args, { cwd: this.projectPath });
      this.logger.info(`Created branch ${branchName}`, { projectPath: this.projectPath });
    } catch (error) {
      this.logger.error(`Failed to create branch ${branchName}:`, { error: error instanceof Error ? error.message : String(error), branchName } as Record<string, any>);
      throw error;
    }
  }

  /**
   * Create pull request (placeholder - would integrate with GitHub/GitLab API)
   */
  async createPullRequest(options: {
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<{ url: string; number: number }> {
    // This would integrate with GitHub/GitLab API
    // For now, return a placeholder
    this.logger.info('Pull request creation requested', options);
    return {
      url: 'https://github.com/placeholder/pull/1',
      number: 1
    };
  }

  cleanup(): void {
    this.logger.info('Cleaning up git integration timers...');
    
    for (const [projectPath, timer] of this.commitTimers.entries()) {
      clearInterval(timer);
      this.logger.debug(`Cleared commit timer for: ${projectPath}`);
    }
    
    this.commitTimers.clear();
    this.logger.info('Git integration cleanup complete');
  }
}