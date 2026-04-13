/**
 * Skill Permission Service
 *
 * Hard enforcement gate for autonomyLevel. Checks whether an agent is
 * permitted to execute a given skill based on their autonomy level, role,
 * and delegation authority.
 *
 * This replaces the "soft" prompt-only approach where agents could ignore
 * autonomy constraints. Skills blocked by this gate are filtered out
 * before the agent sees them.
 *
 * Rules:
 * - directed: execute only, no delegation/decomposition/deployment
 * - bounded: delegate within scope, no production deployment
 * - domain_autonomous: most things allowed, no prod deploy, no budget changes
 * - system: all permissions (reconciler, triggers)
 *
 * @module services/skill/skill-permission
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AutonomyLevel = 'directed' | 'bounded' | 'domain_autonomous';

interface PermissionContext {
  autonomyLevel?: AutonomyLevel;
  role?: string;
  canDelegate?: boolean;
  ownershipDomains?: string[];
}

interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Blocked skills per autonomy level
// ---------------------------------------------------------------------------

/** Skills blocked for "directed" agents — they can only execute assigned work. */
const DIRECTED_BLOCKED: ReadonlySet<string> = new Set([
  'delegate-task',
  'tl-delegate-task',
  'decompose-goal',
  'decompose-mission',
  'design-checklist',
  'design-team',
  'start-agent',
  'stop-agent',
  'handle-failure',
  'aggregate-results',
]);

/** Skills blocked for "bounded" agents — they can delegate within scope but not deploy to prod. */
const BOUNDED_BLOCKED: ReadonlySet<string> = new Set([
  'deploy-to-prod',
  'design-team',
  'stop-agent',
]);

/** Skills blocked for "domain_autonomous" — almost everything allowed except dangerous ops. */
const AUTONOMOUS_BLOCKED: ReadonlySet<string> = new Set([
  'deploy-to-prod',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SkillPermissionService {
  private static instance: SkillPermissionService | null = null;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('SkillPermission');
  }

  public static getInstance(): SkillPermissionService {
    if (!SkillPermissionService.instance) {
      SkillPermissionService.instance = new SkillPermissionService();
    }
    return SkillPermissionService.instance;
  }

  public static resetInstance(): void {
    SkillPermissionService.instance = null;
  }

  /**
   * Check if an agent is permitted to execute a skill.
   *
   * @param skillName - The skill to check
   * @param context - Agent's permission context
   * @returns Permission result with reason if blocked
   */
  canExecuteSkill(skillName: string, context: PermissionContext): PermissionResult {
    const level = context.autonomyLevel ?? 'directed';

    // System/orchestrator role bypasses autonomy checks
    if (context.role === 'orchestrator') {
      return { allowed: true };
    }

    // Delegation skills require canDelegate flag regardless of autonomy
    if (this.isDelegationSkill(skillName) && !context.canDelegate) {
      return {
        allowed: false,
        reason: `Skill "${skillName}" requires delegation authority (canDelegate=true)`,
      };
    }

    // Check autonomy-level-specific blocks
    switch (level) {
      case 'directed':
        if (DIRECTED_BLOCKED.has(skillName)) {
          return {
            allowed: false,
            reason: `Autonomy level "directed" does not permit "${skillName}". Only task execution skills are allowed.`,
          };
        }
        break;

      case 'bounded':
        if (BOUNDED_BLOCKED.has(skillName)) {
          return {
            allowed: false,
            reason: `Autonomy level "bounded" does not permit "${skillName}".`,
          };
        }
        break;

      case 'domain_autonomous':
        if (AUTONOMOUS_BLOCKED.has(skillName)) {
          return {
            allowed: false,
            reason: `Skill "${skillName}" is blocked even for domain_autonomous agents.`,
          };
        }
        break;
    }

    return { allowed: true };
  }

  /**
   * Filter a list of skill names, removing those not permitted for the agent.
   *
   * @param skillNames - Array of skill names to filter
   * @param context - Agent's permission context
   * @returns Filtered array of permitted skill names
   */
  filterPermittedSkills(skillNames: string[], context: PermissionContext): string[] {
    return skillNames.filter((name) => {
      const result = this.canExecuteSkill(name, context);
      if (!result.allowed) {
        this.logger.debug('Skill blocked by permission gate', {
          skill: name,
          reason: result.reason,
          autonomyLevel: context.autonomyLevel,
        });
      }
      return result.allowed;
    });
  }

  /**
   * Check if a skill is a delegation/management skill.
   */
  private isDelegationSkill(skillName: string): boolean {
    return skillName.includes('delegate') || skillName.includes('decompose');
  }
}
