/**
 * L1 Evaluation Tasks - Basic Tool Mastery
 *
 * Six tasks that test an agent's ability to use individual tools
 * correctly: read, write, glob, grep, bash, and edit.
 *
 * Tool name matching is case-insensitive and uses substring matching
 * to support different runtimes (e.g. "Read" vs "read_file").
 *
 * @module eval/tasks/l1-tasks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolCallRecord } from '../../types.js';
import type { EvalCheck, EvalTask, EvalVerification } from '../eval-types.js';
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_STEPS } from '../eval-types.js';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);

/** Absolute path to the base project fixture used by L1 tasks */
const FIXTURE_DIR = path.resolve(__dirname_esm, '..', 'fixtures', 'base-project');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link EvalVerification} from a list of checks.
 * The verification passes only if every check passes.
 *
 * @param checks - individual check results
 * @returns assembled verification
 */
function buildVerification(checks: EvalCheck[]): EvalVerification {
  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Copy the fixture base-project into a work directory.
 *
 * @param workDir - destination directory
 */
async function copyFixture(workDir: string): Promise<void> {
  fs.cpSync(FIXTURE_DIR, workDir, { recursive: true });
}

/**
 * Check whether at least one tool call used a tool matching the given name.
 * Matching is case-insensitive and uses substring/alias matching to handle
 * different runtime tool naming conventions:
 * - "read" matches "Read", "read_file", "ReadFile", etc.
 * - "glob" matches "Glob", "glob_files", "GlobFiles", etc.
 *
 * @param toolCalls - recorded tool calls from the runtime
 * @param toolName  - expected tool name (will match as substring)
 * @returns true if the tool was used
 */
function usedTool(toolCalls: ToolCallRecord[], toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return toolCalls.some((tc) => {
    const tcLower = tc.toolName.toLowerCase();
    return tcLower.includes(lower) || lower.includes(tcLower);
  });
}

/**
 * Get the string value of a tool call argument, checking multiple possible
 * key names (to handle different runtimes using different arg names).
 *
 * @param tc   - tool call record
 * @param keys - possible argument key names
 * @returns the string value or empty string
 */
function getArgValue(tc: ToolCallRecord, ...keys: string[]): string {
  const args = tc.args as Record<string, unknown> | undefined;
  if (!args) return '';
  for (const key of keys) {
    if (args[key] !== undefined) return String(args[key]);
  }
  return '';
}

// ---------------------------------------------------------------------------
// L1-01: Read package.json
// ---------------------------------------------------------------------------

/**
 * L1-01: Read package.json and report its version field.
 *
 * Tests the agent's ability to use the read tool and extract
 * structured information from a JSON file.
 */
const L1_01_READ_FILE: EvalTask = {
  id: 'L1-01',
  level: 'L1',
  title: 'Read package.json and report version',
  prompt: 'Read the package.json file in this project and tell me the current version number.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['read'],
  tags: ['file-ops', 'json'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const usedReadTool = usedTool(toolCalls, 'read');

    // Check if agent read a file containing "package.json" in the path
    const readPackageJson = toolCalls.some((tc) => {
      if (!usedTool([tc], 'read')) return false;
      const filePath = getArgValue(tc, 'path', 'file_path', 'filePath', 'file');
      return filePath.includes('package.json');
    });

    const checks: EvalCheck[] = [
      {
        name: 'used_read',
        passed: usedReadTool,
        message: 'Agent should use a read/read_file tool',
      },
      {
        name: 'read_package_json',
        passed: readPackageJson,
        message: 'Agent should read package.json specifically',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L1-02: Create hello.ts
// ---------------------------------------------------------------------------

/**
 * L1-02: Create a hello.ts file that exports a greeting function.
 *
 * Tests the agent's ability to use the write tool to create
 * a new TypeScript source file. Checks both root and src/ paths.
 */
const L1_02_WRITE_FILE: EvalTask = {
  id: 'L1-02',
  level: 'L1',
  title: 'Create hello.ts with greeting export',
  prompt:
    'Create a file called hello.ts in the project root that exports a function named greet which takes a name parameter (string) and returns a greeting string like "Hello, <name>!".',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['write'],
  tags: ['file-ops', 'typescript'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    // Check both root and src/ paths (agent may put it in either)
    const rootPath = path.join(workDir, 'hello.ts');
    const srcPath = path.join(workDir, 'src', 'hello.ts');
    const fileExists = fs.existsSync(rootPath) || fs.existsSync(srcPath);

    let containsExport = false;
    let containsGreet = false;
    const helloPath = fs.existsSync(rootPath) ? rootPath : srcPath;

    if (fileExists) {
      const content = fs.readFileSync(helloPath, 'utf-8');
      containsExport = content.includes('export');
      containsGreet = content.includes('greet');
    }

    const checks: EvalCheck[] = [
      {
        name: 'used_write',
        passed: usedTool(toolCalls, 'write'),
        message: 'Agent should use a write/write_file tool',
      },
      {
        name: 'file_created',
        passed: fileExists,
        message: 'hello.ts should exist (root or src/)',
      },
      {
        name: 'has_export',
        passed: containsExport,
        message: 'File should contain an export',
      },
      {
        name: 'has_greet_function',
        passed: containsGreet,
        message: 'File should define a greet function',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L1-03: Find test files
// ---------------------------------------------------------------------------

/**
 * L1-03: Find all .test.ts files in the src/ directory.
 *
 * Tests the agent's ability to use glob/search for file discovery.
 * Accepts both glob and grep tools since some runtimes may use either.
 */
const L1_03_GLOB_FILES: EvalTask = {
  id: 'L1-03',
  level: 'L1',
  title: 'Find all .test.ts files in src/',
  prompt: 'Find all files matching the pattern "*.test.ts" inside the src/ directory and list them.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['glob'],
  tags: ['file-ops', 'discovery'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
  },

  async verify(_workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    // Accept glob, grep, bash (ls/find), or any search tool
    const usedSearchTool =
      usedTool(toolCalls, 'glob') ||
      usedTool(toolCalls, 'grep') ||
      usedTool(toolCalls, 'bash') ||
      usedTool(toolCalls, 'search');

    // Check if the pattern includes test.ts
    const correctPattern = toolCalls.some((tc) => {
      const args = tc.args as Record<string, unknown> | undefined;
      if (!args) return false;
      const allArgs = JSON.stringify(args).toLowerCase();
      return allArgs.includes('test.ts') || allArgs.includes('.test.');
    });

    const checks: EvalCheck[] = [
      {
        name: 'used_search_tool',
        passed: usedSearchTool,
        message: 'Agent should use a glob/grep/search tool',
      },
      {
        name: 'correct_pattern',
        passed: correctPattern,
        message: 'Search pattern should target .test.ts files',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L1-04: Search for export class
// ---------------------------------------------------------------------------

/**
 * L1-04: Search for "export class" declarations in src/.
 *
 * Tests the agent's ability to use grep/search for content searching.
 */
const L1_04_GREP_SEARCH: EvalTask = {
  id: 'L1-04',
  level: 'L1',
  title: 'Search for "export class" in src/',
  prompt: 'Search for all occurrences of "export class" in the src/ directory and report the results.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['grep'],
  tags: ['search', 'code-analysis'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
  },

  async verify(_workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    // Accept grep, search, or bash (grep command)
    const usedSearchTool =
      usedTool(toolCalls, 'grep') ||
      usedTool(toolCalls, 'search') ||
      usedTool(toolCalls, 'bash');

    const correctPattern = toolCalls.some((tc) => {
      const args = tc.args as Record<string, unknown> | undefined;
      if (!args) return false;
      const allArgs = JSON.stringify(args).toLowerCase();
      return allArgs.includes('export class') || allArgs.includes('export');
    });

    const checks: EvalCheck[] = [
      {
        name: 'used_search_tool',
        passed: usedSearchTool,
        message: 'Agent should use a grep/search tool',
      },
      {
        name: 'correct_pattern',
        passed: correctPattern,
        message: 'Search pattern should include "export class"',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L1-05: Show git status
// ---------------------------------------------------------------------------

/**
 * L1-05: Show the current git status.
 *
 * Tests the agent's ability to use bash for shell commands.
 */
const L1_05_BASH_EXEC: EvalTask = {
  id: 'L1-05',
  level: 'L1',
  title: 'Show git status',
  prompt: 'Run "git status" in the project directory and show me the output.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['bash'],
  tags: ['bash', 'git'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
    // Initialize a git repo so git status works
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: workDir, stdio: 'ignore' });
    execSync('git add .', { cwd: workDir, stdio: 'ignore' });
  },

  async verify(_workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const usedBashTool = usedTool(toolCalls, 'bash');

    const ranGitStatus = toolCalls.some((tc) => {
      if (!usedTool([tc], 'bash')) return false;
      const cmd = getArgValue(tc, 'command', 'cmd');
      return cmd.includes('git status');
    });

    const checks: EvalCheck[] = [
      {
        name: 'used_bash',
        passed: usedBashTool,
        message: 'Agent should use a bash/exec tool',
      },
      {
        name: 'ran_git_status',
        passed: ranGitStatus,
        message: 'Agent should run git status command',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// L1-06: Edit version in package.json
// ---------------------------------------------------------------------------

/**
 * L1-06: Change the version in package.json from 1.0.0 to 1.1.0.
 *
 * Tests the agent's ability to use edit for targeted modifications.
 */
const L1_06_EDIT_FILE: EvalTask = {
  id: 'L1-06',
  level: 'L1',
  title: 'Change version in package.json 1.0.0 to 1.1.0',
  prompt:
    'Edit the package.json file and change the version from "1.0.0" to "1.1.0". Do not change anything else.',
  maxSteps: MAX_TASK_STEPS,
  timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  expectedTools: ['edit'],
  tags: ['file-ops', 'edit', 'json'],

  async setup(workDir: string): Promise<void> {
    await copyFixture(workDir);
  },

  async verify(workDir: string, toolCalls: ToolCallRecord[]): Promise<EvalVerification> {
    const pkgPath = path.join(workDir, 'package.json');
    let versionUpdated = false;
    let namePreserved = false;

    if (fs.existsSync(pkgPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
        versionUpdated = content.version === '1.1.0';
        namePreserved = content.name === 'eval-base-project';
      } catch {
        // JSON parse failed
      }
    }

    // Accept edit or write (agent may overwrite the whole file)
    const usedEditTool = usedTool(toolCalls, 'edit') || usedTool(toolCalls, 'write');

    const checks: EvalCheck[] = [
      {
        name: 'used_edit',
        passed: usedEditTool,
        message: 'Agent should use an edit/write tool',
      },
      {
        name: 'version_updated',
        passed: versionUpdated,
        message: 'Version should be changed to 1.1.0',
      },
      {
        name: 'name_preserved',
        passed: namePreserved,
        message: 'Package name should remain eval-base-project',
      },
    ];
    return buildVerification(checks);
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All L1 evaluation tasks */
export const L1_TASKS: EvalTask[] = [
  L1_01_READ_FILE,
  L1_02_WRITE_FILE,
  L1_03_GLOB_FILES,
  L1_04_GREP_SEARCH,
  L1_05_BASH_EXEC,
  L1_06_EDIT_FILE,
];
