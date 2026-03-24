import type {
  InProgressTask,
  InProgressTaskStatus,
  TaskTrackingData,
  TaskStatus,
  TaskFileInfo,
  IterationRecord,
  ContinuationTrackingData,
  QualityGateStatus,
  QualityGates,
  TaskArtifact,
  TaskStatusEntry,
  TaskVerificationResult,
} from './task-tracking.types';
import { REQUIRED_QUALITY_GATES } from './task-tracking.types';

describe('Task Tracking Types', () => {
  describe('InProgressTask', () => {
    it('should accept a valid task with all required fields', () => {
      const task: InProgressTask = {
        id: 'task-123',
        projectId: 'project-456',
        teamId: 'team-abc',
        taskFilePath: '/project/.crewly/tasks/m1/open/task.md',
        taskName: 'Test Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'member-789',
        assignedSessionName: 'session-abc',
        assignedAt: '2026-01-01T00:00:00.000Z',
        status: 'assigned',
      };

      expect(task.id).toBe('task-123');
      expect(task.status).toBe('assigned');
    });

    it('should accept optional monitoring fields', () => {
      const task: InProgressTask = {
        id: 'task-123',
        projectId: 'project-456',
        teamId: 'team-abc',
        taskFilePath: '/project/.crewly/tasks/m1/open/task.md',
        taskName: 'Test Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'member-789',
        assignedSessionName: 'session-abc',
        assignedAt: '2026-01-01T00:00:00.000Z',
        status: 'assigned',
        scheduleIds: ['sched-1', 'sched-2'],
        subscriptionIds: ['sub-1'],
      };

      expect(task.scheduleIds).toEqual(['sched-1', 'sched-2']);
      expect(task.subscriptionIds).toEqual(['sub-1']);
    });

    it('should accept all valid status values including A2A-inspired statuses', () => {
      const validStatuses: InProgressTaskStatus[] = [
        'assigned', 'active', 'blocked', 'pending_assignment', 'completed',
        'submitted', 'working', 'input_required', 'verifying', 'failed', 'cancelled',
      ];

      validStatuses.forEach(status => {
        const task: InProgressTask = {
          id: 'task-1',
          projectId: 'p',
          teamId: 't',
          taskFilePath: '/path',
          taskName: 'test',
          targetRole: 'dev',
          assignedTeamMemberId: 'm',
          assignedSessionName: 's',
          assignedAt: '2026-01-01',
          status,
        };
        expect(task.status).toBe(status);
      });
    });

    it('should accept optional priority field', () => {
      const priorities: Array<InProgressTask['priority']> = ['low', 'medium', 'high', undefined];

      priorities.forEach(priority => {
        const task: InProgressTask = {
          id: 'task-1',
          projectId: 'p',
          teamId: 't',
          taskFilePath: '/path',
          taskName: 'test',
          targetRole: 'dev',
          assignedTeamMemberId: 'm',
          assignedSessionName: 's',
          assignedAt: '2026-01-01',
          status: 'assigned',
          priority,
        };
        expect(task.priority).toBe(priority);
      });
    });

    it('should accept optional workingNotes fields', () => {
      const task: InProgressTask = {
        id: 'task-wn',
        projectId: 'p1',
        teamId: 't1',
        taskFilePath: '/path/to/task.md',
        taskName: 'Working Notes Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'member-1',
        assignedSessionName: 'session-1',
        assignedAt: '2026-03-23T00:00:00.000Z',
        status: 'working',
        workingNotes: 'Currently investigating auth flow. Tried approach A (failed). Next: try approach B.',
        workingNotesUpdatedAt: '2026-03-23T10:30:00.000Z',
      };

      expect(task.workingNotes).toContain('auth flow');
      expect(task.workingNotesUpdatedAt).toBe('2026-03-23T10:30:00.000Z');
    });

    it('should be backwards-compatible without workingNotes fields', () => {
      const task: InProgressTask = {
        id: 'task-no-wn',
        projectId: 'p1',
        teamId: 't1',
        taskFilePath: '/path',
        taskName: 'No Working Notes',
        targetRole: 'dev',
        assignedTeamMemberId: 'm1',
        assignedSessionName: 's1',
        assignedAt: '2026-01-01',
        status: 'assigned',
      };

      expect(task.workingNotes).toBeUndefined();
      expect(task.workingNotesUpdatedAt).toBeUndefined();
    });
  });

  describe('TaskTrackingData', () => {
    it('should accept valid tracking data', () => {
      const data: TaskTrackingData = {
        tasks: [],
        lastUpdated: '2026-01-01T00:00:00.000Z',
        version: '1.0.0',
      };

      expect(data.tasks).toEqual([]);
      expect(data.version).toBe('1.0.0');
    });
  });

  describe('TaskFileInfo', () => {
    it('should accept all valid status folders', () => {
      const validFolders: TaskFileInfo['statusFolder'][] = ['open', 'in_progress', 'done', 'blocked'];

      validFolders.forEach(statusFolder => {
        const info: TaskFileInfo = {
          filePath: '/path/to/task.md',
          fileName: 'task.md',
          taskName: 'Test',
          targetRole: 'developer',
          milestoneFolder: 'm1_setup',
          statusFolder,
        };
        expect(info.statusFolder).toBe(statusFolder);
      });
    });
  });

  describe('InProgressTask hierarchy extensions', () => {
    it('should accept hierarchy and delegation fields', () => {
      const task: InProgressTask = {
        id: 'task-h1',
        projectId: 'p1',
        teamId: 't1',
        taskFilePath: '/path/to/task.md',
        taskName: 'Hierarchical Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'worker-1',
        assignedSessionName: 'worker-session',
        assignedAt: '2026-03-06T00:00:00.000Z',
        status: 'submitted',
        delegatedBy: 'tl-member-1',
        delegatedBySession: 'tl-session',
        parentTaskId: 'parent-task-1',
        childTaskIds: ['child-1', 'child-2'],
        assigneeHierarchyLevel: 2,
      };

      expect(task.delegatedBy).toBe('tl-member-1');
      expect(task.parentTaskId).toBe('parent-task-1');
      expect(task.childTaskIds).toEqual(['child-1', 'child-2']);
      expect(task.assigneeHierarchyLevel).toBe(2);
    });

    it('should be backwards-compatible without hierarchy fields', () => {
      const task: InProgressTask = {
        id: 'task-flat',
        projectId: 'p1',
        teamId: 't1',
        taskFilePath: '/path',
        taskName: 'Flat Task',
        targetRole: 'dev',
        assignedTeamMemberId: 'm1',
        assignedSessionName: 's1',
        assignedAt: '2026-01-01',
        status: 'assigned',
      };

      expect(task.delegatedBy).toBeUndefined();
      expect(task.parentTaskId).toBeUndefined();
      expect(task.artifacts).toBeUndefined();
      expect(task.statusHistory).toBeUndefined();
      expect(task.verificationResult).toBeUndefined();
    });
  });

  describe('TaskArtifact', () => {
    it('should accept a valid artifact', () => {
      const artifact: TaskArtifact = {
        id: 'art-1',
        name: 'LoginForm.tsx',
        type: 'file',
        content: 'frontend/src/components/LoginForm.tsx',
        mediaType: 'text/typescript',
        createdAt: '2026-03-06T00:00:00.000Z',
      };

      expect(artifact.type).toBe('file');
      expect(artifact.mediaType).toBe('text/typescript');
    });

    it('should accept all artifact types', () => {
      const types: TaskArtifact['type'][] = ['file', 'text', 'url', 'structured'];
      types.forEach(type => {
        const artifact: TaskArtifact = {
          id: 'a1',
          name: 'test',
          type,
          content: 'test content',
          createdAt: '2026-01-01',
        };
        expect(artifact.type).toBe(type);
      });
    });
  });

  describe('TaskStatusEntry', () => {
    it('should track status transitions', () => {
      const entry: TaskStatusEntry = {
        timestamp: '2026-03-06T10:00:00.000Z',
        fromStatus: 'submitted',
        toStatus: 'working',
        message: 'Agent started execution',
        reportedBy: 'worker-1',
      };

      expect(entry.fromStatus).toBe('submitted');
      expect(entry.toStatus).toBe('working');
    });
  });

  describe('TaskVerificationResult', () => {
    it('should accept all verdict types', () => {
      const verdicts: TaskVerificationResult['verdict'][] = ['approved', 'rejected', 'revision_needed'];
      verdicts.forEach(verdict => {
        const result: TaskVerificationResult = {
          verdict,
          verifiedBy: 'tl-1',
          verifiedAt: '2026-03-06T12:00:00.000Z',
        };
        expect(result.verdict).toBe(verdict);
      });
    });

    it('should accept optional feedback', () => {
      const result: TaskVerificationResult = {
        verdict: 'revision_needed',
        feedback: 'Missing unit tests for the auth guard',
        verifiedBy: 'tl-1',
        verifiedAt: '2026-03-06T12:00:00.000Z',
      };

      expect(result.feedback).toBe('Missing unit tests for the auth guard');
    });
  });

  describe('InProgressTask with artifacts and verification', () => {
    it('should accept a fully-featured hierarchical task', () => {
      const task: InProgressTask = {
        id: 'task-full',
        projectId: 'p1',
        teamId: 't1',
        taskFilePath: '/path/to/task.md',
        taskName: 'Full Feature Task',
        targetRole: 'developer',
        assignedTeamMemberId: 'worker-1',
        assignedSessionName: 'worker-session',
        assignedAt: '2026-03-06T08:00:00.000Z',
        status: 'completed',
        priority: 'high',
        delegatedBy: 'tl-1',
        parentTaskId: 'goal-1',
        artifacts: [
          { id: 'a1', name: 'main.ts', type: 'file', content: '/src/main.ts', createdAt: '2026-03-06T10:00:00.000Z' },
        ],
        statusHistory: [
          { timestamp: '2026-03-06T08:00:00.000Z', fromStatus: 'pending_assignment', toStatus: 'submitted', reportedBy: 'tl-1' },
          { timestamp: '2026-03-06T08:01:00.000Z', fromStatus: 'submitted', toStatus: 'working', reportedBy: 'worker-1' },
          { timestamp: '2026-03-06T10:00:00.000Z', fromStatus: 'working', toStatus: 'verifying', reportedBy: 'worker-1' },
          { timestamp: '2026-03-06T10:30:00.000Z', fromStatus: 'verifying', toStatus: 'completed', reportedBy: 'tl-1' },
        ],
        completedAt: '2026-03-06T10:30:00.000Z',
        verificationResult: {
          verdict: 'approved',
          verifiedBy: 'tl-1',
          verifiedAt: '2026-03-06T10:30:00.000Z',
        },
      };

      expect(task.artifacts).toHaveLength(1);
      expect(task.statusHistory).toHaveLength(4);
      expect(task.verificationResult?.verdict).toBe('approved');
      expect(task.completedAt).toBeDefined();
    });
  });

  describe('REQUIRED_QUALITY_GATES', () => {
    it('should contain expected gates', () => {
      expect(REQUIRED_QUALITY_GATES).toContain('typecheck');
      expect(REQUIRED_QUALITY_GATES).toContain('tests');
      expect(REQUIRED_QUALITY_GATES).toContain('build');
    });

    it('should have exactly 3 required gates', () => {
      expect(REQUIRED_QUALITY_GATES).toHaveLength(3);
    });
  });
});
