/**
 * Tests for Project Scaffolding Utilities
 *
 * Covers detectProjectType, getPresetTeam, generateGoalsContent,
 * generateTeamConfig, and writeProjectScaffold.
 *
 * @module cli/utils/project-scaffold.test
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import * as os from 'os';
import {
  detectProjectType,
  getPresetTeam,
  generateGoalsContent,
  generateTeamConfig,
  writeProjectScaffold,
  PRESET_TEAMS,
  type ProjectType,
  type PresetTeam,
} from './project-scaffold.js';

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

const TEST_ROOT = join(
  os.tmpdir(),
  `crewly-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

function makeTempDir(name: string): string {
  const dir = join(TEST_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectProjectType
// ---------------------------------------------------------------------------

describe('detectProjectType', () => {
  it('should detect a Node.js project with package.json', () => {
    const dir = makeTempDir('node-basic');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

    const result = detectProjectType(dir);

    expect(result.type).toBe('node');
    expect(result.label).toContain('Node');
    expect(result.projectName).toBe('my-app');
    expect(result.signals).toContain('package.json');
  });

  it('should detect a Node.js project with tsconfig.json', () => {
    const dir = makeTempDir('node-ts');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ts-app' }));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    const result = detectProjectType(dir);

    expect(result.type).toBe('node');
    expect(result.signals).toContain('tsconfig.json');
  });

  it('should detect a Python project with requirements.txt', () => {
    const dir = makeTempDir('python-req');
    writeFileSync(join(dir, 'requirements.txt'), 'flask==2.0\n');

    const result = detectProjectType(dir);

    expect(result.type).toBe('python');
    expect(result.label).toBe('Python');
    expect(result.signals).toContain('requirements.txt');
  });

  it('should extract project name from setup.py', () => {
    const dir = makeTempDir('python-setup');
    writeFileSync(join(dir, 'setup.py'), "setup(name='my-python-lib')");

    const result = detectProjectType(dir);

    expect(result.type).toBe('python');
    expect(result.projectName).toBe('my-python-lib');
  });

  it('should extract project name from pyproject.toml', () => {
    const dir = makeTempDir('python-pyproject');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "cool-tool"\n');

    const result = detectProjectType(dir);

    expect(result.type).toBe('python');
    expect(result.projectName).toBe('cool-tool');
  });

  it('should prefer Node.js when both Node and Python signals exist but Node has more', () => {
    const dir = makeTempDir('mixed');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mixed' }));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'requirements.txt'), 'flask\n');

    const result = detectProjectType(dir);

    expect(result.type).toBe('node');
  });

  it('should return generic for empty directory', () => {
    const dir = makeTempDir('empty');

    const result = detectProjectType(dir);

    expect(result.type).toBe('generic');
    expect(result.label).toBe('General');
    expect(result.signals).toHaveLength(0);
  });

  it('should use directory basename when package.json has no name', () => {
    const dir = makeTempDir('unnamed-pkg');
    writeFileSync(join(dir, 'package.json'), '{}');

    const result = detectProjectType(dir);

    expect(result.projectName).toBe('unnamed-pkg');
  });

  it('should handle malformed package.json gracefully', () => {
    const dir = makeTempDir('bad-json');
    writeFileSync(join(dir, 'package.json'), 'not json {{{');

    const result = detectProjectType(dir);

    expect(result.type).toBe('node');
    expect(result.projectName).toBe('bad-json');
  });

  it('should detect Pipfile as a Python signal', () => {
    const dir = makeTempDir('python-pipfile');
    writeFileSync(join(dir, 'Pipfile'), '[packages]\n');

    const result = detectProjectType(dir);

    expect(result.type).toBe('python');
    expect(result.signals).toContain('Pipfile');
  });
});

// ---------------------------------------------------------------------------
// getPresetTeam
// ---------------------------------------------------------------------------

describe('getPresetTeam', () => {
  it('should return dev-team preset', () => {
    const preset = getPresetTeam('dev-team');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Dev Team');
    expect(preset!.members.length).toBeGreaterThan(0);
  });

  it('should return content-agency preset', () => {
    const preset = getPresetTeam('content-agency');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Content Agency');
  });

  it('should return support-team preset', () => {
    const preset = getPresetTeam('support-team');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Support Team');
  });

  it('should return undefined for unknown ID', () => {
    expect(getPresetTeam('nonexistent')).toBeUndefined();
  });

  it('should have unique IDs across all presets', () => {
    const ids = PRESET_TEAMS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// generateGoalsContent
// ---------------------------------------------------------------------------

describe('generateGoalsContent', () => {
  it('should include project name in title', () => {
    const content = generateGoalsContent('my-app', 'node');
    expect(content).toContain('# my-app - Project Goals');
  });

  it('should include project type', () => {
    const content = generateGoalsContent('my-app', 'python');
    expect(content).toContain('Project type: python');
  });

  it('should include preset goals when provided', () => {
    const preset = getPresetTeam('dev-team')!;
    const content = generateGoalsContent('my-app', 'node', preset);

    expect(content).toContain(`## Team: ${preset.name}`);
    for (const goal of preset.suggestedGoals) {
      expect(content).toContain(`- [ ] ${goal}`);
    }
  });

  it('should include milestone sections even without preset', () => {
    const content = generateGoalsContent('my-app', 'generic');
    expect(content).toContain('## Milestones');
    expect(content).toContain('### Phase 1: Setup');
    expect(content).toContain('### Phase 2: Execution');
  });

  it('should include notes section', () => {
    const content = generateGoalsContent('my-app', 'node');
    expect(content).toContain('## Notes');
  });
});

// ---------------------------------------------------------------------------
// generateTeamConfig
// ---------------------------------------------------------------------------

describe('generateTeamConfig', () => {
  const preset: PresetTeam = {
    id: 'test-team',
    name: 'Test Team',
    description: 'A test team',
    members: [
      { name: 'Dev', role: 'developer', systemPrompt: 'You are a dev.' },
      { name: 'QA', role: 'qa', systemPrompt: 'You are QA.' },
    ],
    suggestedGoals: ['Ship code'],
  };

  it('should generate a team ID from project name and preset ID', () => {
    const config = generateTeamConfig(preset, 'My App');
    expect(config.id).toBe('my-app-test-team');
  });

  it('should generate correct number of members', () => {
    const config = generateTeamConfig(preset, 'my-app');
    expect((config.members as unknown[]).length).toBe(2);
  });

  it('should assign unique session names to each member', () => {
    const config = generateTeamConfig(preset, 'my-app');
    const members = config.members as Array<{ sessionName: string }>;
    const sessionNames = members.map(m => m.sessionName);
    expect(new Set(sessionNames).size).toBe(sessionNames.length);
  });

  it('should sanitize project name in session names (remove special chars)', () => {
    const config = generateTeamConfig(preset, 'My App @2.0!');
    const members = config.members as Array<{ sessionName: string }>;
    for (const m of members) {
      expect(m.sessionName).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('should set default agent and working status', () => {
    const config = generateTeamConfig(preset, 'my-app');
    const members = config.members as Array<{ agentStatus: string; workingStatus: string }>;
    for (const m of members) {
      expect(m.agentStatus).toBe('inactive');
      expect(m.workingStatus).toBe('idle');
    }
  });

  it('should include timestamps', () => {
    const config = generateTeamConfig(preset, 'my-app');
    expect(config.createdAt).toBeDefined();
    expect(config.updatedAt).toBeDefined();
  });

  it('should default runtimeType to claude-code when not specified', () => {
    const config = generateTeamConfig(preset, 'my-app');
    const members = config.members as Array<{ runtimeType: string }>;
    for (const m of members) {
      expect(m.runtimeType).toBe('claude-code');
    }
  });

  it('#246: should use provided runtimeType for all members', () => {
    const config = generateTeamConfig(preset, 'my-app', 'codex-cli');
    const members = config.members as Array<{ runtimeType: string }>;
    for (const m of members) {
      expect(m.runtimeType).toBe('codex-cli');
    }
  });

  it('#246: should support gemini-cli runtimeType', () => {
    const config = generateTeamConfig(preset, 'my-app', 'gemini-cli');
    const members = config.members as Array<{ runtimeType: string }>;
    for (const m of members) {
      expect(m.runtimeType).toBe('gemini-cli');
    }
  });
});

// ---------------------------------------------------------------------------
// writeProjectScaffold
// ---------------------------------------------------------------------------

describe('writeProjectScaffold', () => {
  const preset = getPresetTeam('dev-team')!;
  const detection = {
    type: 'node' as ProjectType,
    label: 'Node.js / TypeScript',
    projectName: 'scaffold-test',
    signals: ['package.json'],
  };

  it('should create .crewly directory structure', () => {
    const dir = makeTempDir('scaffold-dirs');
    mkdirSync(join(dir, '.crewly'), { recursive: true });

    const result = writeProjectScaffold(dir, preset, detection);

    expect(result.dirsCreated).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'docs'))).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'memory'))).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'tasks'))).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'teams'))).toBe(true);
  });

  it('should create team.json and goals.md', () => {
    const dir = makeTempDir('scaffold-files');
    mkdirSync(join(dir, '.crewly'), { recursive: true });

    const result = writeProjectScaffold(dir, preset, detection);

    expect(result.teamJsonCreated).toBe(true);
    expect(result.goalsCreated).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'team.json'))).toBe(true);
    expect(existsSync(join(dir, '.crewly', 'goals.md'))).toBe(true);
  });

  it('should produce valid JSON in team.json', () => {
    const dir = makeTempDir('scaffold-json');
    mkdirSync(join(dir, '.crewly'), { recursive: true });

    writeProjectScaffold(dir, preset, detection);

    const raw = readFileSync(join(dir, '.crewly', 'team.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toContain('scaffold-test');
    expect(Array.isArray(parsed.members)).toBe(true);
  });

  it('should not overwrite existing team.json', () => {
    const dir = makeTempDir('scaffold-no-overwrite');
    mkdirSync(join(dir, '.crewly'), { recursive: true });
    writeFileSync(join(dir, '.crewly', 'team.json'), '{"existing": true}');

    const result = writeProjectScaffold(dir, preset, detection);

    expect(result.teamJsonCreated).toBe(false);
    const raw = readFileSync(join(dir, '.crewly', 'team.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ existing: true });
  });

  it('should not overwrite existing goals.md', () => {
    const dir = makeTempDir('scaffold-no-overwrite-goals');
    mkdirSync(join(dir, '.crewly'), { recursive: true });
    writeFileSync(join(dir, '.crewly', 'goals.md'), '# Existing goals');

    const result = writeProjectScaffold(dir, preset, detection);

    expect(result.goalsCreated).toBe(false);
    const content = readFileSync(join(dir, '.crewly', 'goals.md'), 'utf-8');
    expect(content).toBe('# Existing goals');
  });

  it('should create config.env stub', () => {
    const dir = makeTempDir('scaffold-config-env');
    mkdirSync(join(dir, '.crewly'), { recursive: true });

    writeProjectScaffold(dir, preset, detection);

    expect(existsSync(join(dir, '.crewly', 'config.env'))).toBe(true);
    const content = readFileSync(join(dir, '.crewly', 'config.env'), 'utf-8');
    expect(content).toContain('Crewly configuration');
  });
});
