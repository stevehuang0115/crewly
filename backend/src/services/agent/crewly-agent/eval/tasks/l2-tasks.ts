/**
 * L2 Evaluation Tasks - Multi-Step Workflows
 *
 * Five tasks that test an agent's ability to chain multiple tools
 * together to complete realistic development workflows:
 * read-then-edit, test-and-fix, multi-file refactor, git workflow,
 * and dependency analysis.
 *
 * @module eval/tasks/l2-tasks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import type { ToolCallRecord } from '../../types.js';
import type { EvalCheck, EvalTask, EvalVerification } from '../eval-types.js';
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_STEPS } from '../eval-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link EvalVerification} from a list of checks.
 *
 * @param checks - individual check results
 * @returns assembled verification (passes only if all checks pass)
 */
function buildVerification(checks: EvalCheck[]): EvalVerification {
  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Check whether at least one tool call used the specified tool name.
 *
 * @param toolCalls - recorded tool calls
 * @param toolName  - expected tool name (case-insensitive match)
 * @returns true if the tool was used
 */
function usedTool(toolCalls: ToolCallRecord[], toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return toolCalls.some((tc) => tc.toolName.toLowerCase().includes(lower));
}

/**
 * Count how many distinct tool types were used.
 *
 * @param toolCalls - recorded tool calls
 * @returns number of unique tool names
 */
function uniqueToolCount(toolCalls: ToolCallRecord[]): number {
  return new Set(toolCalls.map((tc) => tc.toolName)).size;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal TypeScript project with a deliberate bug.
 *
 * @param workDir - destination directory
 */
async function createBuggyProject(workDir: string): Promise<void> {
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify(
      {
        name: 'eval-buggy-project',
        version: '1.0.0',
        type: 'module',
        scripts: {
          build: 'tsc --noEmit',
          test: 'echo "Tests: 1 passed" && exit 0',
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(workDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          outDir: 'dist',
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
  );

  // Buggy file: missing return type, type mismatch
  fs.writeFileSync(
    path.join(workDir, 'src', 'calculator.ts'),
    `/**
 * Calculator module with deliberate bugs.
 */

export interface CalcResult {
  value: number;
  operation: string;
}

export function add(a: number, b: number) {
  return { value: a + b, operation: 'add' };
}

export function divide(a: number, b: number): CalcResult {
  // Bug: returns string instead of number when dividing by zero
  if (b === 0) {
    return { value: 'Infinity' as any, operation: 'divide' };
  }
  return { value: a / b, operation: 'divide' };
}

export function multiply(a: number, b: string): CalcResult {
  // Bug: b should be number, not string
  return { value: a * (b as any), operation: 'multiply' };
}
`,
  );

  fs.writeFileSync(
    path.join(workDir, 'src', 'utils.ts'),
    `/**
 * Utility functions.
 */
export function formatResult(result: { value: number; operation: string }): string {
  return \`\${result.operation}: \${result.value}\`;
}

export function isPositive(n: number): boolean {
  return n > 0;
}
`,
  );
}

/**
 * Create a multi-file project for refactoring tasks.
 *
 * @param workDir - destination directory
 */
async function createMultiFileProject(workDir: string): Promise<void> {
  const dirs = ['src', 'src/services', 'src/controllers', 'src/utils'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(workDir, d), { recursive: true });
  }

  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify(
      { name: 'eval-multifile', version: '1.0.0', type: 'module' },
      null,
      2,
    ),
  );

  // Service with hardcoded values
  fs.writeFileSync(
    path.join(workDir, 'src', 'services', 'user.service.ts'),
    `/**
 * User service with hardcoded config values.
 */
export class UserService {
  private apiUrl = 'http://localhost:3000';
  private timeout = 5000;
  private maxRetries = 3;

  async getUser(id: string): Promise<{ id: string; name: string }> {
    const response = await fetch(\`\${this.apiUrl}/users/\${id}\`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    return response.json() as Promise<{ id: string; name: string }>;
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }
}
`,
  );

  // Controller with duplicate logic
  fs.writeFileSync(
    path.join(workDir, 'src', 'controllers', 'user.controller.ts'),
    `/**
 * User controller with duplicate validation logic.
 */
export class UserController {
  async handleGetUser(userId: string): Promise<{ valid: boolean; data?: unknown }> {
    // Duplicate validation (same pattern in order.controller.ts)
    if (!userId || userId.length < 3) {
      return { valid: false };
    }
    if (!/^[a-zA-Z0-9]+$/.test(userId)) {
      return { valid: false };
    }
    return { valid: true, data: { id: userId } };
  }
}
`,
  );

  fs.writeFileSync(
    path.join(workDir, 'src', 'controllers', 'order.controller.ts'),
    `/**
 * Order controller with duplicate validation logic.
 */
export class OrderController {
  async handleGetOrder(orderId: string): Promise<{ valid: boolean; data?: unknown }> {
    // Duplicate validation (same pattern in user.controller.ts)
    if (!orderId || orderId.length < 3) {
      return { valid: false };
    }
    if (!/^[a-zA-Z0-9]+$/.test(orderId)) {
      return { valid: false };
    }
    return { valid: true, data: { id: orderId } };
  }
}
`,
  );
}

// ---------------------------------------------------------------------------
// L2-01: Read-Analyze-Fix Bug
// ---------------------------------------------------------------------------

/**
 * L2-01: Find and fix type errors in a TypeScript project.
 *
 * Tests multi-step: read files → identify bugs → edit to fix → verify.
 */
const L2_01_FIX_TYPE_ERRORS: EvalTask = {
  id: 'L2-01',
  level: 'L2',
  title: 'Find and fix TypeScript type errors',
  prompt:
    'This project has TypeScript type errors in src/calculator.ts. Read the code, identify all type issues, and fix them. The multiply function parameter b should be number, and the divide function should not use `as any`. Make the code type-safe.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'edit_file'],
  tags: ['typescript', 'bug-fix', 'multi-step'],

  async setup(workDir: string): Promise<void> {
    await createBuggyProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const calcPath = path.join(workDir, 'src', 'calculator.ts');
    let content = '';
    let noAny = false;
    let multiplyFixed = false;
    let divideFixed = false;

    if (fs.existsSync(calcPath)) {
      content = fs.readFileSync(calcPath, 'utf-8');
      noAny = !content.includes('as any');
      multiplyFixed = /multiply\s*\(\s*a\s*:\s*number\s*,\s*b\s*:\s*number\s*\)/.test(content);
      divideFixed = !content.includes("'Infinity' as any");
    }

    const checks: EvalCheck[] = [
      {
        name: 'used_read_file',
        passed: usedTool(toolCalls, 'read'),
        message: 'Agent should read the source file first',
      },
      {
        name: 'used_edit_file',
        passed: usedTool(toolCalls, 'edit'),
        message: 'Agent should use edit to fix the code',
      },
      {
        name: 'no_as_any',
        passed: noAny,
        message: 'No `as any` casts should remain',
      },
      {
        name: 'multiply_param_fixed',
        passed: multiplyFixed,
        message: 'multiply() b parameter should be number',
      },
      {
        name: 'divide_fixed',
        passed: divideFixed,
        message: 'divide() should not cast Infinity to any',
      },
      {
        name: 'multi_tool_usage',
        passed: uniqueToolCount(toolCalls) >= 2,
        message: 'Should use at least 2 different tools',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L2-02: Extract Shared Validation
// ---------------------------------------------------------------------------

/**
 * L2-02: Extract duplicate validation logic into a shared utility.
 *
 * Tests multi-step: read multiple files → identify duplication → create
 * shared module → update consumers.
 */
const L2_02_EXTRACT_SHARED: EvalTask = {
  id: 'L2-02',
  level: 'L2',
  title: 'Extract duplicate validation into shared utility',
  prompt:
    'Read the controllers in src/controllers/. Both user.controller.ts and order.controller.ts have identical ID validation logic. Extract this into a shared function in src/utils/validation.ts, then update both controllers to use it.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'edit_file'],
  tags: ['refactor', 'duplication', 'multi-file'],

  async setup(workDir: string): Promise<void> {
    await createMultiFileProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const validationPath = path.join(workDir, 'src', 'utils', 'validation.ts');
    const validationExists = fs.existsSync(validationPath);

    let hasValidateFunction = false;
    if (validationExists) {
      const content = fs.readFileSync(validationPath, 'utf-8');
      hasValidateFunction = content.includes('export') && content.includes('valid');
    }

    // Check controllers import from the shared module
    const userCtrlPath = path.join(workDir, 'src', 'controllers', 'user.controller.ts');
    const orderCtrlPath = path.join(workDir, 'src', 'controllers', 'order.controller.ts');
    let userImports = false;
    let orderImports = false;

    if (fs.existsSync(userCtrlPath)) {
      const content = fs.readFileSync(userCtrlPath, 'utf-8');
      userImports = content.includes('validation') || content.includes('validate');
    }
    if (fs.existsSync(orderCtrlPath)) {
      const content = fs.readFileSync(orderCtrlPath, 'utf-8');
      orderImports = content.includes('validation') || content.includes('validate');
    }

    const checks: EvalCheck[] = [
      {
        name: 'validation_file_created',
        passed: validationExists,
        message: 'src/utils/validation.ts should be created',
      },
      {
        name: 'has_validate_function',
        passed: hasValidateFunction,
        message: 'Validation file should export a validate function',
      },
      {
        name: 'user_controller_updated',
        passed: userImports,
        message: 'user.controller.ts should import from shared validation',
      },
      {
        name: 'order_controller_updated',
        passed: orderImports,
        message: 'order.controller.ts should import from shared validation',
      },
      {
        name: 'multi_tool_usage',
        passed: uniqueToolCount(toolCalls) >= 2,
        message: 'Should use at least 2 different tools (read + write/edit)',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L2-03: Git Commit Workflow
// ---------------------------------------------------------------------------

/**
 * L2-03: Create a feature branch, add a file, and commit.
 *
 * Tests multi-step: bash commands chained for a realistic git workflow.
 */
const L2_03_GIT_WORKFLOW: EvalTask = {
  id: 'L2-03',
  level: 'L2',
  title: 'Create feature branch, add file, commit',
  prompt:
    'Create a new git branch called "feat/greeting", create a file src/greeting.ts that exports a greet function, add it to git staging, and commit with message "feat: add greeting module".',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['bash_exec', 'write_file'],
  tags: ['git', 'workflow', 'multi-step'],

  async setup(workDir: string): Promise<void> {
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'eval-git-workflow', version: '1.0.0' }, null, 2),
    );
    execSync('git init && git add -A && git commit -m "init"', {
      cwd: workDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'eval',
        GIT_AUTHOR_EMAIL: 'e@t.l',
        GIT_COMMITTER_NAME: 'eval',
        GIT_COMMITTER_EMAIL: 'e@t.l',
      },
    });
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    let branchCreated = false;
    let fileExists = false;
    let commitExists = false;

    try {
      const branch = execSync('git branch --show-current', {
        cwd: workDir,
        encoding: 'utf-8',
      }).trim();
      branchCreated = branch === 'feat/greeting';
    } catch { /* */ }

    fileExists = fs.existsSync(path.join(workDir, 'src', 'greeting.ts'));

    try {
      const log = execSync('git log --oneline -1', {
        cwd: workDir,
        encoding: 'utf-8',
      }).trim();
      commitExists = log.includes('greeting');
    } catch { /* */ }

    const checks: EvalCheck[] = [
      {
        name: 'branch_created',
        passed: branchCreated,
        message: 'Should be on feat/greeting branch',
      },
      {
        name: 'file_created',
        passed: fileExists,
        message: 'src/greeting.ts should exist',
      },
      {
        name: 'commit_made',
        passed: commitExists,
        message: 'Commit with greeting message should exist',
      },
      {
        name: 'used_bash',
        passed: usedTool(toolCalls, 'bash'),
        message: 'Should use bash for git commands',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L2-04: Config Extraction
// ---------------------------------------------------------------------------

/**
 * L2-04: Extract hardcoded config values into a constants file.
 *
 * Tests multi-step: read → identify hardcoded values → create config
 * file → update source.
 */
const L2_04_CONFIG_EXTRACTION: EvalTask = {
  id: 'L2-04',
  level: 'L2',
  title: 'Extract hardcoded config into constants file',
  prompt:
    'Read src/services/user.service.ts. Extract all hardcoded configuration values (API URL, timeout, max retries) into a new file src/config.ts with named exports. Update user.service.ts to import from config.ts instead of using inline values.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'edit_file'],
  tags: ['refactor', 'config', 'multi-step'],

  async setup(workDir: string): Promise<void> {
    await createMultiFileProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const configPath = path.join(workDir, 'src', 'config.ts');
    const configExists = fs.existsSync(configPath);

    let hasApiUrl = false;
    let hasTimeout = false;
    let hasRetries = false;

    if (configExists) {
      const content = fs.readFileSync(configPath, 'utf-8');
      hasApiUrl =
        content.includes('apiUrl') ||
        content.includes('API_URL') ||
        content.includes('baseUrl') ||
        content.includes('BASE_URL');
      hasTimeout =
        content.includes('timeout') || content.includes('TIMEOUT');
      hasRetries =
        content.includes('retries') || content.includes('RETRIES') || content.includes('MAX_RETRIES');
    }

    // Check service uses imports instead of hardcoded values
    const servicePath = path.join(workDir, 'src', 'services', 'user.service.ts');
    let serviceImportsConfig = false;
    if (fs.existsSync(servicePath)) {
      const content = fs.readFileSync(servicePath, 'utf-8');
      serviceImportsConfig = content.includes('config') || content.includes('CONFIG');
    }

    const checks: EvalCheck[] = [
      {
        name: 'config_file_created',
        passed: configExists,
        message: 'src/config.ts should be created',
      },
      {
        name: 'has_api_url',
        passed: hasApiUrl,
        message: 'Config should contain API URL constant',
      },
      {
        name: 'has_timeout',
        passed: hasTimeout,
        message: 'Config should contain timeout constant',
      },
      {
        name: 'has_retries',
        passed: hasRetries,
        message: 'Config should contain max retries constant',
      },
      {
        name: 'service_updated',
        passed: serviceImportsConfig,
        message: 'User service should import from config',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L2-05: Add Tests for Existing Code
// ---------------------------------------------------------------------------

/**
 * L2-05: Write unit tests for existing functions.
 *
 * Tests multi-step: read source → understand API → write test file.
 */
const L2_05_WRITE_TESTS: EvalTask = {
  id: 'L2-05',
  level: 'L2',
  title: 'Write unit tests for calculator module',
  prompt:
    'Read src/utils.ts and write a test file src/utils.test.ts with unit tests for formatResult() and isPositive(). Cover at least: normal inputs, edge cases (zero, negative numbers), and the format string output.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file'],
  tags: ['testing', 'unit-test', 'multi-step'],

  async setup(workDir: string): Promise<void> {
    await createBuggyProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const testPath = path.join(workDir, 'src', 'utils.test.ts');
    const testExists = fs.existsSync(testPath);

    let importsSource = false;
    let hasDescribe = false;
    let hasMultipleTests = false;
    let coversEdgeCases = false;

    if (testExists) {
      const content = fs.readFileSync(testPath, 'utf-8');
      importsSource = content.includes('utils') || content.includes('formatResult') || content.includes('isPositive');
      hasDescribe = content.includes('describe') || content.includes('test') || content.includes('it(');
      // Count test/it blocks
      const testCount = (content.match(/\b(test|it)\s*\(/g) || []).length;
      hasMultipleTests = testCount >= 3;
      coversEdgeCases =
        content.includes('0') ||
        content.includes('negative') ||
        content.includes('-1') ||
        content.includes('zero');
    }

    const checks: EvalCheck[] = [
      {
        name: 'test_file_created',
        passed: testExists,
        message: 'src/utils.test.ts should exist',
      },
      {
        name: 'imports_source',
        passed: importsSource,
        message: 'Test file should import from utils',
      },
      {
        name: 'has_test_structure',
        passed: hasDescribe,
        message: 'Should use describe/test/it blocks',
      },
      {
        name: 'multiple_tests',
        passed: hasMultipleTests,
        message: 'Should have at least 3 test cases',
      },
      {
        name: 'covers_edge_cases',
        passed: coversEdgeCases,
        message: 'Should test edge cases (zero, negative)',
      },
      {
        name: 'used_read_then_write',
        passed: usedTool(toolCalls, 'read') && usedTool(toolCalls, 'write'),
        message: 'Should read source before writing tests',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All L2 evaluation tasks */
export const L2_TASKS: EvalTask[] = [
  L2_01_FIX_TYPE_ERRORS,
  L2_02_EXTRACT_SHARED,
  L2_03_GIT_WORKFLOW,
  L2_04_CONFIG_EXTRACTION,
  L2_05_WRITE_TESTS,
];
