/**
 * Task registry — defines all benchmark tasks for the eval runner.
 * Each task is a self-contained unit: description, setup, fixture injection, and verification.
 *
 * Task naming convention:
 * - A* = bug_fix tasks
 * - B* = feature tasks
 * - C* = refactor tasks
 * - D* = business tasks (files in, files out, checked by `checks/<task>/check.mjs`)
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
/**
 * Business tasks share one shape: the fixture holds the owner's files, the
 * agent writes new files next to them, and a checker script recomputes the
 * expected result from the fixture and compares. The checker lives outside the
 * fixture (`checks/<task>/check.mjs`) so the agent cannot read the answer key;
 * the verification command resolves it from the run directory
 * (`runs/<runId>/` → `../../checks/`).
 */
function businessCheck(task: string): EvalTask['verification'] {
  return [{ name: 'checks', command: `node ../../checks/${task}/check.mjs`, expected: 'all_pass' }];
}

/**
 * D1: Bookkeeping — month-end summary from a bank export and category rules.
 *
 * Two of the 14 rows match no rule (Amazon, Transfer from savings); a correct
 * answer leaves them out of the totals and lists them for the owner.
 */
const D1_BOOKKEEPING: EvalTask = {
  id: 'D1',
  title: 'Bookkeeping: month-end summary from a bank export',
  category: 'business',
  tier: 'easy',
  provenance: 'inferred',
  description: `You are doing the September 2026 books for a small studio.

transactions.csv is the bank export (date, description, amount; income positive,
spending negative). category-rules.md says which keyword puts a transaction in
which category, and that a transaction matching no keyword is uncategorized:
it is left for the owner and excluded from every total.

Write two files:
1. reports/2026-09-summary.json with exactly these keys:
   { "month": "2026-09", "income": <sum of positive categorized amounts>,
     "expenses": <sum of negative categorized amounts, as a positive number>,
     "net": <income - expenses>,
     "byCategory": { "<category>": <signed sum of that category> } }
   Only categories that have at least one transaction appear in byCategory.
   Round to 2 decimals.
2. reports/needs-review.csv with the header "date,description,amount" and one
   row per uncategorized transaction, copied from transactions.csv with the
   amount written to 2 decimals.

Do not modify transactions.csv or category-rules.md.`,
  repoPath: 'fixtures/D1-bookkeeping',
  setupCommands: [],
  fixtureCommands: [],
  verification: businessCheck('D1-bookkeeping'),
  filesHint: ['transactions.csv', 'category-rules.md'],
  minStepsExpert: 4,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.15,
};

/**
 * D2: Marketing content — one post per platform under a brand rule sheet.
 *
 * The checker is mechanical (platform set, product names, banned words,
 * length, hashtags, the closing link); it does not judge the writing.
 */
const D2_SOCIAL_POSTS: EvalTask = {
  id: 'D2',
  title: 'Marketing: three social posts that follow the brand sheet',
  category: 'business',
  tier: 'easy',
  provenance: 'inferred',
  description: `Write this week's social posts for Rise & Grind Bakery.

brand.md is the voice and rule sheet; products.json lists the products with
price and a note. Write posts/week-41.json: a JSON array of exactly 3 objects,
one per platform ("x", "instagram", "linkedin"), each
{ "platform": ..., "product": ..., "text": ... }.

Rules (all enforced):
- Each post features a different product; "product" is the name exactly as
  written in products.json and the text names it verbatim.
- Every text ends with the order link from brand.md.
- Never use the banned words from brand.md.
- X at most 280 characters; Instagram at most 2200 characters and at least 3
  hashtags; LinkedIn at most 3000 characters.

Do not modify brand.md or products.json.`,
  repoPath: 'fixtures/D2-social-posts',
  setupCommands: [],
  fixtureCommands: [],
  verification: businessCheck('D2-social-posts'),
  filesHint: ['brand.md', 'products.json'],
  minStepsExpert: 3,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.15,
};

/**
 * D3: Customer intake — triage six inbox messages, book the ones that ask for
 * a slot, draft the replies.
 *
 * One message asks for a slot that is not open (004 wants Tuesday; either
 * Tuesday slot is accepted), one is spam and gets no reply.
 */
const D3_CUSTOMER_INTAKE: EvalTask = {
  id: 'D3',
  title: 'Customer intake: triage the inbox and book the free slots',
  category: 'business',
  tier: 'medium',
  provenance: 'inferred',
  description: `You handle the inbox of a one-person consultancy.

inbox/*.txt are six messages received this morning (file name = message id).
availability.json lists the open consultation slots (id, start, end; times are
Europe/London).

Write:
1. intake/triage.json: a JSON array with one entry per message,
   { "message": "<id>", "type": "booking" | "complaint" | "spam" | "other",
     "slot": "<slot id>" | null }.
   A booking is a message that asks for a consultation; give it the open slot
   that fits what the sender asked for (first matching slot by start time if
   several fit). Each slot can be given to one message only. Every other type
   has slot null.
2. intake/replies/<id>.md: a short reply for every message that is not spam.
   Address the sender by first name. A booking reply must state the slot's
   date as YYYY-MM-DD and its start time as HH:MM. Spam gets no reply file.

Do not modify the inbox or availability.json.`,
  repoPath: 'fixtures/D3-customer-intake',
  setupCommands: [],
  fixtureCommands: [],
  verification: businessCheck('D3-customer-intake'),
  filesHint: ['inbox/', 'availability.json'],
  minStepsExpert: 8,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.20,
};

/**
 * D4: Payment reminders — one reminder per overdue unpaid invoice.
 *
 * Traps: an invoice due today is not overdue; paid invoices and not-yet-due
 * ones get no reminder; the amount format and "<n> days overdue" are exact.
 */
const D4_PAYMENT_REMINDERS: EvalTask = {
  id: 'D4',
  title: 'Payment reminders for overdue invoices',
  category: 'business',
  tier: 'easy',
  provenance: 'inferred',
  description: `Send payment reminders for a small services business.

invoices.csv lists the open invoices (invoice, customer, email, issued, due,
amount, status). today.txt holds today's date. reminder-template.md says which
invoices get a reminder and what each reminder must contain.

Write reminders/<invoice>.md for every overdue, unpaid invoice (and for no
other invoice), following reminder-template.md exactly: invoice number, the
amount as "USD 1,250.00", the due date as in the CSV, "<n> days overdue", and
the payment link https://pay.example.test/<invoice>. Then write
reminders/index.csv with the header "invoice,email,days_overdue" and one row
per reminder, most overdue first.

Do not modify invoices.csv, today.txt or reminder-template.md.`,
  repoPath: 'fixtures/D4-payment-reminders',
  setupCommands: [],
  fixtureCommands: [],
  verification: businessCheck('D4-payment-reminders'),
  filesHint: ['invoices.csv', 'today.txt', 'reminder-template.md'],
  minStepsExpert: 5,
  timeLimitMinutes: 10,
  baselineCostUsd: 0.15,
};

export const ALL_TASKS: EvalTask[] = [
  A1_TS_BUG_FIX,
  B1_HEALTH_ENDPOINT,
  C1_EXTRACT_CONSTANTS,
  D1_BOOKKEEPING,
  D2_SOCIAL_POSTS,
  D3_CUSTOMER_INTAKE,
  D4_PAYMENT_REMINDERS,
];

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
