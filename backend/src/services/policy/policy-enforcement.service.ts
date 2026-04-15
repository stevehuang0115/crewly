/**
 * PolicyEnforcementService — MissionPolicy enforcement logic
 *
 * Checks whether a given action is permitted under a Mission's policy,
 * and evaluates escalation rules against the current context.
 *
 * This service is called from the task delegation path, TaskPoolService,
 * and anywhere autonomy needs to be gated.
 *
 * @module services/policy/policy-enforcement.service
 */

import type {
  MissionPolicy,
  PolicyAction,
  PolicyDecision,
  EscalationRule,
  EscalationContext,
  EscalationCondition,
  Mission,
} from '../../types/v2/index.js';
import {
  ACTION_TO_POLICY_FIELD,
  isValidPolicyAction,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Escalation Result
// ---------------------------------------------------------------------------

/**
 * Result of evaluating escalation rules.
 */
export interface EscalationResult {
  /** Whether any escalation was triggered */
  triggered: boolean;
  /** The rules that were triggered */
  triggeredRules: EscalationRule[];
  /** The most severe action required */
  requiredAction?: 'pause' | 'notify' | 'block';
}

// ---------------------------------------------------------------------------
// PolicyEnforcementService
// ---------------------------------------------------------------------------

export class PolicyEnforcementService {
  /**
   * Checks whether an action is allowed under the given Mission's policy.
   *
   * @param action - The action being attempted
   * @param mission - The Mission whose policy governs this action
   * @param context - Optional escalation context for rule evaluation
   * @returns PolicyDecision indicating whether the action is allowed
   *
   * @example
   * ```typescript
   * const decision = service.checkPolicy('create_task', mission);
   * if (!decision.allowed) {
   *   console.log(`Blocked by ${decision.blockedBy}: ${decision.reason}`);
   * }
   * ```
   */
  checkPolicy(
    action: PolicyAction,
    mission: Mission,
    context?: EscalationContext,
  ): PolicyDecision {
    // Validate action
    if (!isValidPolicyAction(action)) {
      return {
        allowed: false,
        reason: `Unknown policy action: ${action}`,
      };
    }

    // Check the boolean gate
    const policyField = ACTION_TO_POLICY_FIELD[action];
    const isAllowed = mission.policy[policyField] as boolean;

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Action '${action}' is not permitted by mission policy`,
        blockedBy: policyField,
      };
    }

    // Check escalation rules if context provided
    if (context) {
      const escalation = this.evaluateEscalationRules(
        mission.policy.escalationRules,
        context,
      );

      if (escalation.triggered) {
        const blockingRule = escalation.triggeredRules.find(r => r.action === 'block');
        if (blockingRule) {
          return {
            allowed: false,
            reason: `Escalation rule triggered: ${blockingRule.condition} exceeded threshold ${blockingRule.threshold}`,
            escalation: blockingRule,
          };
        }

        // Notify/pause don't block, but attach escalation info
        return {
          allowed: true,
          escalation: escalation.triggeredRules[0],
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Checks whether a Mission has capacity for more parallel executions.
   *
   * @param mission - The Mission to check
   * @param currentExecutions - Number of currently running executions
   * @returns PolicyDecision indicating whether another execution is allowed
   */
  checkParallelCapacity(
    mission: Mission,
    currentExecutions: number,
  ): PolicyDecision {
    if (currentExecutions >= mission.policy.maxParallelExecutions) {
      return {
        allowed: false,
        reason: `Parallel execution limit reached: ${currentExecutions}/${mission.policy.maxParallelExecutions}`,
        blockedBy: 'maxParallelExecutions',
      };
    }
    return { allowed: true };
  }

  /**
   * Evaluates escalation rules against the current context.
   *
   * @param rules - Escalation rules to evaluate
   * @param context - Current mission execution context
   * @returns EscalationResult with triggered rules and required action
   */
  evaluateEscalationRules(
    rules: EscalationRule[],
    context: EscalationContext,
  ): EscalationResult {
    const triggeredRules: EscalationRule[] = [];

    for (const rule of rules) {
      if (this.isRuleTriggered(rule, context)) {
        triggeredRules.push(rule);
      }
    }

    if (triggeredRules.length === 0) {
      return { triggered: false, triggeredRules: [] };
    }

    // Determine most severe action: block > pause > notify
    const severityOrder: Array<'block' | 'pause' | 'notify'> = ['block', 'pause', 'notify'];
    const requiredAction = severityOrder.find(
      action => triggeredRules.some(r => r.action === action),
    );

    return {
      triggered: true,
      triggeredRules,
      requiredAction,
    };
  }

  /**
   * Performs a dry-run policy check — simulates without side effects.
   * Useful for the API dry-run endpoint.
   *
   * @param action - The action to simulate
   * @param policy - The policy to check against
   * @param context - Optional escalation context
   * @returns PolicyDecision (same as checkPolicy but guaranteed no side effects)
   */
  dryRunCheck(
    action: PolicyAction,
    policy: MissionPolicy,
    context?: EscalationContext,
  ): PolicyDecision {
    // Create a minimal Mission wrapper for the policy
    const fakeMission: Mission = {
      id: policy.missionId,
      objective: '',
      ownerTeamId: '',
      successCriteria: [],
      currentStrategy: '',
      activeProjectTaskIds: [],
      cadence: '',
      policy,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      learnings: [],
    };

    return this.checkPolicy(action, fakeMission, context);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Checks whether a single escalation rule is triggered by the context.
   *
   * @param rule - The rule to evaluate
   * @param context - The execution context
   * @returns True if the rule's condition exceeds its threshold
   */
  private isRuleTriggered(rule: EscalationRule, context: EscalationContext): boolean {
    const conditionChecks: Record<EscalationCondition, () => boolean> = {
      cost_exceeded: () =>
        context.currentCost !== undefined && context.currentCost > rule.threshold,
      time_exceeded: () =>
        context.hoursElapsed !== undefined && context.hoursElapsed > rule.threshold,
      failure_count: () =>
        context.failureCount !== undefined && context.failureCount > rule.threshold,
      scope_change: () =>
        context.scopeChanged === true && rule.threshold <= 1,
      security_concern: () =>
        context.securityConcern === true && rule.threshold <= 1,
    };

    const check = conditionChecks[rule.condition];
    return check ? check() : false;
  }
}
