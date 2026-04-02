#!/usr/bin/env npx tsx
/**
 * Crewly Eval CLI — Quick Runner
 *
 * Runs L1 eval tasks against the Crewly Agent runtime via the running backend.
 * Uses the backend's chat API to send prompts and collect results.
 *
 * Usage:
 *   npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-cli.ts
 *   npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-cli.ts --tasks L1-01,L1-02
 *
 * @module eval/run-eval-cli
 */

import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

// ─── Configuration ────────────────────────────────────────────────────────
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8787';
const EVAL_SESSION = `eval-agent-${Date.now()}`;
const OUTPUT_DIR = join(process.cwd(), 'eval-results');

// ─── Types ────────────────────────────────────────────────────────────────
interface EvalTaskDef {
  id: string;
  title: string;
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
  expectedTools: string[];
  setup: (workDir: string) => Promise<void>;
  verify: (workDir: string, output: string, toolCalls: string[]) => Promise<VerifyResult>;
}

interface VerifyResult {
  passed: boolean;
  partialScore: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

interface TaskScore {
  taskId: string;
  passed: boolean;
  partialScore: number;
  durationMs: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  output: string;
  toolsUsed: string[];
}

// ─── Fixture Setup ────────────────────────────────────────────────────────
const FIXTURE_PKG = JSON.stringify({
  name: 'eval-base-project',
  version: '1.0.0',
  type: 'module',
  scripts: { build: 'tsc', test: 'echo "no tests"' },
}, null, 2);

const FIXTURE_INDEX = `/**
 * Calculate the sum of numbers.
 * @param numbers - array of numbers
 * @returns total sum
 */
export function calculateTotal(numbers: number[]): number {
  return numbers.reduce((sum, n) => sum + n, 0);
}
`;

const FIXTURE_API = `/**
 * Simple API service.
 */
export class ApiService {
  private baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; }
  async get<T>(path: string): Promise<T> {
    const res = await fetch(\`\${this.baseUrl}\${path}\`);
    return res.json() as Promise<T>;
  }
}
`;

const FIXTURE_HELPERS = `/**
 * Format a date as YYYY-MM-DD.
 * @param date - input date
 * @returns formatted string
 */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
`;

/**
 * Create the base-project fixture in the given directory.
 */
async function createFixture(workDir: string): Promise<void> {
  await mkdir(join(workDir, 'src', 'services'), { recursive: true });
  await mkdir(join(workDir, 'src', 'utils'), { recursive: true });
  await writeFile(join(workDir, 'package.json'), FIXTURE_PKG);
  await writeFile(join(workDir, 'src', 'index.ts'), FIXTURE_INDEX);
  await writeFile(join(workDir, 'src', 'services', 'api.service.ts'), FIXTURE_API);
  await writeFile(join(workDir, 'src', 'utils', 'helpers.ts'), FIXTURE_HELPERS);
}

// ─── L1 Task Definitions ─────────────────────────────────────────────────
const L1_TASKS: EvalTaskDef[] = [
  {
    id: 'L1-01',
    title: 'Read package.json, report version',
    prompt: 'Read the file package.json in this project and tell me the version number.',
    maxSteps: 3,
    timeoutMs: 60_000,
    expectedTools: ['Read'],
    async setup(workDir) { await createFixture(workDir); },
    async verify(workDir, output, toolCalls) {
      const pkg = JSON.parse(await readFile(join(workDir, 'package.json'), 'utf-8'));
      const hasVersion = output.includes(pkg.version);
      const usedRead = toolCalls.some(t => t.toLowerCase().includes('read'));
      return {
        passed: hasVersion && usedRead,
        partialScore: (hasVersion ? 0.5 : 0) + (usedRead ? 0.5 : 0),
        checks: [
          { name: 'output-contains-version', passed: hasVersion, detail: hasVersion ? `Found "${pkg.version}"` : 'Version not in output' },
          { name: 'used-read-tool', passed: usedRead, detail: usedRead ? 'Used Read tool' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'L1-02',
    title: 'Create hello.ts with greeting export',
    prompt: "Create a file called hello.ts in the project root with the content: export const greeting = 'Hello';",
    maxSteps: 3,
    timeoutMs: 60_000,
    expectedTools: ['Write'],
    async setup(workDir) { await createFixture(workDir); },
    async verify(workDir, output, toolCalls) {
      const helloPath = join(workDir, 'hello.ts');
      let exists = false;
      let correct = false;
      try {
        const content = await readFile(helloPath, 'utf-8');
        exists = true;
        correct = content.includes("export const greeting = 'Hello'") || content.includes('export const greeting = "Hello"');
      } catch { /* */ }
      const usedWrite = toolCalls.some(t => t.toLowerCase().includes('write'));
      return {
        passed: exists && correct,
        partialScore: (exists ? 0.3 : 0) + (correct ? 0.4 : 0) + (usedWrite ? 0.3 : 0),
        checks: [
          { name: 'file-exists', passed: exists, detail: exists ? 'hello.ts exists' : 'hello.ts not found' },
          { name: 'content-correct', passed: correct, detail: correct ? 'Content matches' : 'Content mismatch' },
          { name: 'used-write-tool', passed: usedWrite, detail: usedWrite ? 'Used Write' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'L1-03',
    title: 'Find all .test.ts files in src/',
    prompt: 'Find all files ending in .test.ts inside the src/ directory. List them.',
    maxSteps: 3,
    timeoutMs: 60_000,
    expectedTools: ['Glob'],
    async setup(workDir) {
      await createFixture(workDir);
      await writeFile(join(workDir, 'src', 'utils', 'helpers.test.ts'), 'test("x", () => {});');
      await writeFile(join(workDir, 'src', 'index.test.ts'), 'test("y", () => {});');
    },
    async verify(_workDir, output, toolCalls) {
      const found1 = output.includes('helpers.test.ts');
      const found2 = output.includes('index.test.ts');
      const usedGlob = toolCalls.some(t => t.toLowerCase().includes('glob'));
      return {
        passed: found1 && found2,
        partialScore: (found1 ? 0.35 : 0) + (found2 ? 0.35 : 0) + (usedGlob ? 0.3 : 0),
        checks: [
          { name: 'found-helpers-test', passed: found1, detail: found1 ? 'Found helpers.test.ts' : 'Missing' },
          { name: 'found-index-test', passed: found2, detail: found2 ? 'Found index.test.ts' : 'Missing' },
          { name: 'used-glob', passed: usedGlob, detail: usedGlob ? 'Used Glob' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'L1-04',
    title: 'Search for "export class" in src/',
    prompt: 'Search for all occurrences of "export class" in the src/ directory. Report which files and line numbers.',
    maxSteps: 3,
    timeoutMs: 60_000,
    expectedTools: ['Grep'],
    async setup(workDir) {
      await createFixture(workDir);
    },
    async verify(_workDir, output, toolCalls) {
      const foundFile = output.includes('api.service.ts') || output.includes('ApiService');
      const usedGrep = toolCalls.some(t => t.toLowerCase().includes('grep'));
      return {
        passed: foundFile && usedGrep,
        partialScore: (foundFile ? 0.5 : 0) + (usedGrep ? 0.5 : 0),
        checks: [
          { name: 'found-api-service', passed: foundFile, detail: foundFile ? 'Found api.service.ts' : 'Not found' },
          { name: 'used-grep', passed: usedGrep, detail: usedGrep ? 'Used Grep' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'L1-05',
    title: 'Run git status',
    prompt: 'Run git status and show me the output.',
    maxSteps: 3,
    timeoutMs: 60_000,
    expectedTools: ['Bash'],
    async setup(workDir) {
      await createFixture(workDir);
      execSync('git init && git add -A && git commit -m "init"', {
        cwd: workDir, stdio: 'pipe',
        env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'e@t.l', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'e@t.l' },
      });
    },
    async verify(_workDir, output, toolCalls) {
      const hasStatus = output.includes('branch') || output.includes('clean') || output.includes('nothing to commit');
      const usedBash = toolCalls.some(t => t.toLowerCase().includes('bash'));
      return {
        passed: hasStatus && usedBash,
        partialScore: (hasStatus ? 0.5 : 0) + (usedBash ? 0.5 : 0),
        checks: [
          { name: 'has-git-output', passed: hasStatus, detail: hasStatus ? 'Output has git status' : 'No git status in output' },
          { name: 'used-bash', passed: usedBash, detail: usedBash ? 'Used Bash' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'L1-06',
    title: 'Change version in package.json',
    prompt: 'Change the version in package.json from "1.0.0" to "1.1.0".',
    maxSteps: 5,
    timeoutMs: 60_000,
    expectedTools: ['Edit'],
    async setup(workDir) { await createFixture(workDir); },
    async verify(workDir, _output, toolCalls) {
      let correct = false;
      let validJson = false;
      try {
        const content = await readFile(join(workDir, 'package.json'), 'utf-8');
        const pkg = JSON.parse(content);
        validJson = true;
        correct = pkg.version === '1.1.0';
      } catch { /* */ }
      const usedEdit = toolCalls.some(t => t.toLowerCase().includes('edit'));
      return {
        passed: correct && validJson,
        partialScore: (validJson ? 0.3 : 0) + (correct ? 0.4 : 0) + (usedEdit ? 0.3 : 0),
        checks: [
          { name: 'json-valid', passed: validJson, detail: validJson ? 'Valid JSON' : 'Invalid JSON' },
          { name: 'version-updated', passed: correct, detail: correct ? 'Version is 1.1.0' : 'Version not updated' },
          { name: 'used-edit', passed: usedEdit, detail: usedEdit ? 'Used Edit' : `Tools: ${toolCalls.join(', ')}` },
        ],
      };
    },
  },
];

// ─── Backend API Client ───────────────────────────────────────────────────

/**
 * Send a prompt to the Crewly Agent via the backend chat API
 * and collect the response with tool call information.
 */
async function runAgentTask(
  prompt: string,
  workDir: string,
  timeoutMs: number,
): Promise<{ output: string; toolCalls: string[]; durationMs: number }> {
  const startMs = Date.now();

  // Use the agent's internal API to run a single prompt
  const response = await fetch(`${BACKEND_URL}/api/chat/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      workDir,
      sessionName: EVAL_SESSION,
      maxSteps: 10,
      timeoutMs,
    }),
    signal: AbortSignal.timeout(timeoutMs + 10_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Backend API error ${response.status}: ${error}`);
  }

  const result = await response.json() as {
    text: string;
    toolCalls: Array<{ toolName: string }>;
  };

  return {
    output: result.text || '',
    toolCalls: (result.toolCalls || []).map((tc: { toolName: string }) => tc.toolName),
    durationMs: Date.now() - startMs,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const taskFilter = args.find(a => a.startsWith('--tasks='))?.split('=')[1]?.split(',');

  let tasks = L1_TASKS;
  if (taskFilter) {
    tasks = tasks.filter(t => taskFilter.includes(t.id));
  }

  console.log('═'.repeat(72));
  console.log('  CREWLY EVAL RUNNER — L1 Tasks');
  console.log(`  Tasks: ${tasks.length} | Backend: ${BACKEND_URL}`);
  console.log('═'.repeat(72));

  const scores: TaskScore[] = [];

  for (const task of tasks) {
    console.log(`\n▸ ${task.id}: ${task.title}`);

    // Create work directory
    const workDir = join(tmpdir(), `crewly-eval-${task.id}-${randomUUID().slice(0, 8)}`);
    await mkdir(workDir, { recursive: true });

    try {
      // Setup fixture
      await task.setup(workDir);
      console.log(`  Setup: ${workDir}`);

      // Run task
      const { output, toolCalls, durationMs } = await runAgentTask(
        `Working directory: ${workDir}\n\n${task.prompt}`,
        workDir,
        task.timeoutMs,
      );
      console.log(`  Duration: ${durationMs}ms | Tools: ${toolCalls.join(', ') || 'none'}`);

      // Verify
      const verification = await task.verify(workDir, output, toolCalls);
      const status = verification.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`  Result: ${status} (${(verification.partialScore * 100).toFixed(0)}%)`);
      for (const check of verification.checks) {
        console.log(`    ${check.passed ? '✓' : '✗'} ${check.name}: ${check.detail}`);
      }

      scores.push({
        taskId: task.id,
        passed: verification.passed,
        partialScore: verification.partialScore,
        durationMs,
        checks: verification.checks,
        output: output.slice(0, 500),
        toolsUsed: toolCalls,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ERROR: ${msg}`);
      scores.push({
        taskId: task.id,
        passed: false,
        partialScore: 0,
        durationMs: 0,
        checks: [{ name: 'runner-error', passed: false, detail: msg }],
        output: '',
        toolsUsed: [],
      });
    } finally {
      // Cleanup
      try { await rm(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  // Print summary
  console.log('\n' + '═'.repeat(72));
  console.log('  SUMMARY');
  console.log('═'.repeat(72));
  const passed = scores.filter(s => s.passed).length;
  const avgScore = scores.reduce((sum, s) => sum + s.partialScore, 0) / scores.length;
  console.log(`  Pass: ${passed}/${scores.length} | Avg Score: ${(avgScore * 100).toFixed(1)}%`);

  for (const score of scores) {
    const icon = score.passed ? '✅' : '❌';
    console.log(`  ${icon} ${score.taskId}: ${(score.partialScore * 100).toFixed(0)}% (${score.durationMs}ms)`);
  }
  console.log('═'.repeat(72));

  // Save results
  await mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `eval-L1-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  await writeFile(
    join(OUTPUT_DIR, filename),
    JSON.stringify({ timestamp: new Date().toISOString(), scores, summary: { passed, total: scores.length, avgScore } }, null, 2),
  );
  console.log(`\nResults saved to ${join(OUTPUT_DIR, filename)}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
