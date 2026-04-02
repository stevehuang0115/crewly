/**
 * L3 Evaluation Tasks - Complex Reasoning & Planning
 *
 * Four tasks that test an agent's ability to perform multi-step
 * reasoning, architectural analysis, cross-file refactoring, and
 * error diagnosis requiring deeper understanding of code semantics.
 *
 * @module eval/tasks/l3-tasks
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
 * @param toolName  - tool name substring to match (case-insensitive)
 * @returns true if the tool was used
 */
function usedTool(toolCalls: ToolCallRecord[], toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return toolCalls.some((tc) => tc.toolName.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Complex project fixture
// ---------------------------------------------------------------------------

/**
 * Create a project with architectural issues that require analysis.
 *
 * @param workDir - destination directory
 */
async function createComplexProject(workDir: string): Promise<void> {
  const dirs = [
    'src/services',
    'src/controllers',
    'src/models',
    'src/middleware',
    'src/utils',
    'src/types',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(workDir, d), { recursive: true });
  }

  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify(
      {
        name: 'eval-complex-project',
        version: '1.0.0',
        type: 'module',
        scripts: {
          build: 'tsc --noEmit',
          test: 'echo "6 passing" && exit 0',
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

  // Types with circular dependency potential
  fs.writeFileSync(
    path.join(workDir, 'src', 'types', 'index.ts'),
    `/**
 * Core type definitions.
 */
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'viewer';
  createdAt: Date;
}

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered';
}

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}
`,
  );

  // Service with multiple issues: god class, mixed concerns
  fs.writeFileSync(
    path.join(workDir, 'src', 'services', 'app.service.ts'),
    `/**
 * God service that handles too many concerns.
 * This is intentionally bad architecture for evaluation.
 */
import type { User, Order, ApiResponse } from '../types/index.js';

export class AppService {
  private users: Map<string, User> = new Map();
  private orders: Map<string, Order> = new Map();
  private cache: Map<string, unknown> = new Map();
  private logs: string[] = [];

  // User operations
  createUser(name: string, email: string): User {
    const user: User = {
      id: \`usr_\${Date.now()}\`,
      name,
      email,
      role: 'user',
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.log(\`Created user \${user.id}\`);
    return user;
  }

  getUser(id: string): User | undefined {
    const cached = this.cache.get(\`user:\${id}\`) as User | undefined;
    if (cached) return cached;
    const user = this.users.get(id);
    if (user) this.cache.set(\`user:\${id}\`, user);
    return user;
  }

  // Order operations
  createOrder(userId: string, items: { productId: string; quantity: number; price: number }[]): Order {
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order: Order = {
      id: \`ord_\${Date.now()}\`,
      userId,
      items,
      total,
      status: 'pending',
    };
    this.orders.set(order.id, order);
    this.log(\`Created order \${order.id}\`);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }

  // Validation (mixed in with business logic)
  validateEmail(email: string): boolean {
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
  }

  validateOrderTotal(items: { price: number; quantity: number }[]): boolean {
    return items.every(i => i.price > 0 && i.quantity > 0);
  }

  // Logging (should be separate)
  private log(message: string): void {
    this.logs.push(\`[\${new Date().toISOString()}] \${message}\`);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  // Cache management (should be separate)
  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  // Response formatting (should be separate utility)
  formatResponse<T>(data: T): ApiResponse<T> {
    return {
      success: true,
      data,
      timestamp: Date.now(),
    };
  }

  formatError(error: string): ApiResponse<never> {
    return {
      success: false,
      error,
      timestamp: Date.now(),
    };
  }
}
`,
  );

  // Controller with error handling issues
  fs.writeFileSync(
    path.join(workDir, 'src', 'controllers', 'api.controller.ts'),
    `/**
 * API Controller with error handling issues.
 */
import { AppService } from '../services/app.service.js';

const appService = new AppService();

export function createUser(name: string, email: string) {
  // No validation, no error handling
  const user = appService.createUser(name, email);
  return appService.formatResponse(user);
}

export function getUser(id: string) {
  // No null check
  const user = appService.getUser(id);
  return appService.formatResponse(user);
}

export function createOrder(userId: string, items: any[]) {
  // Uses any type, no validation
  const order = appService.createOrder(userId, items);
  return appService.formatResponse(order);
}
`,
  );

  // Middleware with hardcoded values
  fs.writeFileSync(
    path.join(workDir, 'src', 'middleware', 'auth.middleware.ts'),
    `/**
 * Auth middleware with hardcoded secret and magic numbers.
 */
export function authenticate(token: string): boolean {
  // Hardcoded secret key
  const SECRET = 'super-secret-key-12345';
  // Magic number: token must be longer than 20 chars
  if (token.length < 20) return false;
  // Simplified validation
  return token.startsWith('Bearer ');
}

export function rateLimit(requestCount: number): boolean {
  // Magic number: 100 requests per minute
  return requestCount <= 100;
}
`,
  );
}

// ---------------------------------------------------------------------------
// L3-01: Architecture Analysis
// ---------------------------------------------------------------------------

/**
 * L3-01: Analyze a god class and produce a refactoring plan.
 *
 * Tests: reading multiple files, identifying code smells,
 * producing a structured analysis document.
 */
const L3_01_ARCHITECTURE_ANALYSIS: EvalTask = {
  id: 'L3-01',
  level: 'L3',
  title: 'Analyze god class and produce refactoring plan',
  prompt:
    'Read all source files in this project (src/). Analyze src/services/app.service.ts — ' +
    'it\'s a god class that mixes user operations, order operations, validation, logging, ' +
    'caching, and response formatting. Create a file REFACTORING_PLAN.md at the project root ' +
    'that includes:\n' +
    '1. A list of identified code smells (at least 3)\n' +
    '2. A proposed service decomposition (which files to create)\n' +
    '3. For each new service: name, responsibility, methods to move\n' +
    '4. Migration steps (order of refactoring to avoid breaks)\n' +
    '5. Risk assessment for the refactoring',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'glob_files'],
  tags: ['architecture', 'analysis', 'refactoring', 'planning'],

  async setup(workDir: string): Promise<void> {
    await createComplexProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const planPath = path.join(workDir, 'REFACTORING_PLAN.md');
    const planExists = fs.existsSync(planPath);

    let hasCodeSmells = false;
    let hasDecomposition = false;
    let hasMigrationSteps = false;
    let hasRiskAssessment = false;
    let sufficientLength = false;

    if (planExists) {
      const content = fs.readFileSync(planPath, 'utf-8').toLowerCase();
      sufficientLength = content.length > 300;
      hasCodeSmells =
        (content.includes('smell') || content.includes('issue') || content.includes('problem')) &&
        (content.includes('god') || content.includes('single responsibility') || content.includes('mixed'));
      hasDecomposition =
        (content.includes('user') && content.includes('order')) ||
        content.includes('decompos') ||
        content.includes('split') ||
        content.includes('separate');
      hasMigrationSteps =
        content.includes('step') || content.includes('migration') || content.includes('order');
      hasRiskAssessment =
        content.includes('risk') || content.includes('concern') || content.includes('careful');
    }

    const readMultipleFiles = toolCalls.filter((tc) =>
      tc.toolName.toLowerCase().includes('read'),
    ).length >= 2;

    const checks: EvalCheck[] = [
      {
        name: 'read_multiple_files',
        passed: readMultipleFiles,
        message: 'Should read multiple source files for analysis',
      },
      {
        name: 'plan_created',
        passed: planExists,
        message: 'REFACTORING_PLAN.md should be created',
      },
      {
        name: 'sufficient_analysis',
        passed: sufficientLength,
        message: 'Plan should be substantive (300+ chars)',
      },
      {
        name: 'identifies_code_smells',
        passed: hasCodeSmells,
        message: 'Should identify code smells in the god class',
      },
      {
        name: 'proposes_decomposition',
        passed: hasDecomposition,
        message: 'Should propose service decomposition',
      },
      {
        name: 'has_migration_steps',
        passed: hasMigrationSteps,
        message: 'Should include migration steps',
      },
      {
        name: 'has_risk_assessment',
        passed: hasRiskAssessment,
        message: 'Should include risk assessment',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L3-02: Cross-File Refactoring
// ---------------------------------------------------------------------------

/**
 * L3-02: Extract validation logic from the god class into a separate
 * module and update all consumers.
 *
 * Tests: understanding dependencies, safe extraction, maintaining
 * consistency across files.
 */
const L3_02_CROSS_FILE_REFACTOR: EvalTask = {
  id: 'L3-02',
  level: 'L3',
  title: 'Extract validation into separate module',
  prompt:
    'Read the codebase. Extract the validation methods (validateEmail, validateOrderTotal) ' +
    'from src/services/app.service.ts into a new file src/utils/validators.ts. ' +
    'Remove these methods from app.service.ts. Update src/controllers/api.controller.ts ' +
    'to import validators directly and add input validation before creating users/orders.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'edit_file'],
  tags: ['refactoring', 'extraction', 'cross-file'],

  async setup(workDir: string): Promise<void> {
    await createComplexProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const validatorPath = path.join(workDir, 'src', 'utils', 'validators.ts');
    const validatorExists = fs.existsSync(validatorPath);

    let hasEmailValidator = false;
    let hasOrderValidator = false;

    if (validatorExists) {
      const content = fs.readFileSync(validatorPath, 'utf-8');
      hasEmailValidator = content.includes('validateEmail') && content.includes('export');
      hasOrderValidator = content.includes('validateOrderTotal') || content.includes('validateOrder');
    }

    // Check app.service.ts no longer has validation
    const servicePath = path.join(workDir, 'src', 'services', 'app.service.ts');
    let validationRemoved = false;
    if (fs.existsSync(servicePath)) {
      const content = fs.readFileSync(servicePath, 'utf-8');
      // Either removed entirely or method bodies are gone
      validationRemoved =
        !content.includes('validateEmail') || content.includes('import');
    }

    // Check controller imports validators
    const controllerPath = path.join(workDir, 'src', 'controllers', 'api.controller.ts');
    let controllerImportsValidators = false;
    let controllerUsesValidation = false;
    if (fs.existsSync(controllerPath)) {
      const content = fs.readFileSync(controllerPath, 'utf-8');
      controllerImportsValidators =
        content.includes('validator') || content.includes('validate');
      controllerUsesValidation =
        content.includes('validateEmail') ||
        content.includes('validateOrder') ||
        content.includes('if (');
    }

    const checks: EvalCheck[] = [
      {
        name: 'read_source_files',
        passed: usedTool(toolCalls, 'read'),
        message: 'Should read existing source files',
      },
      {
        name: 'validators_file_created',
        passed: validatorExists,
        message: 'src/utils/validators.ts should be created',
      },
      {
        name: 'has_email_validator',
        passed: hasEmailValidator,
        message: 'Validators should export validateEmail',
      },
      {
        name: 'has_order_validator',
        passed: hasOrderValidator,
        message: 'Validators should export validateOrderTotal',
      },
      {
        name: 'validation_removed_from_service',
        passed: validationRemoved,
        message: 'Validation methods should be removed from app.service.ts',
      },
      {
        name: 'controller_uses_validators',
        passed: controllerImportsValidators && controllerUsesValidation,
        message: 'Controller should import and use validators',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L3-03: Security Audit
// ---------------------------------------------------------------------------

/**
 * L3-03: Find security issues in the codebase and produce a report.
 *
 * Tests: reading code for security patterns, identifying hardcoded
 * secrets, producing actionable findings.
 */
const L3_03_SECURITY_AUDIT: EvalTask = {
  id: 'L3-03',
  level: 'L3',
  title: 'Security audit: find and report vulnerabilities',
  prompt:
    'Perform a security audit of this project. Read all files in src/ and identify security issues. ' +
    'Create SECURITY_AUDIT.md at the project root with:\n' +
    '1. Critical findings (hardcoded secrets, auth issues)\n' +
    '2. Medium findings (input validation, type safety)\n' +
    '3. For each finding: file, line/area, description, severity, recommended fix\n' +
    '4. Overall security score (1-10) with justification\n' +
    'Focus especially on: src/middleware/auth.middleware.ts and src/controllers/api.controller.ts.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'write_file', 'glob_files', 'grep_search'],
  tags: ['security', 'audit', 'analysis'],

  async setup(workDir: string): Promise<void> {
    await createComplexProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const auditPath = path.join(workDir, 'SECURITY_AUDIT.md');
    const auditExists = fs.existsSync(auditPath);

    let foundHardcodedSecret = false;
    let foundMissingValidation = false;
    let foundAnyType = false;
    let hasSeverity = false;
    let hasRecommendations = false;
    let sufficientLength = false;

    if (auditExists) {
      const content = fs.readFileSync(auditPath, 'utf-8').toLowerCase();
      sufficientLength = content.length > 300;
      foundHardcodedSecret =
        content.includes('hardcoded') ||
        content.includes('secret') ||
        content.includes('key');
      foundMissingValidation =
        content.includes('validation') ||
        content.includes('input') ||
        content.includes('sanitiz');
      foundAnyType =
        content.includes('any') || content.includes('type safety');
      hasSeverity =
        content.includes('critical') ||
        content.includes('high') ||
        content.includes('medium') ||
        content.includes('severity');
      hasRecommendations =
        content.includes('recommend') ||
        content.includes('fix') ||
        content.includes('should');
    }

    const readMultipleFiles = toolCalls.filter((tc) =>
      tc.toolName.toLowerCase().includes('read'),
    ).length >= 2;

    const checks: EvalCheck[] = [
      {
        name: 'read_multiple_files',
        passed: readMultipleFiles,
        message: 'Should read multiple files for audit',
      },
      {
        name: 'audit_created',
        passed: auditExists,
        message: 'SECURITY_AUDIT.md should be created',
      },
      {
        name: 'sufficient_analysis',
        passed: sufficientLength,
        message: 'Audit should be substantive (300+ chars)',
      },
      {
        name: 'found_hardcoded_secret',
        passed: foundHardcodedSecret,
        message: 'Should identify the hardcoded secret key',
      },
      {
        name: 'found_missing_validation',
        passed: foundMissingValidation,
        message: 'Should identify missing input validation',
      },
      {
        name: 'has_severity_levels',
        passed: hasSeverity,
        message: 'Should categorize findings by severity',
      },
      {
        name: 'has_recommendations',
        passed: hasRecommendations,
        message: 'Should provide fix recommendations',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L3-04: Error Handling Improvement
// ---------------------------------------------------------------------------

/**
 * L3-04: Add proper error handling to the API controller.
 *
 * Tests: understanding existing code, adding try/catch, null checks,
 * type narrowing, consistent error responses.
 */
const L3_04_ERROR_HANDLING: EvalTask = {
  id: 'L3-04',
  level: 'L3',
  title: 'Add proper error handling to API controller',
  prompt:
    'Read src/controllers/api.controller.ts and src/services/app.service.ts. ' +
    'The controller lacks error handling. Fix it:\n' +
    '1. Add input validation for createUser (check name and email are non-empty strings)\n' +
    '2. Add null check for getUser (return error response if user not found)\n' +
    '3. Remove the `any` type in createOrder and add proper typing\n' +
    '4. Wrap all operations in try/catch with formatError responses\n' +
    '5. Remove the module-level AppService instance — accept it as a parameter or use dependency injection',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read_file', 'edit_file'],
  tags: ['error-handling', 'type-safety', 'controller'],

  async setup(workDir: string): Promise<void> {
    await createComplexProject(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const controllerPath = path.join(workDir, 'src', 'controllers', 'api.controller.ts');
    let content = '';

    if (fs.existsSync(controllerPath)) {
      content = fs.readFileSync(controllerPath, 'utf-8');
    }

    const hasInputValidation =
      content.includes('if (') &&
      (content.includes('name') || content.includes('email'));
    const hasNullCheck =
      content.includes('!user') ||
      content.includes('undefined') ||
      content.includes('not found') ||
      content.includes('null');
    const noAnyType = !content.includes(': any') && !content.includes(':any');
    const hasTryCatch = content.includes('try') && content.includes('catch');
    const hasErrorResponse =
      content.includes('formatError') || content.includes('error');

    const checks: EvalCheck[] = [
      {
        name: 'read_source',
        passed: usedTool(toolCalls, 'read'),
        message: 'Should read the controller and service files',
      },
      {
        name: 'used_edit',
        passed: usedTool(toolCalls, 'edit'),
        message: 'Should use edit to modify the controller',
      },
      {
        name: 'has_input_validation',
        passed: hasInputValidation,
        message: 'Should add input validation for createUser',
      },
      {
        name: 'has_null_check',
        passed: hasNullCheck,
        message: 'Should add null check for getUser',
      },
      {
        name: 'no_any_type',
        passed: noAnyType,
        message: 'Should remove all `any` types',
      },
      {
        name: 'has_try_catch',
        passed: hasTryCatch,
        message: 'Should wrap operations in try/catch',
      },
      {
        name: 'has_error_responses',
        passed: hasErrorResponse,
        message: 'Should use formatError for error responses',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All L3 evaluation tasks */
export const L3_TASKS: EvalTask[] = [
  L3_01_ARCHITECTURE_ANALYSIS,
  L3_02_CROSS_FILE_REFACTOR,
  L3_03_SECURITY_AUDIT,
  L3_04_ERROR_HANDLING,
];
