/**
 * Tests for the CLI Adapter.
 *
 * Tests cover: initialization, argument building, file snapshot diffing,
 * tool call merging, process result handling, and factory integration.
 *
 * NOTE: These tests do NOT require actual CLI tools to be installed.
 * They mock the process execution layer and test the adapter logic.
 *
 * @module eval/adapters/cli-adapter.test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CLIAdapter, CLI_DEFAULTS } from './cli-adapter.js';
import { createAdapter } from './index.js';
import type { AdapterConfig } from '../eval-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI_DEFAULTS
// ---------------------------------------------------------------------------

describe('CLI_DEFAULTS', () => {
  it('should have defaults for claude-code', () => {
    const d = CLI_DEFAULTS['claude-code'];
    expect(d.cliCommand).toBe('claude');
    expect(d.cliFlags).toContain('--print');
    expect(d.cliFlags).toContain('--dangerously-skip-permissions');
    expect(d.printMode).toBe(true);
  });

  it('should have defaults for codex-cli', () => {
    const d = CLI_DEFAULTS['codex-cli'];
    expect(d.cliCommand).toBe('codex');
    expect(d.cliFlags).toContain('exec');
    expect(d.cliFlags).toContain('--full-auto');
    expect(d.cliFlags).toContain('--skip-git-repo-check');
    expect(d.printMode).toBe(true);
  });

  it('should have defaults for gemini-cli', () => {
    const d = CLI_DEFAULTS['gemini-cli'];
    expect(d.cliCommand).toBe('gemini');
    expect(d.cliFlags).toContain('-y');
    expect(d.printMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAdapter factory
// ---------------------------------------------------------------------------

describe('createAdapter', () => {
  it('should create CLIAdapter for claude-code', () => {
    const adapter = createAdapter('claude-code');
    expect(adapter).toBeInstanceOf(CLIAdapter);
  });

  it('should create CLIAdapter for codex-cli', () => {
    const adapter = createAdapter('codex-cli');
    expect(adapter).toBeInstanceOf(CLIAdapter);
  });

  it('should create CLIAdapter for gemini-cli', () => {
    const adapter = createAdapter('gemini-cli');
    expect(adapter).toBeInstanceOf(CLIAdapter);
  });
});

// ---------------------------------------------------------------------------
// CLIAdapter initialization
// ---------------------------------------------------------------------------

describe('CLIAdapter', () => {
  it('should throw if initialized with unsupported runtime', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'crewly-agent', // Not a CLI runtime
      model: 'claude-sonnet-4',
      workDir: tmpDir,
    };
    await expect(adapter.initialize(config)).rejects.toThrow('No CLI defaults');
  });

  it('should throw if runTask called before initialize', async () => {
    const adapter = new CLIAdapter();
    const fakeTask = {
      id: 'test',
      level: 'L4' as const,
      title: 'test',
      prompt: 'test',
      maxSteps: 10,
      timeoutMs: 5000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };
    await expect(adapter.runTask(fakeTask, tmpDir)).rejects.toThrow('not initialized');
  });

  it('should shutdown cleanly', async () => {
    const adapter = new CLIAdapter();
    // Shutdown without init should not throw
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLIAdapter.runTask with a mock CLI
// ---------------------------------------------------------------------------

describe('CLIAdapter.runTask with echo CLI', () => {
  it('should execute a simple command and capture output', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        // Use echo as a mock CLI
        cliCommand: 'echo',
        cliFlags: [],
      },
    };

    await adapter.initialize(config);

    // Create a minimal workspace
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-echo',
      level: 'L4' as const,
      title: 'Echo test',
      prompt: 'hello from eval',
      maxSteps: 10,
      timeoutMs: 10_000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello from eval');
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    expect(result.toolCalls).toBeInstanceOf(Array);

    await adapter.shutdown();
  });

  it('should detect file changes as inferred tool calls', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        // Use bash -c to create a file during "execution"
        cliCommand: 'bash',
        cliFlags: ['-c'],
      },
    };

    await adapter.initialize(config);
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-file-create',
      level: 'L4' as const,
      title: 'File creation test',
      prompt: `touch "${path.join(tmpDir, 'new-file.txt')}"`,
      maxSteps: 10,
      timeoutMs: 10_000,
      expectedTools: ['write_file'],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.success).toBe(true);
    // Should have an inferred write_file tool call
    const writeCall = result.toolCalls.find((tc) => tc.toolName === 'write_file');
    expect(writeCall).toBeDefined();

    await adapter.shutdown();
  });

  it('should parse skill log entries', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        cliCommand: 'bash',
        cliFlags: ['-c'],
      },
    };

    await adapter.initialize(config);

    // Pre-create a tool log (simulating skill shim usage)
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });
    const logEntry = JSON.stringify({
      tool: 'delegate-task',
      args: { to: 'eval-dev-leo', task: 'fix bug' },
      timestamp: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(tmpDir, '.crewly', '.tool-log.jsonl'), logEntry + '\n');

    const task = {
      id: 'test-skill-log',
      level: 'L4' as const,
      title: 'Skill log test',
      prompt: 'echo done',
      maxSteps: 10,
      timeoutMs: 10_000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    // Should include the pre-existing skill log entry
    const skillCall = result.toolCalls.find((tc) => tc.toolName === 'skill:delegate-task');
    expect(skillCall).toBeDefined();
    expect((skillCall?.args as Record<string, unknown>)?.to).toBe('eval-dev-leo');

    await adapter.shutdown();
  });

  it('should handle process timeout', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        cliCommand: 'sleep',
        cliFlags: [],
      },
    };

    await adapter.initialize(config);
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-timeout',
      level: 'L4' as const,
      title: 'Timeout test',
      prompt: '60', // sleep 60 seconds
      maxSteps: 10,
      timeoutMs: 1000, // 1s timeout
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);

    await adapter.shutdown();
  }, 15_000);

  it('should close stdin immediately so CLIs receive EOF', async () => {
    // This test verifies the fix for the Codex CLI stdin hang bug.
    // Codex CLI reads from stdin when piped, and hangs if stdin never closes.
    // The fix: runCLIProcess calls proc.stdin?.end() after spawning.
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        // Use 'cat' which reads from stdin — if stdin isn't closed, it hangs
        cliCommand: 'cat',
        cliFlags: [],
      },
    };

    await adapter.initialize(config);
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-stdin-close',
      level: 'L4' as const,
      title: 'Stdin close test',
      prompt: '/dev/null', // cat /dev/null exits immediately if stdin is closed
      maxSteps: 10,
      timeoutMs: 5000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    // Should complete quickly (not hang for 5s timeout)
    expect(result.durationMs).toBeLessThan(3000);
    expect(result.timedOut).toBe(false);

    await adapter.shutdown();
  }, 10_000);

  it('should detect timeout via duration heuristic', async () => {
    // Test that processes hitting ~95% of timeout are flagged as timed out,
    // even when they exit cleanly (exit code 0) after receiving SIGTERM.
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        cliCommand: 'sleep',
        cliFlags: [],
      },
    };

    await adapter.initialize(config);
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-duration-timeout',
      level: 'L4' as const,
      title: 'Duration timeout detection test',
      prompt: '60',
      maxSteps: 10,
      timeoutMs: 2000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.timedOut).toBe(true);

    await adapter.shutdown();
  }, 15_000);

  it('should handle process error (non-zero exit)', async () => {
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        cliCommand: 'bash',
        cliFlags: ['-c'],
      },
    };

    await adapter.initialize(config);
    fs.mkdirSync(path.join(tmpDir, '.crewly'), { recursive: true });

    const task = {
      id: 'test-error',
      level: 'L4' as const,
      title: 'Error test',
      prompt: 'exit 1',
      maxSteps: 10,
      timeoutMs: 10_000,
      expectedTools: [],
      setup: async () => {},
      verify: async () => ({ passed: true, checks: [] }),
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code');

    await adapter.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Integration: CLIAdapter + L4-C1 setup/verify
// ---------------------------------------------------------------------------

describe('CLIAdapter + L4-C1 integration', () => {
  it('should set up workspace and run verification after mock CLI', async () => {
    // Import L4-C1 task
    const { L4_TASKS } = await import('../tasks/l4-tasks.js');
    const c1 = L4_TASKS.find((t) => t.id === 'L4-C1');
    expect(c1).toBeDefined();

    // Set up the workspace
    await c1!.setup(tmpDir);

    // Verify workspace structure
    expect(fs.existsSync(path.join(tmpDir, 'CONTEXT.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'skills', 'delegate-task.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.crewly', 'tasks', 'task-frontend-bug.md'))).toBe(true);

    // Simulate what a CLI agent would do: run the skill shims
    const adapter = new CLIAdapter();
    const config: AdapterConfig = {
      runtimeId: 'claude-code',
      model: 'claude-sonnet-4',
      workDir: tmpDir,
      options: {
        cliCommand: 'bash',
        cliFlags: ['-c'],
      },
    };
    await adapter.initialize(config);

    // Simulate: agent reads CONTEXT.md, delegates to Leo, reports status
    const script = [
      `cd "${tmpDir}"`,
      `bash skills/delegate-task.sh '{"to":"eval-dev-leo","task":"fix button","priority":"high"}'`,
      `bash skills/delegate-task.sh '{"to":"eval-dev-leo","task":"add pagination","priority":"medium"}'`,
      `bash skills/report-status.sh '{"status":"complete","summary":"triaged all tasks"}'`,
    ].join(' && ');

    const task = {
      ...c1!,
      prompt: script,
      setup: async () => {}, // Already set up
    };

    const result = await adapter.runTask(task, tmpDir);

    expect(result.success).toBe(true);

    // Verify the skill log was written
    expect(fs.existsSync(path.join(tmpDir, '.crewly', '.tool-log.jsonl'))).toBe(true);

    // Skill calls should be in tool calls
    const delegateCalls = result.toolCalls.filter(
      (tc) => tc.toolName === 'skill:delegate-task',
    );
    expect(delegateCalls.length).toBeGreaterThanOrEqual(2);

    // Now run verification with the actual tool calls
    const verification = await c1!.verify(tmpDir, result.toolCalls);

    // Delegation checks should pass (delegated to Leo, not Max)
    const activeCheck = verification.collaborationChecks?.find(
      (c) => c.name === 'delegated_to_active_worker',
    );
    expect(activeCheck?.passed).toBe(true);

    const leoCheck = verification.collaborationChecks?.find(
      (c) => c.name === 'delegated_to_leo',
    );
    expect(leoCheck?.passed).toBe(true);

    await adapter.shutdown();
  });
});
