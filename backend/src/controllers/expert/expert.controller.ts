/**
 * Expert Controller
 *
 * Reads expert profiles from config/experts/ subdirectories and returns
 * them as a flat list. Each subdirectory must contain an expert.json file.
 *
 * @module controllers/expert/expert.controller
 */

import { Request, Response } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ExpertController');

/** Shape of the expert.json file on disk */
interface ExpertProfile {
  id: string;
  version: string;
  name: string;
  category: string;
  intensity: number;
  baseRoles: string[];
  tags: string[];
  distillationDate: string;
  teacherModel: string;
}

/** Summary returned by the API (subset of ExpertProfile) */
export interface ExpertSummary {
  id: string;
  name: string;
  category: string;
  tags: string[];
  baseRoles: string[];
}

/** Files/directories to skip when scanning config/experts/ */
const SKIP_ENTRIES = new Set(['EXAMPLE.json', 'EXAMPLE.md']);

/**
 * Resolves the absolute path to the config/experts directory.
 * Walks up from the controllers folder to the project root.
 *
 * @returns Absolute path to config/experts/
 */
function getExpertsDir(): string {
  // backend/src/controllers/expert -> project root
  const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(projectRoot, 'config', 'experts');
}

/**
 * Lists all available expert profiles.
 *
 * Scans config/experts/ for subdirectories containing expert.json,
 * parses each, and returns the summary fields.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 * @returns JSON response with { success, data: ExpertSummary[] }
 */
export async function listExperts(_req: Request, res: Response): Promise<void> {
  try {
    const expertsDir = getExpertsDir();

    let entries: string[];
    try {
      entries = await fs.readdir(expertsDir);
    } catch {
      // Directory missing is not an error — just means no experts configured
      res.json({ success: true, data: [] });
      return;
    }

    const experts: ExpertSummary[] = [];

    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry)) continue;

      const entryPath = path.join(expertsDir, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const jsonPath = path.join(entryPath, 'expert.json');
      try {
        const raw = await fs.readFile(jsonPath, 'utf-8');
        const profile: ExpertProfile = JSON.parse(raw);
        experts.push({
          id: profile.id,
          name: profile.name,
          category: profile.category,
          tags: profile.tags,
          baseRoles: profile.baseRoles,
        });
      } catch (err) {
        logger.warn(`Skipping expert "${entry}": failed to read expert.json`, { error: String(err) });
      }
    }

    res.json({ success: true, data: experts });
  } catch (err) {
    logger.error('Failed to list experts', { error: String(err) });
    res.status(500).json({ success: false, error: 'Failed to list experts' });
  }
}
