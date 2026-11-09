import { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import { GitIntegrationService } from '../../services/index.js';
import { ApiResponse } from '../../types/index.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { isValidGitRefName } from '../../utils/git-ref.utils.js';

const logger = LoggerService.getInstance().createComponentLogger('GitController');

export async function getGitStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    if (!await git.isGitRepository()) { res.status(400).json({ success: false, error: 'Not a git repository' } as ApiResponse); return; }
    const [status, stats, lastCommit] = await Promise.all([
      git.getGitStatus(),
      git.getRepositoryStats(),
      git.getLastCommitInfo(),
    ]);
    res.json({ success: true, data: { status, stats, lastCommit } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting git status', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get git status' } as ApiResponse);
  }
}

export async function commitChanges(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const { message, includeUntracked, dryRun } = req.body as any;
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    if (!await git.isGitRepository()) { res.status(400).json({ success: false, error: 'Not a git repository' } as ApiResponse); return; }
    const result = await git.commit({ message, includeUntracked, dryRun });
    res.json({ success: true, data: result } as ApiResponse);
  } catch (error) {
    logger.error('Error committing changes', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to commit changes' } as ApiResponse);
  }
}

export async function startAutoCommit(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const { intervalMinutes } = req.body as any;
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    if (!await git.isGitRepository()) { await git.initializeGitRepository(); }
    await git.startAutoCommitTimer(intervalMinutes || 30);
    (global as any).gitServices = (global as any).gitServices || {};
    (global as any).gitServices[projectId] = git;
    res.json({ success: true, data: { projectId, intervalMinutes: intervalMinutes || 30, started: true } } as ApiResponse);
  } catch (error) {
    logger.error('Error starting auto-commit', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to start auto-commit' } as ApiResponse);
  }
}

export async function stopAutoCommit(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const gitServices = (global as any).gitServices || {};
    const git = gitServices[projectId];
    if (git) { git.stopAutoCommitTimer(); delete gitServices[projectId]; }
    res.json({ success: true, data: { projectId, stopped: true } } as ApiResponse);
  } catch (error) {
    logger.error('Error stopping auto-commit', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to stop auto-commit' } as ApiResponse);
  }
}

export async function getCommitHistory(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const { limit } = req.query as any;
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    if (!await git.isGitRepository()) { res.status(400).json({ success: false, error: 'Not a git repository' } as ApiResponse); return; }
    const commits = await git.getCommitHistory(limit ? parseInt(limit) : 10);
    res.json({ success: true, data: { commits, projectId } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting commit history', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get commit history' } as ApiResponse);
  }
}

export async function createBranch(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const { branchName, switchTo } = req.body as any;
    if (!branchName) { res.status(400).json({ success: false, error: 'Branch name is required' } as ApiResponse); return; }
    // CREW-967: refuse anything git would not accept as a ref name, or that starts with "-".
    if (!isValidGitRefName(branchName)) { res.status(400).json({ success: false, error: 'Invalid branch name' } as ApiResponse); return; }
    if (switchTo !== undefined && switchTo !== null && switchTo !== '' && switchTo !== false && !isValidGitRefName(switchTo)) {
      res.status(400).json({ success: false, error: 'Invalid start point' } as ApiResponse); return;
    }
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    await git.createBranch(branchName, switchTo);
    res.json({ success: true, data: { projectId, branchName, switchedTo: switchTo || false } } as ApiResponse);
  } catch (error) {
    logger.error('Error creating branch', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to create branch' } as ApiResponse);
  }
}

export async function createPullRequest(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params as any;
    const { baseBranch, headBranch, title, description } = req.body as any;
    if (!baseBranch || !headBranch || !title) { res.status(400).json({ success: false, error: 'baseBranch, headBranch, and title are required' } as ApiResponse); return; }
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse); return; }
    const git = new GitIntegrationService(project.path);
    const url = await git.createPullRequest({ title, description, sourceBranch: headBranch, targetBranch: baseBranch });
    res.json({ success: true, data: { projectId, pullRequestUrl: url } } as ApiResponse);
  } catch (error) {
    logger.error('Error creating pull request', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to create pull request' } as ApiResponse);
  }
}
