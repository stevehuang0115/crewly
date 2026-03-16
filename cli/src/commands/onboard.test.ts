/**
 * Tests for the CLI onboard command.
 *
 * Validates the interactive setup wizard: banner output, provider selection,
 * tool detection/installation, skills check, team creation, the full flow,
 * and the --yes (non-interactive) and --template flags.
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
jest.mock('../utils/templates.js', () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
  getTemplatesDir: (...args: unknown[]) => mockGetTemplatesDir(...args),
}));

const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockCopyFileSync = jest.fn();
jest.mock('fs', () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => '',
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

import {
  printBanner,
  selectProvider,
  checkToolInstalled,
  getToolVersion,
  installTool,
  ensureTools,
  ensureSkills,
  selectTemplate,
  createTeamFromTemplate,
  scaffoldCrewlyDirectory,
  copyTemplateProjectFiles,
  printSummary,
  onboardCommand,
  type ProviderChoice,
} from './onboard.js';

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

/** Helper: make tmux appear as not found (consumes 1 mockExecSync call) */
function mockTmuxNotFound(): void {
  mockExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
}

/** Helper: make tmux appear as found (consumes 2 mockExecSync calls) */
function mockTmuxFound(): void {
  mockExecSync
    .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
    .mockReturnValueOnce(Buffer.from('tmux 3.4'));        // tmux -V
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onboard command', () => {
  let logSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    mockExecSync.mockReset();
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
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
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
  // selectProvider
  // -----------------------------------------------------------------------

  describe('selectProvider', () => {
    it.each([
      ['1', 'claude'],
      ['2', 'gemini'],
      ['3', 'codex'],
      ['4', 'both'],
      ['5', 'skip'],
    ] as [string, ProviderChoice][])('returns "%s" when user enters %s', async (input, expected) => {
      const rl = createMockReadline([input]);
      const result = await selectProvider(rl);
      expect(result).toBe(expected);
    });

    it('re-prompts on invalid input then accepts valid', async () => {
      const rl = createMockReadline(['x', '9', '2']);
      const result = await selectProvider(rl);
      expect(result).toBe('gemini');
      // Should have printed a warning for bad inputs
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Please enter 1, 2, 3, 4, or 5');
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
  // installTool
  // -----------------------------------------------------------------------

  describe('installTool', () => {
    it('runs npm install and returns true on success', () => {
      mockExecSync.mockReturnValue(Buffer.from(''));
      const result = installTool('Claude Code', '@anthropic-ai/claude-code');
      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'npm install -g @anthropic-ai/claude-code',
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('returns false on failure and suggests sudo', () => {
      mockExecSync.mockImplementation(() => { throw new Error('permission denied'); });
      const result = installTool('Claude Code', '@anthropic-ai/claude-code');
      expect(result).toBe(false);
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('sudo npm install -g');
    });
  });

  // -----------------------------------------------------------------------
  // ensureTools
  // -----------------------------------------------------------------------

  describe('ensureTools', () => {
    it('checks for tmux before provider tools', async () => {
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
        .mockReturnValueOnce(Buffer.from('tmux 3.4'));        // tmux -V

      const rl = createMockReadline([]);
      await ensureTools(rl, 'skip');

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('tmux detected');
    });

    it('warns when tmux is not found and exits', async () => {
      mockTmuxNotFound();

      const rl = createMockReadline([]);
      await expect(ensureTools(rl, 'skip')).rejects.toThrow('process.exit called');

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('tmux not found');
      expect(output).toContain('brew install tmux');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('skips tool installation when provider is skip and tmux present', async () => {
      // tmux found
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))
        .mockReturnValueOnce(Buffer.from('tmux 3.4'));

      const rl = createMockReadline([]);
      await ensureTools(rl, 'skip');
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Skipped');
    });

    it('detects an already-installed tool', async () => {
      // tmux → found; which claude → found; claude --version
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
        .mockReturnValueOnce(Buffer.from('tmux 3.4'))         // tmux -V
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

      const rl = createMockReadline([]);
      await ensureTools(rl, 'claude');

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Claude Code detected');
    });

    it('prompts to install a missing tool and installs on Y', async () => {
      // tmux → found; which claude → not found; npm install → succeeds
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
        .mockReturnValueOnce(Buffer.from('tmux 3.4'))         // tmux -V
        .mockImplementationOnce(() => { throw new Error('not found'); })  // which claude
        .mockReturnValueOnce(Buffer.from(''))  // npm install
        ;

      const rl = createMockReadline(['Y']);
      await ensureTools(rl, 'claude');

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('not found');
      expect(output).toContain('installed');
    });

    it('skips installation when user declines', async () => {
      // tmux → found; which claude → not found
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
        .mockReturnValueOnce(Buffer.from('tmux 3.4'))         // tmux -V
        .mockImplementationOnce(() => { throw new Error('not found'); });  // which claude

      const rl = createMockReadline(['n']);
      await ensureTools(rl, 'claude');

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Skipped Claude Code');
    });

    it('auto-installs missing tools when autoYes is true', async () => {
      // tmux → found; which claude → not found; npm install → succeeds
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/bin/tmux'))   // which tmux
        .mockReturnValueOnce(Buffer.from('tmux 3.4'))         // tmux -V
        .mockImplementationOnce(() => { throw new Error('not found'); }) // which claude
        .mockReturnValueOnce(Buffer.from('')) // npm install
        ;

      const rl = createMockReadline([]);
      await ensureTools(rl, 'claude', true);

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('not found');
      expect(output).toContain('installed');
      // Should NOT have asked the user
      expect(rl.question).not.toHaveBeenCalled;
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
      mockInstallAllSkills.mockResolvedValue(5);
      await ensureSkills();
      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Installing 5 agent skills');
      expect(output).toContain('5 skills installed');
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

    it('runs the full wizard selecting skip provider', async () => {
      mockReadlineAnswers = ['5']; // skip provider; template auto-skips (no templates)
      mockReadlineAnswerIndex = 0;

      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Welcome');
      expect(output).toContain('Skipped');
      expect(output).toContain('Setup complete');
      expect(mockRlClose).toHaveBeenCalled();
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

      // Answer '5' for provider (skip), '1' for template selection
      mockReadlineAnswers = ['5', '1'];
      mockReadlineAnswerIndex = 0;

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

      mockReadlineAnswers = ['5', '1']; // skip provider, select first template
      mockReadlineAnswerIndex = 0;

      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Team "Web Dev Team" created');
    });

    it('closes readline even if an error occurs in skills', async () => {
      mockReadlineAnswers = ['1']; // claude provider; template auto-skips (no templates)
      mockReadlineAnswerIndex = 0;

      // tmux → found; which claude → found; claude --version
      mockTmuxFound();
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

      // Skills check fails
      mockCheckSkillsInstalled.mockRejectedValue(new Error('fail'));

      await onboardCommand();

      // readline should still be closed
      expect(mockRlClose).toHaveBeenCalled();
    });

    it('scaffolds .crewly/ directory during interactive flow', async () => {
      mockReadlineAnswers = ['5']; // skip provider
      mockReadlineAnswerIndex = 0;
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      await onboardCommand();

      // Should have called scaffoldCrewlyDirectory (which calls mkdirSync)
      expect(mockMkdirSync).toHaveBeenCalled();
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
      // tmux → found; which claude → found; claude --version
      mockTmuxFound();
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('non-interactive');
      expect(output).toContain('Using default: Claude Code');
      expect(output).toContain('Setup complete');
    });

    it('auto-installs missing tools in --yes mode', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      // tmux → found; which claude → not found; npm install succeeds
      mockTmuxFound();
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockReturnValueOnce(Buffer.from(''));

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('not found');
      expect(output).toContain('installed');
    });

    it('uses first available template when no --template specified', async () => {
      mockListTemplates.mockReturnValue([sampleTemplate]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockTmuxFound();
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

      await onboardCommand({ yes: true });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
    });

    it('scaffolds .crewly/ directory in --yes mode', async () => {
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockTmuxFound();
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

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

      // Skip provider (step 1)
      mockReadlineAnswers = ['5'];
      mockReadlineAnswerIndex = 0;

      await onboardCommand({ template: 'web-dev-team' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
      // Should NOT prompt for template selection
      expect(output).not.toContain('Choose a pre-built team');
    });

    it('uses specified template in --yes mode', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });
      mockTmuxFound();
      mockExecSync
        .mockReturnValueOnce(Buffer.from('/usr/local/bin/claude'))
        .mockReturnValueOnce(Buffer.from('1.0.17'));

      await onboardCommand({ yes: true, template: 'web-dev-team' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Using template: Web Dev Team');
    });

    it('warns when template ID is not found', async () => {
      mockGetTemplate.mockReturnValue(undefined);
      mockListTemplates.mockReturnValue([sampleTemplate]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      mockReadlineAnswers = ['5', '']; // skip provider, skip template
      mockReadlineAnswerIndex = 0;

      await onboardCommand({ template: 'nonexistent' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Template "nonexistent" not found');
      expect(output).toContain('Available templates: web-dev-team');
    });

    it('warns when template not found and no templates available', async () => {
      mockGetTemplate.mockReturnValue(undefined);
      mockListTemplates.mockReturnValue([]);
      mockCheckSkillsInstalled.mockResolvedValue({ installed: 10, total: 10 });

      mockReadlineAnswers = ['5'];
      mockReadlineAnswerIndex = 0;

      await onboardCommand({ template: 'nonexistent' });

      const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Template "nonexistent" not found');
      // Should not show available templates line
      expect(output).not.toContain('Available templates:');
    });
  });
});
