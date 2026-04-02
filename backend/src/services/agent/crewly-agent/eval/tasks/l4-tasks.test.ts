/**
 * Tests for L4 Evaluation Tasks — Runtime-Agnostic Collaboration & Self-Healing
 *
 * Validates setup fixtures, verification logic, and scoring for all 8 L4 tasks
 * (5 collaboration C1-C5 + 3 trap T1-T3).
 *
 * @module eval/tasks/l4-tasks.test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { ToolCallRecord } from '../../types.js';
import { L4_TASKS } from './l4-tasks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-l4-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Convenience: find a task by ID */
function getTask(id: string) {
  const task = L4_TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`Task ${id} not found`);
  return task;
}

/** Build a minimal tool call record for read_file */
function readCall(filePath: string): ToolCallRecord {
  return { toolName: 'read_file', args: { path: filePath }, result: 'content' };
}

/** Build a bash tool call that runs a skill shim */
function bashSkillCall(skillName: string, argsJson: string): ToolCallRecord {
  return {
    toolName: 'bash',
    args: { command: `bash skills/${skillName}.sh '${argsJson}'` },
    result: '{"success":true}',
  };
}

/** Write a tool log entry to .crewly/.tool-log.jsonl */
function writeToolLogEntry(workDir: string, tool: string, args: Record<string, unknown>): void {
  const logDir = path.join(workDir, '.crewly');
  fs.mkdirSync(logDir, { recursive: true });
  const entry = JSON.stringify({ tool, args, timestamp: new Date().toISOString() });
  fs.appendFileSync(path.join(logDir, '.tool-log.jsonl'), entry + '\n');
}

// ---------------------------------------------------------------------------
// Task registry
// ---------------------------------------------------------------------------

describe('L4 Task Registry', () => {
  it('should export 8 tasks', () => {
    expect(L4_TASKS).toHaveLength(8);
  });

  it('should have 5 collaboration tasks (C1-C5)', () => {
    const cTasks = L4_TASKS.filter((t) => t.id.startsWith('L4-C'));
    expect(cTasks).toHaveLength(5);
  });

  it('should have 3 trap tasks (T1-T3)', () => {
    const tTasks = L4_TASKS.filter((t) => t.id.startsWith('L4-T'));
    expect(tTasks).toHaveLength(3);
  });

  it('should all be level L4 and multiAgent', () => {
    for (const task of L4_TASKS) {
      expect(task.level).toBe('L4');
      expect(task.multiAgent).toBe(true);
    }
  });

  it('should have unique IDs', () => {
    const ids = L4_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// L4-C1: Triage & Delegate
// ---------------------------------------------------------------------------

describe('L4-C1: Triage & Delegate', () => {
  it('should set up 3 task files and workspace', async () => {
    const task = getTask('L4-C1');
    await task.setup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'CONTEXT.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-frontend-bug.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-backend-feature.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-write-tests.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'skills', 'delegate-task.sh'))).toBe(true);
  });

  it('should pass verification when agent delegates to Leo correctly', async () => {
    const task = getTask('L4-C1');
    await task.setup(tmpDir);

    // Simulate correct agent behavior via tool log
    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-leo', task: 'fix button' });
    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-leo', task: 'add pagination' });
    writeToolLogEntry(tmpDir, 'report-status', { status: 'complete', summary: 'triaged 3 tasks' });

    // Create delegation files
    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'tasks', 'deleg-1-delegation.json'),
      JSON.stringify({ delegatedTo: 'eval-dev-leo' }),
    );

    // Create report
    fs.mkdirSync(path.join(tmpDir, '.crewly', 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'reports', 'report-1.json'),
      JSON.stringify({ status: 'complete' }),
    );

    const toolCalls: ToolCallRecord[] = [
      readCall('CONTEXT.md'),
      readCall('.crewly/tasks/task-frontend-bug.md'),
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.collaborationChecks?.every((c) => c.passed)).toBe(true);
  });

  it('should fail verification when agent delegates to Max', async () => {
    const task = getTask('L4-C1');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-max', task: 'fix button' });

    const toolCalls: ToolCallRecord[] = [readCall('CONTEXT.md'), readCall('task-frontend-bug')];
    const result = await task.verify(tmpDir, toolCalls);

    const activeCheck = result.collaborationChecks?.find((c) => c.name === 'delegated_to_active_worker');
    expect(activeCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-C2: Knowledge-Driven Implementation
// ---------------------------------------------------------------------------

describe('L4-C2: Knowledge-Driven Implementation', () => {
  it('should set up task file and knowledge base', async () => {
    const task = getTask('L4-C2');
    await task.setup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-health-endpoint.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'knowledge', 'project-patterns.md'))).toBe(true);
  });

  it('should pass when controller follows all patterns and learnings recorded', async () => {
    const task = getTask('L4-C2');
    await task.setup(tmpDir);

    // Create health controller following all patterns
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'controllers', 'health.controller.ts'),
      `export async function healthCheck(req: Request, res: Response): Promise<void> {\n  try {\n    res.json({ status: 'ok', timestamp: Date.now() });\n  } catch (err) {\n    res.status(500).json({ error: 'Internal error' });\n  }\n}\n`,
    );

    // Create learnings
    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'knowledge', 'learnings.md'),
      '# Learnings\n\nThe project uses named function exports for controllers with try/catch error handling and JSON responses.',
    );

    const toolCalls: ToolCallRecord[] = [
      readCall('project-patterns.md'),
      readCall('CONTEXT.md'),
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.passed).toBe(true);
  });

  it('should fail when learnings not recorded', async () => {
    const task = getTask('L4-C2');
    await task.setup(tmpDir);

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'controllers', 'health.controller.ts'),
      `export function healthCheck(req: any, res: any) {\n  try {\n    res.json({ status: 'ok' });\n  } catch (e) {}\n}\n`,
    );

    const result = await task.verify(tmpDir, [readCall('project-patterns')]);
    const learningsCheck = result.collaborationChecks?.find((c) => c.name === 'persisted_learnings');
    expect(learningsCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-C3: Fault Detection & Recovery
// ---------------------------------------------------------------------------

describe('L4-C3: Fault Detection & Recovery', () => {
  it('should set up task-001 assigned to inactive Max with partial work', async () => {
    const task = getTask('L4-C3');
    await task.setup(tmpDir);

    const taskContent = fs.readFileSync(path.join(tmpDir, '.crewly', 'tasks', 'task-001.md'), 'utf-8');
    expect(taskContent).toContain('eval-dev-max');
    expect(taskContent).toContain('in_progress');
    expect(fs.existsSync(path.join(tmpDir, 'src', 'services', 'auth.service.ts'))).toBe(true);
  });

  it('should pass when agent reassigns to Leo and preserves partial work', async () => {
    const task = getTask('L4-C3');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'get-team-status', {});
    writeToolLogEntry(tmpDir, 'handle-failure', { worker: 'eval-dev-max', action: 'reassign' });
    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-leo', task: 'pick up task-001' });
    writeToolLogEntry(tmpDir, 'send-message', { to: 'eval-dev-leo', message: 'Max went inactive' });

    const toolCalls: ToolCallRecord[] = [
      readCall('CONTEXT.md'),
      readCall('team-config'),
      readCall('task-001'),
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L4-C4: Multi-File Coordinated Feature
// ---------------------------------------------------------------------------

describe('L4-C4: Multi-File Coordinated Feature', () => {
  it('should pass when all 3 files created with correct cross-references', async () => {
    const task = getTask('L4-C4');
    await task.setup(tmpDir);

    // Create service
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'user.service.ts'),
      `export interface UserRecord { id: string; name: string; createdAt: number; }\nexport function createUser(name: string): UserRecord { return { id: '1', name, createdAt: Date.now() }; }\nexport function validateUser(u: UserRecord): boolean { return u.name.length > 0; }\n`,
    );

    // Create controller importing service
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'controllers', 'user.controller.ts'),
      `import { createUser, validateUser } from '../services/user.service.js';\nexport function handleCreate(req: any, res: any) { const u = createUser(req.body.name); res.json(u); }\n`,
    );

    // Create test importing service
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'user.service.test.ts'),
      `import { createUser, validateUser } from './user.service.js';\nimport { describe, it, expect } from 'vitest';\ndescribe('createUser', () => { it('works', () => { expect(createUser('a').name).toBe('a'); }); });\n`,
    );

    // Simulate delegation of code review to Leo
    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-leo', task: 'review user feature' });

    const toolCalls: ToolCallRecord[] = [readCall('data.service.ts')];
    const result = await task.verify(tmpDir, toolCalls);
    expect(result.passed).toBe(true);
  });

  it('should fail when test file is missing', async () => {
    const task = getTask('L4-C4');
    await task.setup(tmpDir);

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'user.service.ts'),
      `export interface UserRecord { id: string; }\nexport function createUser() {}\nexport function validateUser() {}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'controllers', 'user.controller.ts'),
      `import { createUser } from '../services/user.service.js';\n`,
    );
    // No test file!

    const result = await task.verify(tmpDir, [readCall('data.service')]);
    const testCheck = result.checks.find((c) => c.name === 'test_created');
    expect(testCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-C5: Team Health Assessment
// ---------------------------------------------------------------------------

describe('L4-C5: Team Health Assessment', () => {
  it('should set up stale and open tasks', async () => {
    const task = getTask('L4-C5');
    await task.setup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-stale.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-open-1.md'))).toBe(true);
  });

  it('should pass with valid health report', async () => {
    const task = getTask('L4-C5');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'get-team-status', {});

    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'reports', 'team-health.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        teamId: 'eval-team-001',
        activeAgents: ['Sam', 'Leo'],
        inactiveAgents: ['Max'],
        staleAgents: [],
        pendingTasks: ['task-open-1'],
        recommendations: ['Restart Max', 'Reassign stale login bug task'],
        overallHealth: 'degraded',
      }),
    );

    const toolCalls: ToolCallRecord[] = [readCall('CONTEXT.md'), readCall('task-stale')];
    const result = await task.verify(tmpDir, toolCalls);
    expect(result.passed).toBe(true);
  });

  it('should fail when report is invalid JSON', async () => {
    const task = getTask('L4-C5');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'get-team-status', {});
    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'reports', 'team-health.json'),
      'not valid json {{{',
    );

    const result = await task.verify(tmpDir, [readCall('CONTEXT.md')]);
    const jsonCheck = result.checks.find((c) => c.name === 'valid_json_report');
    expect(jsonCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-T1: Broken Project Structure (Trap)
// ---------------------------------------------------------------------------

describe('L4-T1: Broken Project Structure (trap)', () => {
  it('should set up source/ instead of src/', async () => {
    const task = getTask('L4-T1');
    await task.setup(tmpDir);

    // The trap: code is in source/, not src/
    expect(fs.existsSync(path.join(tmpDir, 'source', 'services', 'data.service.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'source', 'index.ts'))).toBe(true);

    // tsconfig points to source/
    const tsconfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tsconfig.json'), 'utf-8'));
    expect(tsconfig.compilerOptions.rootDir).toBe('./source');

    // npm test looks in source/
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8'));
    expect(pkg.scripts.test).toContain('source');
  });

  it('should pass when agent adapts and creates in source/', async () => {
    const task = getTask('L4-T1');
    await task.setup(tmpDir);

    // Agent discovered structure and created in source/
    fs.mkdirSync(path.join(tmpDir, 'source', 'utils'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'source', 'utils', 'logger.ts'),
      `export function log(msg: string) { console.log(msg); }\nexport function error(msg: string) { console.error(msg); }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'source', 'utils', 'logger.test.ts'),
      `import { log, error } from './logger.js';\n`,
    );

    const toolCalls: ToolCallRecord[] = [
      readCall('package.json'),
      readCall('tsconfig.json'),
      { toolName: 'bash', args: { command: 'npm test' }, result: 'All tests passed' },
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.passed).toBe(true);

    // Self-healing checks should pass
    const discoveredCheck = result.collaborationChecks?.find((c) => c.name === 'discovered_structure_discrepancy');
    expect(discoveredCheck?.passed).toBe(true);
    const adaptedCheck = result.collaborationChecks?.find((c) => c.name === 'adapted_to_correct_location');
    expect(adaptedCheck?.passed).toBe(true);
  });

  it('should pass when agent creates in src/ but fixes tsconfig', async () => {
    const task = getTask('L4-T1');
    await task.setup(tmpDir);

    // Agent created in src/ AND updated tsconfig
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils', 'logger.ts'),
      `export function log(msg: string) {}\nexport function error(msg: string) {}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils', 'logger.test.ts'),
      `import { log } from './logger.js';\n`,
    );
    // Fix tsconfig to include src/
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { rootDir: './src', outDir: './dist', strict: true },
        include: ['src/**/*.ts'],
      }),
    );

    const toolCalls: ToolCallRecord[] = [
      readCall('tsconfig.json'),
      { toolName: 'bash', args: { command: 'npm test' }, result: '' },
    ];

    const result = await task.verify(tmpDir, toolCalls);
    const adaptedCheck = result.collaborationChecks?.find((c) => c.name === 'adapted_to_correct_location');
    expect(adaptedCheck?.passed).toBe(true);
  });

  it('should fail adapted_to_correct_location when agent blindly uses src/ without fixing config', async () => {
    const task = getTask('L4-T1');
    await task.setup(tmpDir);

    // Agent created in src/ but did NOT fix tsconfig (still points to source/)
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'logger.ts'), 'export function log() {}');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'logger.test.ts'), '');

    const result = await task.verify(tmpDir, []);
    const adaptedCheck = result.collaborationChecks?.find((c) => c.name === 'adapted_to_correct_location');
    expect(adaptedCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-T2: Missing Dependencies & Broken Build (Trap)
// ---------------------------------------------------------------------------

describe('L4-T2: Broken Build (trap)', () => {
  it('should set up broken source files', async () => {
    const task = getTask('L4-T2');
    await task.setup(tmpDir);

    const userService = fs.readFileSync(
      path.join(tmpDir, 'src', 'services', 'user.service.ts'), 'utf-8',
    );
    // Has missing-module import and `any` type
    expect(userService).toContain('missing-module');
    expect(userService).toContain(': any');

    // No node_modules
    expect(fs.existsSync(path.join(tmpDir, 'node_modules'))).toBe(false);
  });

  it('should pass when agent fixes issues and reports', async () => {
    const task = getTask('L4-T2');
    await task.setup(tmpDir);

    // Fix missing module — remove the import
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'user.service.ts'),
      `export interface User { id: string; name: string; email: string; }\nexport function createUser(name: string, email: string): User { return { id: '1', name, email }; }\nexport function validateEmail(email: string): boolean { return email.includes('@'); }\n`,
    );

    // Fix any types in controller
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'controllers', 'user.controller.ts'),
      `import { createUser, validateEmail } from '../services/user.service.js';\nexport function handleCreateUser(req: { body: { name: string; email: string } }, res: { json: (d: unknown) => void; status: (n: number) => { json: (d: unknown) => void } }): void {\n  try { const u = createUser(req.body.name, req.body.email); res.json(u); } catch { res.status(500).json({ error: 'err' }); }\n}\n`,
    );

    writeToolLogEntry(tmpDir, 'report-status', { status: 'fixed', summary: 'Fixed missing import and any types' });

    const toolCalls: ToolCallRecord[] = [
      readCall('CONTEXT.md'),
      { toolName: 'bash', args: { command: 'npm run build' }, result: 'error TS...' },
      { toolName: 'bash', args: { command: 'npm install' }, result: 'added 50 packages' },
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.collaborationChecks?.find((c) => c.name === 'identified_multiple_issues')?.passed).toBe(true);
  });

  it('should fail when agent does not attempt build', async () => {
    const task = getTask('L4-T2');
    await task.setup(tmpDir);

    const result = await task.verify(tmpDir, [readCall('CONTEXT.md')]);
    const buildCheck = result.checks.find((c) => c.name === 'attempted_build');
    expect(buildCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L4-T3: Conflicting State (Trap)
// ---------------------------------------------------------------------------

describe('L4-T3: Conflicting State (trap)', () => {
  it('should set up contradictory task state and malformed JSON', async () => {
    const task = getTask('L4-T3');
    await task.setup(tmpDir);

    // task-007 says open but delegation exists
    const taskContent = fs.readFileSync(path.join(tmpDir, '.crewly', 'tasks', 'task-007.md'), 'utf-8');
    expect(taskContent).toContain('status: open');
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-007-delegation.json'))).toBe(true);

    // Duplicate task
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-007-duplicate.md'))).toBe(true);

    // Malformed team config (trailing comma)
    const configContent = fs.readFileSync(
      path.join(tmpDir, '.crewly', 'teams', 'team-config.json'), 'utf-8',
    );
    expect(() => JSON.parse(configContent)).toThrow();
  });

  it('should pass when agent handles contradictions and delegates', async () => {
    const task = getTask('L4-T3');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-leo', task: 'caching layer' });

    // Create report about inconsistencies
    fs.mkdirSync(path.join(tmpDir, '.crewly', 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.crewly', 'reports', 'report-1.json'),
      JSON.stringify({ summary: 'Found conflicting state' }),
    );

    const toolCalls: ToolCallRecord[] = [
      readCall('CONTEXT.md'),
      readCall('task-007'),
      readCall('team-config'),
    ];

    const result = await task.verify(tmpDir, toolCalls);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.collaborationChecks?.find((c) => c.name === 'avoided_inactive_worker')?.passed).toBe(true);
    expect(result.collaborationChecks?.find((c) => c.name === 'reported_inconsistencies')?.passed).toBe(true);
  });

  it('should fail when agent delegates to inactive Max', async () => {
    const task = getTask('L4-T3');
    await task.setup(tmpDir);

    writeToolLogEntry(tmpDir, 'delegate-task', { to: 'eval-dev-max', task: 'caching' });

    const toolCalls: ToolCallRecord[] = [readCall('CONTEXT.md'), readCall('task-007')];
    const result = await task.verify(tmpDir, toolCalls);

    const avoidCheck = result.collaborationChecks?.find((c) => c.name === 'avoided_inactive_worker');
    expect(avoidCheck?.passed).toBe(false);
  });
});
