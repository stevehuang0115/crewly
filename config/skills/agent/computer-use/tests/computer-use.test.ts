/**
 * Computer Use Skill Tests
 *
 * Tests for the Agent Browser universal desktop control skill.
 * Includes unit tests for each subcommand (syntax validation,
 * help output) and integration tests (list-apps, screenshot).
 *
 * @module config/skills/agent/computer-use/tests/computer-use.test
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const EXECUTE_SH = join(SKILL_DIR, 'execute.sh');
const LIB_DIR = join(SKILL_DIR, 'lib');

/**
 * Helper to run execute.sh with args and return stdout.
 *
 * @param args - Command line arguments
 * @param expectFailure - If true, don't throw on non-zero exit
 * @returns stdout output
 */
function runSkill(args: string, expectFailure = false): string {
  try {
    return execSync(`bash "${EXECUTE_SH}" ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: process.env.HOME },
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
// File Structure Tests
// =============================================================================

describe('Skill Structure', () => {
  it('should have execute.sh', () => {
    expect(existsSync(EXECUTE_SH)).toBe(true);
  });

  it('should have SKILL.md with frontmatter and instructions', () => {
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  it('should have lib/ directory with all modules', () => {
    const libs = ['discover.sh', 'applescript.sh', 'accessibility.sh', 'screenshot.sh', 'playwright.sh'];
    for (const lib of libs) {
      expect(existsSync(join(LIB_DIR, lib))).toBe(true);
    }
  });
});

// =============================================================================
// Skill Metadata Tests (parsed from SKILL.md YAML frontmatter)
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

  beforeAll(() => {
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw);
    metadata = parsed.meta;
  });

  it('should have name containing "Desktop Control"', () => {
    expect(metadata.name).toContain('Desktop Control');
  });

  it('should have execution type "script"', () => {
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('type: script');
  });

  it('should have triggers array with more than 5 items', () => {
    expect(Array.isArray(metadata.triggers)).toBe(true);
    expect((metadata.triggers as string[]).length).toBeGreaterThan(5);
  });

  it('should include key triggers', () => {
    const triggers = metadata.triggers as string[];
    expect(triggers).toContain('computer use');
    expect(triggers).toContain('screenshot');
    expect(triggers).toContain('applescript');
    expect(triggers).toContain('accessibility');
    expect(triggers).toContain('playwright');
  });

  it('should have version 1.0.0', () => {
    expect(metadata.version).toBe('1.0.0');
  });
});

// =============================================================================
// Shell Script Syntax Tests
// =============================================================================

describe('Shell Script Syntax', () => {
  const scripts = [
    'execute.sh',
    'lib/discover.sh',
    'lib/applescript.sh',
    'lib/accessibility.sh',
    'lib/screenshot.sh',
    'lib/playwright.sh',
  ];

  for (const script of scripts) {
    it(`${script} should pass bash syntax check`, () => {
      const result = execSync(`bash -n "${join(SKILL_DIR, script)}" 2>&1`, {
        encoding: 'utf-8',
      });
      expect(result.trim()).toBe('');
    });
  }
});

// =============================================================================
// Help / Usage Tests
// =============================================================================

describe('Help Output', () => {
  it('should show usage when no subcommand given', () => {
    const output = runSkill('', true);
    expect(output).toContain('Usage');
    expect(output).toContain('list-apps');
    expect(output).toContain('screenshot');
    expect(output).toContain('applescript');
    expect(output).toContain('chrome-connect');
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  it('should error on unknown subcommand', () => {
    const output = runSkill('nonexistent-command', true);
    expect(output).toContain('error');
    expect(output).toContain('Unknown subcommand');
  });

  it('should error when --app missing for ui-tree', () => {
    const output = runSkill('ui-tree', true);
    expect(output).toContain('error');
    expect(output).toContain('--app');
  });

  it('should error when --app missing for app-info', () => {
    const output = runSkill('app-info', true);
    expect(output).toContain('error');
    expect(output).toContain('--app');
  });

  it('should error when --text missing for type', () => {
    const output = runSkill('type', true);
    expect(output).toContain('error');
    expect(output).toContain('--text');
  });

  it('should error when --app missing for get-text', () => {
    const output = runSkill('get-text', true);
    expect(output).toContain('error');
    expect(output).toContain('--app');
  });

  it('should error when --code and --preset both missing for applescript', () => {
    const output = runSkill('applescript', true);
    expect(output).toContain('error');
    expect(output).toContain('--code');
  });

  it('should error when --code missing for chrome-eval', () => {
    const output = runSkill('chrome-eval', true);
    expect(output).toContain('error');
    expect(output).toContain('--code');
  });
});

// =============================================================================
// Integration Tests — list-apps
// =============================================================================

describe('Integration: list-apps', () => {
  it('should return valid JSON with apps array', () => {
    const output = runSkill('list-apps');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('list-apps');
    expect(Array.isArray(data.apps)).toBe(true);
  });

  it('should include app name and bundleId for each app', () => {
    const output = runSkill('list-apps');
    const data = JSON.parse(output);
    for (const app of data.apps) {
      expect(app.name).toBeDefined();
      expect(typeof app.name).toBe('string');
      expect(app.bundleId).toBeDefined();
    }
  });

  it('should include methods array for each app', () => {
    const output = runSkill('list-apps');
    const data = JSON.parse(output);
    for (const app of data.apps) {
      expect(Array.isArray(app.methods)).toBe(true);
      expect(app.methods.length).toBeGreaterThan(0);
      expect(app.methods).toContain('accessibility');
    }
  });

  it('should include controllable flag', () => {
    const output = runSkill('list-apps');
    const data = JSON.parse(output);
    for (const app of data.apps) {
      expect(app.controllable).toBe(true);
    }
  });

  it('should detect Finder as having applescript method', () => {
    const output = runSkill('list-apps');
    const data = JSON.parse(output);
    const finder = data.apps.find((a: { name: string }) => a.name === 'Finder');
    if (finder) {
      expect(finder.methods).toContain('applescript');
    }
  });
});

// =============================================================================
// Integration Tests — screenshot
// =============================================================================

describe('Integration: screenshot', () => {
  const testOutput = '/tmp/test-computer-use-screenshot.png';

  afterEach(() => {
    try {
      if (existsSync(testOutput)) unlinkSync(testOutput);
    } catch {
      // Best effort cleanup
    }
  });

  it('should capture a screenshot file', () => {
    const output = runSkill(`screenshot --output ${testOutput}`);
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('screenshot');
    expect(data.file).toBe(testOutput);
    expect(existsSync(testOutput)).toBe(true);
  });

  it('should return file size > 0', () => {
    const output = runSkill(`screenshot --output ${testOutput}`);
    const data = JSON.parse(output);
    expect(data.size).toBeGreaterThan(0);
    const stat = statSync(testOutput);
    expect(stat.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// Integration Tests — check-access
// =============================================================================

describe('Integration: check-access', () => {
  it('should return valid JSON with trusted field', () => {
    const output = runSkill('check-access');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('check-access');
    expect(typeof data.trusted).toBe('boolean');
    expect(typeof data.message).toBe('string');
  });
});

// =============================================================================
// Integration Tests — applescript presets
// =============================================================================

describe('Integration: applescript', () => {
  it('should execute get-clipboard preset', () => {
    const output = runSkill('applescript --preset get-clipboard');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.preset).toBe('get-clipboard');
  });

  it('should execute set-clipboard preset', () => {
    const output = runSkill('applescript --preset set-clipboard --text "test-clipboard-data"');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.preset).toBe('set-clipboard');
  });

  it('should execute custom AppleScript code', () => {
    const output = runSkill('applescript --code \'return "hello"\'');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('applescript');
  });
});

// =============================================================================
// Integration Tests — app-info
// =============================================================================

describe('Integration: app-info', () => {
  it('should return info for Finder', () => {
    const output = runSkill('app-info --app Finder');
    const data = JSON.parse(output);
    expect(data.success).toBe(true);
    expect(data.action).toBe('app-info');
    expect(data.app.name).toBe('Finder');
    expect(data.app.bundleId).toBe('com.apple.finder');
    expect(data.app.methods).toContain('applescript');
  });
});

// =============================================================================
// Integration Tests — chrome-connect (expected to fail without CDP)
// =============================================================================

describe('Integration: chrome-connect', () => {
  it('should return error when Chrome CDP is not available', () => {
    // Use a non-standard port that definitely won't have CDP
    const output = runSkill('chrome-connect --port 59999', true);
    const data = JSON.parse(output);
    expect(data.success).toBe(false);
    expect(data.error).toContain('Cannot connect');
  });
});

// =============================================================================
// Audit Logging Tests
// =============================================================================

describe('Audit Logging', () => {
  const logFile = join(process.env.HOME || '', '.crewly', 'logs', 'computer-use.log');

  it('should write to audit log file', () => {
    // Run a command that triggers logging
    runSkill('list-apps');
    expect(existsSync(logFile)).toBe(true);
  });

  it('should include timestamp and action in log', () => {
    const content = readFileSync(logFile, 'utf-8');
    // Check for recent list-apps entry
    expect(content).toContain('list-apps');
    // Check timestamp format [YYYY-MM-DD HH:MM:SS]
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });
});

// =============================================================================
// Instructions Documentation Tests
// =============================================================================

describe('Instructions Documentation (from SKILL.md body)', () => {
  let instructions: string;

  beforeAll(() => {
    const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    instructions = match ? match[1] : raw;
  });

  it('should document all subcommands', () => {
    const subcommands = [
      'list-apps', 'app-info', 'ui-tree', 'click', 'type',
      'get-text', 'scroll', 'focus', 'screenshot', 'applescript',
      'check-access', 'chrome-connect', 'chrome-tabs', 'chrome-eval',
    ];
    for (const cmd of subcommands) {
      expect(instructions).toContain(cmd);
    }
  });

  it('should document safety rules', () => {
    expect(instructions).toContain('Safety Rules');
    expect(instructions).toContain('NEVER close or kill');
    expect(instructions).toContain('password');
  });

  it('should document the 4 layers', () => {
    expect(instructions).toContain('Layer 1');
    expect(instructions).toContain('Layer 2');
    expect(instructions).toContain('Layer 3');
    expect(instructions).toContain('Layer 4');
  });
});
