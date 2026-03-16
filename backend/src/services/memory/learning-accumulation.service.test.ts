/**
 * Unit tests for LearningAccumulationService
 *
 * Tests project-level and global-level learning file management including
 * recording successes, failures, cross-project insights, and reading them back.
 *
 * @module services/memory/learning-accumulation.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as actualOs from 'os';

/**
 * Mutable override for os.homedir() return value.
 * When set to a non-empty string, os.homedir() in the service under test
 * will return this value instead of the real home directory.
 */
let homedirOverride = '';

// Mock the os module so we can control homedir() for global-path tests
jest.mock('os', () => {
  const realOs = jest.requireActual<typeof import('os')>('os');
  return {
    ...realOs,
    homedir: () => (homedirOverride || realOs.homedir()),
  };
});

// Mock LoggerService to avoid initializing ConfigService in tests
jest.mock('../core/logger.service.js', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    LoggerService: {
      getInstance: () => ({
        createComponentLogger: () => mockLogger,
      }),
    },
  };
});

import { LearningAccumulationService } from './learning-accumulation.service.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';

describe('LearningAccumulationService', () => {
  let service: LearningAccumulationService;
  let testProjectDir: string;
  let testGlobalHome: string;
  const testAgentId = 'dev-001';
  const testRole = 'developer';

  beforeEach(async () => {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    testProjectDir = path.join(actualOs.tmpdir(), `crewly-learn-project-${uniqueId}`);
    testGlobalHome = path.join(actualOs.tmpdir(), `crewly-learn-global-${uniqueId}`);
    await fs.mkdir(testProjectDir, { recursive: true });
    await fs.mkdir(testGlobalHome, { recursive: true });

    // Reset homedir override
    homedirOverride = '';

    LearningAccumulationService.clearInstance();
    service = LearningAccumulationService.getInstance();
  });

  afterEach(async () => {
    homedirOverride = '';
    LearningAccumulationService.clearInstance();
    try {
      await fs.rm(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      await fs.rm(testGlobalHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getInstance', () => {
    it('should return the same singleton instance', () => {
      const instance1 = LearningAccumulationService.getInstance();
      const instance2 = LearningAccumulationService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after clearInstance', () => {
      const instance1 = LearningAccumulationService.getInstance();
      LearningAccumulationService.clearInstance();
      const instance2 = LearningAccumulationService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('recordSuccess', () => {
    it('should create learning directory and what_worked.md', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Tests pass reliably');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should write file with correct header on first entry', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'A success');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# What Worked');
      expect(content).toContain('Successful patterns, approaches, and solutions.');
    });

    it('should append formatted entry with timestamp, role, and agentId', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Parallel tests work');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toMatch(/### \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] developer \/ dev-001/);
      expect(content).toContain('Parallel tests work');
      expect(content).toContain('Context: None');
      expect(content).toContain('---');
    });

    it('should include context when provided', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Caching helps', 'Redis layer');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Context: Redis layer');
    });

    it('should append multiple entries without overwriting', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'First success');
      await service.recordSuccess(testProjectDir, 'dev-002', 'qa', 'Second success');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('First success');
      expect(content).toContain('Second success');
      expect(content).toContain('developer / dev-001');
      expect(content).toContain('qa / dev-002');
    });
  });

  describe('recordFailure', () => {
    it('should create learning directory and what_failed.md', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Flaky test');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
      );

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should write file with correct header on first entry', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'A failure');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# What Failed');
      expect(content).toContain('Failed approaches, pitfalls, and things to avoid.');
    });

    it('should append formatted entry with context', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'ORM was slow', 'N+1 query issue');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toMatch(/### \[.*\] developer \/ dev-001/);
      expect(content).toContain('ORM was slow');
      expect(content).toContain('Context: N+1 query issue');
    });
  });

  describe('recordCrossProjectInsight', () => {
    it('should create global learning directory and insights file', async () => {
      homedirOverride = testGlobalHome;

      await service.recordCrossProjectInsight(testAgentId, testRole, 'TypeScript strict mode is great');

      const filePath = path.join(
        testGlobalHome,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.GLOBAL_LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.CROSS_PROJECT_INSIGHTS,
      );

      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# Cross-Project Insights');
      expect(content).toContain('TypeScript strict mode is great');
    });

    it('should include context when provided', async () => {
      homedirOverride = testGlobalHome;

      await service.recordCrossProjectInsight(testAgentId, testRole, 'Insight text', 'Observed in 3 projects');

      const filePath = path.join(
        testGlobalHome,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.GLOBAL_LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.CROSS_PROJECT_INSIGHTS,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Context: Observed in 3 projects');
    });
  });

  describe('getSuccesses', () => {
    it('should return null when file does not exist', async () => {
      const result = await service.getSuccesses(testProjectDir);
      expect(result).toBeNull();
    });

    it('should return full content when tailChars is not specified', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Success entry');

      const result = await service.getSuccesses(testProjectDir);
      expect(result).not.toBeNull();
      expect(result).toContain('# What Worked');
      expect(result).toContain('Success entry');
    });

    it('should return only last N characters when tailChars is specified', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'First entry for tail test');
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Second entry for tail test');

      const fullContent = await service.getSuccesses(testProjectDir);
      expect(fullContent).not.toBeNull();

      const tailResult = await service.getSuccesses(testProjectDir, 50);
      expect(tailResult).not.toBeNull();
      expect(tailResult!.length).toBe(50);
      // Tail should be the end of the full content
      expect(fullContent!.endsWith(tailResult!)).toBe(true);
    });

    it('should return full content when tailChars exceeds content length', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Short');

      const result = await service.getSuccesses(testProjectDir, 999999);
      expect(result).not.toBeNull();
      expect(result).toContain('# What Worked');
      expect(result).toContain('Short');
    });
  });

  describe('getFailures', () => {
    it('should return null when file does not exist', async () => {
      const result = await service.getFailures(testProjectDir);
      expect(result).toBeNull();
    });

    it('should return full content when tailChars is not specified', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Failure entry');

      const result = await service.getFailures(testProjectDir);
      expect(result).not.toBeNull();
      expect(result).toContain('# What Failed');
      expect(result).toContain('Failure entry');
    });

    it('should return only last N characters when tailChars is specified', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'First failure');
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Second failure');

      const fullContent = await service.getFailures(testProjectDir);
      expect(fullContent).not.toBeNull();

      const tailResult = await service.getFailures(testProjectDir, 40);
      expect(tailResult).not.toBeNull();
      expect(tailResult!.length).toBe(40);
      expect(fullContent!.endsWith(tailResult!)).toBe(true);
    });
  });

  describe('supersede mechanism', () => {
    it('should include Supersedes tag when recordSuccess has supersedes param', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'T1 deploy succeeded', 'completed', 'T1 deploy BLOCKED');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Supersedes: T1 deploy BLOCKED');
    });

    it('should mark matching failure entries as [SUPERSEDED] when recordSuccess has supersedes', async () => {
      // First record a failure
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'T1 deploy BLOCKED: build failed');
      // Then record success that supersedes it
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'T1 deploy succeeded', undefined, 'T1 deploy BLOCKED');

      const failedPath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
      );

      const failedContent = await fs.readFile(failedPath, 'utf-8');
      expect(failedContent).toContain('[SUPERSEDED]');
    });

    it('should filter out [SUPERSEDED] entries from getFailures output', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'T1 deploy BLOCKED: build failed');
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Unrelated failure keeps showing');
      // Supersede the T1 failure
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'T1 deploy succeeded', undefined, 'T1 deploy BLOCKED');

      const failures = await service.getFailures(testProjectDir);
      expect(failures).not.toBeNull();
      expect(failures).not.toContain('T1 deploy BLOCKED');
      expect(failures).toContain('Unrelated failure keeps showing');
    });

    it('should filter out [SUPERSEDED] entries from getSuccesses output', async () => {
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'Old approach worked');
      // A later failure supersedes the old success
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Old approach actually failed', undefined, 'Old approach worked');

      const successes = await service.getSuccesses(testProjectDir);
      expect(successes).not.toBeNull();
      expect(successes).not.toContain('Old approach worked');
    });

    it('should include Supersedes tag when recordFailure has supersedes param', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Actually it broke', undefined, 'Initial success');

      const filePath = path.join(
        testProjectDir,
        CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
        MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
        MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
      );

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Supersedes: Initial success');
    });

    it('should handle supersede when target file does not exist', async () => {
      // Record success with supersedes but no prior failure file
      await expect(
        service.recordSuccess(testProjectDir, testAgentId, testRole, 'No prior failure', undefined, 'nonexistent')
      ).resolves.not.toThrow();
    });

    it('should not modify entries that do not match the supersedes keyword', async () => {
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'Unrelated issue: X');
      await service.recordFailure(testProjectDir, testAgentId, testRole, 'T2 deploy BLOCKED');
      await service.recordSuccess(testProjectDir, testAgentId, testRole, 'T2 done', undefined, 'T2 deploy BLOCKED');

      const failures = await service.getFailures(testProjectDir);
      expect(failures).toContain('Unrelated issue: X');
      expect(failures).not.toContain('T2 deploy BLOCKED');
    });
  });

  describe('getCrossProjectInsights', () => {
    it('should return null when file does not exist', async () => {
      homedirOverride = testGlobalHome;

      const result = await service.getCrossProjectInsights();
      expect(result).toBeNull();
    });

    it('should return full content when tailChars is not specified', async () => {
      homedirOverride = testGlobalHome;

      await service.recordCrossProjectInsight(testAgentId, testRole, 'Global insight');

      const result = await service.getCrossProjectInsights();
      expect(result).not.toBeNull();
      expect(result).toContain('# Cross-Project Insights');
      expect(result).toContain('Global insight');
    });

    it('should return only last N characters when tailChars is specified', async () => {
      homedirOverride = testGlobalHome;

      await service.recordCrossProjectInsight(testAgentId, testRole, 'Insight one');
      await service.recordCrossProjectInsight(testAgentId, testRole, 'Insight two');

      const fullContent = await service.getCrossProjectInsights();
      expect(fullContent).not.toBeNull();

      const tailResult = await service.getCrossProjectInsights(30);
      expect(tailResult).not.toBeNull();
      expect(tailResult!.length).toBe(30);
      expect(fullContent!.endsWith(tailResult!)).toBe(true);
    });
  });
});
