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
import { realpathSync } from 'fs';
import { findPackageRoot } from '../../utils/package-root.js';
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
 * Returns the directories to search upward from for the Crewly package root,
 * most reliable first.
 *
 * Why not `__dirname` alone: the root package.json has `"type": "module"`, so
 * the compiled backend runs as ESM, where `__dirname` does not exist — reading
 * it threw a ReferenceError and made GET /api/experts return 500. Nor can this
 * module use `import.meta.url`: ts-jest compiles it as CommonJS, where
 * `import.meta` does not compile (see utils/node-require.utils.ts).
 *
 * 1. The real path of the entry script (`process.argv[1]`). `crewly start`
 *    spawns `dist/backend/backend/src/index.js` from inside the package, and
 *    dev runs `backend/src/index.ts`, so this is inside the package either
 *    way. realpath follows a global-install bin symlink back into the package.
 * 2. `__dirname`, when the module runs as CommonJS (tests).
 * 3. `process.cwd()`.
 *
 * @returns Candidate start directories; entries that cannot be computed are omitted
 */
function defaultPackageRootAnchors(): string[] {
  const anchors: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    try {
      anchors.push(path.dirname(realpathSync(entry)));
    } catch {
      anchors.push(path.dirname(path.resolve(entry)));
    }
  }
  if (typeof __dirname === 'string') anchors.push(__dirname);
  anchors.push(process.cwd());
  return anchors;
}

/**
 * Resolves the absolute path to the config/experts directory.
 *
 * Walks up from each anchor to the package.json named "crewly" (see
 * findPackageRoot), so the result does not depend on whether the code runs
 * from backend/src/ or from dist/backend/backend/src/.
 *
 * @param anchors - Directories to search upward from, tried in order.
 *   Defaults to the entry script, the module directory and the cwd.
 * @returns Absolute path to <package root>/config/experts, or null when no
 *   anchor lies inside a Crewly package
 */
export function resolveExpertsDir(anchors: string[] = defaultPackageRootAnchors()): string | null {
  for (const anchor of anchors) {
    try {
      return path.join(findPackageRoot(anchor), 'config', 'experts');
    } catch {
      // Not inside a Crewly package from this anchor; try the next one
    }
  }
  return null;
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
    let expertsDir: string | null = null;
    let entries: string[];
    try {
      expertsDir = resolveExpertsDir();
      if (!expertsDir) throw new Error('Crewly package root not found');
      logger.debug('Reading experts directory', { expertsDir });
      entries = await fs.readdir(expertsDir);
    } catch (err) {
      // A missing or unreadable experts directory means no experts are
      // configured. It is not a server error, so it must never become a 500.
      logger.warn('Experts directory unavailable; returning no experts', {
        expertsDir,
        error: String(err),
      });
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
