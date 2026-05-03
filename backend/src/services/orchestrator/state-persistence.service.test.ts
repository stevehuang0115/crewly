/**
 * Tests for State Persistence Service
 *
 * @module services/orchestrator/state-persistence.service.test
 */

// Jest globals are available automatically
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  StatePersistenceService,
  getStatePersistenceService,
  resetStatePersistenceService,
} from './state-persistence.service.js';
import {
  OrchestratorState,
  STATE_PATHS,
  STATE_VERSION,
} from '../../types/orchestrator-state.types.js';

describe('StatePersistenceService', () => {
  let testDir: string;
  let service: StatePersistenceService;
  let additionalServices: StatePersistenceService[] = [];

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `state-test-${Date.now()}`);
    service = new StatePersistenceService(testDir);
    additionalServices = [];
    resetStatePersistenceService();
  });

  afterEach(async () => {
    // Stop periodic checkpoint on main service
    service.stopPeriodicCheckpoint();
    // Stop any additional services created during tests
    for (const svc of additionalServices) {
      svc.stopPeriodicCheckpoint();
    }
    resetStatePersistenceService();
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getStatePersistenceService', () => {
    it('should return singleton instance', () => {
      const service1 = getStatePersistenceService();
      const service2 = getStatePersistenceService();
      expect(service1).toBe(service2);
    });
  });

  describe('resetStatePersistenceService', () => {
    it('should reset the singleton instance', () => {
      const service1 = getStatePersistenceService();
      resetStatePersistenceService();
      const service2 = getStatePersistenceService();
      expect(service1).not.toBe(service2);
    });
  });

  describe('initialize', () => {
    it('should create state directories', async () => {
      await service.initialize();

      const stateDir = path.join(testDir, STATE_PATHS.STATE_DIR);
      const stat = await fs.stat(stateDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create backup directory', async () => {
      await service.initialize();

      const backupDir = path.join(
        testDir,
        STATE_PATHS.STATE_DIR,
        STATE_PATHS.BACKUP_DIR
      );
      const stat = await fs.stat(backupDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create self-improvement directory', async () => {
      await service.initialize();

      const siDir = path.join(
        testDir,
        STATE_PATHS.STATE_DIR,
        STATE_PATHS.SELF_IMPROVEMENT_DIR
      );
      const stat = await fs.stat(siDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should return null when no previous state', async () => {
      const previousState = await service.initialize();
      expect(previousState).toBeNull();
    });

    it('should set initialized to true', async () => {
      expect(service.isInitialized()).toBe(false);
      await service.initialize();
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('saveState and loadState', () => {
    it('should save and load state', async () => {
      await service.initialize();

      // Update some state
      service.updateConversation({
        id: 'conv-1',
        source: 'chat',
        recentMessages: [
          { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
        ],
        lastActivityAt: new Date().toISOString(),
      });

      await service.saveState('user_request');

      // Create new service instance to test loading
      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState).not.toBeNull();
      expect(loadedState?.conversations).toHaveLength(1);
      expect(loadedState?.conversations[0].id).toBe('conv-1');
    });

    it('should save with correct checkpoint reason', async () => {
      await service.initialize();
      await service.saveState('before_restart');

      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState?.checkpointReason).toBe('before_restart');
    });
  });

  describe('orchestrator mode round-trip (Onboarding v3 — B2)', () => {
    it('should default to "normal" on a fresh state', async () => {
      await service.initialize();
      expect(service.getMode()).toBe('normal');
      const state = service.getState();
      expect(state?.mode).toBe('normal');
    });

    it('should round-trip the "onboarding" mode through atomicWriteJson', async () => {
      await service.initialize();
      service.setMode('onboarding');
      await service.saveState('user_request');

      // Re-read via a fresh service to prove it survives the disk hop.
      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState).not.toBeNull();
      expect(loadedState?.mode).toBe('onboarding');
      expect(service2.getMode()).toBe('onboarding');
    });

    it('should round-trip the "onboarding-provisioning" future-reserved value', async () => {
      await service.initialize();
      service.setMode('onboarding-provisioning');
      await service.saveState('scheduled');

      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState?.mode).toBe('onboarding-provisioning');
    });

    it('should backfill mode to "normal" when loading legacy state files', async () => {
      // Simulate a state file written by a Crewly version that predates
      // the `mode` field. The loader must not crash; it must default.
      const stateDir = path.join(testDir, STATE_PATHS.STATE_DIR);
      await fs.mkdir(stateDir, { recursive: true });
      const legacyState: Omit<OrchestratorState, 'mode'> = {
        id: 'legacy-state',
        version: STATE_VERSION,
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'scheduled',
        conversations: [],
        tasks: [],
        agents: [],
        projects: [],
        metadata: {
          version: STATE_VERSION,
          hostname: 'legacy-host',
          pid: 1,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 0,
          restartCount: 0,
        },
      };
      await fs.writeFile(
        path.join(stateDir, STATE_PATHS.CURRENT_STATE),
        JSON.stringify(legacyState),
        'utf-8',
      );

      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState).not.toBeNull();
      expect(loadedState?.mode).toBe('normal');
    });

    it('should sanitize unknown mode values to the default', async () => {
      // Defends against a future Crewly writing a value this build doesn't
      // recognize, or a hand-edited / corrupted state file.
      const stateDir = path.join(testDir, STATE_PATHS.STATE_DIR);
      await fs.mkdir(stateDir, { recursive: true });
      const corruptState = {
        id: 'corrupt-state',
        version: STATE_VERSION,
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'scheduled',
        mode: 'totally-bogus-mode',
        conversations: [],
        tasks: [],
        agents: [],
        projects: [],
        metadata: {
          version: STATE_VERSION,
          hostname: 'corrupt-host',
          pid: 1,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 0,
          restartCount: 0,
        },
      };
      await fs.writeFile(
        path.join(stateDir, STATE_PATHS.CURRENT_STATE),
        JSON.stringify(corruptState),
        'utf-8',
      );

      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState?.mode).toBe('normal');
    });

    it('setMode should be idempotent', async () => {
      await service.initialize();
      service.setMode('onboarding');
      service.setMode('onboarding'); // second call — no change expected
      expect(service.getMode()).toBe('onboarding');
    });

    it('getMode should return default before initialization', () => {
      // Pre-init: no currentState yet — must not throw, must return default.
      expect(service.getMode()).toBe('normal');
    });
  });

  describe('getState', () => {
    it('should return null before initialization', () => {
      expect(service.getState()).toBeNull();
    });

    it('should return state after initialization', async () => {
      await service.initialize();
      const state = service.getState();
      expect(state).not.toBeNull();
      expect(state?.version).toBe(STATE_VERSION);
    });
  });

  describe('updateConversation', () => {
    it('should add new conversation', async () => {
      await service.initialize();

      service.updateConversation({
        id: 'conv-1',
        source: 'slack',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      const state = service.getState();
      expect(state?.conversations).toHaveLength(1);
    });

    it('should update existing conversation', async () => {
      await service.initialize();

      service.updateConversation({
        id: 'conv-1',
        source: 'slack',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      service.updateConversation({
        id: 'conv-1',
        source: 'slack',
        recentMessages: [
          { role: 'user', content: 'Hi', timestamp: new Date().toISOString() },
        ],
        lastActivityAt: new Date().toISOString(),
      });

      const state = service.getState();
      expect(state?.conversations).toHaveLength(1);
      expect(state?.conversations[0].recentMessages).toHaveLength(1);
    });

    it('should trim messages to max limit', async () => {
      await service.initialize();

      const manyMessages = Array.from({ length: 100 }, (_, i) => ({
        role: 'user' as const,
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      }));

      service.updateConversation({
        id: 'conv-1',
        source: 'chat',
        recentMessages: manyMessages,
        lastActivityAt: new Date().toISOString(),
      });

      const state = service.getState();
      expect(state?.conversations[0].recentMessages.length).toBeLessThanOrEqual(
        50
      );
    });
  });

  describe('removeConversation', () => {
    it('should remove a conversation', async () => {
      await service.initialize();

      service.updateConversation({
        id: 'conv-1',
        source: 'chat',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      service.removeConversation('conv-1');

      const state = service.getState();
      expect(state?.conversations).toHaveLength(0);
    });
  });

  describe('updateTask', () => {
    it('should add and update tasks', async () => {
      await service.initialize();

      service.updateTask({
        id: 'task-1',
        title: 'Test task',
        description: 'Testing',
        status: 'pending',
        priority: 'medium',
        progress: { percentComplete: 0, completedSteps: [] },
        createdAt: new Date().toISOString(),
      });

      const state = service.getState();
      expect(state?.tasks).toHaveLength(1);
    });

    it('should update existing task', async () => {
      await service.initialize();

      service.updateTask({
        id: 'task-1',
        title: 'Test task',
        description: 'Testing',
        status: 'pending',
        priority: 'medium',
        progress: { percentComplete: 0, completedSteps: [] },
        createdAt: new Date().toISOString(),
      });

      service.updateTask({
        id: 'task-1',
        title: 'Test task',
        description: 'Testing',
        status: 'in_progress',
        priority: 'high',
        progress: { percentComplete: 50, completedSteps: ['Step 1'] },
        createdAt: new Date().toISOString(),
      });

      const state = service.getState();
      expect(state?.tasks).toHaveLength(1);
      expect(state?.tasks[0].status).toBe('in_progress');
    });
  });

  describe('removeTask', () => {
    it('should remove a task', async () => {
      await service.initialize();

      service.updateTask({
        id: 'task-1',
        title: 'Test',
        description: 'Test',
        status: 'pending',
        priority: 'low',
        progress: { percentComplete: 0, completedSteps: [] },
        createdAt: new Date().toISOString(),
      });

      service.removeTask('task-1');

      expect(service.getState()?.tasks).toHaveLength(0);
    });
  });

  describe('updateAgent', () => {
    it('should add and update agents', async () => {
      await service.initialize();

      service.updateAgent({
        sessionName: 'dev-1',
        agentId: 'agent-1',
        role: 'developer',
        status: 'active',
      });

      expect(service.getState()?.agents).toHaveLength(1);
    });
  });

  describe('updateProject', () => {
    it('should add and update projects', async () => {
      await service.initialize();

      service.updateProject({
        id: 'project-1',
        name: 'Test Project',
        path: '/test/path',
        status: 'active',
        activeTasks: [],
        activeAgents: [],
      });

      expect(service.getState()?.projects).toHaveLength(1);
    });
  });

  describe('updateSelfImprovement', () => {
    it('should update self-improvement state', async () => {
      await service.initialize();

      service.updateSelfImprovement({
        validationChecks: [
          { name: 'Build', type: 'build', required: true },
        ],
      });

      expect(service.getState()?.selfImprovement).toBeDefined();
      expect(service.getState()?.selfImprovement?.validationChecks).toHaveLength(1);
    });
  });

  describe('clearSelfImprovement', () => {
    it('should clear self-improvement state', async () => {
      await service.initialize();

      service.updateSelfImprovement({
        validationChecks: [],
      });

      service.clearSelfImprovement();

      expect(service.getState()?.selfImprovement).toBeUndefined();
    });
  });

  describe('createBackup and restoreFromBackup', () => {
    it('should create and restore backups', async () => {
      await service.initialize();

      service.updateConversation({
        id: 'conv-1',
        source: 'chat',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      const backupId = await service.createBackup('test');

      // Modify state
      service.updateConversation({
        id: 'conv-2',
        source: 'slack',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      expect(service.getState()?.conversations).toHaveLength(2);

      // Restore
      const restored = await service.restoreFromBackup(backupId);
      expect(restored).toBe(true);
      expect(service.getState()?.conversations).toHaveLength(1);
    });

    it('should return false for non-existent backup', async () => {
      await service.initialize();

      const restored = await service.restoreFromBackup('non-existent');
      expect(restored).toBe(false);
    });
  });

  describe('listBackups', () => {
    it('should list available backups', async () => {
      await service.initialize();

      await service.createBackup('test1');
      await service.createBackup('test2');

      const backups = await service.listBackups();
      expect(backups.length).toBe(2);
    });

    it('should return empty array when no backups', async () => {
      await service.initialize();

      const backups = await service.listBackups();
      expect(backups).toEqual([]);
    });
  });

  describe('generateResumeInstructions', () => {
    it('should generate instructions for in-progress tasks', async () => {
      await service.initialize();

      const previousState: OrchestratorState = {
        id: 'state-1',
        version: '1.0.0',
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'before_restart',
        conversations: [],
        tasks: [
          {
            id: 'task-1',
            title: 'In progress task',
            description: 'Testing',
            status: 'in_progress',
            priority: 'high',
            progress: { percentComplete: 50, completedSteps: [] },
            createdAt: new Date().toISOString(),
          },
        ],
        agents: [],
        projects: [],
        metadata: {
          version: '1.0.0',
          hostname: 'test',
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          restartCount: 0,
        },
      };

      const instructions = service.generateResumeInstructions(previousState);

      expect(instructions.tasksToResume).toHaveLength(1);
      expect(instructions.tasksToResume[0].id).toBe('task-1');
    });

    it('should include paused tasks', async () => {
      await service.initialize();

      const previousState: OrchestratorState = {
        id: 'state-1',
        version: '1.0.0',
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'before_restart',
        conversations: [],
        tasks: [
          {
            id: 'task-1',
            title: 'Paused task',
            description: 'Testing',
            status: 'paused',
            priority: 'medium',
            progress: { percentComplete: 25, completedSteps: [] },
            createdAt: new Date().toISOString(),
          },
        ],
        agents: [],
        projects: [],
        metadata: {
          version: '1.0.0',
          hostname: 'test',
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          restartCount: 0,
        },
      };

      const instructions = service.generateResumeInstructions(previousState);

      expect(instructions.tasksToResume).toHaveLength(1);
    });

    it('should include recent conversations', async () => {
      await service.initialize();

      const previousState: OrchestratorState = {
        id: 'state-1',
        version: '1.0.0',
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'before_restart',
        conversations: [
          {
            id: 'conv-1',
            source: 'chat',
            recentMessages: [],
            lastActivityAt: new Date().toISOString(), // Recent
          },
          {
            id: 'conv-2',
            source: 'slack',
            recentMessages: [],
            lastActivityAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
          },
        ],
        tasks: [],
        agents: [],
        projects: [],
        metadata: {
          version: '1.0.0',
          hostname: 'test',
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          restartCount: 0,
        },
      };

      const instructions = service.generateResumeInstructions(previousState);

      expect(instructions.conversationsToResume).toHaveLength(1);
      expect(instructions.conversationsToResume[0].id).toBe('conv-1');
    });

    it('should include notification about self-improvement in progress', async () => {
      await service.initialize();

      const previousState: OrchestratorState = {
        id: 'state-1',
        version: '1.0.0',
        checkpointedAt: new Date().toISOString(),
        checkpointReason: 'self_improvement',
        conversations: [],
        tasks: [],
        agents: [],
        projects: [],
        selfImprovement: {
          currentTask: {
            id: 'si-1',
            description: 'Optimize search',
            targetFiles: ['search.ts'],
            plannedChanges: [],
            status: 'implementing',
          },
          validationChecks: [],
        },
        metadata: {
          version: '1.0.0',
          hostname: 'test',
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          restartCount: 0,
        },
      };

      const instructions = service.generateResumeInstructions(previousState);

      const siNotification = instructions.notifications.find((n) =>
        n.message.includes('Self-improvement')
      );
      expect(siNotification).toBeDefined();
    });
  });

  describe('prepareForShutdown', () => {
    it('should save state before shutdown', async () => {
      await service.initialize();

      service.updateConversation({
        id: 'conv-1',
        source: 'chat',
        recentMessages: [],
        lastActivityAt: new Date().toISOString(),
      });

      await service.prepareForShutdown();

      // Verify state was saved
      const service2 = new StatePersistenceService(testDir);
      additionalServices.push(service2);
      const loadedState = await service2.initialize();

      expect(loadedState?.checkpointReason).toBe('before_restart');
    });
  });

  describe('getStateDir', () => {
    it('should return state directory path', async () => {
      const stateDir = service.getStateDir();
      expect(stateDir).toContain(STATE_PATHS.STATE_DIR);
    });
  });
});
