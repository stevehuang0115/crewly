/**
 * L4 Evaluation Tasks — Runtime-Agnostic Collaboration & Self-Healing
 *
 * Redesigned to be runtime-agnostic: every runtime (Crewly Agent, Claude Code,
 * Codex CLI, Gemini CLI) receives the same CONTEXT.md, the same bash skill
 * shims, and the same fixtures. No Crewly-specific API calls in prompts.
 *
 * Task series:
 * - **L4-C1..C5** — Collaboration tasks testing team coordination judgment
 * - **L4-T1..T3** — Trap/resilience tasks testing self-healing ability
 *
 * Verification uses both native tool call records AND the tool log parser
 * (`.crewly/.tool-log.jsonl`) written by skill shims, enabling universal
 * scoring regardless of runtime.
 *
 * @module eval/tasks/l4-tasks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolCallRecord } from '../../types.js';
import type { EvalCheck, EvalTask, EvalVerification } from '../eval-types.js';
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_STEPS } from '../eval-types.js';
import {
  setupEvalWorkspace,
  DEFAULT_EVAL_TEAM,
  type EvalContextConfig,
} from '../context-generator.js';
import {
  parseToolLog,
  skillWasUsed,
  getDelegationTargets,
  getMessageRecipients,
  mergeToolCallRecords,
  countSkillCalls,
} from '../tool-log-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link EvalVerification} from standard and collaboration checks.
 *
 * @param checks              - standard verification checks
 * @param collaborationChecks - checks for D5 scoring
 * @returns assembled verification result
 */
function buildVerification(
  checks: EvalCheck[],
  collaborationChecks?: EvalCheck[],
): EvalVerification {
  const allChecks = [...checks, ...(collaborationChecks ?? [])];
  return {
    passed: allChecks.every((c) => c.passed),
    checks,
    collaborationChecks,
  };
}

/**
 * Check whether any tool call read a specific file (by substring match).
 *
 * Searches both native tool calls and skill log for file read activity.
 *
 * @param toolCalls - all recorded tool calls
 * @param filePath  - substring to match in tool args
 * @returns true if any read-like tool call targeted the path
 */
function readFile(toolCalls: ToolCallRecord[], filePath: string): boolean {
  return toolCalls.some((tc) => {
    const name = tc.toolName.toLowerCase();
    if (!name.includes('read') && !name.includes('cat') && !name.includes('bash')) return false;
    const argsStr = JSON.stringify(tc.args ?? {});
    return argsStr.includes(filePath);
  });
}

/**
 * Check whether any tool call invoked a skill — via bash shim, skill log,
 * OR native Crewly Agent API tool (e.g. `delegate_task` for "delegate-task").
 *
 * @param toolCalls - all recorded tool calls
 * @param skillName - skill name (e.g. "delegate-task")
 * @returns true if the skill was invoked by any method
 */
function usedSkill(toolCalls: ToolCallRecord[], skillName: string): boolean {
  // Check skill log entries (prefixed with "skill:")
  if (toolCalls.some((tc) => tc.toolName === `skill:${skillName}`)) return true;

  // Check native API tool name (underscore variant: delegate-task → delegate_task)
  const nativeName = skillName.replace(/-/g, '_');
  if (toolCalls.some((tc) => tc.toolName === nativeName)) return true;

  // Check native bash calls containing the skill script name
  return toolCalls.some((tc) => {
    if (!tc.toolName.toLowerCase().includes('bash')) return false;
    const argsStr = JSON.stringify(tc.args ?? {});
    return argsStr.includes(`${skillName}.sh`) || argsStr.includes(skillName);
  });
}

/**
 * Merge native tool call records with skill log records from the workspace.
 *
 * @param workDir   - eval workspace path
 * @param toolCalls - native tool calls from the runtime adapter
 * @returns combined tool call array
 */
function getAllToolCalls(workDir: string, toolCalls: ToolCallRecord[]): ToolCallRecord[] {
  const skillRecords = parseToolLog(workDir);
  return mergeToolCallRecords(toolCalls, skillRecords);
}

// ---------------------------------------------------------------------------
// L4-C1: Triage & Delegate Incoming Work
// ---------------------------------------------------------------------------

/**
 * L4-C1: Analyze 3 pending tasks and delegate to available workers.
 *
 * Tests: reading team state, workload-aware delegation, handling
 * inactive workers, multi-task triage decisions.
 */
const L4_C1_TRIAGE_DELEGATE: EvalTask = {
  id: 'L4-C1',
  level: 'L4',
  title: 'Triage & delegate incoming work',
  prompt:
    'Read CONTEXT.md for your team info and available skills. ' +
    'There are 3 new tasks in `.crewly/tasks/` (open status). ' +
    'Analyze each task, decide which team member should handle it based on ' +
    'their availability and role, and delegate using the delegate-task skill. ' +
    'One of your workers (Max) is inactive — handle that appropriately. ' +
    'Report your triage decisions via report-status.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'bash', 'write_file'],
  tags: ['delegation', 'triage', 'collaboration'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir);

    // 3 tasks with varying complexity
    const tasks = [
      {
        id: 'task-frontend-bug',
        title: 'Fix button alignment on dashboard',
        priority: 'high',
        description: 'The submit button is misaligned on mobile view. Fix CSS in Dashboard.tsx.',
      },
      {
        id: 'task-backend-feature',
        title: 'Add pagination to users API',
        priority: 'medium',
        description: 'Add limit/offset query params to GET /api/users. Update user.service.ts.',
      },
      {
        id: 'task-write-tests',
        title: 'Write tests for data.service.ts',
        priority: 'low',
        description: 'Add unit tests for createRecord and validateRecord in data.service.test.ts.',
      },
    ];

    for (const t of tasks) {
      fs.writeFileSync(
        path.join(workDir, '.crewly', 'tasks', `${t.id}.md`),
        `---\nid: ${t.id}\ntitle: ${t.title}\nstatus: open\nassignee: null\npriority: ${t.priority}\n---\n\n# ${t.title}\n\n${t.description}\n`,
      );
    }
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // Check delegation files exist
    const taskDir = path.join(workDir, '.crewly', 'tasks');
    const delegationFiles = fs.readdirSync(taskDir).filter((f) => f.includes('delegation'));
    const hasDelegations = delegationFiles.length > 0;

    // Check delegation targets — should be Leo (active), not Max (inactive)
    const targets = getDelegationTargets(all);
    const delegatedToActive = targets.length > 0 &&
      targets.every((t) => !t.toLowerCase().includes('max'));
    const delegatedToLeo = targets.some((t) => t.toLowerCase().includes('leo'));

    // Check reports
    const reportsDir = path.join(workDir, '.crewly', 'reports');
    const hasReports = fs.existsSync(reportsDir) &&
      fs.readdirSync(reportsDir).length > 0;

    const checks: EvalCheck[] = [
      {
        name: 'read_context',
        passed: readFile(all, 'CONTEXT.md'),
        message: 'Should read CONTEXT.md first',
      },
      {
        name: 'read_task_files',
        passed: readFile(all, 'task-'),
        message: 'Should read task files',
      },
      {
        name: 'used_delegate_skill',
        passed: usedSkill(all, 'delegate-task'),
        message: 'Should use delegate-task skill',
      },
      {
        name: 'delegations_created',
        passed: hasDelegations,
        message: 'Should create delegation JSON files',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'delegated_to_active_worker',
        passed: delegatedToActive,
        message: 'Should only delegate to active workers (not Max)',
      },
      {
        name: 'delegated_to_leo',
        passed: delegatedToLeo,
        message: 'Should delegate to Leo (the active developer)',
      },
      {
        name: 'report_status_called',
        passed: hasReports || usedSkill(all, 'report-status'),
        message: 'Should report triage decisions via report-status',
      },
      {
        name: 'handled_inactive_worker',
        passed: delegatedToActive,
        message: 'Should handle Max being inactive (not assign to him)',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-C2: Knowledge-Driven Implementation
// ---------------------------------------------------------------------------

/**
 * L4-C2: Read project knowledge, apply patterns, record learnings.
 *
 * Tests: knowledge retrieval, pattern application, memory persistence.
 */
const L4_C2_KNOWLEDGE_DRIVEN: EvalTask = {
  id: 'L4-C2',
  level: 'L4',
  title: 'Knowledge-driven implementation',
  prompt:
    'Read CONTEXT.md. Check `.crewly/knowledge/project-patterns.md` for coding standards. ' +
    'Implement the task described in `.crewly/tasks/task-health-endpoint.md` following ' +
    'the documented patterns. After implementation, record what you learned in ' +
    '`.crewly/knowledge/learnings.md`.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file'],
  tags: ['knowledge', 'pattern-application', 'collaboration'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir);

    // Task file requesting a health endpoint
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-health-endpoint.md'),
      `---\nid: task-health\ntitle: Implement health endpoint\nstatus: open\nassignee: eval-tl-sam\npriority: high\n---\n\n# Implement Health Endpoint\n\nCreate a GET /health endpoint in \`src/controllers/health.controller.ts\`.\n\n## Requirements\n- Export a named function \`healthCheck\`\n- Accept (req, res) parameters\n- Return JSON: \`{ status: "ok", timestamp: Date.now() }\`\n- Follow patterns in \`.crewly/knowledge/project-patterns.md\`\n`,
    );
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    const controllerPath = path.join(workDir, 'src', 'controllers', 'health.controller.ts');
    const controllerExists = fs.existsSync(controllerPath);

    let hasNamedExport = false;
    let hasReqRes = false;
    let hasTryCatch = false;
    let hasJsonResponse = false;

    if (controllerExists) {
      const content = fs.readFileSync(controllerPath, 'utf-8');
      hasNamedExport = /export\s+(async\s+)?function/.test(content);
      hasReqRes = content.includes('req') && content.includes('res');
      hasTryCatch = content.includes('try') && content.includes('catch');
      hasJsonResponse = content.includes('.json(') || content.includes('json');
    }

    const learningsPath = path.join(workDir, '.crewly', 'knowledge', 'learnings.md');
    const learningsExists = fs.existsSync(learningsPath);
    let learningsHasContent = false;
    if (learningsExists) {
      const content = fs.readFileSync(learningsPath, 'utf-8');
      learningsHasContent = content.length > 50;
    }

    const checks: EvalCheck[] = [
      {
        name: 'read_patterns',
        passed: readFile(all, 'project-patterns'),
        message: 'Should read patterns documentation before coding',
      },
      {
        name: 'controller_created',
        passed: controllerExists,
        message: 'health.controller.ts should be created',
      },
      {
        name: 'follows_named_export',
        passed: hasNamedExport,
        message: 'Should use named function export per pattern',
      },
      {
        name: 'follows_req_res',
        passed: hasReqRes,
        message: 'Should accept req/res parameters per pattern',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'follows_try_catch',
        passed: hasTryCatch,
        message: 'Should use try/catch per documented pattern',
      },
      {
        name: 'follows_json_response',
        passed: hasJsonResponse,
        message: 'Should return JSON response per pattern',
      },
      {
        name: 'persisted_learnings',
        passed: learningsExists && learningsHasContent,
        message: 'Should create learnings.md with meaningful content (>50 chars)',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-C3: Fault Detection & Recovery
// ---------------------------------------------------------------------------

/**
 * L4-C3: Detect an inactive worker with an in-progress task, recover.
 *
 * Tests: state reading, failure detection, reassignment, communication.
 */
const L4_C3_FAULT_RECOVERY: EvalTask = {
  id: 'L4-C3',
  level: 'L4',
  title: 'Fault detection & recovery',
  prompt:
    'Read CONTEXT.md. Worker Max was assigned to task-001 but has gone inactive. ' +
    'Investigate the situation: check team status, read the stuck task, and execute ' +
    'a recovery plan using the available skills. Ensure the work is not lost.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'bash', 'write_file'],
  tags: ['fault-recovery', 'resilience', 'collaboration'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir);

    // task-001 assigned to Max (inactive), status: in_progress
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-001.md'),
      `---\nid: task-001\ntitle: Implement user authentication\nstatus: in_progress\nassignee: eval-dev-max\npriority: high\n---\n\n# Implement User Authentication\n\nAdd JWT-based auth to the API. Max started this but went inactive.\n\n## Partial Progress\n- Created auth.service.ts skeleton\n- JWT token generation function stubbed\n`,
    );

    // Max's partial work
    fs.writeFileSync(
      path.join(workDir, 'src', 'services', 'auth.service.ts'),
      `/**\n * Authentication service — PARTIAL IMPLEMENTATION by Max\n * Status: incomplete, worker went inactive\n */\n\nexport interface AuthToken {\n  token: string;\n  expiresAt: number;\n}\n\n// TODO: implement JWT signing\nexport function generateToken(userId: string): AuthToken {\n  throw new Error('Not implemented');\n}\n`,
    );
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // Check if agent detected Max is inactive
    const readTeamConfig = readFile(all, 'team-config') ||
      usedSkill(all, 'get-team-status');

    // Check recovery actions
    const usedHandleFailure = usedSkill(all, 'handle-failure');
    const usedDelegate = usedSkill(all, 'delegate-task');
    const recoveryAction = usedHandleFailure || usedDelegate;

    // Check reassignment — should go to Leo
    const targets = getDelegationTargets(all);
    const reassignedToLeo = targets.some((t) => t.toLowerCase().includes('leo'));

    // Check communication
    const sentMessage = usedSkill(all, 'send-message');
    const recipients = getMessageRecipients(all);
    const messagedLeo = recipients.some((r) => r.toLowerCase().includes('leo'));

    // Check partial work preserved
    const authServicePath = path.join(workDir, 'src', 'services', 'auth.service.ts');
    const partialWorkPreserved = fs.existsSync(authServicePath);

    const checks: EvalCheck[] = [
      {
        name: 'read_context',
        passed: readFile(all, 'CONTEXT.md'),
        message: 'Should read CONTEXT.md',
      },
      {
        name: 'detected_inactive_worker',
        passed: readTeamConfig,
        message: 'Should check team status to detect Max is inactive',
      },
      {
        name: 'read_stuck_task',
        passed: readFile(all, 'task-001'),
        message: 'Should read the stuck task',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'recovery_action_taken',
        passed: recoveryAction,
        message: 'Should use handle-failure or delegate-task for recovery',
      },
      {
        name: 'reassigned_to_leo',
        passed: reassignedToLeo,
        message: 'Should reassign to Leo (the active worker)',
      },
      {
        name: 'preserved_partial_work',
        passed: partialWorkPreserved,
        message: 'Should not delete Max\'s partial implementation',
      },
      {
        name: 'communicated_with_leo',
        passed: sentMessage || messagedLeo,
        message: 'Should send message to Leo about the reassignment',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-C4: Multi-File Coordinated Feature
// ---------------------------------------------------------------------------

/**
 * L4-C4: Implement a complete feature across service, controller, and test,
 * then delegate a code review.
 *
 * Tests: pattern reading, multi-file consistency, cross-file imports, delegation.
 */
const L4_C4_COORDINATED_FEATURE: EvalTask = {
  id: 'L4-C4',
  level: 'L4',
  title: 'Multi-file coordinated feature',
  prompt:
    'Read CONTEXT.md. Read the existing `src/services/data.service.ts` to understand code patterns. ' +
    'Implement a complete "user" feature following the same patterns: ' +
    '1. Create src/services/user.service.ts with UserRecord interface, createUser, and validateUser functions. ' +
    '2. Create src/controllers/user.controller.ts that imports and uses the user service. ' +
    '3. Create src/services/user.service.test.ts with tests for both functions. ' +
    'All files must be consistent with each other (imports match exports, types align). ' +
    'Then delegate a code review of your work to Leo using the delegate-task skill.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'bash'],
  tags: ['multi-file', 'feature', 'coordination', 'collaboration'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    const servicePath = path.join(workDir, 'src', 'services', 'user.service.ts');
    const controllerPath = path.join(workDir, 'src', 'controllers', 'user.controller.ts');
    const testPath = path.join(workDir, 'src', 'services', 'user.service.test.ts');

    const serviceExists = fs.existsSync(servicePath);
    const controllerExists = fs.existsSync(controllerPath);
    const testExists = fs.existsSync(testPath);

    let hasInterface = false;
    let hasCreate = false;
    let hasValidate = false;
    let controllerImportsService = false;
    let testImportsService = false;

    if (serviceExists) {
      const content = fs.readFileSync(servicePath, 'utf-8');
      hasInterface = content.includes('UserRecord') || content.includes('interface');
      hasCreate = content.includes('createUser');
      hasValidate = content.includes('validateUser') || content.includes('validate');
    }

    if (controllerExists) {
      const content = fs.readFileSync(controllerPath, 'utf-8');
      controllerImportsService = content.includes('user.service') || content.includes('user-service');
    }

    if (testExists) {
      const content = fs.readFileSync(testPath, 'utf-8');
      testImportsService = content.includes('user.service') ||
        content.includes('createUser') ||
        content.includes('validateUser');
    }

    // Check delegation for code review
    const delegatedReview = usedSkill(all, 'delegate-task');
    const targets = getDelegationTargets(all);
    const delegatedToLeo = targets.some((t) => t.toLowerCase().includes('leo'));

    const checks: EvalCheck[] = [
      {
        name: 'read_existing_pattern',
        passed: readFile(all, 'data.service'),
        message: 'Should read data.service.ts for patterns',
      },
      {
        name: 'service_created',
        passed: serviceExists,
        message: 'user.service.ts should be created',
      },
      {
        name: 'controller_created',
        passed: controllerExists,
        message: 'user.controller.ts should be created',
      },
      {
        name: 'test_created',
        passed: testExists,
        message: 'user.service.test.ts should be created',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'has_interface',
        passed: hasInterface,
        message: 'Service should define UserRecord interface',
      },
      {
        name: 'has_create_function',
        passed: hasCreate,
        message: 'Service should export createUser function',
      },
      {
        name: 'has_validate_function',
        passed: hasValidate,
        message: 'Service should export validateUser function',
      },
      {
        name: 'cross_file_consistency',
        passed: controllerImportsService && testImportsService,
        message: 'Controller and test should import from user service',
      },
      {
        name: 'delegated_review_to_leo',
        passed: delegatedReview && delegatedToLeo,
        message: 'Should delegate code review to Leo via delegate-task',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-C5: Team Health Assessment & Reporting
// ---------------------------------------------------------------------------

/**
 * L4-C5: Analyze team health, identify problems, produce structured report.
 *
 * Tests: status reading, analytical reasoning, structured output, recommendations.
 */
const L4_C5_TEAM_HEALTH: EvalTask = {
  id: 'L4-C5',
  level: 'L4',
  title: 'Team health assessment & reporting',
  prompt:
    'Read CONTEXT.md. Analyze the current state of your team and project. ' +
    'Check team member statuses, review all pending tasks, and produce a ' +
    'comprehensive health report at `.crewly/reports/team-health.json`. ' +
    'Use get-team-status to confirm live statuses. Make actionable recommendations.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'bash'],
  tags: ['health-check', 'monitoring', 'reporting', 'collaboration'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir);

    // Add a mix of tasks — one stale
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-stale.md'),
      `---\nid: task-stale\ntitle: Fix login bug\nstatus: in_progress\nassignee: eval-dev-max\npriority: high\nupdatedAt: ${staleTime}\n---\n\n# Fix Login Bug\n\nStarted 3 hours ago but no progress. Assigned to Max who is now inactive.\n`,
    );

    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-open-1.md'),
      `---\nid: task-open-1\ntitle: Add search feature\nstatus: open\nassignee: null\npriority: medium\n---\n\n# Add Search Feature\n\nUnassigned task waiting for delegation.\n`,
    );
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // Check get-team-status was used
    const usedGetStatus = usedSkill(all, 'get-team-status');

    // Check report file
    const reportPath = path.join(workDir, '.crewly', 'reports', 'team-health.json');
    const reportExists = fs.existsSync(reportPath);

    let validJson = false;
    let hasActiveList = false;
    let hasInactiveList = false;
    let identifiedMaxInactive = false;
    let hasRecommendations = false;
    let hasHealthStatus = false;
    let identifiedStaleTasks = false;

    if (reportExists) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        validJson = true;
        hasActiveList = Array.isArray(report.activeAgents) && report.activeAgents.length > 0;
        hasInactiveList = Array.isArray(report.inactiveAgents) && report.inactiveAgents.length > 0;
        identifiedMaxInactive = JSON.stringify(report.inactiveAgents ?? []).toLowerCase().includes('max');
        hasRecommendations = Array.isArray(report.recommendations) && report.recommendations.length > 0;
        hasHealthStatus = typeof report.overallHealth === 'string' && report.overallHealth.length > 0;
        // Check if stale tasks identified
        const reportStr = JSON.stringify(report).toLowerCase();
        identifiedStaleTasks = reportStr.includes('stale') || reportStr.includes('stuck') ||
          reportStr.includes('3 hour') || reportStr.includes('login');
      } catch { /* invalid JSON */ }
    }

    const checks: EvalCheck[] = [
      {
        name: 'read_context',
        passed: readFile(all, 'CONTEXT.md'),
        message: 'Should read CONTEXT.md',
      },
      {
        name: 'used_get_team_status',
        passed: usedGetStatus,
        message: 'Should use get-team-status skill',
      },
      {
        name: 'report_created',
        passed: reportExists,
        message: 'team-health.json should be created',
      },
      {
        name: 'valid_json_report',
        passed: validJson,
        message: 'Report should be valid JSON',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'identified_inactive_member',
        passed: identifiedMaxInactive,
        message: 'Should identify Max as inactive',
      },
      {
        name: 'identified_stale_tasks',
        passed: identifiedStaleTasks,
        message: 'Should identify stale/stuck tasks',
      },
      {
        name: 'actionable_recommendations',
        passed: hasRecommendations,
        message: 'Should provide actionable recommendations',
      },
      {
        name: 'overall_health_assessment',
        passed: hasHealthStatus,
        message: 'Should include overall health assessment',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-T1: Broken Project Structure (Trap)
// ---------------------------------------------------------------------------

/**
 * L4-T1: The prompt says `src/` but the actual code is in `source/`.
 *
 * The agent must discover the non-standard structure and adapt.
 * This is NOT mentioned in the prompt — it's a trap.
 */
const L4_T1_BROKEN_STRUCTURE: EvalTask = {
  id: 'L4-T1',
  level: 'L4',
  title: 'Broken project structure (trap)',
  prompt:
    'Read CONTEXT.md. The team needs you to add a logging utility to this project. ' +
    'Create `src/utils/logger.ts` with a structured logger (log, warn, error methods), ' +
    'and `src/utils/logger.test.ts` with tests. Then run `npm test` to verify.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'bash'],
  tags: ['trap', 'self-healing', 'resilience'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    // Use custom setup — the trap is `source/` instead of `src/`
    await setupEvalWorkspace(workDir, DEFAULT_EVAL_TEAM, { skipProjectFiles: true });

    // Create `source/` directory (not `src/`)
    fs.mkdirSync(path.join(workDir, 'source', 'services'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'source', 'utils'), { recursive: true });

    // Existing code in source/ (not src/)
    fs.writeFileSync(
      path.join(workDir, 'source', 'services', 'data.service.ts'),
      `export function getData(): string[] {\n  return ['item1', 'item2'];\n}\n`,
    );

    fs.writeFileSync(
      path.join(workDir, 'source', 'index.ts'),
      `export { getData } from './services/data.service.js';\n`,
    );

    // package.json references source/ not src/
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({
        name: 'eval-project',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc --noEmit',
          test: 'find source -name "*.test.ts" -exec echo "PASS:" {} \\; && echo "All tests passed" && exit 0',
        },
      }, null, 2),
    );

    // tsconfig points to source/
    fs.writeFileSync(
      path.join(workDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          outDir: './dist',
          rootDir: './source',
        },
        include: ['source/**/*.ts'],
      }, null, 2),
    );
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // The agent should discover source/ instead of src/
    // Either: (a) created in source/ to match project, or (b) fixed project to use src/
    const loggerInSource = fs.existsSync(path.join(workDir, 'source', 'utils', 'logger.ts'));
    const loggerInSrc = fs.existsSync(path.join(workDir, 'src', 'utils', 'logger.ts'));
    const loggerCreated = loggerInSource || loggerInSrc;

    const testInSource = fs.existsSync(path.join(workDir, 'source', 'utils', 'logger.test.ts'));
    const testInSrc = fs.existsSync(path.join(workDir, 'src', 'utils', 'logger.test.ts'));
    const testCreated = testInSource || testInSrc;

    // Did agent discover the discrepancy?
    const discoveredStructure =
      readFile(all, 'package.json') ||
      readFile(all, 'tsconfig.json') ||
      readFile(all, 'source/');

    // If created in src/, check if project was fixed too
    let adaptedCorrectly = false;
    if (loggerInSource) {
      // Adapted to existing structure — correct
      adaptedCorrectly = true;
    } else if (loggerInSrc) {
      // Created in src/ — only correct if tsconfig was updated too
      const tsconfig = JSON.parse(fs.readFileSync(path.join(workDir, 'tsconfig.json'), 'utf-8'));
      adaptedCorrectly = tsconfig.include?.some((p: string) => p.includes('src'));
    }

    // Check logger has required methods
    let hasLogMethods = false;
    const loggerPath = loggerInSource
      ? path.join(workDir, 'source', 'utils', 'logger.ts')
      : path.join(workDir, 'src', 'utils', 'logger.ts');
    if (fs.existsSync(loggerPath)) {
      const content = fs.readFileSync(loggerPath, 'utf-8');
      hasLogMethods = content.includes('log') && content.includes('error');
    }

    // Check if npm test was attempted
    const attemptedTest = all.some((tc) => {
      const argsStr = JSON.stringify(tc.args ?? {});
      return argsStr.includes('npm test') || argsStr.includes('npm run test');
    });

    const checks: EvalCheck[] = [
      {
        name: 'logger_created',
        passed: loggerCreated,
        message: 'Logger file should be created',
      },
      {
        name: 'test_created',
        passed: testCreated,
        message: 'Logger test file should be created',
      },
      {
        name: 'has_log_methods',
        passed: hasLogMethods,
        message: 'Logger should have log and error methods',
      },
    ];

    // Self-healing checks go into collaborationChecks — scored via D5/D6
    const collaborationChecks: EvalCheck[] = [
      {
        name: 'discovered_structure_discrepancy',
        passed: discoveredStructure,
        message: 'Should discover source/ vs src/ discrepancy (self-healing)',
      },
      {
        name: 'adapted_to_correct_location',
        passed: adaptedCorrectly,
        message: 'Should place files in correct location or fix project config',
      },
      {
        name: 'attempted_npm_test',
        passed: attemptedTest,
        message: 'Should attempt to run npm test to verify',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-T2: Missing Dependencies & Broken Build (Trap)
// ---------------------------------------------------------------------------

/**
 * L4-T2: Build is broken with multiple hidden issues.
 *
 * The agent must investigate, diagnose, and fix without being told what's wrong.
 */
const L4_T2_BROKEN_BUILD: EvalTask = {
  id: 'L4-T2',
  level: 'L4',
  title: 'Missing dependencies & broken build (trap)',
  prompt:
    'Read CONTEXT.md. A worker reported that the build is broken. ' +
    'Investigate, fix the issues, and verify the build passes. ' +
    'Then report the root causes via report-status.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'bash', 'edit_file'],
  tags: ['trap', 'self-healing', 'debugging'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    await setupEvalWorkspace(workDir, DEFAULT_EVAL_TEAM, { skipProjectFiles: true });

    // Source files with intentional problems
    fs.mkdirSync(path.join(workDir, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'src', 'controllers'), { recursive: true });

    // Problem 1: file imports from non-existent module
    fs.writeFileSync(
      path.join(workDir, 'src', 'services', 'user.service.ts'),
      `import { hashPassword } from './missing-module.js';\n\nexport interface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\nexport function createUser(name: string, email: string): User {\n  return { id: String(Date.now()), name, email };\n}\n\nexport function validateEmail(email: any): boolean {\n  return email.includes('@');\n}\n`,
    );

    // Problem 2: uses `any` with strict mode on
    fs.writeFileSync(
      path.join(workDir, 'src', 'controllers', 'user.controller.ts'),
      `import { createUser, validateEmail } from '../services/user.service.js';\n\nexport function handleCreateUser(req: any, res: any): void {\n  try {\n    const { name, email } = req.body;\n    if (!validateEmail(email)) {\n      res.status(400).json({ error: 'Invalid email' });\n      return;\n    }\n    const user = createUser(name, email);\n    res.json(user);\n  } catch (err) {\n    res.status(500).json({ error: 'Internal error' });\n  }\n}\n`,
    );

    // Problem 3: circular import
    fs.writeFileSync(
      path.join(workDir, 'src', 'index.ts'),
      `import { handleCreateUser } from './controllers/user.controller.js';\nimport { createUser } from './services/user.service.js';\n\nexport { handleCreateUser, createUser };\n`,
    );

    // package.json — no node_modules
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({
        name: 'eval-broken-build',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          'express': '4.21.0',
          'zod': '3.24.0',
        },
        scripts: {
          build: 'tsc --noEmit',
          test: 'echo "tests pass" && exit 0',
        },
      }, null, 2),
    );

    // tsconfig with strict: true
    fs.writeFileSync(
      path.join(workDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }, null, 2),
    );
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // Check if agent attempted the build
    const attemptedBuild = all.some((tc) => {
      const argsStr = JSON.stringify(tc.args ?? {});
      return argsStr.includes('npm run build') || argsStr.includes('tsc');
    });

    // Check fixes
    const userServicePath = path.join(workDir, 'src', 'services', 'user.service.ts');
    const userControllerPath = path.join(workDir, 'src', 'controllers', 'user.controller.ts');

    let fixedMissingImport = false;
    let fixedAnyTypes = false;

    if (fs.existsSync(userServicePath)) {
      const content = fs.readFileSync(userServicePath, 'utf-8');
      // Either removed the import, created the missing file, or changed the import
      fixedMissingImport = !content.includes('missing-module') ||
        fs.existsSync(path.join(workDir, 'src', 'services', 'missing-module.ts'));
      // Check if `any` was replaced in validateEmail
      fixedAnyTypes = !content.includes(': any');
    }

    if (fs.existsSync(userControllerPath)) {
      const controllerContent = fs.readFileSync(userControllerPath, 'utf-8');
      if (!controllerContent.includes(': any')) {
        fixedAnyTypes = true;
      }
    }

    // Check if npm install was attempted (for missing node_modules)
    const attemptedInstall = all.some((tc) => {
      const argsStr = JSON.stringify(tc.args ?? {});
      return argsStr.includes('npm install') || argsStr.includes('npm i');
    });

    // Check report
    const usedReport = usedSkill(all, 'report-status');
    const reportsDir = path.join(workDir, '.crewly', 'reports');
    const hasReport = usedReport || (fs.existsSync(reportsDir) &&
      fs.readdirSync(reportsDir).length > 0);

    // Count issues identified (at least 2 of 4)
    let issuesFound = 0;
    if (fixedMissingImport) issuesFound++;
    if (fixedAnyTypes) issuesFound++;
    if (attemptedInstall) issuesFound++;
    // Check if circular import was noticed (harder to detect)

    const checks: EvalCheck[] = [
      {
        name: 'attempted_build',
        passed: attemptedBuild,
        message: 'Should run or attempt the build to discover failures',
      },
      {
        name: 'fixed_missing_import',
        passed: fixedMissingImport,
        message: 'Should fix the missing-module import',
      },
      {
        name: 'fixed_any_types',
        passed: fixedAnyTypes,
        message: 'Should fix `any` types (strict mode)',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'identified_multiple_issues',
        passed: issuesFound >= 2,
        message: 'Should identify at least 2 of the 4 issues',
      },
      {
        name: 'attempted_npm_install',
        passed: attemptedInstall,
        message: 'Should run npm install for missing node_modules',
      },
      {
        name: 'reported_root_causes',
        passed: hasReport,
        message: 'Should report root causes via report-status',
      },
      {
        name: 'did_not_ignore_errors',
        passed: attemptedBuild && issuesFound > 0,
        message: 'Should not silently ignore build errors',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// L4-T3: Conflicting State & Data Integrity (Trap)
// ---------------------------------------------------------------------------

/**
 * L4-T3: Contradictory task state and malformed config.
 *
 * The agent must handle conflicting data, parse errors, and make
 * reasonable decisions despite inconsistencies.
 */
const L4_T3_CONFLICTING_STATE: EvalTask = {
  id: 'L4-T3',
  level: 'L4',
  title: 'Conflicting state & data integrity (trap)',
  prompt:
    'Read CONTEXT.md. Your orchestrator has asked you to assign task-007 to an ' +
    'available developer. Use delegate-task to make the assignment and update the task status.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'bash', 'write_file'],
  tags: ['trap', 'self-healing', 'data-integrity'],
  multiAgent: true,

  async setup(workDir: string): Promise<void> {
    // Custom team config with traps
    const trapTeam: EvalContextConfig = {
      agentName: 'Sam',
      agentRole: 'Team Lead',
      teamName: 'Eval Product Team',
      teamId: 'eval-team-001',
      members: [
        {
          name: 'Sam',
          role: 'Team Lead',
          sessionName: 'eval-tl-sam',
          agentStatus: 'active',
          workingStatus: 'idle',
        },
        {
          name: 'Leo',
          role: 'Developer',
          sessionName: 'eval-dev-leo',
          agentStatus: 'active',
          workingStatus: 'overloaded',
        },
        {
          name: 'Max',
          role: 'Developer',
          sessionName: 'eval-dev-max',
          agentStatus: 'inactive',
          workingStatus: 'idle',
        },
      ],
    };

    await setupEvalWorkspace(workDir, trapTeam);

    // TRAP 1: task-007.md says "open" but a delegation already exists
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-007.md'),
      `---\nid: task-007\ntitle: Implement caching layer\nstatus: open\nassignee: null\npriority: high\n---\n\n# Implement Caching Layer\n\nAdd Redis caching to frequently accessed endpoints.\n`,
    );

    // Previous delegation to Max (who is now inactive) — contradicts "open" status
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-007-delegation.json'),
      JSON.stringify({
        taskId: 'task-007',
        delegatedTo: 'eval-dev-max',
        task: 'Implement caching layer',
        priority: 'high',
        delegatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        delegatedBy: 'eval-tl-sam',
      }, null, 2),
    );

    // TRAP 2: Duplicate task file with different description
    fs.writeFileSync(
      path.join(workDir, '.crewly', 'tasks', 'task-007-duplicate.md'),
      `---\nid: task-007\ntitle: Implement caching layer v2\nstatus: open\nassignee: null\npriority: medium\n---\n\n# Implement Caching Layer (V2)\n\nUse in-memory cache instead of Redis. Different requirements from task-007.md.\n`,
    );

    // TRAP 3: Malformed team-config.json (trailing comma = invalid JSON)
    const configPath = path.join(workDir, '.crewly', 'teams', 'team-config.json');
    const validConfig = fs.readFileSync(configPath, 'utf-8');
    // Insert trailing comma before the closing brace of the last member
    const malformed = validConfig.replace(
      /("workingStatus":\s*"idle"\s*)\n(\s*}\s*\n\s*\]\s*\n\s*})/,
      '$1,\n$2',
    );
    fs.writeFileSync(configPath, malformed);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const all = getAllToolCalls(workDir, toolCalls);

    // Check if agent discovered the conflicting state
    const readTask007 = readFile(all, 'task-007');
    const readTeamConfig = readFile(all, 'team-config') || usedSkill(all, 'get-team-status');

    // Check delegation — should pick an appropriate worker
    const usedDelegate = usedSkill(all, 'delegate-task');
    const targets = getDelegationTargets(all);

    // Should NOT delegate to Max (inactive) or blindly to overloaded Leo
    const avoidedInactive = !targets.some((t) => t.toLowerCase().includes('max'));
    // Leo is overloaded but is the only active dev — agent should either
    // delegate to Leo with acknowledgment, or note the constraint
    const madeReasonableDecision = usedDelegate || targets.length > 0;

    // Check if agent handled the malformed JSON
    // Evidence: agent read the file and either fixed it, worked around it,
    // or noted the error
    const handledMalformedJson = readTeamConfig; // At minimum tried to read it

    // Check if agent noted the conflicting state
    const reportsDir = path.join(workDir, '.crewly', 'reports');
    const hasReport = (fs.existsSync(reportsDir) && fs.readdirSync(reportsDir).length > 0) ||
      usedSkill(all, 'report-status');

    // Check for evidence of addressing duplicates
    const readDuplicate = readFile(all, 'task-007-duplicate') || readFile(all, 'duplicate');

    const checks: EvalCheck[] = [
      {
        name: 'read_context',
        passed: readFile(all, 'CONTEXT.md'),
        message: 'Should read CONTEXT.md',
      },
      {
        name: 'read_task',
        passed: readTask007,
        message: 'Should read task-007 file(s)',
      },
      {
        name: 'used_delegate_task',
        passed: usedDelegate,
        message: 'Should use delegate-task skill',
      },
    ];

    const collaborationChecks: EvalCheck[] = [
      {
        name: 'handled_conflicting_state',
        passed: readTask007 && readTeamConfig,
        message: 'Should discover conflicting state (open status vs existing delegation)',
      },
      {
        name: 'handled_malformed_json',
        passed: handledMalformedJson,
        message: 'Should handle malformed team-config.json',
      },
      {
        name: 'avoided_inactive_worker',
        passed: avoidedInactive,
        message: 'Should not delegate to Max (inactive)',
      },
      {
        name: 'made_reasonable_decision',
        passed: madeReasonableDecision,
        message: 'Should make a reasonable delegation despite contradictions',
      },
      {
        name: 'reported_inconsistencies',
        passed: hasReport,
        message: 'Should report what inconsistencies were found',
      },
    ];

    return buildVerification(checks, collaborationChecks);
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All L4 evaluation tasks (5 collaboration + 3 trap/resilience) */
export const L4_TASKS: EvalTask[] = [
  L4_C1_TRIAGE_DELEGATE,
  L4_C2_KNOWLEDGE_DRIVEN,
  L4_C3_FAULT_RECOVERY,
  L4_C4_COORDINATED_FEATURE,
  L4_C5_TEAM_HEALTH,
  L4_T1_BROKEN_STRUCTURE,
  L4_T2_BROKEN_BUILD,
  L4_T3_CONFLICTING_STATE,
];
