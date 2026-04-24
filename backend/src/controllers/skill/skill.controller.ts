/**
 * Skill Controller
 *
 * REST API endpoints for skill management.
 *
 * @module controllers/skill/skill.controller
 */

import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getSkillService } from '../../services/skill/skill.service.js';
import { getSkillExecutorService } from '../../services/skill/skill-executor.service.js';
import type {
  CreateSkillInput,
  UpdateSkillInput,
  SkillFilter,
  SkillExecutionContext,
  SkillCategory,
  SkillExecutionType,
} from '../../types/skill.types.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SkillController');

/**
 * MCP server configuration structure
 */
interface McpServerConfig {
  command?: string;
  args?: string[];
  transport?: string;
  url?: string;
  type?: string;
  env?: Record<string, string>;
}

/**
 * Interface for Claude Code ~/.claude.json structure
 */
interface ClaudeJsonConfig {
  /** Global MCP servers (User MCPs) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Project-specific settings */
  projects?: Record<string, {
    mcpServers?: Record<string, McpServerConfig>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Interface for Claude Code settings.json structure (legacy)
 */
interface ClaudeSettings {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

/**
 * MCP server installation status
 */
interface McpServerStatus {
  /** Package name (e.g., @playwright/mcp) */
  packageName: string;
  /** Whether the MCP server is installed/configured */
  isInstalled: boolean;
  /** The configured name in Claude settings (if installed) */
  configuredName?: string;
}

const router = Router();

/**
 * GET /api/skills
 * List all skills with optional filtering
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter: SkillFilter = {
      category: req.query.category as SkillCategory | undefined,
      executionType: req.query.executionType as SkillExecutionType | undefined,
      roleId: req.query.roleId as string | undefined,
      isBuiltin:
        req.query.isBuiltin === 'true'
          ? true
          : req.query.isBuiltin === 'false'
            ? false
            : undefined,
      isEnabled:
        req.query.isEnabled === 'true'
          ? true
          : req.query.isEnabled === 'false'
            ? false
            : undefined,
      search: req.query.search as string | undefined,
      tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
    };

    const skillService = getSkillService();
    const skills = await skillService.listSkills(filter);

    res.json({
      success: true,
      data: skills,
      count: skills.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/skills/match
 * Find skills matching a query
 * Note: This route must be defined before /:id to avoid route conflicts
 */
router.get('/match', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, roleId, limit } = req.query;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter is required',
      });
    }

    const skillService = getSkillService();
    const skills = await skillService.matchSkills(
      query as string,
      roleId as string | undefined,
      limit ? parseInt(limit as string, 10) : 5
    );

    res.json({
      success: true,
      data: skills,
      count: skills.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/skills/role/:roleId
 * Get skills assigned to a specific role
 */
router.get('/role/:roleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    const skills = await skillService.getSkillsForRole(req.params.roleId);

    res.json({
      success: true,
      data: skills,
      count: skills.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/skills/refresh
 * Refresh skills from disk
 */
router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    await skillService.refresh();

    res.json({
      success: true,
      message: 'Skills refreshed from disk',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/skills/mcp-status
 * Check which MCP servers are installed in Claude Code
 *
 * Query params:
 * - packages: Comma-separated list of package names to check
 * - projectPath: Optional project path to also check project-level settings
 */
router.get('/mcp-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const packagesToCheck = req.query.packages
      ? (req.query.packages as string).split(',').map(p => p.trim())
      : [];
    const projectPath = req.query.projectPath as string | undefined;

    // Read ~/.claude.json which contains both global and project-specific MCP servers
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    let claudeConfig: ClaudeJsonConfig = {};

    try {
      const configContent = await fs.readFile(claudeJsonPath, 'utf-8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      logger.info('Could not read ~/.claude.json', { error: (error as Error).message });
    }

    // Also read ~/.claude/settings.json for User MCPs (legacy location)
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let globalSettings: ClaudeSettings = {};

    try {
      const settingsContent = await fs.readFile(globalSettingsPath, 'utf-8');
      globalSettings = JSON.parse(settingsContent);
    } catch (error) {
      // Settings file doesn't exist or is invalid - that's ok
    }

    // Get global MCP servers (User MCPs) from both locations
    const globalMcpServers: Record<string, McpServerConfig> = {
      ...(globalSettings.mcpServers || {}),
      ...(claudeConfig.mcpServers || {}),
    };

    // Get project-specific MCP servers (Local MCPs) from ~/.claude.json projects section
    let projectMcpServers: Record<string, McpServerConfig> = {};
    let projectSettingsFound = false;

    if (projectPath && claudeConfig.projects) {
      const projectConfig = claudeConfig.projects[projectPath];
      if (projectConfig && projectConfig.mcpServers) {
        projectMcpServers = projectConfig.mcpServers;
        projectSettingsFound = true;
      }
    }

    // Merge global and project MCP servers (project takes precedence)
    const allMcpServers = {
      ...globalMcpServers,
      ...projectMcpServers,
    };

    // Build status for each requested package
    const statuses: McpServerStatus[] = packagesToCheck.map(packageName => {
      // Check if the package is configured by looking at:
      // 1. The server name matches the package name
      // 2. The command/args contain the package name
      // Prefer project matches over global, and prefer exact matches over partial
      let bestMatch: { serverName: string; source: 'global' | 'project'; score: number } | null = null;

      const shortPackageName = packageName.replace(/^@[^/]+\//, '');

      // Helper to calculate match score (higher is better)
      const getMatchScore = (serverName: string, serverConfig: McpServerConfig, isProject: boolean): number => {
        let score = 0;

        // Project matches get a base bonus
        if (isProject) score += 100;

        // Check args for package match (most reliable)
        const argsMatch = serverConfig.args?.some(arg => arg.includes(packageName));
        if (argsMatch) score += 50;

        // Check server name matches
        if (serverName.toLowerCase() === shortPackageName.toLowerCase()) {
          // Exact name match (e.g., "playwright" matches "@playwright/mcp")
          score += 40;
        } else if (serverName.toLowerCase().includes(shortPackageName.toLowerCase())) {
          // Partial name match - only count if the short name is specific enough (> 3 chars)
          if (shortPackageName.length > 3) {
            score += 10;
          }
        }

        return score;
      };

      // Check project MCP servers first
      for (const [serverName, serverConfig] of Object.entries(projectMcpServers)) {
        const score = getMatchScore(serverName, serverConfig, true);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { serverName, source: 'project', score };
        }
      }

      // Then check global MCP servers
      for (const [serverName, serverConfig] of Object.entries(globalMcpServers)) {
        const score = getMatchScore(serverName, serverConfig, false);
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { serverName, source: 'global', score };
        }
      }

      return {
        packageName,
        isInstalled: bestMatch !== null,
        configuredName: bestMatch?.serverName,
        source: bestMatch?.source,
      };
    });

    // Return all configured MCP servers with their source
    const allConfiguredServers = Object.keys(allMcpServers);

    res.json({
      success: true,
      data: {
        statuses,
        allConfiguredServers,
        globalSettingsFound: Object.keys(globalMcpServers).length > 0,
        projectSettingsFound,
        projectPath: projectPath || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/skills/:id
 * Get a single skill by ID with full prompt content
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    const skill = await skillService.getSkill(req.params.id);

    if (!skill) {
      return res.status(404).json({
        success: false,
        error: 'Skill not found',
      });
    }

    res.json({
      success: true,
      data: skill,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/skills
 * Create a new user-defined skill
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreateSkillInput = {
      name: req.body.name,
      description: req.body.description,
      category: req.body.category,
      promptContent: req.body.promptContent,
      execution: req.body.execution,
      environment: req.body.environment,
      assignableRoles: req.body.assignableRoles,
      triggers: req.body.triggers,
      tags: req.body.tags,
    };

    const skillService = getSkillService();
    const skill = await skillService.createSkill(input);

    res.status(201).json({
      success: true,
      data: skill,
    });
  } catch (error) {
    if ((error as Error).name === 'SkillValidationError') {
      const validationError = error as Error & { errors?: string[] };
      return res.status(400).json({
        success: false,
        error: validationError.message,
        validationErrors: validationError.errors,
      });
    }
    next(error);
  }
});

/**
 * PUT /api/skills/:id
 * Update an existing skill
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateSkillInput = {
      name: req.body.name,
      description: req.body.description,
      category: req.body.category,
      promptContent: req.body.promptContent,
      execution: req.body.execution,
      environment: req.body.environment,
      assignableRoles: req.body.assignableRoles,
      triggers: req.body.triggers,
      tags: req.body.tags,
      isEnabled: req.body.isEnabled,
    };

    const skillService = getSkillService();
    const skill = await skillService.updateSkill(req.params.id, input);

    res.json({
      success: true,
      data: skill,
    });
  } catch (error) {
    if ((error as Error).name === 'SkillNotFoundError') {
      return res.status(404).json({
        success: false,
        error: (error as Error).message,
      });
    }
    if ((error as Error).name === 'BuiltinSkillModificationError') {
      return res.status(403).json({
        success: false,
        error: (error as Error).message,
      });
    }
    next(error);
  }
});

/**
 * DELETE /api/skills/:id
 * Delete a user-created skill
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    await skillService.deleteSkill(req.params.id);

    res.json({
      success: true,
      message: 'Skill deleted successfully',
    });
  } catch (error) {
    if ((error as Error).name === 'SkillNotFoundError') {
      return res.status(404).json({
        success: false,
        error: (error as Error).message,
      });
    }
    if ((error as Error).name === 'BuiltinSkillModificationError') {
      return res.status(403).json({
        success: false,
        error: (error as Error).message,
      });
    }
    next(error);
  }
});

/**
 * POST /api/skills/:id/execute
 * Execute a skill
 */
router.post('/:id/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const context: SkillExecutionContext = {
      agentId: req.body.agentId || 'api-user',
      roleId: req.body.roleId || 'default',
      projectId: req.body.projectId,
      taskId: req.body.taskId,
      userInput: req.body.userInput,
      metadata: req.body.metadata,
      credentialBindings: req.body.credentialBindings,
    };

    const executor = getSkillExecutorService();
    const result = await executor.executeSkill(req.params.id, context);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/skills/:id/enable
 * Enable a skill
 */
router.put('/:id/enable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    const skill = await skillService.setSkillEnabled(req.params.id, true);

    res.json({
      success: true,
      data: skill,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/skills/:id/disable
 * Disable a skill
 */
router.put('/:id/disable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillService = getSkillService();
    const skill = await skillService.setSkillEnabled(req.params.id, false);

    res.json({
      success: true,
      data: skill,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
