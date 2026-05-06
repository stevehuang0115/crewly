/**
 * Tests for ProjectTaskWatcherService — automatic WorkItem creation from ProjectTask files
 * with 48h staleness check on startup sync.
 *
 * @module services/v3/project-task-watcher.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockAddToPool,
  mockGetAllItems,
  mockReaddir,
  mockReadFile,
  mockChokidarWatch,
  mockChokidarClose,
} = vi.hoisted(() => {
  const mockClose = vi.fn();
  return {
    mockAddToPool: vi.fn().mockResolvedValue(undefined),
    mockGetAllItems: vi.fn().mockResolvedValue([]),
    mockReaddir: vi.fn().mockResolvedValue([]),
    mockReadFile: vi.fn().mockResolvedValue(''),
    mockChokidarWatch: vi.fn(),
    mockChokidarClose: mockClose,
  };
});

vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  },
}));

vi.mock('../task-pool/task-pool.service.js', () => ({
  TaskPoolService: {
    getInstance: () => ({
      getAllItems: mockGetAllItems,
      addToPool: mockAddToPool,
    }),
  },
}));

vi.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

// Track event handlers registered with chokidar
let chokidarHandlers: Record<string, Function> = {};

vi.mock('chokidar', () => ({
  watch: vi.fn((...args: unknown[]) => {
    mockChokidarWatch(...args);
    const fakeWatcher = {
      on: vi.fn((event: string, handler: Function) => {
        chokidarHandlers[event] = handler;
        return fakeWatcher;
      }),
      close: mockChokidarClose,
    };
    return fakeWatcher;
  }),
}));

vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { ProjectTaskWatcherService, parseProjectTaskFile } from './project-task-watcher.service.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_PATH = '/test/project';
const TASKS_BASE = path.join(PROJECT_PATH, '.crewly', 'tasks');

/**
 * Creates a standard task markdown content string for testing.
 */
function makeTaskMarkdown(opts: {
  title?: string;
  priority?: string;
  assignedTo?: string;
} = {}): string {
  const lines = [
    `# ${opts.title ?? 'Test Task'}`,
    '',
    '## Task Information',
    `- **Priority**: ${opts.priority ?? 'high'}`,
    '- **Milestone**: delegated',
    '- **Status**: Open',
  ];

  if (opts.assignedTo) {
    lines.push('', '## Assignment Information', `- **Assigned to**: ${opts.assignedTo}`);
  }

  lines.push('', '## Task Description', '', 'Do the thing.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectTaskWatcherService', () => {
  let service: ProjectTaskWatcherService;

  beforeEach(() => {
    vi.clearAllMocks();
    chokidarHandlers = {};
    service = new ProjectTaskWatcherService(PROJECT_PATH);
  });

  afterEach(() => {
    service.dispose();
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe('start()', () => {
    it('should start chokidar live-watch only — no startup backfill', async () => {
      // Simulate the disk having existing actionable .md files. Pre-deprecation
      // the service would have read them all and created WorkItems on start;
      // post-deprecation (PR #482 / Phase 2 Workstream C) it must NOT.
      mockReaddir
        .mockResolvedValueOnce([
          { name: 'delegated', isDirectory: () => true },
        ]) // milestones
        .mockResolvedValueOnce(['stale_task.md']); // pretend in_progress/ has a stale file
      mockReadFile.mockResolvedValueOnce(
        makeTaskMarkdown({ title: 'Stale Task' }),
      );
      mockGetAllItems.mockResolvedValue([]);

      await service.start();

      // chokidar.watch IS called (live path is preserved)
      expect(mockChokidarWatch).toHaveBeenCalledWith(
        expect.stringContaining('.crewly/tasks'),
        expect.objectContaining({
          ignoreInitial: true,
          persistent: true,
        }),
      );

      // Critical regression assertion: backend startup must NOT add any
      // WorkItem from existing .md files. New files written by skills after
      // start are still bridged via the chokidar 'add' handler tested below.
      expect(mockAddToPool).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // ensureWorkItemForTask
  // -----------------------------------------------------------------------

  describe('ensureWorkItemForTask()', () => {
    it('should create a WorkItem with type project_task', async () => {
      const filePath = path.join(TASKS_BASE, 'delegated', 'open', 'my_task.md');
      mockReadFile.mockResolvedValueOnce(
        makeTaskMarkdown({ title: 'Build API', priority: 'high', assignedTo: 'agent-leo' }),
      );
      mockGetAllItems.mockResolvedValue([]);

      const created = await service.ensureWorkItemForTask(filePath, 'delegated', 'open');

      expect(created).toBe(true);
      expect(mockAddToPool).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'project_task',
          owner: 'agent',
          target: 'agent-leo',
          title: 'Build API',
          projectTaskId: 'my_task',
        }),
      );
    });

    it('should set owner to orchestrator when no assignee', async () => {
      const filePath = path.join(TASKS_BASE, 'sprint1', 'open', 'unassigned.md');
      mockReadFile.mockResolvedValueOnce(makeTaskMarkdown({ title: 'Unassigned Task' }));
      mockGetAllItems.mockResolvedValue([]);

      await service.ensureWorkItemForTask(filePath, 'sprint1', 'open');

      expect(mockAddToPool).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'orchestrator',
          target: undefined,
        }),
      );
    });

    it('should return false when WorkItem already exists', async () => {
      const filePath = path.join(TASKS_BASE, 'delegated', 'open', 'dup_task.md');
      mockReadFile.mockResolvedValueOnce(makeTaskMarkdown({ title: 'Dup' }));
      mockGetAllItems.mockResolvedValue([
        { projectTaskId: 'dup_task', status: 'running' },
      ]);

      const created = await service.ensureWorkItemForTask(filePath, 'delegated', 'open');

      expect(created).toBe(false);
      expect(mockAddToPool).not.toHaveBeenCalled();
    });

    it('should return false and not throw when file is unreadable', async () => {
      const filePath = path.join(TASKS_BASE, 'delegated', 'open', 'bad_file.md');
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const created = await service.ensureWorkItemForTask(filePath, 'delegated', 'open');

      expect(created).toBe(false);
      expect(mockAddToPool).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Live watcher (chokidar integration)
  // -----------------------------------------------------------------------

  describe('file watcher', () => {
    it('should process new files in open/ folder via chokidar add event', async () => {
      mockReaddir.mockResolvedValueOnce([]); // initial sync: no milestones
      await service.start();

      mockReadFile.mockResolvedValueOnce(
        makeTaskMarkdown({ title: 'New Live Task', priority: 'medium' }),
      );
      mockGetAllItems.mockResolvedValue([]);

      // Simulate chokidar 'add' event
      const newFilePath = path.join(TASKS_BASE, 'sprint2', 'open', 'live_task.md');
      chokidarHandlers['add']?.(newFilePath);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockAddToPool).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'project_task',
          title: 'New Live Task',
          projectTaskId: 'live_task',
        }),
      );
    });

    it('should ignore files not in actionable status folders', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      await service.start();

      // File in 'done/' folder — should be ignored
      const donePath = path.join(TASKS_BASE, 'sprint1', 'done', 'finished_task.md');
      chokidarHandlers['add']?.(donePath);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockAddToPool).not.toHaveBeenCalled();
    });

    it('should ignore files with insufficient path depth', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      await service.start();

      // File directly in tasks root — should be ignored
      const shallowPath = path.join(TASKS_BASE, 'notes.md');
      chokidarHandlers['add']?.(shallowPath);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mockAddToPool).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe('dispose()', () => {
    it('should close the chokidar watcher', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      await service.start();

      service.dispose();

      expect(mockChokidarClose).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// parseProjectTaskFile (exported utility)
// ---------------------------------------------------------------------------

describe('parseProjectTaskFile', () => {
  it('should extract title from H1 heading', async () => {
    mockReadFile.mockResolvedValueOnce(
      makeTaskMarkdown({ title: 'Deploy Service', priority: 'high' }),
    );

    const result = await parseProjectTaskFile('/path/to/task.md', 'sprint1', 'open');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Deploy Service');
    expect(result!.taskId).toBe('task');
    expect(result!.priority).toBe('high');
    expect(result!.milestone).toBe('sprint1');
    expect(result!.statusFolder).toBe('open');
  });

  it('should extract assigned session name', async () => {
    mockReadFile.mockResolvedValueOnce(
      makeTaskMarkdown({ title: 'Assigned Task', assignedTo: 'crewly-product-leo' }),
    );

    const result = await parseProjectTaskFile('/path/to/assigned.md', 'delegated', 'in_progress');

    expect(result!.assignedTo).toBe('crewly-product-leo');
  });

  it('should default priority to medium when not specified', async () => {
    mockReadFile.mockResolvedValueOnce('# Simple Task\n\nJust do it.');

    const result = await parseProjectTaskFile('/path/to/simple.md', 'sprint1', 'open');

    expect(result!.priority).toBe('medium');
  });

  it('should fall back to filename when no H1 heading', async () => {
    mockReadFile.mockResolvedValueOnce('No heading here, just text.');

    const result = await parseProjectTaskFile('/path/to/no_heading.md', 'sprint1', 'open');

    expect(result!.title).toBe('no_heading');
  });

  it('should return null for unreadable files', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('EACCES'));

    const result = await parseProjectTaskFile('/path/to/protected.md', 'sprint1', 'open');

    expect(result).toBeNull();
  });
});
