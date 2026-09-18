/**
 * Unit tests for SessionMemoryService
 *
 * Tests the session lifecycle management: startup briefings, session summaries,
 * agents index updates, and markdown formatting of briefings. Uses mocked
 * AgentMemoryService and ProjectMemoryService dependencies and temporary
 * directories for file I/O isolation.
 *
 * @module services/memory/session-memory.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ---- Mocks must be declared before importing the service under test ----

/**
 * Fake home directory for os.homedir(). We use `var` because jest.mock factories
 * are hoisted before const/let declarations, but `var` declarations are also hoisted.
 */
// eslint-disable-next-line no-var
var _fakeHomeDir: string = '';

jest.mock('os', () => {
  const actualOs = jest.requireActual<typeof import('os')>('os');
  return {
    ...actualOs,
    homedir: () => _fakeHomeDir || actualOs.homedir(),
  };
});

jest.mock('../core/logger.service.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    LoggerService: {
      getInstance: () => ({ createComponentLogger: () => mockLogger }),
    },
  };
});

const mockAgentMemoryService = {
  initializeAgent: jest.fn(),
  generateAgentContext: jest.fn().mockResolvedValue('agent context'),
  getRoleKnowledge: jest.fn().mockResolvedValue([]),
};

jest.mock('./agent-memory.service.js', () => ({
  AgentMemoryService: {
    getInstance: () => mockAgentMemoryService,
  },
}));

const mockProjectMemoryService = {
  initializeProject: jest.fn(),
  generateProjectContext: jest.fn().mockResolvedValue('project context'),
};

jest.mock('./project-memory.service.js', () => ({
  ProjectMemoryService: {
    getInstance: () => mockProjectMemoryService,
  },
}));

import { SessionMemoryService } from './session-memory.service.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import type { StartupBriefing } from '../../types/memory.types.js';

describe('SessionMemoryService', () => {
  let service: SessionMemoryService;
  let testDir: string;
  let testProjectPath: string;
  const testAgentId = 'test-agent-001';
  const testRole = 'developer';

  /**
   * Returns the current fake home directory used by the mocked os.homedir().
   *
   * @returns Absolute path to the fake home
   */
  function fakeHome(): string {
    return _fakeHomeDir || os.homedir();
  }

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `crewly-session-test-${Date.now()}-${Math.random().toString(36).substring(2)}`,
    );
    testProjectPath = path.join(testDir, 'project');
    await fs.mkdir(testProjectPath, { recursive: true });

    // Point os.homedir() to a fake home inside the temp directory
    _fakeHomeDir = path.join(testDir, 'home');

    SessionMemoryService.clearInstance();
    service = SessionMemoryService.getInstance();

    jest.clearAllMocks();
  });

  afterEach(async () => {
    SessionMemoryService.clearInstance();
    // Reset fake home to real home so cleanup code works normally
    _fakeHomeDir = '';
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ========================= SINGLETON PATTERN =========================

  describe('getInstance / clearInstance', () => {
    it('should return the same singleton instance', () => {
      const instance1 = SessionMemoryService.getInstance();
      const instance2 = SessionMemoryService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after clearInstance', () => {
      const first = SessionMemoryService.getInstance();
      SessionMemoryService.clearInstance();
      const second = SessionMemoryService.getInstance();
      expect(first).not.toBe(second);
    });
  });

  // ========================= onSessionStart =========================

  describe('onSessionStart', () => {
    it('should initialize agent memory', async () => {
      await service.onSessionStart(testAgentId, testRole, testProjectPath);
      expect(mockAgentMemoryService.initializeAgent).toHaveBeenCalledWith(testAgentId, testRole);
    });

    it('should initialize project memory', async () => {
      await service.onSessionStart(testAgentId, testRole, testProjectPath);
      expect(mockProjectMemoryService.initializeProject).toHaveBeenCalledWith(testProjectPath);
    });

    it('should update the agents index', async () => {
      await service.onSessionStart(testAgentId, testRole, testProjectPath);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(1);
      expect(index.agents[0].agentId).toBe(testAgentId);
      expect(index.agents[0].role).toBe(testRole);
    });
  });

  // ========================= onSessionEnd =========================

  describe('onSessionEnd', () => {
    it('should write a timestamped session archive file', async () => {
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Implemented auth');

      const sessionsDir = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
      );

      const files = await fs.readdir(sessionsDir);
      // Should contain both the timestamped file and latest-summary.md
      expect(files.length).toBeGreaterThanOrEqual(2);

      const mdFiles = files.filter((f) => f.endsWith('.md'));
      expect(mdFiles).toContain(MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY);
      // There should be at least one YYYY-MM-DD-HH-MM.md file
      const archiveFiles = mdFiles.filter((f) => f !== MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY);
      expect(archiveFiles.length).toBe(1);
      expect(archiveFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/);
    });

    it('should write latest-summary.md with correct content', async () => {
      const summary = 'Added user authentication with JWT';
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, summary);

      const latestPath = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
        MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY,
      );

      const content = await fs.readFile(latestPath, 'utf-8');
      expect(content).toContain('# Session Summary');
      expect(content).toContain(`**Agent:** ${testAgentId}`);
      expect(content).toContain(`**Role:** ${testRole}`);
      expect(content).toContain(`**Project:** ${testProjectPath}`);
      expect(content).toContain('**Ended:**');
      expect(content).toContain(summary);
    });

    it('should use default summary text when none provided', async () => {
      await service.onSessionEnd(testAgentId, testRole, testProjectPath);

      const latestPath = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
        MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY,
      );

      const content = await fs.readFile(latestPath, 'utf-8');
      expect(content).toContain('No summary provided');
    });

    it('should produce archive and latest-summary with identical content', async () => {
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Test summary');

      const sessionsDir = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
      );

      const files = await fs.readdir(sessionsDir);
      const archiveFile = files.find(
        (f) => f.endsWith('.md') && f !== MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY,
      );
      expect(archiveFile).toBeDefined();

      const archiveContent = await fs.readFile(path.join(sessionsDir, archiveFile!), 'utf-8');
      const latestContent = await fs.readFile(
        path.join(sessionsDir, MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY),
        'utf-8',
      );

      expect(archiveContent).toBe(latestContent);
    });

    it('should include an ISO timestamp in the Ended field', async () => {
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Check timestamp');

      const latestPath = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
        MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY,
      );

      const content = await fs.readFile(latestPath, 'utf-8');
      // ISO timestamp like 2026-02-09T12:34:56.789Z
      expect(content).toMatch(/\*\*Ended:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // ========================= generateStartupBriefing =========================

  describe('generateStartupBriefing', () => {
    it('should return a StartupBriefing object with all expected fields', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);

      expect(briefing).toHaveProperty('lastSessionSummary');
      expect(briefing).toHaveProperty('agentContext');
      expect(briefing).toHaveProperty('projectContext');
      expect(briefing).toHaveProperty('todaysDailyLog');
      expect(briefing).toHaveProperty('activeGoals');
      expect(briefing).toHaveProperty('recentFailures');
      expect(briefing).toHaveProperty('recentSuccesses');
    });

    it('should include agentContext from AgentMemoryService', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.agentContext).toBe('agent context');
      expect(mockAgentMemoryService.generateAgentContext).toHaveBeenCalledWith(testAgentId);
    });

    it('should include projectContext from ProjectMemoryService', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.projectContext).toBe('project context');
      expect(mockProjectMemoryService.generateProjectContext).toHaveBeenCalledWith(testProjectPath);
    });

    it('should read the latest session summary when it exists', async () => {
      const sessionsDir = path.join(
        fakeHome(),
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
        testAgentId,
        MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
      );
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY),
        'Previous session summary content',
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.lastSessionSummary).toBe('Previous session summary content');
    });

    it('should return null for lastSessionSummary when no file exists', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.lastSessionSummary).toBeNull();
    });

    it('should read todays daily log when it exists', async () => {
      const today = new Date().toISOString().split('T')[0];
      const dailyLogDir = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.DAILY_LOG_DIR,
      );
      await fs.mkdir(dailyLogDir, { recursive: true });
      await fs.writeFile(path.join(dailyLogDir, `${today}.md`), 'Daily log content');

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.todaysDailyLog).toBe('Daily log content');
    });

    it('should return null for todaysDailyLog when no file exists', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.todaysDailyLog).toBeNull();
    });

    it('should read active goals when the goals file exists', async () => {
      const goalsDir = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.GOALS_DIR,
      );
      await fs.mkdir(goalsDir, { recursive: true });
      await fs.writeFile(
        path.join(goalsDir, MEMORY_CONSTANTS.PATHS.GOALS_FILE),
        '- Finish auth module',
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.activeGoals).toBe('- Finish auth module');
    });

    it('should return null for activeGoals when no file exists', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.activeGoals).toBeNull();
    });

    it('should read and tail recent failures to last 500 characters', async () => {
      const learningDir = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
      );
      await fs.mkdir(learningDir, { recursive: true });
      const failedContent = 'A'.repeat(1000);
      await fs.writeFile(
        path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE),
        failedContent,
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.recentFailures).not.toBeNull();
      expect(briefing.recentFailures!.length).toBe(500);
    });

    it('should read and tail recent successes to last 500 characters', async () => {
      const learningDir = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
      );
      await fs.mkdir(learningDir, { recursive: true });
      const workedContent = 'B'.repeat(800);
      await fs.writeFile(
        path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE),
        workedContent,
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.recentSuccesses).not.toBeNull();
      expect(briefing.recentSuccesses!.length).toBe(500);
    });

    it('should return null for recentFailures when no file exists', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.recentFailures).toBeNull();
    });

    it('should return null for recentSuccesses when no file exists', async () => {
      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.recentSuccesses).toBeNull();
    });

    it('should gracefully handle agentContext generation failure', async () => {
      mockAgentMemoryService.generateAgentContext.mockRejectedValueOnce(new Error('agent error'));

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.agentContext).toBe('');
    });

    it('should gracefully handle projectContext generation failure', async () => {
      mockProjectMemoryService.generateProjectContext.mockRejectedValueOnce(
        new Error('project error'),
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.projectContext).toBe('');
    });

    it('should not tail content shorter than LEARNING_TAIL_CHARS', async () => {
      const learningDir = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
      );
      await fs.mkdir(learningDir, { recursive: true });
      const shortContent = 'Short failure note';
      await fs.writeFile(
        path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE),
        shortContent,
      );

      const briefing = await service.generateStartupBriefing(testAgentId, testRole, testProjectPath);
      expect(briefing.recentFailures).toBe(shortContent);
    });
  });

  // ========================= formatBriefingAsMarkdown =========================

  describe('formatBriefingAsMarkdown', () => {
    it('should always include the top-level heading', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('## Your Previous Knowledge');
    });

    it('should include last session section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: 'Did great work',
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Last Session');
      expect(md).toContain('Did great work');
    });

    it('should include agent memory section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: 'Agent knowledge data',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Your Agent Memory');
      expect(md).toContain('Agent knowledge data');
    });

    it('should include project knowledge section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: 'Project patterns and decisions',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Project Knowledge');
      expect(md).toContain('Project patterns and decisions');
    });

    it('should include todays activity section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: 'Fixed 3 bugs today',
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain("### Today's Activity");
      expect(md).toContain('Fixed 3 bugs today');
    });

    it('should include active goals section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: '- Ship feature X\n- Review PR #42',
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Active Goals');
      expect(md).toContain('Ship feature X');
    });

    it('should include recent failures section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: 'Database migration failed',
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Recent Failures (avoid repeating)');
      expect(md).toContain('Database migration failed');
    });

    it('should include recent successes section when present', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: 'Caching layer reduced latency by 80%',
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('### Recent Successes (replicate)');
      expect(md).toContain('Caching layer reduced latency by 80%');
    });

    it('should omit null and empty-string sections', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).not.toContain('### Last Session');
      expect(md).not.toContain('### Your Agent Memory');
      expect(md).not.toContain('### Project Knowledge');
      expect(md).not.toContain("### Today's Activity");
      expect(md).not.toContain('### Active Goals');
      expect(md).not.toContain('### Recent Failures');
      expect(md).not.toContain('### Recent Successes');
    });

    it('should truncate sections exceeding MAX_SECTION_CHARS (2000)', () => {
      const longContent = 'X'.repeat(3000);
      const briefing: StartupBriefing = {
        lastSessionSummary: longContent,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('... (truncated)');
      // The truncated section should not contain the full 3000-char string
      expect(md).not.toContain(longContent);
    });

    it('should not truncate sections within MAX_SECTION_CHARS', () => {
      const shortContent = 'Y'.repeat(1500);
      const briefing: StartupBriefing = {
        lastSessionSummary: shortContent,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain(shortContent);
      expect(md).not.toContain('... (truncated)');
    });

    it('should truncate agentContext and projectContext independently', () => {
      const longAgent = 'A'.repeat(2500);
      const longProject = 'P'.repeat(2500);
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: longAgent,
        projectContext: longProject,
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      // Both sections should be truncated
      const truncationCount = (md.match(/\.\.\. \(truncated\)/g) || []).length;
      expect(truncationCount).toBe(2);
    });

    it('should include all sections in a full briefing', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: 'Summary here',
        agentContext: 'Agent context here',
        projectContext: 'Project context here',
        todaysDailyLog: 'Daily log here',
        activeGoals: 'Goals here',
        recentFailures: 'Failures here',
        recentSuccesses: 'Successes here',
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toContain('## Your Previous Knowledge');
      expect(md).toContain('### Last Session');
      expect(md).toContain('### Your Agent Memory');
      expect(md).toContain('### Project Knowledge');
      expect(md).toContain("### Today's Activity");
      expect(md).toContain('### Active Goals');
      expect(md).toContain('### Recent Failures (avoid repeating)');
      expect(md).toContain('### Recent Successes (replicate)');
    });

    it('should return a trimmed string', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: null,
        agentContext: '',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      expect(md).toBe(md.trim());
    });

    it('should separate sections with double newlines', () => {
      const briefing: StartupBriefing = {
        lastSessionSummary: 'Session data',
        agentContext: 'Agent data',
        projectContext: '',
        todaysDailyLog: null,
        activeGoals: null,
        recentFailures: null,
        recentSuccesses: null,
      };

      const md = service.formatBriefingAsMarkdown(briefing);
      // Between the heading and content there should be a double newline
      expect(md).toContain('## Your Previous Knowledge\n\n### Last Session');
    });
  });

  // ========================= updateAgentsIndex =========================

  describe('updateAgentsIndex', () => {
    it('should create a new agents index file when none exists', async () => {
      await service.updateAgentsIndex(testProjectPath, testAgentId, testRole);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(1);
      expect(index.agents[0].agentId).toBe(testAgentId);
      expect(index.agents[0].role).toBe(testRole);
      expect(index.agents[0].lastActive).toBeDefined();
    });

    it('writes the index under CREWLY_HOME when the project path is the npm package tree', async () => {
      const pkgPath = path.join(testDir, 'lib', 'node_modules', 'crewly');
      const savedHome = process.env.CREWLY_HOME;
      process.env.CREWLY_HOME = path.join(testDir, 'safe-home');
      try {
        await service.updateAgentsIndex(pkgPath, testAgentId, testRole);
        const safeIndex = path.join(testDir, 'safe-home', MEMORY_CONSTANTS.PATHS.AGENTS_INDEX);
        expect(JSON.parse(await fs.readFile(safeIndex, 'utf-8')).agents).toHaveLength(1);
        await expect(
          fs.access(path.join(pkgPath, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, MEMORY_CONSTANTS.PATHS.AGENTS_INDEX)),
        ).rejects.toBeDefined();
      } finally {
        if (savedHome === undefined) delete process.env.CREWLY_HOME;
        else process.env.CREWLY_HOME = savedHome;
      }
    });

    it('should store a valid ISO timestamp in lastActive', async () => {
      await service.updateAgentsIndex(testProjectPath, testAgentId, testRole);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      const parsedDate = new Date(index.agents[0].lastActive);
      expect(parsedDate.toISOString()).toBe(index.agents[0].lastActive);
    });

    it('should add a second agent to an existing index', async () => {
      await service.updateAgentsIndex(testProjectPath, testAgentId, testRole);
      await service.updateAgentsIndex(testProjectPath, 'agent-002', 'qa');

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(2);
      const ids = index.agents.map((a: { agentId: string }) => a.agentId);
      expect(ids).toContain(testAgentId);
      expect(ids).toContain('agent-002');
    });

    it('should update lastActive and role for an existing agent', async () => {
      await service.updateAgentsIndex(testProjectPath, testAgentId, testRole);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const firstRaw = await fs.readFile(indexPath, 'utf-8');
      const firstIndex = JSON.parse(firstRaw);
      const firstLastActive = firstIndex.agents[0].lastActive;

      // Small delay to guarantee a different ISO timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await service.updateAgentsIndex(testProjectPath, testAgentId, 'qa');

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(1);
      expect(index.agents[0].role).toBe('qa');
      // lastActive should have been updated
      expect(index.agents[0].lastActive).not.toBe(firstLastActive);
    });

    it('should create the .crewly directory if it does not exist', async () => {
      const freshProject = path.join(testDir, 'fresh-project');
      await fs.mkdir(freshProject, { recursive: true });

      await service.updateAgentsIndex(freshProject, testAgentId, testRole);

      const crewlyDir = path.join(freshProject, CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
      const stat = await fs.stat(crewlyDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should preserve existing agents when updating a different one', async () => {
      await service.updateAgentsIndex(testProjectPath, 'agent-A', 'developer');
      await service.updateAgentsIndex(testProjectPath, 'agent-B', 'qa');
      await service.updateAgentsIndex(testProjectPath, 'agent-A', 'developer');

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(2);
    });

    it('should write valid JSON to the index file', async () => {
      await service.updateAgentsIndex(testProjectPath, testAgentId, testRole);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  // ========================= End-to-end session lifecycle =========================

  describe('end-to-end session lifecycle', () => {
    it('should produce a briefing with lastSessionSummary after onSessionEnd', async () => {
      // Start session
      await service.onSessionStart(testAgentId, testRole, testProjectPath);

      // End session with a summary
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Completed task X');

      // Generate briefing -- should pick up latest-summary.md
      const briefing = await service.generateStartupBriefing(
        testAgentId,
        testRole,
        testProjectPath,
      );

      expect(briefing.lastSessionSummary).not.toBeNull();
      expect(briefing.lastSessionSummary).toContain('Completed task X');
    });

    it('should format the lifecycle briefing into markdown', async () => {
      await service.onSessionStart(testAgentId, testRole, testProjectPath);
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Refactored services');

      const briefing = await service.generateStartupBriefing(
        testAgentId,
        testRole,
        testProjectPath,
      );
      const md = service.formatBriefingAsMarkdown(briefing);

      expect(md).toContain('## Your Previous Knowledge');
      expect(md).toContain('### Last Session');
      expect(md).toContain('Refactored services');
    });

    it('should update the agents index during start and remain readable after end', async () => {
      await service.onSessionStart(testAgentId, testRole, testProjectPath);
      await service.onSessionEnd(testAgentId, testRole, testProjectPath, 'Done');

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(1);
      expect(index.agents[0].agentId).toBe(testAgentId);
    });

    it('should handle multiple agents in the same project', async () => {
      await service.onSessionStart('agent-A', 'developer', testProjectPath);
      await service.onSessionStart('agent-B', 'qa', testProjectPath);

      const indexPath = path.join(
        testProjectPath,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
      );

      const raw = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw);

      expect(index.agents).toHaveLength(2);
      expect(mockAgentMemoryService.initializeAgent).toHaveBeenCalledTimes(2);
      expect(mockProjectMemoryService.initializeProject).toHaveBeenCalledTimes(2);
    });
  });
});
