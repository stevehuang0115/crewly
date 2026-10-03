/**
 * Computer Use Skill Tests
 *
 * Tests for the self-contained macOS desktop-control skill
 * (`execute.sh '{"action":...}'`, rewritten in 1f45a214b and given shared
 * safety rails in `_common/desktop-guards.sh`).
 *
 * The skill drives a real mouse, keyboard and screen, so these tests never
 * let it touch one. They run the real script against stubs placed first on
 * PATH:
 *  - `uname` — reports the platform under test (Darwin by default), so the
 *    macOS code path is exercised on a Linux CI runner and the Linux refusal
 *    is exercised on a Mac;
 *  - `osascript` — answers the guard probes (screen locked? permission
 *    granted?) from environment variables instead of asking the OS.
 * Everything else is hermetic: a temp CREWLY_HOME (lock, stop/pause files,
 * audit log), no audit screenshots, no presence banner, and dry runs for
 * actions the rails allow.
 *
 * @module config/skills/agent/computer-use/tests/computer-use.test
 */

import { spawnSync } from 'child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SKILL_DIR = join(__dirname, '..');
const EXECUTE_SH = join(SKILL_DIR, 'execute.sh');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const GUARDS_SH = join(SKILL_DIR, '..', '..', '_common', 'desktop-guards.sh');
const COMMON_LIB_SH = join(SKILL_DIR, '..', '_common', 'lib.sh');

/** Session name the guards record as the holder of the desktop. */
const TEST_SESSION = 'computer-use-test-agent';

let sandbox: string;
let crewlyHome: string;
let stubBin: string;

/** Result of one skill run. */
interface SkillRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run execute.sh with a JSON argument inside the hermetic sandbox.
 *
 * @param input - JSON argument (empty string passes no argument)
 * @param env - Environment overrides (FAKE_UNAME, FAKE_LOCKED, FAKE_GRANTED, CREWLY_DESKTOP_DRY_RUN, ...)
 * @returns exit code, stdout and stderr
 */
function runSkill(input: string, env: NodeJS.ProcessEnv = {}): SkillRun {
  const args = input === '' ? [EXECUTE_SH] : [EXECUTE_SH, input];
  const result = spawnSync('bash', args, {
    encoding: 'utf-8',
    timeout: 30000,
    // stdin is closed so read_json_input never waits on the terminal.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      CREWLY_HOME: crewlyHome,
      CREWLY_SESSION_NAME: TEST_SESSION,
      CREWLY_DESKTOP_AUDIT_SHOTS: '0',
      CREWLY_DESKTOP_NO_BANNER: '1',
      ...env,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Parse the JSON a refusal or result prints on stdout.
 *
 * @param run - Skill run
 * @returns Parsed object
 */
function json(run: SkillRun): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

/**
 * Remove the stop/pause/lock state files between tests.
 */
function resetDesktopState(): void {
  for (const f of ['desktop.stop', 'desktop.pause', 'desktop.lock']) {
    rmSync(join(crewlyHome, f), { force: true });
  }
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'computer-use-test-'));
  crewlyHome = join(sandbox, 'crewly-home');
  stubBin = join(sandbox, 'bin');
  mkdirSync(crewlyHome, { recursive: true });
  mkdirSync(stubBin, { recursive: true });

  const uname = join(stubBin, 'uname');
  writeFileSync(uname, '#!/usr/bin/env bash\necho "${FAKE_UNAME:-Darwin}"\n');
  chmodSync(uname, 0o755);

  // The lock probe is the only JXA snippet that mentions CGSSessionScreenIsLocked;
  // every other probe here is a permission check.
  const osascript = join(stubBin, 'osascript');
  writeFileSync(osascript, [
    '#!/usr/bin/env bash',
    'case "$*" in',
    '  *CGSSessionScreenIsLocked*) echo "${FAKE_LOCKED:-no}" ;;',
    '  *) echo "${FAKE_GRANTED:-yes}" ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(osascript, 0o755);
});

afterEach(() => {
  resetDesktopState();
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// =============================================================================
// File Structure Tests
// =============================================================================

describe('Skill Structure', () => {
  it('should have an executable execute.sh', () => {
    expect(existsSync(EXECUTE_SH)).toBe(true);
    expect(() => accessSync(EXECUTE_SH, constants.X_OK)).not.toThrow();
  });

  it('should have SKILL.md with frontmatter and instructions', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    expect(readFileSync(SKILL_MD, 'utf-8')).toMatch(/^---\n[\s\S]*?\n---\n/);
  });

  it('should be self-contained (no lib/ directory) and source only the shared helpers', () => {
    expect(existsSync(join(SKILL_DIR, 'lib'))).toBe(false);
    const script = readFileSync(EXECUTE_SH, 'utf-8');
    const sourced = [...script.matchAll(/^\s*source\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(sourced).toEqual([
      '${SCRIPT_DIR}/../_common/lib.sh',
      '${SCRIPT_DIR}/../../_common/desktop-guards.sh',
    ]);
    expect(existsSync(COMMON_LIB_SH)).toBe(true);
    expect(existsSync(GUARDS_SH)).toBe(true);
  });
});

// =============================================================================
// Skill Metadata Tests (parsed from SKILL.md YAML frontmatter)
// =============================================================================

/**
 * Parse YAML frontmatter from SKILL.md into a plain object.
 * Simple parser for top-level key: value and top-level list items.
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
  let raw: string;
  let metadata: Record<string, unknown>;

  beforeAll(() => {
    raw = readFileSync(SKILL_MD, 'utf-8');
    metadata = parseSkillMd(raw).meta;
  });

  it('should be named computer-use with display name "Computer Use"', () => {
    expect(metadata.name).toBe('computer-use');
    expect(metadata.displayName).toBe('Computer Use');
  });

  it('should have a semver version', () => {
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should execute execute.sh as a bash script', () => {
    expect(raw).toContain('type: script');
    expect(raw).toContain('file: execute.sh');
    expect(raw).toContain('interpreter: bash');
  });

  it('should have triggers array with more than 5 items', () => {
    expect(Array.isArray(metadata.triggers)).toBe(true);
    expect((metadata.triggers as string[]).length).toBeGreaterThan(5);
  });

  it('should include key triggers', () => {
    const triggers = metadata.triggers as string[];
    expect(triggers).toContain('computer use');
    expect(triggers).toContain('desktop automation');
    expect(triggers).toContain('screenshot');
    expect(triggers).toContain('click');
    expect(triggers).toContain('find element');
  });

  it('should be assignable to at least one role', () => {
    expect(Array.isArray(metadata.assignableRoles)).toBe(true);
    expect((metadata.assignableRoles as string[]).length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Shell Script Syntax Tests
// =============================================================================

describe('Shell Script Syntax', () => {
  it.each([
    ['execute.sh', EXECUTE_SH],
    ['_common/desktop-guards.sh', GUARDS_SH],
  ])('%s should pass bash syntax check', (_label, file) => {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// =============================================================================
// Input Validation
// =============================================================================

describe('Input Validation', () => {
  it('should error when no JSON input is given', () => {
    const run = runSkill('');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('No JSON input provided');
  });

  it('should error when action is missing', () => {
    const run = runSkill('{}');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Missing required parameter: action');
  });

  it('should error on an unknown action and list the valid ones', () => {
    const run = runSkill('{"action":"nonexistent-command"}');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Unknown action: nonexistent-command');
    expect(run.stderr).toContain('screenshot');
    expect(run.stderr).toContain('request-human');
  });
});

// =============================================================================
// Platform
// =============================================================================

describe('Platform', () => {
  it.each(['screenshot', 'click', 'check-permissions'])(
    'refuses %s on a non-macOS host with a structured reason',
    (action) => {
      const run = runSkill(JSON.stringify({ action, x: 1, y: 1 }), { FAKE_UNAME: 'Linux' });
      expect(run.code).not.toBe(0);
      expect(json(run)).toMatchObject({
        success: false,
        action,
        reason: 'unsupported_platform',
        platform: 'Linux',
        supported: ['Darwin'],
      });
    },
  );
});

// =============================================================================
// Safety Rails (shared _common/desktop-guards.sh)
// =============================================================================

describe('Safety Rails', () => {
  it.each(['command+q', 'cmd+w', 'Command + Shift + Delete'])('refuses the destructive key combo %s', (key) => {
    const run = runSkill(JSON.stringify({ action: 'key', key }));
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'destructive_blocked', key });
  });

  it.each(['Keychain Access', '1Password', 'System Settings'])('refuses to focus the credential app %s', (app) => {
    const run = runSkill(JSON.stringify({ action: 'focus', app }));
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'app_not_allowed', app });
  });

  it('refuses every action once the owner has stopped desktop control', () => {
    writeFileSync(join(crewlyHome, 'desktop.stop'), '');
    const run = runSkill('{"action":"screenshot"}');
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'stopped_by_user' });
  });

  it('refuses while paused, as recoverable', () => {
    writeFileSync(join(crewlyHome, 'desktop.pause'), '');
    const run = runSkill('{"action":"click","x":10,"y":10}');
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'paused', recoverable: true });
  });

  it('refuses while the screen is locked', () => {
    const run = runSkill('{"action":"click","x":10,"y":10}', { FAKE_LOCKED: 'yes' });
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'screen_locked', recoverable: true });
  });

  it('names the missing permission instead of acting blind', () => {
    const run = runSkill('{"action":"click","x":10,"y":10}', { FAKE_GRANTED: 'no' });
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'permission_required', permission: 'accessibility' });
  });

  it('refuses while another agent holds the desktop lock', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    writeFileSync(join(crewlyHome, 'desktop.lock'), JSON.stringify({ holder: 'other-agent', expiresAt }));
    const run = runSkill('{"action":"click","x":10,"y":10}');
    expect(run.code).not.toBe(0);
    expect(json(run)).toMatchObject({ success: false, reason: 'desktop_busy', heldBy: 'other-agent' });
  });

  it('lets an allowed action through (dry run) and takes the lock for this agent', () => {
    const run = runSkill('{"action":"click","x":10,"y":10}', { CREWLY_DESKTOP_DRY_RUN: '1' });
    expect(run.code).toBe(0);
    expect(json(run)).toEqual({ success: true, action: 'click', dryRun: true, wouldRun: true });
    const lock = JSON.parse(readFileSync(join(crewlyHome, 'desktop.lock'), 'utf-8')) as { holder: string };
    expect(lock.holder).toBe(TEST_SESSION);
  });

  it('allows a harmless key combo (dry run)', () => {
    const run = runSkill('{"action":"key","key":"command+c"}', { CREWLY_DESKTOP_DRY_RUN: '1' });
    expect(run.code).toBe(0);
    expect(json(run)).toMatchObject({ success: true, wouldRun: true });
  });
});

// =============================================================================
// check-permissions
// =============================================================================

describe('check-permissions', () => {
  it('reports both grants as ready when they are given', () => {
    const run = runSkill('{"action":"check-permissions"}');
    expect(run.code).toBe(0);
    expect(json(run)).toMatchObject({
      success: true,
      action: 'check-permissions',
      screenRecording: true,
      accessibility: true,
      ready: true,
    });
    expect(typeof json(run).askingProcess).toBe('string');
  });

  it('reports not ready when the grants are missing', () => {
    const run = runSkill('{"action":"check-permissions"}', { FAKE_GRANTED: 'no' });
    expect(run.code).toBe(0);
    expect(json(run)).toMatchObject({ screenRecording: false, accessibility: false, ready: false });
  });
});

// =============================================================================
// Audit Logging
// =============================================================================

describe('Audit Logging', () => {
  it('records each attempted action, refused ones included, in desktop-actions.jsonl', () => {
    runSkill('{"action":"key","key":"command+q"}');
    const logFile = join(crewlyHome, 'desktop-actions.jsonl');
    expect(existsSync(logFile)).toBe(true);
    const entries = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { at: string; session: string; action: string; input: { key?: string } });
    const entry = entries.find((e) => e.action === 'key' && e.input.key === 'command+q');
    expect(entry).toBeDefined();
    expect(entry?.session).toBe(TEST_SESSION);
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// =============================================================================
// Instructions Documentation Tests
// =============================================================================

describe('Instructions Documentation (from SKILL.md body)', () => {
  let instructions: string;
  let dispatchedActions: string[];

  beforeAll(() => {
    instructions = parseSkillMd(readFileSync(SKILL_MD, 'utf-8')).body;
    const script = readFileSync(EXECUTE_SH, 'utf-8');
    const dispatch = script.slice(script.lastIndexOf('case "$ACTION" in'));
    dispatchedActions = [...dispatch.matchAll(/^\s{2}([a-z][a-z-]*)\)/gm)].map((m) => m[1]);
  });

  it('dispatches the documented core actions', () => {
    expect(dispatchedActions).toEqual(expect.arrayContaining([
      'screenshot', 'click', 'move', 'type', 'key', 'scroll', 'drag', 'focus',
      'open-url', 'list-apps', 'find', 'check-permissions', 'snapshot',
      'click-ref', 'fill-ref', 'wait-for', 'request-human',
    ]));
  });

  it('documents every action execute.sh dispatches', () => {
    const undocumented = dispatchedActions.filter((a) => !instructions.includes(a));
    expect(undocumented).toEqual([]);
  });

  it('documents the safety rails and how to check permissions first', () => {
    expect(instructions).toContain('refuses destructive key combos');
    expect(instructions).toContain('password');
    expect(instructions).toContain('desktop-actions.jsonl');
    expect(instructions).toContain('check-permissions');
  });

  it('documents the macOS requirements', () => {
    expect(instructions).toContain('## Requirements');
    expect(instructions).toContain('macOS');
    expect(instructions).toContain('Accessibility permission');
    expect(instructions).toContain('Screen Recording permission');
  });
});
