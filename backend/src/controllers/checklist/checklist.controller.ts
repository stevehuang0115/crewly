/**
 * Checklist Controller — TL acceptance checklists for delegated tasks.
 *
 * Extracted from `task-management.controller.ts` as part of spec
 * 2026-05-06-task-management-v1-deprecation.md so that the v1
 * task-management controller can be deleted while preserving the
 * checklist quality-gate workflow.
 *
 * Storage model is unchanged: each checklist is a JSON file at
 * `<projectPath>/.crewly/tasks/checklist-<taskId>.json` with three
 * lifecycle states: `pending_approval` → `approved`. The orchestrator
 * approves/adjusts the proposed checklist before workers run against it.
 *
 * Routes (mounted at the same paths as the legacy v1 endpoints to avoid
 * breaking the `team-leader/design-checklist` and `team-leader/verify-output`
 * skills):
 *   - POST /api/task-management/:taskId/checklist          — submit
 *   - POST /api/task-management/:taskId/checklist/approve  — approve
 *   - GET  /api/task-management/:taskId/checklist          — fetch
 *
 * @module controllers/checklist/checklist.controller
 */

import type { Request, Response } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ChecklistController');

/**
 * Submit a TL-proposed checklist for a task. Status starts as `pending_approval`.
 *
 * @param req - Express request. Body: `{ items: [...], projectPath?: string, ... }`.
 * @param res - 201 on success | 400 on missing fields | 500 on disk error.
 */
export async function submitChecklist(req: Request, res: Response): Promise<void> {
  try {
    const { taskId } = req.params;
    const checklist = req.body;

    if (!taskId || !checklist?.items || !Array.isArray(checklist.items)) {
      res.status(400).json({ success: false, error: 'taskId and items[] are required' });
      return;
    }

    const projectPath = checklist.projectPath || process.cwd();
    const checklistDir = join(projectPath, '.crewly', 'tasks');
    await mkdir(checklistDir, { recursive: true });

    const checklistPath = join(checklistDir, `checklist-${taskId}.json`);
    const checklistData = {
      ...checklist,
      taskId,
      status: 'pending_approval',
      submittedAt: new Date().toISOString(),
    };

    await writeFile(checklistPath, JSON.stringify(checklistData, null, 2));

    logger.info('Checklist submitted for approval', { taskId, itemCount: checklist.items.length });

    res.status(201).json({
      success: true,
      data: { taskId, checklistPath, status: 'pending_approval', itemCount: checklist.items.length },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Error submitting checklist', { error: msg });
    res.status(500).json({ success: false, error: msg });
  }
}

/**
 * Approve (or adjust) a pending checklist. Called by the Orchestrator.
 *
 * @param req - Express request. Body: `{ adjustments?: [...], projectPath?: string, approvedBy?: string }`.
 * @param res - 200 on success | 404 if checklist file missing | 500 on disk error.
 */
export async function approveChecklist(req: Request, res: Response): Promise<void> {
  try {
    const { taskId } = req.params;
    const { adjustments, projectPath: reqProjectPath } = req.body;

    const projectPath = reqProjectPath || process.cwd();
    const checklistPath = join(projectPath, '.crewly', 'tasks', `checklist-${taskId}.json`);

    let checklist;
    try {
      const raw = await readFile(checklistPath, 'utf-8');
      checklist = JSON.parse(raw);
    } catch {
      res.status(404).json({ success: false, error: `Checklist not found for task ${taskId}` });
      return;
    }

    if (adjustments && Array.isArray(adjustments)) {
      checklist.items = adjustments;
    }

    checklist.status = 'approved';
    checklist.approvedAt = new Date().toISOString();
    checklist.approvedBy = req.body.approvedBy || 'orchestrator';

    await writeFile(checklistPath, JSON.stringify(checklist, null, 2));

    logger.info('Checklist approved', { taskId, approvedBy: checklist.approvedBy });

    res.json({
      success: true,
      data: { taskId, status: 'approved', itemCount: checklist.items.length },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Error approving checklist', { error: msg });
    res.status(500).json({ success: false, error: msg });
  }
}

/**
 * Fetch the current checklist for a task.
 *
 * @param req - Express request. Query: `projectPath?: string`.
 * @param res - 200 on success | 404 if missing.
 */
export async function getChecklist(req: Request, res: Response): Promise<void> {
  try {
    const { taskId } = req.params;
    const projectPath = (req.query.projectPath as string) || process.cwd();
    const checklistPath = join(projectPath, '.crewly', 'tasks', `checklist-${taskId}.json`);

    const raw = await readFile(checklistPath, 'utf-8');
    res.json({ success: true, data: JSON.parse(raw) });
  } catch {
    res.status(404).json({ success: false, error: 'Checklist not found' });
  }
}
