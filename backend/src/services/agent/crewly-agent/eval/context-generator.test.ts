/**
 * Tests for the Eval Context Generator.
 *
 * Verifies CONTEXT.md generation, team config generation, and
 * full workspace setup for runtime-agnostic L4 eval tasks.
 *
 * @module eval/context-generator.test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  generateContextMarkdown,
  generateTeamConfig,
  setupEvalWorkspace,
  DEFAULT_EVAL_TEAM,
  type EvalContextConfig,
} from './context-generator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ctx-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateContextMarkdown
// ---------------------------------------------------------------------------

describe('generateContextMarkdown', () => {
  it('should include agent identity', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('You are **Sam**');
    expect(md).toContain('Team Lead');
    expect(md).toContain('Eval Product Team');
  });

  it('should include all team members in the table', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('| Sam |');
    expect(md).toContain('| Leo |');
    expect(md).toContain('| Max |');
  });

  it('should show session names for skill commands', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('eval-tl-sam');
    expect(md).toContain('eval-dev-leo');
    expect(md).toContain('eval-dev-max');
  });

  it('should show inactive status with dash workload', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('| inactive | — |');
  });

  it('should list all 6 skill commands', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('delegate-task.sh');
    expect(md).toContain('send-message.sh');
    expect(md).toContain('get-team-status.sh');
    expect(md).toContain('verify-output.sh');
    expect(md).toContain('report-status.sh');
    expect(md).toContain('handle-failure.sh');
  });

  it('should include project layout section', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).toContain('.crewly/tasks/');
    expect(md).toContain('.crewly/knowledge/');
    expect(md).toContain('.crewly/reports/');
  });

  it('should append extra instructions when provided', () => {
    const config: EvalContextConfig = {
      ...DEFAULT_EVAL_TEAM,
      extraInstructions: 'This is a trap task. Be careful.',
    };
    const md = generateContextMarkdown(config);
    expect(md).toContain('Additional Instructions');
    expect(md).toContain('This is a trap task. Be careful.');
  });

  it('should not include extra section when not provided', () => {
    const md = generateContextMarkdown(DEFAULT_EVAL_TEAM);
    expect(md).not.toContain('Additional Instructions');
  });

  it('should work with custom team configuration', () => {
    const custom: EvalContextConfig = {
      agentName: 'Alice',
      agentRole: 'Orchestrator',
      teamName: 'Research Team',
      teamId: 'research-001',
      members: [
        {
          name: 'Alice',
          role: 'Orchestrator',
          sessionName: 'eval-orc-alice',
          agentStatus: 'active',
          workingStatus: 'idle',
        },
        {
          name: 'Bob',
          role: 'Researcher',
          sessionName: 'eval-res-bob',
          agentStatus: 'active',
          workingStatus: 'in_progress',
        },
      ],
    };
    const md = generateContextMarkdown(custom);
    expect(md).toContain('You are **Alice**');
    expect(md).toContain('Research Team');
    expect(md).toContain('| Bob |');
    expect(md).toContain('in_progress');
  });
});

// ---------------------------------------------------------------------------
// generateTeamConfig
// ---------------------------------------------------------------------------

describe('generateTeamConfig', () => {
  it('should produce valid JSON', () => {
    const json = generateTeamConfig(DEFAULT_EVAL_TEAM);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should include team id and name', () => {
    const config = JSON.parse(generateTeamConfig(DEFAULT_EVAL_TEAM));
    expect(config.id).toBe('eval-team-001');
    expect(config.name).toBe('Eval Product Team');
  });

  it('should include all members with correct fields', () => {
    const config = JSON.parse(generateTeamConfig(DEFAULT_EVAL_TEAM));
    expect(config.members).toHaveLength(3);

    const sam = config.members[0];
    expect(sam.name).toBe('Sam');
    expect(sam.role).toBe('team-lead');
    expect(sam.sessionName).toBe('eval-tl-sam');
    expect(sam.agentStatus).toBe('active');
  });

  it('should generate sequential member IDs', () => {
    const config = JSON.parse(generateTeamConfig(DEFAULT_EVAL_TEAM));
    expect(config.members[0].id).toBe('member-001');
    expect(config.members[1].id).toBe('member-002');
    expect(config.members[2].id).toBe('member-003');
  });

  it('should convert role to lowercase kebab-case', () => {
    const config = JSON.parse(generateTeamConfig(DEFAULT_EVAL_TEAM));
    expect(config.members[0].role).toBe('team-lead');
    expect(config.members[1].role).toBe('developer');
  });
});

// ---------------------------------------------------------------------------
// setupEvalWorkspace
// ---------------------------------------------------------------------------

describe('setupEvalWorkspace', () => {
  it('should create CONTEXT.md', async () => {
    await setupEvalWorkspace(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'CONTEXT.md'))).toBe(true);
  });

  it('should create team-config.json', async () => {
    await setupEvalWorkspace(tmpDir);
    const configPath = path.join(tmpDir, '.crewly', 'teams', 'team-config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.members).toHaveLength(3);
  });

  it('should create all required directories', async () => {
    await setupEvalWorkspace(tmpDir);
    const expectedDirs = [
      '.crewly/tasks',
      '.crewly/knowledge',
      '.crewly/teams',
      '.crewly/messages',
      '.crewly/reports',
      'skills',
      'src/services',
      'src/controllers',
      'src/utils',
    ];
    for (const d of expectedDirs) {
      expect(fs.existsSync(path.join(tmpDir, d))).toBe(true);
    }
  });

  it('should copy skill shim scripts', async () => {
    await setupEvalWorkspace(tmpDir);
    const scripts = [
      '_log.sh',
      'delegate-task.sh',
      'send-message.sh',
      'get-team-status.sh',
      'verify-output.sh',
      'report-status.sh',
      'handle-failure.sh',
    ];
    for (const script of scripts) {
      const scriptPath = path.join(tmpDir, 'skills', script);
      expect(fs.existsSync(scriptPath)).toBe(true);
      // Check executable bit
      const stat = fs.statSync(scriptPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('should create default project files', async () => {
    await setupEvalWorkspace(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src', 'services', 'data.service.ts'))).toBe(true);
  });

  it('should create knowledge base files', async () => {
    await setupEvalWorkspace(tmpDir);
    expect(
      fs.existsSync(path.join(tmpDir, '.crewly', 'knowledge', 'project-patterns.md')),
    ).toBe(true);
  });

  it('should skip project files when option set', async () => {
    await setupEvalWorkspace(tmpDir, DEFAULT_EVAL_TEAM, { skipProjectFiles: true });
    expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'tsconfig.json'))).toBe(false);
  });

  it('should skip knowledge when option set', async () => {
    await setupEvalWorkspace(tmpDir, DEFAULT_EVAL_TEAM, { skipKnowledge: true });
    expect(
      fs.existsSync(path.join(tmpDir, '.crewly', 'knowledge', 'project-patterns.md')),
    ).toBe(false);
  });

  it('should work with custom config', async () => {
    const custom: EvalContextConfig = {
      agentName: 'TestAgent',
      agentRole: 'QA',
      teamName: 'Test Team',
      teamId: 'test-001',
      members: [
        {
          name: 'TestAgent',
          role: 'QA',
          sessionName: 'eval-qa-test',
          agentStatus: 'active',
          workingStatus: 'idle',
        },
      ],
    };
    await setupEvalWorkspace(tmpDir, custom);

    const contextMd = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf-8');
    expect(contextMd).toContain('TestAgent');
    expect(contextMd).toContain('Test Team');

    const teamConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.crewly', 'teams', 'team-config.json'), 'utf-8'),
    );
    expect(teamConfig.id).toBe('test-001');
    expect(teamConfig.members).toHaveLength(1);
  });
});
