/**
 * Desktop App Control Skill Tests
 *
 * Tests for the agent-browser wrapper skill that controls
 * Electron desktop apps and Chrome browsers via CDP.
 *
 * Hermetic: every run gets a temp HOME (so the audit log never lands in the
 * real ~/.crewly), a fixture applications directory (CREWLY_APPLICATIONS_DIR)
 * holding a fake Electron app and a fake Chrome, and a stub `agent-browser`
 * on PATH. The suite therefore behaves the same on a Linux CI runner as on
 * a Mac, whatever is installed there.
 *
 * @module config/skills/agent/desktop-app-control/tests/desktop-app-control.test
 */

import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const EXECUTE_SH = join(SKILL_DIR, 'execute.sh');

/** Version string the stub `agent-browser` reports. */
const STUB_VERSION = 'agent-browser 0.0.0-test';
/** Name of the fixture Electron app placed in the applications directory. */
const FIXTURE_ELECTRON_APP = 'Fixture Electron App';

let sandbox: string;
let fakeHome: string;
let fakeAppsDir: string;
let stubBin: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'desktop-app-control-'));
  fakeHome = join(sandbox, 'home');
  fakeAppsDir = join(sandbox, 'Applications');
  stubBin = join(sandbox, 'bin');
  mkdirSync(fakeHome, { recursive: true });
  // An Electron app is recognised by its bundled Electron framework.
  mkdirSync(join(fakeAppsDir, `${FIXTURE_ELECTRON_APP}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  // A known Chromium browser is recognised by its bundle name alone.
  mkdirSync(join(fakeAppsDir, 'Google Chrome.app'), { recursive: true });
  // A plain app without the Electron framework must not be reported.
  mkdirSync(join(fakeAppsDir, 'Plain Native App.app', 'Contents'), { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  const stub = join(stubBin, 'agent-browser');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `if [ "\${1:-}" = "--version" ]; then echo "${STUB_VERSION}"; exit 0; fi`,
    'if [ "${1:-}" = "session" ] && [ "${2:-}" = "list" ]; then echo "no active sessions"; exit 0; fi',
    'echo "stub agent-browser: $*"',
    '',
  ].join('\n'));
  chmodSync(stub, 0o755);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Run execute.sh with args and return stdout.
 *
 * @param args - Command line arguments
 * @param expectFailure - If true, capture stderr on non-zero exit
 * @param env - Environment overrides (merged over the hermetic defaults)
 * @returns stdout + stderr output
 */
function runSkill(args: string, expectFailure = false, env: NodeJS.ProcessEnv = {}): string {
  try {
    return execSync(`bash "${EXECUTE_SH}" ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        HOME: fakeHome,
        CREWLY_APPLICATIONS_DIR: fakeAppsDir,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        ...env,
      },
    }).trim();
  } catch (error: unknown) {
    if (expectFailure) {
      const err = error as { stdout?: string; stderr?: string };
      return (err.stdout || '') + (err.stderr || '');
    }
    throw error;
  }
}

// =============================================================================
// Skill Structure
// =============================================================================

describe('Skill Structure', () => {
  it('should have execute.sh', () => {
    expect(existsSync(EXECUTE_SH)).toBe(true);
  });

  it('should have SKILL.md with frontmatter and instructions', () => {
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true);
  });
});

// =============================================================================
// Skill Metadata (parsed from SKILL.md YAML frontmatter)
// =============================================================================

/**
 * Parse YAML frontmatter from SKILL.md into a plain object.
 * Simple parser for key: value and list items.
 *
 * @param raw - Raw SKILL.md content
 * @returns Parsed frontmatter object and markdown body
 */
function parseSkillMd(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const yaml = match[1];
  const body = match[2];
  const meta: Record<string, unknown> = {};
  let currentKey = '';
  let currentList: string[] | null = null;
  for (const line of yaml.split('\n')) {
    const listMatch = line.match(/^  - (.+)$/);
    if (listMatch && currentKey) {
      if (!currentList) { currentList = []; meta[currentKey] = currentList; }
      currentList.push(listMatch[1]);
      continue;
    }
    const kvMatch = line.match(/^(\w[\w.]*?):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      currentList = null;
      const val = kvMatch[2].replace(/^["']|["']$/g, '').trim();
      if (val) meta[currentKey] = val;
    }
  }
  return { meta, body };
}

describe('Skill Metadata', () => {
  let metadata: Record<string, unknown>;
  let instructions: string;

  beforeAll(() => {
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw);
    metadata = parsed.meta;
    instructions = parsed.body;
  });

  it('should have name containing "Desktop App Control"', () => {
    expect(metadata.name).toContain('Desktop App Control');
  });

  it('should have execution type "script"', () => {
    // execution block is nested YAML; check raw string
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('type: script');
  });

  it('should include key triggers', () => {
    const triggers = metadata.triggers as string[];
    expect(triggers).toContain('electron');
    expect(triggers).toContain('agent-browser');
    expect(triggers).toContain('cdp');
  });
});

// =============================================================================
// Syntax
// =============================================================================

describe('Shell Script Syntax', () => {
  it('execute.sh should pass bash syntax check', () => {
    const result = execSync(`bash -n "${EXECUTE_SH}" 2>&1`, {
      encoding: 'utf-8',
    });
    expect(result.trim()).toBe('');
  });
});

// =============================================================================
// Help Output
// =============================================================================

describe('Help Output', () => {
  it('should show usage when no subcommand given', () => {
    const output = runSkill('', true);
    expect(output).toContain('Usage');
    expect(output).toContain('scan');
    expect(output).toContain('snapshot');
    expect(output).toContain('click');
    expect(output).toContain('connect');
  });
});

// =============================================================================
// Error Handling
// =============================================================================

describe('Error Handling', () => {
  it('should error on unknown subcommand', () => {
    const output = runSkill('nonexistent', true);
    expect(output).toContain('error');
    expect(output).toContain('Unknown subcommand');
  });

  it('should error when --port missing for connect', () => {
    const output = runSkill('connect', true);
    expect(output).toContain('error');
    expect(output).toContain('--port');
  });

  it('should error when --ref missing for click', () => {
    const output = runSkill('click', true);
    expect(output).toContain('error');
    expect(output).toContain('--ref');
  });

  it('should error when --ref missing for fill', () => {
    const output = runSkill('fill', true);
    expect(output).toContain('error');
    expect(output).toContain('--ref');
  });

  it('should error when --key missing for press', () => {
    const output = runSkill('press', true);
    expect(output).toContain('error');
    expect(output).toContain('--key');
  });

  it('should error when --text missing for type-text', () => {
    const output = runSkill('type-text', true);
    expect(output).toContain('error');
    expect(output).toContain('--text');
  });

  it('should error when --ref missing for get-text', () => {
    const output = runSkill('get-text', true);
    expect(output).toContain('error');
    expect(output).toContain('--ref');
  });

  it('should error when --code missing for eval', () => {
    const output = runSkill('eval', true);
    expect(output).toContain('error');
    expect(output).toContain('--code');
  });

  it('should error when --app missing for launch', () => {
    const output = runSkill('launch', true);
    expect(output).toContain('error');
    expect(output).toContain('--app');
  });
});

// =============================================================================
// Integration: scan
// =============================================================================

describe('Integration: scan', () => {
  it('should return valid JSON with apps array', () => {
    const output = runSkill('scan');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('scan');
    expect(Array.isArray(data.apps)).toBe(true);
  });

  it('should detect at least one Electron app', () => {
    const output = runSkill('scan');
    const data = JSON.parse(output);
    const electronApps = data.apps.filter((a: { type: string }) => a.type === 'electron');
    expect(electronApps.length).toBeGreaterThan(0);
    expect(electronApps.map((a: { name: string }) => a.name)).toContain(FIXTURE_ELECTRON_APP);
  });

  it('should detect an installed Chromium browser and ignore non-Electron apps', () => {
    const output = runSkill('scan');
    const data = JSON.parse(output);
    const names = data.apps.map((a: { name: string }) => a.name);
    expect(data.apps).toContainEqual(expect.objectContaining({ name: 'Google Chrome', type: 'browser', defaultPort: 9226 }));
    expect(names).not.toContain('Plain Native App');
  });

  it('should include required fields for each app', () => {
    const output = runSkill('scan');
    const data = JSON.parse(output);
    for (const app of data.apps) {
      expect(app.name).toBeDefined();
      expect(app.type).toBeDefined();
      expect(typeof app.installed).toBe('boolean');
      expect(typeof app.running).toBe('boolean');
      expect(typeof app.cdpActive).toBe('boolean');
    }
  });

  it('should have activeCdpPorts array', () => {
    const output = runSkill('scan');
    const data = JSON.parse(output);
    expect(Array.isArray(data.activeCdpPorts)).toBe(true);
  });
});

// =============================================================================
// Integration: status
// =============================================================================

describe('Integration: status', () => {
  it('should return agent-browser version', () => {
    const output = runSkill('status');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('status');
    expect(data.version).toContain('agent-browser');
    expect(data.version).toBe(STUB_VERSION);
  });

  it('should explain how to install agent-browser when it is missing', () => {
    // System directories only: no stub, and no globally installed copy.
    const output = runSkill('status', true, { PATH: '/usr/bin:/bin' });
    expect(output).toContain('agent-browser not installed');
    expect(output).toContain('npm install -g agent-browser');
  });
});

// =============================================================================
// Audit Logging
// =============================================================================

describe('Audit Logging', () => {
  const logFile = (): string => join(fakeHome, '.crewly', 'logs', 'desktop-app-control.log');

  it('should write to audit log file', () => {
    // Run scan to trigger logging
    runSkill('scan');
    runSkill('status');
    expect(existsSync(logFile())).toBe(true);
  });

  it('should include timestamps in log', () => {
    const content = readFileSync(logFile(), 'utf-8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    expect(content).toContain('scan');
  });
});

// =============================================================================
// Instructions Documentation
// =============================================================================

describe('Instructions Documentation (from SKILL.md body)', () => {
  let instructions: string;

  beforeAll(() => {
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    // Extract body after YAML frontmatter
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    instructions = match ? match[1] : raw;
  });

  it('should document all subcommands', () => {
    const cmds = [
      'scan', 'launch', 'connect', 'snapshot', 'click', 'fill',
      'press', 'screenshot', 'get-text', 'scroll', 'tabs', 'close', 'status',
    ];
    for (const cmd of cmds) {
      expect(instructions).toContain(cmd);
    }
  });

  it('should document safety rules', () => {
    expect(instructions).toContain('Safety Rules');
    expect(instructions).toContain('NEVER close or kill');
  });

  it('should document multi-app sessions', () => {
    expect(instructions).toContain('--session');
    expect(instructions).toContain('Multi-App');
  });

  it('should document requirements', () => {
    expect(instructions).toContain('agent-browser');
    expect(instructions).toContain('npm install');
  });
});
