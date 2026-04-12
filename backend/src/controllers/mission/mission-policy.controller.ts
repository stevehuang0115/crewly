/**
 * MissionPolicy Controller — HTTP handlers for Mission Policy CRUD API
 *
 * Endpoints:
 * - GET  /api/missions/:id/policy       — get a mission's policy
 * - PUT  /api/missions/:id/policy       — update a mission's policy
 * - POST /api/missions/:id/policy/check — dry-run: check if an action is allowed
 *
 * Missions are stored as individual JSON files at:
 *   `{projectPath}/.crewly/missions/{id}.json`
 *
 * @module controllers/mission/mission-policy.controller
 */

import type { Request, Response } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  Mission,
  MissionPolicy,
  UpdatePolicyInput,
  PolicyAction,
  EscalationContext,
} from '../../types/v2/index.js';
import {
  isMission,
  isValidPolicyAction,
  isValidMissionPolicy,
  isValidEscalationRule,
} from '../../types/v2/index.js';
import { PolicyEnforcementService } from '../../services/policy/policy-enforcement.service.js';
import { applyPolicyUpdate } from '../../services/policy/default-policies.js';
import { ensureDir, atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default project path — resolved from CWD or env. */
const PROJECT_PATH = process.env.CREWLY_PROJECT_PATH || process.cwd();

/** Directory where mission JSON files are stored. */
const MISSIONS_DIR = '.crewly/missions';

/**
 * Resolves the file path for a mission JSON file.
 *
 * @param missionId - The mission ID
 * @returns Absolute path to the mission JSON file
 */
function getMissionFilePath(missionId: string): string {
  return path.join(PROJECT_PATH, MISSIONS_DIR, `${missionId}.json`);
}

/**
 * Loads a Mission from disk by ID.
 *
 * @param missionId - The mission ID to load
 * @returns The Mission object, or null if not found
 */
async function loadMission(missionId: string): Promise<Mission | null> {
  const filePath = getMissionFilePath(missionId);
  const data = await safeReadJson<Mission | null>(filePath, null);
  if (!data || !isMission(data)) return null;
  return data;
}

/**
 * Persists a Mission to disk.
 *
 * @param mission - The Mission object to save
 */
async function saveMission(mission: Mission): Promise<void> {
  const filePath = getMissionFilePath(mission.id);
  await ensureDir(path.dirname(filePath));
  await atomicWriteJson(filePath, mission);
}

/**
 * Validates that an UpdatePolicyInput is structurally correct.
 *
 * @param input - The update payload to validate
 * @returns An error message string, or null if valid
 */
function validateUpdatePolicyInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'Request body must be a non-null object';
  }

  const obj = input as Record<string, unknown>;

  // Validate boolean fields
  const booleanFields = [
    'canCreateTasks',
    'canReprioritizeTasks',
    'canCloseTasks',
    'canDeployToStaging',
    'canDeployToProd',
    'canSpendMoney',
    'canChangeUserVisibleBehaviorWithoutReview',
  ] as const;

  for (const field of booleanFields) {
    if (field in obj && typeof obj[field] !== 'boolean') {
      return `Field '${field}' must be a boolean`;
    }
  }

  // Validate maxParallelExecutions
  if ('maxParallelExecutions' in obj) {
    if (typeof obj.maxParallelExecutions !== 'number' || obj.maxParallelExecutions < 1) {
      return 'maxParallelExecutions must be a positive number';
    }
  }

  // Validate escalationRules
  if ('escalationRules' in obj) {
    if (!Array.isArray(obj.escalationRules)) {
      return 'escalationRules must be an array';
    }
    for (let i = 0; i < obj.escalationRules.length; i++) {
      if (!isValidEscalationRule(obj.escalationRules[i])) {
        return `escalationRules[${i}] is invalid`;
      }
    }
  }

  return null;
}

/**
 * Validates a dry-run check request body.
 *
 * @param body - The request body
 * @returns An error message string, or null if valid
 */
function validateCheckBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'Request body must be a non-null object';
  }

  const obj = body as Record<string, unknown>;

  if (!obj.action || typeof obj.action !== 'string') {
    return 'action is required and must be a string';
  }

  if (!isValidPolicyAction(obj.action)) {
    return `Invalid action '${obj.action}'. Valid actions: create_task, reprioritize_task, close_task, deploy_staging, deploy_prod, spend_money, change_user_visible_behavior`;
  }

  // Context is optional but must be an object if provided
  if (obj.context !== undefined && (typeof obj.context !== 'object' || obj.context === null)) {
    return 'context must be an object if provided';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Singleton enforcement service
// ---------------------------------------------------------------------------

let enforcementService: PolicyEnforcementService | null = null;

/**
 * Returns the PolicyEnforcementService singleton.
 *
 * @returns PolicyEnforcementService instance
 */
function getEnforcementService(): PolicyEnforcementService {
  if (!enforcementService) {
    enforcementService = new PolicyEnforcementService();
  }
  return enforcementService;
}

// ---------------------------------------------------------------------------
// GET /api/missions/:id/policy — Get mission policy
// ---------------------------------------------------------------------------

/**
 * Returns the MissionPolicy for a given mission.
 *
 * @param req - Express request with mission ID in params
 * @param res - Express response with the policy object
 */
export async function getPolicy(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!id || typeof id !== 'string' || !id.trim()) {
      res.status(400).json({ success: false, error: 'Mission ID is required' });
      return;
    }

    const mission = await loadMission(id);

    if (!mission) {
      res.status(404).json({ success: false, error: `Mission '${id}' not found` });
      return;
    }

    res.json({ success: true, data: mission.policy });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/missions/:id/policy — Update mission policy
// ---------------------------------------------------------------------------

/**
 * Updates the MissionPolicy for a given mission.
 * Accepts partial updates — only the fields provided are changed.
 *
 * Request body: UpdatePolicyInput (partial MissionPolicy fields)
 *
 * @param req - Express request with mission ID in params and policy updates in body
 * @param res - Express response with the updated policy
 */
export async function updatePolicy(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!id || typeof id !== 'string' || !id.trim()) {
      res.status(400).json({ success: false, error: 'Mission ID is required' });
      return;
    }

    const validationError = validateUpdatePolicyInput(req.body);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const mission = await loadMission(id);

    if (!mission) {
      res.status(404).json({ success: false, error: `Mission '${id}' not found` });
      return;
    }

    const updates = req.body as UpdatePolicyInput;
    const updatedPolicy = applyPolicyUpdate(mission.policy, updates);

    // Sanity-check the result
    if (!isValidMissionPolicy(updatedPolicy)) {
      res.status(500).json({ success: false, error: 'Policy update produced an invalid policy' });
      return;
    }

    mission.policy = updatedPolicy;
    mission.updatedAt = new Date().toISOString();

    await saveMission(mission);

    res.json({ success: true, data: updatedPolicy });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/missions/:id/policy/check — Dry-run policy check
// ---------------------------------------------------------------------------

/**
 * Performs a dry-run check to see if a given action would be allowed
 * under the mission's current policy. No side effects.
 *
 * Request body:
 * ```json
 * {
 *   "action": "create_task",
 *   "context": { "currentCost": 45.0, "failureCount": 2 }
 * }
 * ```
 *
 * @param req - Express request with mission ID in params and action/context in body
 * @param res - Express response with the PolicyDecision
 */
export async function checkPolicy(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    if (!id || typeof id !== 'string' || !id.trim()) {
      res.status(400).json({ success: false, error: 'Mission ID is required' });
      return;
    }

    const validationError = validateCheckBody(req.body);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const { action, context } = req.body as {
      action: PolicyAction;
      context?: EscalationContext;
    };

    const mission = await loadMission(id);

    if (!mission) {
      res.status(404).json({ success: false, error: `Mission '${id}' not found` });
      return;
    }

    const decision = getEnforcementService().dryRunCheck(action, mission.policy, context);

    res.json({ success: true, data: decision });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Test helpers (exported for test use only)
// ---------------------------------------------------------------------------

/**
 * Resets the enforcement service singleton.
 * Intended for test isolation only.
 */
export function resetEnforcementService(): void {
  enforcementService = null;
}

/** Exposed for testing: load a mission from disk. */
export { loadMission as _loadMission };

/** Exposed for testing: save a mission to disk. */
export { saveMission as _saveMission };
