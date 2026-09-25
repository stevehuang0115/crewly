/**
 * Tests for the CLI onboard command.
 *
 * Validates the setup wizard: banner, web-or-terminal choice, system tools,
 * the harness step (engine mocked — it has its own tests in harness-setup),
 * skills check, team creation, the full flow, and the --yes (non-interactive),
 * --template, --harness, --web and --cli flags.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockCheckSkillsInstalled = jest.fn();
const mockInstallAllSkills = jest.fn();
const mockCountBundledSkills = jest.fn();
jest.mock('../utils/marketplace.js', () => ({
  checkSkillsInstalled: (...args: unknown[]) => mockCheckSkillsInstalled(...args),
  installAllSkills: (...args: unknown[]) => mockInstallAllSkills(...args),
  countBundledSkills: (...args: unknown[]) => mockCountBundledSkills(...args),
}));

const mockListTemplates = jest.fn();
const mockGetTemplate = jest.fn();
const mockGetTemplatesDir = jest.fn().mockReturnValue('/mock/templates');
jest.mock('../utils/templates.js', () => {
  const actual = jest.requireActual('../utils/templates.js');
  return {
    listTemplates: (...args: unknown[]) => mockListTemplates(...args),
    getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
    getTemplatesDir: (...args: unknown[]) => mockGetTemplatesDir(...args),
    // Pure helpers: always called with the (mocked) template list.
    listOnboardingStarters: actual.listOnboardingStarters,
    getDefaultStarterTemplate: actual.getDefaultStarterTemplate,
  };
});

// The first-task / Cloud / Slack steps (onboard-checklist.ts has its own tests):
// keep the real prompts and printing, stub what touches the backend or disk.
const mockDeliverFirstTask = jest.fn();
const mockRecordBlankChoice = jest.fn();
const mockReadConnectState = jest.fn();
jest.mock('./onboard-checklist.js', () => ({
  ...jest.requireActual('./onboard-checklist.js'),
  deliverFirstTask: (...args: unknown[]) => mockDeliverFirstTask(...args),
  recordBlankChoice: (...args: unknown[]) => mockRecordBlankChoice(...args),
  readConnectState: (...args: unknown[]) => mockReadConnectState(...args),
}));

jest.mock('../../../backend/src/services/core/api-token.service.js', () => ({
  resolveApiToken: () => ({ token: 'api-tok', source: 'file', filePath: '/x' }),
}));

jest.mock('./token.js', () => ({
  pickAdvertisedHost: () => '192.168.1.20',
}));

const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockReaddirSync = jest.fn((): string[] => []);
const mockReadFileSync = jest.fn((): string => '');
jest.mock('fs', () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...(args as [])),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...(args as [])),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
}));

/** Shared mock readline answers — set per-test */
let mockReadlineAnswers: string[] = [];
let mockReadlineAnswerIndex = 0;
const mockRlClose = jest.fn();

jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => {
      const answer = mockReadlineAnswerIndex < mockReadlineAnswers.length
        ? mockReadlineAnswers[mockReadlineAnswerIndex++]
        : '';
      setImmediate(() => cb(answer));
    },
    close: mockRlClose,
    on: jest.fn().mockReturnThis(),
    removeListener: jest.fn(),
  }),
}));

const mockRunHarnessSetup = jest.fn();
jest.mock('./harness-setup.js', () => ({
  runHarnessSetup: (...args: unknown[]) => mockRunHarnessSetup(...args),
}));

const mockBrokerShutdown = jest.fn();
const mockPickLoginDriver = jest.fn();
const mockIsBackendRunning = jest.fn();
jest.mock('../utils/harness-engine.js', () => ({
  createCliHarnessService: () => ({ broker: { shutdown: mockBrokerShutdown } }),
  pickLoginDriver: (...args: unknown[]) => mockPickLoginDriver(...args),
  getBackendPort: () => 8787,
  localBackendUrl: (port: number) => `http://localhost:${port}`,
  isBackendRunning: (...args: unknown[]) => mockIsBackendRunning(...args),
}));

const mockStartCommand = jest.fn();
jest.mock('./start.js', () => ({
  startCommand: (...args: unknown[]) => mockStartCommand(...args),
}));

const mockOpen = jest.fn();
jest.mock('open', () => ({ __esModule: true, default: (...args: unknown[]) => mockOpen(...args) }), { virtual: true });

import {
  printBanner,
  checkToolInstalled,
  getToolVersion,
  ensureSystemTools,
  hasLocalDesktop,
  chooseSetupMode,
  continueInWebApp,
  runHarnessStep,
  ensureSkills,
  selectTemplate,
  createTeamFromTemplate,
  scaffoldCrewlyDirectory,
  copyTemplateProjectFiles,
  printSummary,
  onboardCommand,
  isInteractiveInput,
  reportNonInteractiveInput,
  WizardInputClosedError,
} from './onboard.js';
import { createReadlineIO } from '../utils/prompt-io.js';

import type { TeamTemplate } from '../utils/templates.js';

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock readline interface that answers questions
 * from the provided array of responses (consumed in order).
 */
function createMockReadline(answers: string[]) {
  let answerIndex = 0;
  const emitter = new EventEmitter();
  return {
    question: (_prompt: string, cb: (answer: string) => void) => {
      const answer = answerIndex < answers.length ? answers[answerIndex++] : '';
      // Simulate async readline
      setImmediate(() => cb(answer));
    },
    close: jest.fn(),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  } as unknown as import('readline').Interface;
}

const sampleTemplate: TeamTemplate = {
  id: 'web-dev-team',
  name: 'Web Dev Team',
  description: 'Frontend + Backend + QA',
  members: [
    { name: 'Frontend Dev', role: 'frontend-developer', systemPrompt: 'prompt' },
    { name: 'Backend Dev', role: 'backend-developer', systemPrompt: 'prompt' },
  ],
};

/** Helper: make jq appear as not found (consumes 1 mockExecSync call) */
function mockJqNotFound(): void {
  mockExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
}

/** Helper: make jq appear as found (consumes 2 mockExecSync calls) */
function mockJqFound(): void {
  mockExecSync
    .mockReturnValueOnce(Buffer.from('/usr/bin/jq'))   // which jq
    .mockReturnValueOnce(Buffer.from('jq-1.7.1'));        // jq --version
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Original stdin TTY descriptor, restored after each test. */
const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

/** Make process.stdin look like a terminal (true) or a pipe (false). */
function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

describe('onboard command', () => {
  let logSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    // The interactive wizard requires a terminal; jest's stdin is not one.
    setStdinIsTTY(true);
    process.exitCode = 0;
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    mockExecSync.mockReset();
    mockDeliverFirstTask.mockReset().mockResolvedValue({ status: 'pending' });
    mockRecordBlankChoice.mockReset().mockResolvedValue(undefined);
    mockReadConnectState.mockReset().mockResolvedValue(null);
    mockCheckSkillsInstalled.mockReset();
    mockInstallAllSkills.mockReset();
    mockCountBundledSkills.mockReset();
    mockCountBundledSkills.mockReturnValue(0);
    mockListTemplates.mockReset();
    mockGetTemplate.mockReset();
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockCopyFileSync.mockReset();
    mockGetTemplatesDir.mockReturnValue('/mock/templates');
    mockRunHarnessSetup.mockReset();
    mockRunHarnessSetup.mockResolvedValue({ harnessId: 'claude-code', installed: true, login: 'succeeded' });
    mockBrokerShutdown.mockReset();
    mockPickLoginDriver.mockReset();
    mockIsBackendRunning.mockReset();
    mockStartCommand.mockReset();
    mockOpen.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    process.exitCode = 0;
  });

  // -----------------------------------------------------------------------
  // printBanner
  // -----------------------------------------------------------------------

  describe('printBanner', () => {
    it('prints the ASCII art and welcome message', () => {
      printBanner();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Crewly');
      expect(output).toContain('Welcome');
    });
  });

  // -----------------------------------------------------------------------
  // Web or terminal
  // -----------------------------------------------------------------------

  describe('hasLocalDesktop', () => {
    it('is true on macOS and on Linux with a display', () => {
      expect(hasLocalDesktop({}, 'darwin')).toBe(true);
      expect(hasLocalDesktop({ DISPLAY: ':0' }, 'linux')).toBe(true);
      expect(hasLocalDesktop({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
    });

    it('is false over SSH, inside an agent shell, and on a headless Linux box', () => {
      expect(hasLocalDesktop({ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' }, 'darwin')).toBe(false);
      expect(hasLocalDesktop({ SSH_TTY: '/dev/ttys001' }, 'darwin')).toBe(false);
      expect(hasLocalDesktop({ CREWLY_SESSION_NAME: 'crewly-orc' }, 'darwin')).toBe(false);
      expect(hasLocalDesktop({}, 'linux')).toBe(false);
    });
  });

  describe('chooseSetupMode', () => {
    const never = async (): Promise<string> => { throw new Error('should not ask'); };

    it('honours --web, --cli and --yes without asking', async () => {
      expect(await chooseSetupMode(never, { web: true }, false)).toBe('web');
      expect(await chooseSetupMode(never, { cli: true }, true)).toBe('cli');
      expect(await chooseSetupMode(never, { yes: true }, true)).toBe('cli');
    });

    it('defaults to the web app with a desktop and to the terminal without', async () => {
      expect(await chooseSetupMode(async () => '', {}, true)).toBe('web');
      expect(await chooseSetupMode(async () => '', {}, false)).toBe('cli');
    });

    it('accepts numbers and words, and re-asks on nonsense', async () => {
      const answers = ['x', '2'];
      expect(await chooseSetupMode(async () => answers.shift() ?? '', {}, true)).toBe('cli');
      expect(await chooseSetupMode(async () => 'web', {}, false)).toBe('web');
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Please enter 1 or 2');
    });
  });

  describe('continueInWebApp', () => {
    it('opens the setup page when Crewly is running and prints the URL', async () => {
      const openUrl = jest.fn(async () => undefined);
      const start = jest.fn(async () => undefined);
      await continueInWebApp({ openUrl, isRunning: async () => true, start, port: 8787 });
      expect(openUrl).toHaveBeenCalledWith('http://localhost:8787/setup');
      expect(start).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('http://localhost:8787/setup');
    });

    it('uses the real opener and starter by default (loaded lazily)', async () => {
      const running = [false, true];
      await continueInWebApp({ isRunning: async () => running.shift() ?? true, port: 8787 });
      expect(mockStartCommand).toHaveBeenCalledWith({ port: '8787', browser: false });
      expect(mockOpen).toHaveBeenCalledWith('http://localhost:8787/setup');
    });

    it('starts Crewly when it is not running, then opens the page once it answers', async () => {
      const running = [false, true];
      const openUrl = jest.fn(async () => { throw new Error('no browser'); });
      const start = jest.fn(async () => undefined);
      await continueInWebApp({ openUrl, isRunning: async () => running.shift() ?? true, start, port: 9000 });
      expect(start).toHaveBeenCalled();
      expect(openUrl).toHaveBeenCalledWith('http://localhost:9000/setup');
    });
  });

  // -----------------------------------------------------------------------
  // checkToolInstalled
  // -----------------------------------------------------------------------

  describe('checkToolInstalled', () => {
    it('returns true when which succeeds', () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
      expect(checkToolInstalled('claude')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('which claude', { stdio: 'pipe' });
    });

    it('returns false when which throws', () => {
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(checkToolInstalled('nonexistent')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getToolVersion
  // -----------------------------------------------------------------------

  describe('getToolVersion', () => {
    it('extracts version from output', () => {
      mockExecSync.mockReturnValue(Buffer.from('claude v1.0.17\n'));
      expect(getToolVersion('claude')).toBe('1.0.17');
    });

    it('returns null on error', () => {
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(getToolVersion('missing')).toBeNull();
    });

    it('returns first line when no version pattern found', () => {
      mockExecSync.mockReturnValue(Buffer.from('some tool output'));
      expect(getToolVersion('tool')).toBe('some tool output');
    });
  });

  // -----------------------------------------------------------------------
  // ensureSystemTools (jq required, tmux not)
  // -----------------------------------------------------------------------

  describe('ensureSystemTools', () => {
    it('reports jq when present', () => {
      mockJqFound();
      expect(ensureSystemTools()).toBe(1);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('jq detected');
    });

    it('blocks with install commands when jq is not found', () => {
      mockJqNotFound();
      expect(() => ensureSystemTools()).toThrow('process.exit called');
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('jq not found');
      expect(output).toContain('brew install jq');
      expect(output).toContain('sudo apt-get install -y jq');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not require tmux: only jq is probed', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('tmux')) throw new Error('not found');
        if (String(cmd) === 'which jq') return Buffer.from('/usr/bin/jq');
        if (String(cmd).startsWith('jq --version')) return Buffer.from('jq-1.7.1');
        throw new Error(`unexpected command: ${cmd}`);
      });
      ensureSystemTools();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(exitSpy).not.toHaveBeenCalled();
      expect(output).not.toMatch(/tmux/i);
      expect(output).toContain('1 system tool(s) checked');
      const probed = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(probed).toEqual(['which jq', 'jq --version 2>/dev/null']);
    });
  });

  // -----------------------------------------------------------------------
  // runHarnessStep
  // -----------------------------------------------------------------------

  describe('runHarnessStep', () => {
    it('checks jq, then runs the shared harness setup with the login step header', async () => {
      mockJqFound();
      const io = { ask: jest.fn(), log: jest.fn() };
      const getDriver = jest.fn();
      const service = { broker: { shutdown: jest.fn() } } as never;
      const result = await runHarnessStep(io, service, getDriver, { interactive: false, harness: 'codex' });
      expect(result).toEqual({ harnessId: 'claude-code', installed: true, login: 'succeeded' });
      expect(mockRunHarnessSetup).toHaveBeenCalledWith(io, service, getDriver, expect.objectContaining({
        interactive: false,
        preset: 'codex',
        loginHeader: expect.stringContaining('Step 2/7'),
      }));
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Step 1/7: AI Harness');
      expect(output).toContain('jq detected');
    });
  });

  // -----------------------------------------------------------------------
  // ensureSkills
  // -----------------------------------------------------------------------

  describe('ensureSkills', () => {
    it('reports already-installed skills', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 22, total: 22 });
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('22 agent skills already installed');
    });

    it('installs missing skills', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 0, total: 5 });
      mockInstallAllSkills.mockResolvedValue({ total: 5, installed: 5, failed: [] });
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Installing 5 agent skills');
      expect(output).toContain('5 skills installed');
    });

    it('names every skill that failed instead of reporting only the successes', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 0, total: 31 });
      mockInstallAllSkills.mockResolvedValue({
        total: 31,
        installed: 29,
        failed: [
          { id: 'skill-nano-banana', name: 'Nano Banana', message: 'Download failed: 404 Not Found (https://crewlyai.com/api/assets/skills/nano-banana/nano-banana-1.1.0.tar.gz)' },
          { id: 'gone', name: 'Gone Skill', message: 'No skill manifest at x (SKILL.md: 404, skill.json: 404)' },
        ],
      });
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('✗ Nano Banana: Download failed: 404');
      expect(output).toContain('✗ Gone Skill: No skill manifest');
      expect(output).toContain('29 of 31 skills installed, 2 failed');
      expect(output).not.toContain('✓ 29 skills installed');
    });

    it('shows bundled skills when marketplace has zero', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 0, total: 0 });
      mockCountBundledSkills.mockReturnValue(15);
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('15 bundled skills available');
    });

    it('handles zero marketplace skills with no bundled fallback', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 0, total: 0 });
      mockCountBundledSkills.mockReturnValue(0);
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('No skills available');
    });

    it('falls back to bundled skills on network error', async () => {
      mockCheckSkillsInstalled.mockRejectedValue(new Error('network error'));
      mockCountBundledSkills.mockReturnValue(12);
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('12 bundled skills available');
      expect(output).toContain('marketplace offline');
    });

    it('handles errors gracefully when no bundled skills', async () => {
      mockCheckSkillsInstalled.mockRejectedValue(new Error('network error'));
      mockCountBundledSkills.mockReturnValue(0);
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Could not install skills');
      expect(output).toContain('network error');
    });
  });

  // -----------------------------------------------------------------------
  // selectTemplate
  // -----------------------------------------------------------------------

  describe('selectTemplate', () => {
    const sampleTemplates: TeamTemplate[] = [
      {
        id: 'web-dev-team',
        name: 'Web Dev Team',
        description: 'Frontend + Backend + QA',
        members: [
          { name: 'Frontend Dev', role: 'frontend-developer', systemPrompt: 'prompt' },
          { name: 'Backend Dev', role: 'backend-developer', systemPrompt: 'prompt' },
        ],
      },
      {
        id: 'startup-team',
        name: 'Startup Team',
        description: 'PM + Dev + Generalist',
        members: [
          { name: 'PM', role: 'product-manager', systemPrompt: 'prompt' },
        ],
      },
    ];

    it('returns selected template when user picks a number', async () => {
      mockListTemplates.mockReturnValue(sampleTemplates);
      const rl = createMockReadline(['1']);
      const result = await selectTemplate(rl);
      expect(result).toBeDefined();
      expect(result!.id).toBe('web-dev-team'); // first in mock array
    });

    it('returns null when user picks skip option', async () => {
      mockListTemplates.mockReturnValue(sampleTemplates);
      const rl = createMockReadline(['3']); // 2 templates + 1 skip = 3
      const result = await selectTemplate(rl);
      expect(result).toBeNull();
    });

    it('returns null when user presses enter (empty)', async () => {
      mockListTemplates.mockReturnValue(sampleTemplates);
      const rl = createMockReadline(['']);
      const result = await selectTemplate(rl);
      expect(result).toBeNull();
    });

    it('returns null when no templates available', async () => {
      mockListTemplates.mockReturnValue([]);
      const rl = createMockReadline([]);
      const result = await selectTemplate(rl);
      expect(result).toBeNull();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('No templates available');
    });

    it('re-prompts on invalid input then accepts valid', async () => {
      mockListTemplates.mockReturnValue(sampleTemplates);
      const rl = createMockReadline(['x', '0', '1']);
      const result = await selectTemplate(rl);
      expect(result).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // createTeamFromTemplate
  // -----------------------------------------------------------------------

  describe('createTeamFromTemplate', () => {
    it('creates team directory and config file', () => {
      const result = createTeamFromTemplate(sampleTemplate);

      expect(result).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('teams/web-dev-team'),
        expect.objectContaining({ recursive: true }),
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('teams/web-dev-team/config.json'),
        expect.stringContaining('"name": "Web Dev Team"'),
      );
    });

    it('includes all members with required fields', () => {
      createTeamFromTemplate(sampleTemplate);

      const writeCall = mockWriteFileSync.mock.calls[0];
      const config = JSON.parse(writeCall[1] as string);

      expect(config.members).toHaveLength(2);
      expect(config.members[0]).toEqual(expect.objectContaining({
        name: 'Frontend Dev',
        role: 'frontend-developer',
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
      }));
      expect(config.members[0].id).toBeDefined();
      expect(config.members[0].sessionName).toBeDefined();
      expect(config.members[0].createdAt).toBeDefined();
    });

    it('puts every member on the given runtime (the orchestrator harness)', () => {
      createTeamFromTemplate(sampleTemplate, 'codex-cli');

      const writeCall = mockWriteFileSync.mock.calls[0];
      const config = JSON.parse(writeCall[1] as string);

      expect(config.members.every((m: { runtimeType: string }) => m.runtimeType === 'codex-cli')).toBe(true);
    });

    it('returns false when filesystem operation fails', () => {
      mockMkdirSync.mockImplementation(() => { throw new Error('permission denied'); });

      const result = createTeamFromTemplate(sampleTemplate);

      expect(result).toBe(false);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Failed to create team');
    });
  });

  // -----------------------------------------------------------------------
  // scaffoldCrewlyDirectory
  // -----------------------------------------------------------------------

  describe('scaffoldCrewlyDirectory', () => {
    it('creates .crewly/ directory structure when it does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = scaffoldCrewlyDirectory('/test/project');

      expect(result).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledTimes(4);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('.crewly/ directory created');
    });

    it('reports existing directory and skips creation', () => {
      mockExistsSync.mockReturnValue(true);

      const result = scaffoldCrewlyDirectory('/test/project');

      expect(result).toBe(true);
      expect(mockMkdirSync).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('already exists');
    });

    it('returns false and logs error when mkdir fails', () => {
      mockExistsSync.mockReturnValue(false);
      mockMkdirSync.mockImplementation(() => { throw new Error('permission denied'); });

      const result = scaffoldCrewlyDirectory('/test/project');

      expect(result).toBe(false);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Failed to create');
    });

    it('creates subdirectories: docs, memory, tasks, teams', () => {
      mockExistsSync.mockReturnValue(false);

      scaffoldCrewlyDirectory('/test/project');

      const mkdirCalls = mockMkdirSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(mkdirCalls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('docs'),
          expect.stringContaining('memory'),
          expect.stringContaining('tasks'),
          expect.stringContaining('teams'),
        ]),
      );
    });

    it('writes config.env file', () => {
      mockExistsSync.mockReturnValue(false);

      scaffoldCrewlyDirectory('/test/project');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('config.env'),
        expect.stringContaining('Crewly configuration'),
      );
    });

    it('copies template project files when template is provided', () => {
      // .crewly/ doesn't exist, template dir exists, goals.md exists, team.json exists
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('/mock/templates/web-dev-team')) return true;
        if (typeof p === 'string' && p.endsWith('goals.md') && p.includes('/mock/templates')) return true;
        if (typeof p === 'string' && p.endsWith('team.json') && p.includes('/mock/templates')) return true;
        return false;
      });

      scaffoldCrewlyDirectory('/test/project', sampleTemplate);

      expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Copied 2 template file(s)');
    });

    it('does not overwrite existing project files', () => {
      // .crewly/ exists, template dir exists, goals.md exists in both src and dest
      mockExistsSync.mockReturnValue(true);

      scaffoldCrewlyDirectory('/test/project', sampleTemplate);

      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // copyTemplateProjectFiles
  // -----------------------------------------------------------------------

  describe('copyTemplateProjectFiles', () => {
    it('copies goals.md and team.json from template directory', () => {
      // Template dir exists, both files exist in template, neither in target
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('/mock/templates/web-dev-team')) return true;
        if (typeof p === 'string' && p.includes('/mock/templates') && (p.endsWith('goals.md') || p.endsWith('team.json'))) return true;
        return false;
      });

      copyTemplateProjectFiles('/test/.crewly', sampleTemplate);

      expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
    });

    it('skips when template directory does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      copyTemplateProjectFiles('/test/.crewly', sampleTemplate);

      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });

    it('does not copy files that already exist in target', () => {
      // Template dir exists, source files exist, dest files also exist
      mockExistsSync.mockReturnValue(true);

      copyTemplateProjectFiles('/test/.crewly', sampleTemplate);

      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // printSummary
  // -----------------------------------------------------------------------

  describe('printSummary', () => {
    it('prints completion message and next steps', () => {
      printSummary();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Setup complete');
      expect(output).toContain('crewly start');
      expect(output).toContain('Next steps');
    });

    it('includes template info when a template was selected', () => {
      const template: TeamTemplate = {
        id: 'test',
        name: 'Test Team',
        description: 'desc',
        members: [
          { name: 'Dev', role: 'developer', systemPrompt: 'prompt' },
          { name: 'QA', role: 'qa', systemPrompt: 'prompt' },
        ],
      };
      printSummary(template);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Test Team');
      expect(output).toContain('Dev, QA');
      expect(output).toContain('Your team is ready');
    });

    it('does not include template info when null', () => {
      printSummary(null);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).not.toContain('Your team is ready');
      expect(output).toContain('Setup complete');
    });

    it('includes cd command when projectDir differs from cwd', () => {
      printSummary(null, '/some/other/path');
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('cd /some/other/path');
    });
  });

  // -----------------------------------------------------------------------
  // onboardCommand (full flow)
  // -----------------------------------------------------------------------

  describe('onboardCommand', () => {
    beforeEach(() => {
      mockRlClose.mockReset();
      // Default: no templates (template step skips quickly)
      mockListTemplates.mockReturnValue([]);
      mockExistsSync.mockReturnValue(false);
    });

    it('runs the full wizard in the terminal', async () => {
      mockReadlineAnswers = ['2']; // terminal; template auto-skips (no templates)
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Welcome');
      expect(output).toContain('No templates available');
      expect(output).toContain('Setup complete');
      expect(mockRlClose).toHaveBeenCalled();
      expect(mockRunHarnessSetup).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), expect.objectContaining({ interactive: true }));
      expect(mockBrokerShutdown).toHaveBeenCalled();
    });

    it('hands off to the web app when chosen, without running the terminal steps', async () => {
      mockReadlineAnswers = ['1'];
      mockReadlineAnswerIndex = 0;
      const continueInWeb = jest.fn(async () => undefined);

      await onboardCommand({}, { continueInWeb, hasDesktop: true });

      expect(continueInWeb).toHaveBeenCalled();
      expect(mockRunHarnessSetup).not.toHaveBeenCalled();
      expect(mockCheckSkillsInstalled).not.toHaveBeenCalled();
    });

    it('creates the team on the chosen orchestrator harness', async () => {
      mockListTemplates.mockReturnValue([sampleTemplate]);
      mockRunHarnessSetup.mockResolvedValue({ harnessId: 'codex-cli', installed: true, login: 'pending' });
      mockReadlineAnswers = ['1']; // template 1 (mode comes from --cli)
      mockReadlineAnswerIndex = 0;
      mockJqFound();
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand({ cli: true, harness: 'codex' });

      expect(mockRunHarnessSetup).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), expect.objectContaining({ preset: 'codex' }));
      const written = String(mockWriteFileSync.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('config.json'))?.[1]);
      expect(written).toContain('"runtimeType": "codex-cli"');
    });

    it('runs full wizard with template selection', async () => {
      mockListTemplates.mockReturnValue([
        {
          id: 'test-team',
          name: 'Test Team',
          description: 'A test team',
          members: [{ name: 'Dev', role: 'developer', systemPrompt: 'prompt' }],
        },
      ]);

      // Answer '2' for the terminal, '1' for template selection
      mockReadlineAnswers = ['2', '1'];
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Welcome');
      expect(output).toContain('Test Team');
      expect(output).toContain('Setup complete');
      expect(mockRlClose).toHaveBeenCalled();
    });

    it('creates team when template is selected', async () => {
      mockListTemplates.mockReturnValue([sampleTemplate]);

      mockReadlineAnswers = ['2', '1']; // terminal, select first template
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Team "Web Dev Team" created');
    });

    it('closes readline even if an error occurs in skills', async () => {
      mockReadlineAnswers = ['2']; // terminal; template auto-skips (no templates)
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      // Skills check fails
      mockCheckSkillsInstalled.mockRejectedValue(new Error('fail'));

      await onboardCommand();

      // readline should still be closed
      expect(mockRlClose).toHaveBeenCalled();
    });

    it('scaffolds .crewly/ directory during interactive flow', async () => {
      mockReadlineAnswers = ['2']; // terminal
      mockReadlineAnswerIndex = 0;
      mockJqFound();
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      // Should have called scaffoldCrewlyDirectory (which calls mkdirSync)
      expect(mockMkdirSync).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Non-interactive stdin (#772: `curl | bash` exited 0 having set up nothing)
  // -----------------------------------------------------------------------

  describe('onboardCommand without a terminal (#772)', () => {
    beforeEach(() => {
      mockRlClose.mockReset();
      mockListTemplates.mockReturnValue([]);
      mockExistsSync.mockReturnValue(false);
    });

    it('isInteractiveInput is true only for a TTY', () => {
      expect(isInteractiveInput({ isTTY: true })).toBe(true);
      expect(isInteractiveInput({ isTTY: false })).toBe(false);
      expect(isInteractiveInput({})).toBe(false);
    });

    it('refuses with the next command and a non-zero exit code when stdin is a pipe', async () => {
      setStdinIsTTY(false);

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('needs a terminal');
      expect(output).toContain('Nothing was set up');
      expect(output).toContain('crewly onboard');
      expect(output).toContain('crewly init --yes');
      expect(output).not.toContain('Setup complete');
      expect(process.exitCode).toBe(1);
      // Nothing was written: no prompt, no skills, no scaffold
      expect(mockCheckSkillsInstalled).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('still runs --yes without a terminal', async () => {
      setStdinIsTTY(false);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Setup complete');
      expect(process.exitCode).toBe(0);
      // --yes never opens a readline interface, so stdin cannot hold the process open
      expect(mockRlClose).not.toHaveBeenCalled();
    });

    it('says setup did not finish (not "nothing was set up") when the input closes mid-wizard', () => {
      reportNonInteractiveInput('The setup wizard\'s input closed before setup finished.', true);

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Setup did not finish');
      expect(output).not.toContain('Nothing was set up');
      expect(output).toContain('crewly onboard');
      expect(process.exitCode).toBe(1);
    });

    it('rejects a pending question with WizardInputClosedError when the input closes', async () => {
      const emitter = new EventEmitter();
      const rl = {
        question: jest.fn(),
        close: jest.fn(),
        on: emitter.on.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
      } as unknown as import('readline').Interface;

      const io = createReadlineIO(rl, () => new WizardInputClosedError());
      const pending = chooseSetupMode(io.ask, {}, true);
      emitter.emit('close');

      await expect(pending).rejects.toBeInstanceOf(WizardInputClosedError);
    });
  });

  // -----------------------------------------------------------------------
  // --yes flag (non-interactive mode)
  // -----------------------------------------------------------------------

  describe('onboardCommand with --yes flag', () => {
    beforeEach(() => {
      mockRlClose.mockReset();
      mockListTemplates.mockReturnValue([]);
      mockExistsSync.mockReturnValue(false);
    });

    it('runs non-interactive with defaults', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('non-interactive');
      expect(output).toContain('Setup complete');
      expect(mockRunHarnessSetup).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), expect.objectContaining({ interactive: false }));
    });

    it('never prompts in --yes mode (the harness step gets a no-prompt IO)', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true, harness: 'codex' });

      const [io, , , opts] = mockRunHarnessSetup.mock.calls[0];
      expect(opts).toMatchObject({ interactive: false, preset: 'codex' });
      expect(await io.ask('anything?')).toBe('');
      expect(mockRlClose).not.toHaveBeenCalled();
      expect(mockBrokerShutdown).toHaveBeenCalled();
    });

    it('--yes --web hands off to the web app', async () => {
      const continueInWeb = jest.fn(async () => undefined);
      await onboardCommand({ yes: true, web: true }, { continueInWeb });
      expect(continueInWeb).toHaveBeenCalled();
      expect(mockRunHarnessSetup).not.toHaveBeenCalled();
    });

    it('uses first available template when no --template specified', async () => {
      mockListTemplates.mockReturnValue([sampleTemplate]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
    });

    it('scaffolds .crewly/ directory in --yes mode', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true });

      expect(mockMkdirSync).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // --template flag
  // -----------------------------------------------------------------------

  describe('onboardCommand with --template flag', () => {
    beforeEach(() => {
      mockRlClose.mockReset();
      mockListTemplates.mockReturnValue([]);
      mockExistsSync.mockReturnValue(false);
    });

    it('uses specified template in interactive mode', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      // Terminal
      mockReadlineAnswers = ['2'];
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      await onboardCommand({ template: 'web-dev-team' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
      // Should NOT prompt for template selection
      expect(output).not.toContain('Choose a pre-built team');
    });

    it('uses specified template in --yes mode', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockJqFound();

      await onboardCommand({ yes: true, template: 'web-dev-team' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
    });

    it('warns when template ID is not found', async () => {
      mockGetTemplate.mockReturnValue(undefined);
      mockListTemplates.mockReturnValue([sampleTemplate]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      mockReadlineAnswers = ['2', '']; // terminal, skip template
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      await onboardCommand({ template: 'nonexistent' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Template "nonexistent" not found');
      expect(output).toContain('Available templates: web-dev-team');
    });

    it('warns when template not found and no templates available', async () => {
      mockGetTemplate.mockReturnValue(undefined);
      mockListTemplates.mockReturnValue([]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      mockReadlineAnswers = ['2'];
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      await onboardCommand({ template: 'nonexistent' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Template "nonexistent" not found');
      // Should not show available templates line
      expect(output).not.toContain('Available templates:');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: starter teams, first task, Cloud & Slack
  // -----------------------------------------------------------------------

  describe('first-run steps (Phase 3)', () => {
    const starter = (id: string, name: string, order: number, recommended: boolean): TeamTemplate => ({
      id,
      name,
      description: `${name} team`,
      members: [{ name: 'Lead', role: 'generalist', systemPrompt: 'prompt' }],
      onboarding: { order, recommended, label: `L${order}`, tagline: `tagline ${order}`, suggestions: [`${id} s1`, `${id} s2`, `${id} s3`] },
    });
    const marketing = starter('growth-marketing-team', 'Growth Marketing Team', 2, false);
    const assistant = starter('personal-assistant-team', 'Personal Assistant', 1, true);

    beforeEach(() => {
      mockRlClose.mockReset();
      mockExistsSync.mockReturnValue(false);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      // Alphabetical order, as listTemplates() returns it: Marketing first.
      mockListTemplates.mockReturnValue([marketing, assistant, sampleTemplate]);
    });

    const output = (): string => logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');

    it('--yes without --template creates the Personal Assistant, not the first template by name', async () => {
      mockJqFound();
      await onboardCommand({ yes: true });
      expect(output()).toContain('Using template: Personal Assistant');
      const written = mockWriteFileSync.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('config.json'));
      expect(String(written?.[0])).toContain('teams/personal-assistant-team');
      expect(JSON.parse(String(written?.[1])).templateId).toBe('personal-assistant-team');
    });

    it('--yes never asks for a first task and sends --task to the new team', async () => {
      mockJqFound();
      await onboardCommand({ yes: true });
      expect(mockDeliverFirstTask).not.toHaveBeenCalled();
      expect(output()).toContain('pass --task');

      mockJqFound();
      await onboardCommand({ yes: true, task: '  Plan my week ' });
      expect(mockDeliverFirstTask).toHaveBeenCalledWith('Plan my week', 'personal-assistant-team');
      expect(output()).toContain('The orchestrator gets it when Crewly starts');
    });

    it('interactive: Enter picks the recommended starter and a number picks a suggested task', async () => {
      mockReadlineAnswers = ['', '2']; // starter: Enter; first task: suggestion 2
      mockReadlineAnswerIndex = 0;
      mockJqFound();
      mockDeliverFirstTask.mockResolvedValue({ status: 'sent', queued: false });

      await onboardCommand({ cli: true });

      expect(output()).toContain('Selected: Personal Assistant');
      expect(output()).toContain('(recommended / 推荐)');
      expect(mockDeliverFirstTask).toHaveBeenCalledWith('personal-assistant-team s2', 'personal-assistant-team');
      expect(output()).toContain('Sent to the orchestrator.');
      expect(output()).toContain('Step 7/7: Done!');
    });

    it('interactive: Blank records the choice, creates no team and sends the task to the orchestrator', async () => {
      mockReadlineAnswers = ['3', 'Tell me what you can do'];
      mockReadlineAnswerIndex = 0;
      mockJqFound();

      await onboardCommand({ cli: true });

      expect(mockRecordBlankChoice).toHaveBeenCalled();
      expect(mockWriteFileSync.mock.calls.some((c: unknown[]) => String(c[0]).includes('/teams/'))).toBe(false);
      expect(mockDeliverFirstTask).toHaveBeenCalledWith('Tell me what you can do', null);
    });

    it('interactive: Enter at the first task skips it', async () => {
      mockReadlineAnswers = ['1', ''];
      mockReadlineAnswerIndex = 0;
      mockJqFound();
      await onboardCommand({ cli: true });
      expect(mockDeliverFirstTask).not.toHaveBeenCalled();
      expect(output()).toContain('Skipped. Send it any time');
    });

    it('prints phone links for Cloud and Slack (LAN host + API token) and does not wait', async () => {
      mockJqFound();
      await onboardCommand({ yes: true });
      const text = output();
      expect(text).toContain('Step 6/7: Crewly Cloud & Slack');
      expect(text).toContain('/api/cloud/google/start?redirect=');
      expect(text).toContain('http://192.168.1.20:8787/setup?step=cloud&token=api-tok');
      expect(text).toContain('http://192.168.1.20:8787/setup?step=slack&token=api-tok');
    });

    it('shows done marks when the running backend reports Cloud and Slack connected', async () => {
      mockReadConnectState.mockResolvedValue({ cloud: true, slack: true });
      mockJqFound();
      await onboardCommand({ yes: true });
      expect(output()).toContain('Crewly Cloud connected');
      expect(output()).toContain('Slack connected');
      expect(output()).not.toContain('setup?step=cloud');
    });

    it('keeps a team that already exists instead of replacing it', () => {
      mockExistsSync.mockReturnValue(true);
      expect(createTeamFromTemplate(assistant)).toBe(true);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(output()).toContain('already exists');
    });

    it('keeps a team the web app created from the same template (UUID directory)', () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValueOnce(['0b1c-uuid']);
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({ id: '0b1c-uuid', templateId: 'personal-assistant-team' }));
      expect(createTeamFromTemplate(assistant)).toBe(true);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('sends the first task to a web-created team by its own id', async () => {
      mockReaddirSync.mockReturnValue(['0b1c-uuid']);
      mockReadFileSync.mockReturnValue(JSON.stringify({ id: '0b1c-uuid', templateId: 'personal-assistant-team' }));
      mockJqFound();
      await onboardCommand({ yes: true, task: 'Plan my week' });
      expect(mockDeliverFirstTask).toHaveBeenCalledWith('Plan my week', '0b1c-uuid');
      mockReaddirSync.mockReturnValue([]);
      mockReadFileSync.mockReturnValue('');
    });

    it('writes teams under CREWLY_HOME', () => {
      const saved = process.env.CREWLY_HOME;
      process.env.CREWLY_HOME = '/tmp/crewly-home-test';
      try {
        createTeamFromTemplate(assistant);
        expect(String(mockWriteFileSync.mock.calls[0][0])).toBe('/tmp/crewly-home-test/teams/personal-assistant-team/config.json');
      } finally {
        if (saved === undefined) delete process.env.CREWLY_HOME;
        else process.env.CREWLY_HOME = saved;
      }
    });
  });

  // -----------------------------------------------------------------------
  // --template <solution bundle>
  // -----------------------------------------------------------------------

  describe('onboardCommand with a solution bundle template', () => {
    const bundle = {
      id: 'demo-bundle',
      name: 'Demo',
      description: 'd',
      roles: [],
      bundle: {
        schemaVersion: 1,
        label: '演示方案',
        tagline: '一句话',
        ownerSummary: 's',
        runtime: { recommended: 'crewly-agent' },
        server: { tier: 'entry' },
        questions: [
          { id: 'business_name', label: '名字', type: 'text', required: true },
          { id: 'platforms', label: '平台', type: 'multiselect', required: true, options: [{ value: '小红书' }, { value: '抖音' }] },
        ],
      },
    } as unknown as import('../../../backend/src/types/solution-bundle.types.js').BundleTemplate;

    beforeEach(() => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockListTemplates.mockReturnValue([]);
    });

    it('--yes deploys it with --answers and --runtime instead of creating a starter team', async () => {
      mockReadFileSync.mockReturnValueOnce(JSON.stringify({ business_name: 'Acme', platforms: ['抖音'] }));
      const deployBundle = jest.fn(async () => 0);
      mockJqFound();
      await onboardCommand(
        { yes: true, template: 'demo-bundle', answers: 'answers.json', runtime: 'crewly-agent' },
        { findBundle: (id) => (id === 'demo-bundle' ? bundle : null), deployBundle },
      );
      expect(deployBundle).toHaveBeenCalledWith('demo-bundle', { business_name: 'Acme', platforms: ['抖音'] }, 'crewly-agent');
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('First team: 演示方案');
      expect(output).toContain('Setup complete');
      expect(mockGetTemplate).not.toHaveBeenCalled();
      expect(mockDeliverFirstTask).not.toHaveBeenCalled();
    });

    it('asks the bundle questions in the terminal', async () => {
      mockReadlineAnswers = ['2', 'Acme', '1,2'];
      mockReadlineAnswerIndex = 0;
      const deployBundle = jest.fn(async () => 0);
      mockJqFound();
      await onboardCommand({ template: 'demo-bundle' }, { findBundle: () => bundle, deployBundle });
      expect(deployBundle).toHaveBeenCalledWith('demo-bundle', { business_name: 'Acme', platforms: ['小红书', '抖音'] }, undefined);
    });

    it('--task still goes to the bundle team', async () => {
      const deployBundle = jest.fn(async () => 0);
      mockJqFound();
      await onboardCommand({ yes: true, template: 'demo-bundle', task: 'Hello' }, { findBundle: () => bundle, deployBundle });
      expect(mockDeliverFirstTask).toHaveBeenCalledWith('Hello', 'demo-bundle');
    });

    it('does not deploy when the answers file cannot be read', async () => {
      mockReadFileSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
      const deployBundle = jest.fn(async () => 0);
      mockJqFound();
      await onboardCommand({ yes: true, template: 'demo-bundle', answers: 'missing.json' }, { findBundle: () => bundle, deployBundle });
      expect(deployBundle).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Cannot read the answers file: missing.json');
    });
  });
});
