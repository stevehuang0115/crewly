/**
 * Role Controller
 *
 * REST API endpoints for managing AI agent roles.
 *
 * @module controllers/settings/role.controller
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  getRoleService,
  RoleNotFoundError,
  RoleValidationError,
  BuiltinRoleModificationError,
  DuplicateRoleNameError,
} from '../../services/settings/role.service.js';
import {
  CreateRoleInput,
  UpdateRoleInput,
  RoleFilter,
  RoleCategory,
  isValidRoleCategory,
} from '../../types/role.types.js';
import { ownerOnly } from '../../middleware/caller-identity.middleware.js';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';

const router = Router();

/**
 * Role writes are the owner's (#1024), like the other settings writes: a
 * role's system prompt and skills are inherited by every future agent of
 * that role, so an agent (or any local process) rewriting one changes what
 * all of them do. Agents get 403, a caller with no credential 401. Reads and
 * `POST /refresh` (reload from disk; changes nothing) stay open.
 */
const ownerGate = ownerOnly({
  success: false,
  error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_ONLY,
  message: 'Only the owner can change roles.',
});

/**
 * POST /api/settings/roles/refresh
 * Refresh roles from disk
 *
 * Forces the role service to reload all roles from the filesystem.
 * Use this after adding/modifying role files to see changes without server restart.
 *
 * Note: This route must be defined before /:id to avoid matching 'refresh' as an ID
 */
router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    await roleService.refresh();
    res.json({
      success: true,
      message: 'Roles refreshed from disk',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/settings/roles/default
 * Get the current default role
 *
 * Note: This route must be defined before /:id to avoid matching 'default' as an ID
 */
router.get('/default', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    const role = await roleService.getDefaultRole();

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'No default role configured',
      });
    }

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/settings/roles
 * List all roles with optional filtering
 *
 * Query params:
 * - category: Filter by role category
 * - isBuiltin: Filter by builtin status (true/false)
 * - hasSkill: Filter roles that have a specific skill assigned
 * - search: Search in name and description
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categoryParam = req.query.category as string | undefined;
    const filter: RoleFilter = {
      category: categoryParam && isValidRoleCategory(categoryParam)
        ? categoryParam as RoleCategory
        : undefined,
      isBuiltin: req.query.isBuiltin === 'true' ? true :
                 req.query.isBuiltin === 'false' ? false : undefined,
      hasSkill: req.query.hasSkill as string | undefined,
      search: req.query.search as string | undefined,
    };

    const roleService = getRoleService();
    const roles = await roleService.listRoles(filter);

    res.json({
      success: true,
      data: roles,
      count: roles.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/settings/roles/:id
 * Get a single role by ID with full prompt content
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    const role = await roleService.getRole(req.params.id);

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'Role not found',
      });
    }

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/roles
 * Create a new user-defined role
 */
router.post('/', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreateRoleInput = {
      name: req.body.name,
      displayName: req.body.displayName,
      description: req.body.description,
      category: req.body.category,
      systemPromptContent: req.body.systemPromptContent,
      assignedSkills: req.body.assignedSkills,
      isDefault: req.body.isDefault,
    };

    const roleService = getRoleService();
    const role = await roleService.createRole(input);

    res.status(201).json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error instanceof RoleValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        validationErrors: error.errors,
      });
    }
    if (error instanceof DuplicateRoleNameError) {
      return res.status(409).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * PUT /api/settings/roles/:id
 * Update an existing role
 */
router.put('/:id', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateRoleInput = {
      displayName: req.body.displayName,
      description: req.body.description,
      category: req.body.category,
      systemPromptContent: req.body.systemPromptContent,
      assignedSkills: req.body.assignedSkills,
      isDefault: req.body.isDefault,
    };

    const roleService = getRoleService();
    const role = await roleService.updateRole(req.params.id, input);

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof BuiltinRoleModificationError) {
      return res.status(403).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof RoleValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        validationErrors: error.errors,
      });
    }
    next(error);
  }
});

/**
 * DELETE /api/settings/roles/:id
 * Delete a user-created role
 */
router.delete('/:id', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    await roleService.deleteRole(req.params.id);

    res.json({
      success: true,
      message: 'Role deleted successfully',
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof BuiltinRoleModificationError) {
      return res.status(403).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * POST /api/settings/roles/:id/skills
 * Assign skills to a role
 */
router.post('/:id/skills', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { skillIds } = req.body;

    if (!Array.isArray(skillIds)) {
      return res.status(400).json({
        success: false,
        error: 'skillIds must be an array',
      });
    }

    const roleService = getRoleService();
    const role = await roleService.assignSkills(req.params.id, skillIds);

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof BuiltinRoleModificationError) {
      return res.status(403).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * DELETE /api/settings/roles/:id/skills
 * Remove skills from a role
 */
router.delete('/:id/skills', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { skillIds } = req.body;

    if (!Array.isArray(skillIds)) {
      return res.status(400).json({
        success: false,
        error: 'skillIds must be an array',
      });
    }

    const roleService = getRoleService();
    const role = await roleService.removeSkills(req.params.id, skillIds);

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    if (error instanceof BuiltinRoleModificationError) {
      return res.status(403).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * POST /api/settings/roles/:id/set-default
 * Set a role as the default
 */
router.post('/:id/set-default', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    const role = await roleService.setDefaultRole(req.params.id);

    res.json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * POST /api/settings/roles/:id/reset
 * Reset a builtin role to its default (removes user override)
 */
router.post('/:id/reset', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    const role = await roleService.resetToDefault(req.params.id);

    res.json({
      success: true,
      data: role,
      message: 'Role reset to default successfully',
    });
  } catch (error) {
    if (error instanceof RoleNotFoundError) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    next(error);
  }
});

/**
 * GET /api/settings/roles/:id/has-override
 * Check if a builtin role has a user override
 */
router.get('/:id/has-override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleService = getRoleService();
    const hasOverride = await roleService.hasOverride(req.params.id);

    res.json({
      success: true,
      data: { hasOverride },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
