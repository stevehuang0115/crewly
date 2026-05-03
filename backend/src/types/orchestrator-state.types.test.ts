/**
 * Tests for Orchestrator State Types
 *
 * @module types/orchestrator-state.types.test
 */

// Jest globals are available automatically
import {
  STATE_PATHS,
  STATE_VERSION,
  MAX_PERSISTED_MESSAGES,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_REASONS,
  ORCHESTRATOR_MODES,
  DEFAULT_ORCHESTRATOR_MODE,
  isValidCheckpointReason,
  isValidTaskStatus,
  isValidTaskPriority,
  isValidConversationSource,
  isValidOrchestratorMode,
  OrchestratorState,
  OrchestratorMode,
  TaskState,
  ConversationState,
  AgentState,
  ProjectState,
  SelfImprovementState,
  PersistedMessage,
  TaskProgress,
  TaskCheckpoint,
  PlannedChange,
  FileBackup,
  ValidationCheck,
  StateChange,
  StateDiff,
  ResumeInstructions,
} from './orchestrator-state.types.js';

describe('Orchestrator State Types', () => {
  describe('Constants', () => {
    describe('STATE_PATHS', () => {
      it('should have correct STATE_DIR', () => {
        expect(STATE_PATHS.STATE_DIR).toBe('.crewly/state');
      });

      it('should have correct CURRENT_STATE', () => {
        expect(STATE_PATHS.CURRENT_STATE).toBe('orchestrator-state.json');
      });

      it('should have correct BACKUP_DIR', () => {
        expect(STATE_PATHS.BACKUP_DIR).toBe('backups');
      });

      it('should have correct SELF_IMPROVEMENT_DIR', () => {
        expect(STATE_PATHS.SELF_IMPROVEMENT_DIR).toBe('self-improvement');
      });
    });

    describe('STATE_VERSION', () => {
      it('should be a valid semver string', () => {
        expect(STATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });

    describe('MAX_PERSISTED_MESSAGES', () => {
      it('should be reasonable (10-100)', () => {
        expect(MAX_PERSISTED_MESSAGES).toBeGreaterThan(10);
        expect(MAX_PERSISTED_MESSAGES).toBeLessThanOrEqual(100);
      });
    });

    describe('CHECKPOINT_INTERVAL_MS', () => {
      it('should be reasonable (30s - 5min)', () => {
        expect(CHECKPOINT_INTERVAL_MS).toBeGreaterThanOrEqual(30000);
        expect(CHECKPOINT_INTERVAL_MS).toBeLessThanOrEqual(300000);
      });
    });

    describe('CHECKPOINT_REASONS', () => {
      it('should contain all expected reasons', () => {
        expect(CHECKPOINT_REASONS).toContain('scheduled');
        expect(CHECKPOINT_REASONS).toContain('before_restart');
        expect(CHECKPOINT_REASONS).toContain('task_completed');
        expect(CHECKPOINT_REASONS).toContain('user_request');
        expect(CHECKPOINT_REASONS).toContain('self_improvement');
        expect(CHECKPOINT_REASONS).toContain('error_recovery');
      });

      it('should have exactly 6 reasons', () => {
        expect(CHECKPOINT_REASONS).toHaveLength(6);
      });
    });

    describe('ORCHESTRATOR_MODES (Onboarding v3 — B2)', () => {
      it('should contain all expected modes', () => {
        expect(ORCHESTRATOR_MODES).toContain('normal');
        expect(ORCHESTRATOR_MODES).toContain('onboarding');
        expect(ORCHESTRATOR_MODES).toContain('onboarding-provisioning');
      });

      it('should have exactly 3 modes', () => {
        expect(ORCHESTRATOR_MODES).toHaveLength(3);
      });

      it('should default to normal', () => {
        expect(DEFAULT_ORCHESTRATOR_MODE).toBe('normal');
      });
    });
  });

  describe('Type Guards', () => {
    describe('isValidCheckpointReason', () => {
      it('should return true for valid reasons', () => {
        expect(isValidCheckpointReason('scheduled')).toBe(true);
        expect(isValidCheckpointReason('before_restart')).toBe(true);
        expect(isValidCheckpointReason('self_improvement')).toBe(true);
      });

      it('should return false for invalid reasons', () => {
        expect(isValidCheckpointReason('invalid')).toBe(false);
        expect(isValidCheckpointReason('')).toBe(false);
        expect(isValidCheckpointReason('random')).toBe(false);
      });
    });

    describe('isValidTaskStatus', () => {
      it('should return true for valid statuses', () => {
        expect(isValidTaskStatus('pending')).toBe(true);
        expect(isValidTaskStatus('in_progress')).toBe(true);
        expect(isValidTaskStatus('blocked')).toBe(true);
        expect(isValidTaskStatus('paused')).toBe(true);
        expect(isValidTaskStatus('completed')).toBe(true);
      });

      it('should return false for invalid statuses', () => {
        expect(isValidTaskStatus('invalid')).toBe(false);
        expect(isValidTaskStatus('')).toBe(false);
        expect(isValidTaskStatus('running')).toBe(false);
      });
    });

    describe('isValidTaskPriority', () => {
      it('should return true for valid priorities', () => {
        expect(isValidTaskPriority('low')).toBe(true);
        expect(isValidTaskPriority('medium')).toBe(true);
        expect(isValidTaskPriority('high')).toBe(true);
        expect(isValidTaskPriority('critical')).toBe(true);
      });

      it('should return false for invalid priorities', () => {
        expect(isValidTaskPriority('invalid')).toBe(false);
        expect(isValidTaskPriority('urgent')).toBe(false);
        expect(isValidTaskPriority('')).toBe(false);
      });
    });

    describe('isValidConversationSource', () => {
      it('should return true for valid sources', () => {
        expect(isValidConversationSource('chat')).toBe(true);
        expect(isValidConversationSource('slack')).toBe(true);
        expect(isValidConversationSource('api')).toBe(true);
      });

      it('should return false for invalid sources', () => {
        expect(isValidConversationSource('invalid')).toBe(false);
        expect(isValidConversationSource('email')).toBe(false);
        expect(isValidConversationSource('')).toBe(false);
      });
    });

    describe('isValidOrchestratorMode (Onboarding v3 — B2)', () => {
      it('should return true for each declared mode', () => {
        expect(isValidOrchestratorMode('normal')).toBe(true);
        expect(isValidOrchestratorMode('onboarding')).toBe(true);
        expect(isValidOrchestratorMode('onboarding-provisioning')).toBe(true);
      });

      it('should return false for unknown strings', () => {
        expect(isValidOrchestratorMode('idle')).toBe(false);
        expect(isValidOrchestratorMode('')).toBe(false);
        expect(isValidOrchestratorMode('NORMAL')).toBe(false); // case-sensitive
      });

      it('should return false for non-string inputs (defends against corrupt JSON)', () => {
        expect(isValidOrchestratorMode(undefined)).toBe(false);
        expect(isValidOrchestratorMode(null)).toBe(false);
        expect(isValidOrchestratorMode(0)).toBe(false);
        expect(isValidOrchestratorMode({ mode: 'normal' })).toBe(false);
        expect(isValidOrchestratorMode(['normal'])).toBe(false);
      });
    });
  });

  describe('Type Interfaces', () => {
    describe('OrchestratorState', () => {
      it('should accept valid orchestrator state', () => {
        const state: OrchestratorState = {
          id: 'state-123',
          version: '1.0.0',
          checkpointedAt: new Date().toISOString(),
          checkpointReason: 'scheduled',
          conversations: [],
          tasks: [],
          agents: [],
          projects: [],
          metadata: {
            version: '1.0.0',
            hostname: 'test-host',
            pid: 12345,
            startedAt: new Date().toISOString(),
            uptimeSeconds: 3600,
            restartCount: 0,
          },
        };

        expect(state.id).toBe('state-123');
        expect(state.conversations).toHaveLength(0);
        expect(state.metadata.pid).toBe(12345);
      });

      it('should accept state with onboarding mode (Onboarding v3 — B2)', () => {
        const state: OrchestratorState = {
          id: 'state-onboarding',
          version: '1.0.0',
          checkpointedAt: new Date().toISOString(),
          checkpointReason: 'scheduled',
          mode: 'onboarding',
          conversations: [],
          tasks: [],
          agents: [],
          projects: [],
          metadata: {
            version: '1.0.0',
            hostname: 'test-host',
            pid: 12345,
            startedAt: new Date().toISOString(),
            uptimeSeconds: 0,
            restartCount: 0,
          },
        };

        expect(state.mode).toBe('onboarding');
      });

      it('should accept state with onboarding-provisioning mode (future-reserved)', () => {
        const mode: OrchestratorMode = 'onboarding-provisioning';
        const state: OrchestratorState = {
          id: 'state-prov',
          version: '1.0.0',
          checkpointedAt: new Date().toISOString(),
          checkpointReason: 'scheduled',
          mode,
          conversations: [],
          tasks: [],
          agents: [],
          projects: [],
          metadata: {
            version: '1.0.0',
            hostname: 'test-host',
            pid: 12345,
            startedAt: new Date().toISOString(),
            uptimeSeconds: 0,
            restartCount: 0,
          },
        };

        expect(state.mode).toBe('onboarding-provisioning');
      });

      it('should treat mode as optional for backwards compatibility', () => {
        // State files written before the `mode` field existed must still
        // parse — the loader backfills via `DEFAULT_ORCHESTRATOR_MODE`.
        const state: OrchestratorState = {
          id: 'state-legacy',
          version: '1.0.0',
          checkpointedAt: new Date().toISOString(),
          checkpointReason: 'scheduled',
          conversations: [],
          tasks: [],
          agents: [],
          projects: [],
          metadata: {
            version: '1.0.0',
            hostname: 'test-host',
            pid: 12345,
            startedAt: new Date().toISOString(),
            uptimeSeconds: 0,
            restartCount: 0,
          },
        };

        expect(state.mode).toBeUndefined();
      });

      it('should accept state with selfImprovement', () => {
        const state: OrchestratorState = {
          id: 'state-123',
          version: '1.0.0',
          checkpointedAt: new Date().toISOString(),
          checkpointReason: 'self_improvement',
          conversations: [],
          tasks: [],
          agents: [],
          projects: [],
          selfImprovement: {
            validationChecks: [],
          },
          metadata: {
            version: '1.0.0',
            hostname: 'test-host',
            pid: 12345,
            startedAt: new Date().toISOString(),
            uptimeSeconds: 3600,
            restartCount: 0,
          },
        };

        expect(state.selfImprovement).toBeDefined();
        expect(state.selfImprovement?.validationChecks).toHaveLength(0);
      });
    });

    describe('TaskState', () => {
      it('should accept minimal task state', () => {
        const task: TaskState = {
          id: 'task-123',
          title: 'Fix bug',
          description: 'Fix the login bug',
          status: 'pending',
          priority: 'medium',
          progress: {
            percentComplete: 0,
            completedSteps: [],
          },
          createdAt: new Date().toISOString(),
        };

        expect(task.id).toBe('task-123');
        expect(task.status).toBe('pending');
      });

      it('should accept task with checkpoint', () => {
        const task: TaskState = {
          id: 'task-123',
          title: 'Fix bug',
          description: 'Fix the login bug',
          status: 'in_progress',
          priority: 'high',
          progress: {
            percentComplete: 50,
            currentStep: 'Testing fix',
            completedSteps: ['Analyzed issue', 'Implemented fix'],
          },
          createdAt: new Date().toISOString(),
          checkpoint: {
            stepIndex: 2,
            modifiedFiles: ['src/auth.ts'],
            pendingActions: ['Run tests'],
          },
        };

        expect(task.checkpoint?.stepIndex).toBe(2);
        expect(task.progress.percentComplete).toBe(50);
      });

      it('should accept task with all fields', () => {
        const task: TaskState = {
          id: 'task-123',
          title: 'Implement feature',
          description: 'Add new feature',
          status: 'in_progress',
          priority: 'critical',
          assignedTo: 'developer-session',
          teamId: 'team-1',
          projectId: 'project-1',
          progress: {
            percentComplete: 75,
            currentStep: 'Final testing',
            completedSteps: ['Design', 'Implementation', 'Unit tests'],
            remainingSteps: ['Integration tests', 'Deployment'],
            blockers: [],
          },
          blockedBy: [],
          blocks: ['task-456'],
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          checkpoint: {
            stepIndex: 3,
            workData: { testResults: 'passed' },
            modifiedFiles: ['src/feature.ts', 'tests/feature.test.ts'],
            agentContext: 'Running final tests',
            pendingActions: ['deploy'],
          },
        };

        expect(task.assignedTo).toBe('developer-session');
        expect(task.blocks).toContain('task-456');
      });
    });

    describe('ConversationState', () => {
      it('should accept chat conversation', () => {
        const conversation: ConversationState = {
          id: 'conv-123',
          source: 'chat',
          recentMessages: [
            { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
            { role: 'orchestrator', content: 'Hi!', timestamp: new Date().toISOString() },
          ],
          lastActivityAt: new Date().toISOString(),
        };

        expect(conversation.source).toBe('chat');
        expect(conversation.recentMessages).toHaveLength(2);
      });

      it('should accept slack conversation with context', () => {
        const conversation: ConversationState = {
          id: 'conv-123',
          source: 'slack',
          recentMessages: [
            { role: 'user', content: 'Status', timestamp: new Date().toISOString() },
          ],
          slackContext: {
            channelId: 'C123',
            threadTs: '1234567890.123456',
          },
          userId: 'U123',
          currentTopic: 'project status',
          lastActivityAt: new Date().toISOString(),
        };

        expect(conversation.slackContext?.channelId).toBe('C123');
        expect(conversation.currentTopic).toBe('project status');
      });
    });

    describe('AgentState', () => {
      it('should accept minimal agent state', () => {
        const agent: AgentState = {
          sessionName: 'developer-1',
          agentId: 'agent-123',
          role: 'developer',
          status: 'active',
        };

        expect(agent.sessionName).toBe('developer-1');
        expect(agent.status).toBe('active');
      });

      it('should accept agent with full details', () => {
        const agent: AgentState = {
          sessionName: 'developer-1',
          agentId: 'agent-123',
          role: 'developer',
          status: 'busy',
          currentTaskId: 'task-456',
          currentProjectPath: '/path/to/project',
          contextSummary: 'Working on login feature',
          lastActivity: {
            type: 'code_edit',
            timestamp: new Date().toISOString(),
            description: 'Modified auth.ts',
          },
        };

        expect(agent.currentTaskId).toBe('task-456');
        expect(agent.lastActivity?.type).toBe('code_edit');
      });
    });

    describe('ProjectState', () => {
      it('should accept minimal project state', () => {
        const project: ProjectState = {
          id: 'project-123',
          name: 'My Project',
          path: '/path/to/project',
          status: 'active',
          activeTasks: [],
          activeAgents: [],
        };

        expect(project.name).toBe('My Project');
        expect(project.status).toBe('active');
      });

      it('should accept project with git and build state', () => {
        const project: ProjectState = {
          id: 'project-123',
          name: 'My Project',
          path: '/path/to/project',
          status: 'active',
          activeTasks: ['task-1', 'task-2'],
          activeAgents: ['agent-1'],
          gitState: {
            branch: 'feature/new',
            lastCommit: 'abc123',
            hasUncommittedChanges: true,
          },
          buildState: {
            lastBuildStatus: 'success',
            lastBuildAt: new Date().toISOString(),
            testsPass: true,
          },
        };

        expect(project.gitState?.branch).toBe('feature/new');
        expect(project.buildState?.testsPass).toBe(true);
      });
    });

    describe('SelfImprovementState', () => {
      it('should accept empty self-improvement state', () => {
        const state: SelfImprovementState = {
          validationChecks: [],
        };

        expect(state.validationChecks).toHaveLength(0);
        expect(state.currentTask).toBeUndefined();
      });

      it('should accept full self-improvement state', () => {
        const state: SelfImprovementState = {
          currentTask: {
            id: 'improvement-1',
            description: 'Optimize search algorithm',
            targetFiles: ['src/search.ts'],
            plannedChanges: [
              {
                file: 'src/search.ts',
                type: 'modify',
                description: 'Improve performance',
                risk: 'medium',
              },
            ],
            status: 'implementing',
          },
          backup: {
            id: 'backup-1',
            createdAt: new Date().toISOString(),
            files: [
              {
                path: 'src/search.ts',
                originalContent: 'original code',
                backupPath: 'backups/search.ts.bak',
                checksum: 'abc123',
              },
            ],
            gitCommit: 'abc123',
          },
          validationChecks: [
            {
              name: 'Build',
              type: 'build',
              command: 'npm run build',
              required: true,
            },
            {
              name: 'Tests',
              type: 'test',
              command: 'npm test',
              required: true,
            },
          ],
          rollbackPlan: {
            steps: ['Restore files', 'Reset git'],
            gitCommit: 'abc123',
          },
        };

        expect(state.currentTask?.status).toBe('implementing');
        expect(state.backup?.files).toHaveLength(1);
        expect(state.validationChecks).toHaveLength(2);
      });
    });

    describe('StateChange and StateDiff', () => {
      it('should accept valid state change', () => {
        const change: StateChange = {
          type: 'task',
          operation: 'update',
          id: 'task-123',
          data: { status: 'completed' },
        };

        expect(change.type).toBe('task');
        expect(change.operation).toBe('update');
      });

      it('should accept valid state diff', () => {
        const diff: StateDiff = {
          timestamp: new Date().toISOString(),
          changes: [
            { type: 'task', operation: 'add', id: 'task-1' },
            { type: 'agent', operation: 'update', id: 'agent-1', data: {} },
          ],
        };

        expect(diff.changes).toHaveLength(2);
      });
    });

    describe('ResumeInstructions', () => {
      it('should accept valid resume instructions', () => {
        const instructions: ResumeInstructions = {
          resumeOrder: ['task-1', 'conv-1'],
          conversationsToResume: [
            { id: 'conv-1', resumeMessage: 'Resuming from restart' },
          ],
          tasksToResume: [
            { id: 'task-1', resumeFromCheckpoint: true },
          ],
          notifications: [
            { type: 'slack', message: 'Orchestrator restarted' },
            { type: 'log', message: 'Resuming 1 task' },
          ],
        };

        expect(instructions.resumeOrder).toHaveLength(2);
        expect(instructions.tasksToResume[0].resumeFromCheckpoint).toBe(true);
      });
    });
  });
});
