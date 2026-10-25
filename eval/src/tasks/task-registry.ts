/**
 * Task registry — defines all benchmark tasks for the eval runner.
 * Each task is a self-contained unit: description, setup, fixture injection, and verification.
 *
 * Task naming convention:
 * - A* = bug_fix tasks
 * - B* = feature tasks
 * - C* = refactor tasks
 */

import type { EvalTask } from '../types/eval.types.js';

/**
 * A1: TypeScript Bug Fix — Fix broken type exports in a shared config module.
 *
 * Scenario: The config/constants.ts file has a type error that breaks the build.
 * A function uses `as const` but the return type annotation is wrong, causing
 * downstream consumers to get `string` instead of literal types.
 */
const A1_TS_BUG_FIX: EvalTask = {
  id: 'A1',
  title: 'Fix TypeScript type error in shared constants module',
  category: 'bug_fix',
  tier: 'easy',
  description: `The project has a TypeScript compilation error in src/config/constants.ts.

The function \`getDefaultConfig()\` returns an object with \`as const\` assertion,
but the explicit return type annotation uses \`Record<string, string>\` instead of
a const-narrowed type. This causes 3 downstream files to fail type checking because
they rely on literal type narrowing.

Your task:
1. Find the type error in src/config/constants.ts
2. Fix the return type to preserve const narrowing
3. Ensure \`npm run build\` passes with zero errors
4. Ensure \`npm test\` passes with zero failures

Do NOT change the runtime behavior — only fix the types.`,
  repoPath: 'fixtures/A1-ts-fix',
  setupCommands: [
    'npm install',
  ],
  fixtureCommands: [],
  verification: [
    { name: 'typescript', command: 'npx tsc --noEmit', expected: 'all_pass' },
    { name: 'tests', command: 'npm test', expected: 'all_pass' },
  ],
  filesHint: [
    'src/config/constants.ts',
    'src/services/config.service.ts',
    'src/utils/env.ts',
  ],
  minStepsExpert: 3,
  timeLimitMinutes: 5,
  baselineCostUsd: 0.10,
};

/**
 * B1: Feature — Add a /health endpoint with structured response.
 *
 * Scenario: An Express.js backend needs a health check endpoint that returns
 * structured JSON with uptime, version, and dependency status.
 */
const B1_HEALTH_ENDPOINT: EvalTask = {
  id: 'B1',
  title: 'Add structured health check endpoint to Express backend',
  category: 'feature',
  tier: 'medium',
  description: `Add a GET /health endpoint to the Express.js backend.

Requirements:
1. Create src/routes/health.route.ts with a GET /health handler
2. Response must be JSON with this schema:
   {
     "status": "healthy" | "degraded",
     "uptime": number (process uptime in seconds),
     "version": string (from package.json),
     "timestamp": string (ISO 8601),
     "checks": {
       "memory": { "status": "ok" | "warning", "usedMb": number, "maxMb": number },
       "eventLoop": { "status": "ok" | "warning", "latencyMs": number }
     }
   }
3. Memory check: warn if used > 512MB
4. Event loop check: warn if latency > 100ms
5. Register the route in src/app.ts
6. Write tests in src/routes/health.route.test.ts (co-located)
7. All existing tests must continue to pass

The endpoint must work without any external dependencies.`,
  repoPath: 'fixtures/B1-health-endpoint',
  setupCommands: [
    'npm install',
  ],
  fixtureCommands: [],
  verification: [
    { name: 'typescript', command: 'npx tsc --noEmit', expected: 'all_pass' },
    { name: 'tests', command: 'npm test', expected: 'all_pass' },
    { name: 'health_exists', command: 'grep -rn "health" src/ --include="*.ts" | grep -v test | grep -v node_modules', expected: '/health' },
  ],
  filesHint: [
    'src/app.ts',
    'src/routes/',
    'package.json',
  ],
  minStepsExpert: 8,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.25,
};

/**
 * C1: Refactor — Extract hardcoded values into a constants module.
 *
 * Scenario: A service file has multiple hardcoded values (ports, timeouts, URLs)
 * scattered throughout. Extract them into a centralized constants file.
 */
const C1_EXTRACT_CONSTANTS: EvalTask = {
  id: 'C1',
  title: 'Extract hardcoded values into centralized constants module',
  category: 'refactor',
  tier: 'medium',
  description: `The file src/services/connection.service.ts contains multiple hardcoded values:
- Port numbers (3000, 3001, 8080)
- Timeout values (5000, 30000, 120000)
- URL patterns ("http://localhost:", "ws://localhost:")
- Retry counts (3, 5)
- Status strings ("connected", "disconnected", "reconnecting")

Your task:
1. Create src/config/constants.ts with properly organized, typed constants
2. Use \`as const\` assertions and group related values into namespaces
3. Replace ALL hardcoded values in connection.service.ts with constant references
4. Ensure zero behavior change — all existing tests must pass
5. Write tests for the constants module in src/config/constants.test.ts
6. Use SCREAMING_SNAKE_CASE for constant names

Do NOT change any runtime behavior. This is purely a refactoring task.`,
  repoPath: 'fixtures/C1-extract-constants',
  setupCommands: [
    'npm install',
  ],
  fixtureCommands: [],
  verification: [
    { name: 'typescript', command: 'npx tsc --noEmit', expected: 'all_pass' },
    { name: 'tests', command: 'npm test', expected: 'all_pass' },
    { name: 'no_hardcoded_ports', command: 'grep -c "3000\\|3001\\|8080" src/services/connection.service.ts', expected: '0' },
    { name: 'constants_exist', command: 'find src/ -name "constants*" -name "*.ts" ! -name "*.test.*" | head -1 | grep -q . && echo "exists"', expected: 'exists' },
  ],
  filesHint: [
    'src/services/connection.service.ts',
    'src/services/connection.service.test.ts',
  ],
  minStepsExpert: 6,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.20,
};

/** All registered eval tasks */
export const ALL_TASKS: EvalTask[] = [A1_TS_BUG_FIX, B1_HEALTH_ENDPOINT, C1_EXTRACT_CONSTANTS];

/**
 * Get a task by ID.
 * @param id - Task identifier (e.g., "A1", "B1", "C1")
 * @returns The task definition, or undefined if not found
 */
export function getTaskById(id: string): EvalTask | undefined {
  return ALL_TASKS.find((t) => t.id === id);
}

/**
 * Get all tasks matching a category.
 * @param category - Task category to filter by
 * @returns Array of matching tasks
 */
export function getTasksByCategory(category: EvalTask['category']): EvalTask[] {
  return ALL_TASKS.filter((t) => t.category === category);
}
