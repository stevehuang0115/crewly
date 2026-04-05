/**
 * Tests for Intent Task Controller — V2
 *
 * @module controllers/intent-task/intent-task.controller.test
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IntentTaskService } from '../../services/intent-task/intent-task.service.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import {
  decomposeMessage,
  batchCreateTasks,
  createTask,
  listTasks,
  getStatistics,
  listMessageGroups,
  getProjectTaskStatus,
  getTask,
  updateTask,
  toggleTask,
  deleteTask,
  startRun,
  completeRun,
  failRun,
  recordSpan,
} from './intent-task.controller.js';

/** Create a mock Express request */
function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    body: {},
    params: {},
    query: {},
    ...overrides,
  };
}

/** Create a mock Express response with jest spies */
function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('IntentTaskController', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intent-task-ctrl-test-'));
    IntentTaskService.resetInstance();
    IntentTaskService.setPersistencePath(join(tmpDir, 'intent-tasks.json'));
    TokenUsageService.resetInstance();
  });

  afterEach(() => {
    IntentTaskService.resetInstance();
    IntentTaskService.setPersistencePath(undefined);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ===========================================================================
  // Decomposition Endpoint
  // ===========================================================================

  describe('POST /api/intent-tasks/decompose (decomposeMessage)', () => {
    it('should decompose a message and return 201', async () => {
      const req = mockReq({ body: { message: 'Fix the bug then deploy to staging' } });
      const res = mockRes();

      await decomposeMessage(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const data = res.json.mock.calls[0][0].data;
      expect(data.length).toBeGreaterThanOrEqual(2);
      // All tasks share same messageId
      const messageId = data[0].messageId;
      for (const task of data) {
        expect(task.messageId).toBe(messageId);
      }
    });

    it('should return 400 for missing message', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await decomposeMessage(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for empty message', async () => {
      const req = mockReq({ body: { message: '   ' } });
      const res = mockRes();

      await decomposeMessage(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should apply projectTaskId to decomposed tasks', async () => {
      const req = mockReq({ body: { message: 'Fix bug then deploy', projectTaskId: 'proj-1' } });
      const res = mockRes();

      await decomposeMessage(req, res);

      const data = res.json.mock.calls[0][0].data;
      for (const task of data) {
        expect(task.projectTaskId).toBe('proj-1');
      }
    });
  });

  // ===========================================================================
  // Batch Create Endpoint (V3)
  // ===========================================================================

  describe('POST /api/intent-tasks/batch (batchCreateTasks)', () => {
    it('should batch create tasks and return 201', async () => {
      const req = mockReq({
        body: {
          tasks: [
            { intent: '部署到 staging', level: 'L1', category: 'deployment' },
            { intent: '检查错误日志', level: 'L0', category: 'debugging' },
          ],
          originalMessage: '帮我部署一下然后检查日志',
        },
      });
      const res = mockRes();

      await batchCreateTasks(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(data[0].intent).toBe('部署到 staging');
      expect(data[1].intent).toBe('检查错误日志');
      // All tasks share same messageId
      expect(data[0].messageId).toBe(data[1].messageId);
    });

    it('should return 400 for missing tasks array', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await batchCreateTasks(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for empty tasks array', async () => {
      const req = mockReq({ body: { tasks: [] } });
      const res = mockRes();

      await batchCreateTasks(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when a task is missing intent', async () => {
      const req = mockReq({
        body: {
          tasks: [
            { intent: 'Valid task' },
            { level: 'L1' }, // missing intent
          ],
        },
      });
      const res = mockRes();

      await batchCreateTasks(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error).toContain('tasks[1].intent');
    });

    it('should create message group viewable via messages endpoint', async () => {
      const req = mockReq({
        body: {
          tasks: [
            { intent: 'Task A' },
            { intent: 'Task B' },
          ],
          originalMessage: 'Do A and B',
        },
      });
      const res = mockRes();

      await batchCreateTasks(req, res);

      // Now list message groups
      const listReq = mockReq();
      const listRes = mockRes();
      await listMessageGroups(listReq, listRes);

      const groups = listRes.json.mock.calls[0][0].data;
      expect(groups).toHaveLength(1);
      expect(groups[0].originalMessage).toBe('Do A and B');
      expect(groups[0].totalCount).toBe(2);
    });
  });

  // ===========================================================================
  // Extended Update (V3)
  // ===========================================================================

  describe('PUT /api/intent-tasks/:taskId — extended fields', () => {
    it('should update intent description', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Original' });

      const req = mockReq({ params: { taskId: task.id }, body: { intent: 'Refined' } });
      const res = mockRes();

      await updateTask(req, res);

      expect(res.json.mock.calls[0][0].data.intent).toBe('Refined');
    });

    it('should update level and category', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test', level: 'L0', category: 'query' });

      const req = mockReq({
        params: { taskId: task.id },
        body: { level: 'L2', category: 'deployment' },
      });
      const res = mockRes();

      await updateTask(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.level).toBe('L2');
      expect(data.category).toBe('deployment');
    });
  });

  // ===========================================================================
  // Task Endpoints
  // ===========================================================================

  describe('POST /api/intent-tasks (createTask)', () => {
    it('should create a task and return 201', async () => {
      const req = mockReq({ body: { intent: 'Fix the bug' } });
      const res = mockRes();

      await createTask(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ intent: 'Fix the bug', messageId: expect.any(String) }),
        })
      );
    });

    it('should return 400 for missing intent', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      await createTask(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for empty intent', async () => {
      const req = mockReq({ body: { intent: '   ' } });
      const res = mockRes();

      await createTask(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/intent-tasks (listTasks)', () => {
    it('should list all tasks', async () => {
      IntentTaskService.getInstance().createTask({ intent: 'Task 1' });
      IntentTaskService.getInstance().createTask({ intent: 'Task 2' });

      const req = mockReq();
      const res = mockRes();

      await listTasks(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.arrayContaining([
            expect.objectContaining({ intent: 'Task 1' }),
          ]),
        })
      );
    });

    it('should filter by status query param', async () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'Task 1' });
      service.createTask({ intent: 'Task 2' });
      service.completeTask(t1.id);

      const req = mockReq({ query: { status: 'completed' } });
      const res = mockRes();

      await listTasks(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
    });

    it('should include originalMessage in task summaries', async () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy to staging' });

      const req = mockReq();
      const res = mockRes();

      await listTasks(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.length).toBeGreaterThanOrEqual(2);
      for (const summary of data) {
        expect(summary.originalMessage).toBe('Fix bug then deploy to staging');
      }
    });
  });

  describe('GET /api/intent-tasks/statistics', () => {
    it('should return statistics with totalMessages', async () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.createTask({ intent: 'Standalone' });

      const req = mockReq();
      const res = mockRes();

      await getStatistics(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            totalTasks: expect.any(Number),
            totalMessages: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/intent-tasks/messages (listMessageGroups)', () => {
    it('should return message groups', async () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });

      const req = mockReq();
      const res = mockRes();

      await listMessageGroups(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0]).toHaveProperty('messageId');
      expect(data[0]).toHaveProperty('originalMessage');
      expect(data[0]).toHaveProperty('tasks');
      expect(data[0]).toHaveProperty('completedCount');
      expect(data[0]).toHaveProperty('totalCount');
    });

    it('should filter message groups by status query param', async () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.completeTask(tasks[0].id, 'Done');

      const req = mockReq({ query: { status: 'completed' } });
      const res = mockRes();

      await listMessageGroups(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].tasks).toHaveLength(1);
      expect(data[0].tasks[0].status).toBe('completed');
      // originalMessage preserved from stored text, not rebuilt
      expect(data[0].originalMessage).toBe('Fix bug then deploy');
    });

    it('should return empty array when no tasks match status filter', async () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });

      const req = mockReq({ query: { status: 'failed' } });
      const res = mockRes();

      await listMessageGroups(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data).toHaveLength(0);
    });
  });

  describe('GET /api/intent-tasks/project/:projectTaskId', () => {
    it('should return project task status', async () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy', projectTaskId: 'proj-1' });

      const req = mockReq({ params: { projectTaskId: 'proj-1' } });
      const res = mockRes();

      await getProjectTaskStatus(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.projectTaskId).toBe('proj-1');
      expect(data.totalTasks).toBeGreaterThanOrEqual(2);
      expect(data.allCompleted).toBe(false);
    });

    it('should return 404 for unlinked project task', async () => {
      const req = mockReq({ params: { projectTaskId: 'unknown' } });
      const res = mockRes();

      await getProjectTaskStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/intent-tasks/:taskId', () => {
    it('should return a task', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id } });
      const res = mockRes();

      await getTask(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ id: task.id }),
        })
      );
    });

    it('should return 404 for non-existent task', async () => {
      const req = mockReq({ params: { taskId: 'nope' } });
      const res = mockRes();

      await getTask(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PUT /api/intent-tasks/:taskId', () => {
    it('should update task status', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id }, body: { status: 'in_progress' } });
      const res = mockRes();

      await updateTask(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ status: 'in_progress' }),
        })
      );
    });

    it('should return 404 for non-existent task', async () => {
      const req = mockReq({ params: { taskId: 'nope' }, body: { status: 'completed' } });
      const res = mockRes();

      await updateTask(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/intent-tasks/:taskId/toggle (toggleTask)', () => {
    it('should toggle a classified task to completed', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id } });
      const res = mockRes();

      await toggleTask(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.status).toBe('completed');
    });

    it('should toggle a completed task back to classified', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      service.completeTask(task.id);

      const req = mockReq({ params: { taskId: task.id } });
      const res = mockRes();

      await toggleTask(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.status).toBe('classified');
      expect(data.completedAt).toBeNull();
    });

    it('should toggle in_progress task to completed', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      service.updateTask(task.id, { status: 'in_progress' });

      const req = mockReq({ params: { taskId: task.id } });
      const res = mockRes();

      await toggleTask(req, res);

      const data = res.json.mock.calls[0][0].data;
      expect(data.status).toBe('completed');
    });

    it('should return 404 for non-existent task', async () => {
      const req = mockReq({ params: { taskId: 'nope' } });
      const res = mockRes();

      await toggleTask(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /api/intent-tasks/:taskId', () => {
    it('should delete a task', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id } });
      const res = mockRes();

      await deleteTask(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('should return 404 for non-existent task', async () => {
      const req = mockReq({ params: { taskId: 'nope' } });
      const res = mockRes();

      await deleteTask(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ===========================================================================
  // Run Endpoints
  // ===========================================================================

  describe('POST /:taskId/runs (startRun)', () => {
    it('should start a run', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id }, body: { sessionName: 'agent-1' } });
      const res = mockRes();

      await startRun(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ sessionName: 'agent-1' }),
        })
      );
    });

    it('should return 400 for missing sessionName', async () => {
      const task = IntentTaskService.getInstance().createTask({ intent: 'Test' });

      const req = mockReq({ params: { taskId: task.id }, body: {} });
      const res = mockRes();

      await startRun(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /:taskId/runs/:runId/complete', () => {
    it('should complete a run', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const req = mockReq({ params: { taskId: task.id, runId: run.id } });
      const res = mockRes();

      await completeRun(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'completed' }),
        })
      );
    });
  });

  describe('POST /:taskId/runs/:runId/fail', () => {
    it('should fail a run with error', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const req = mockReq({ params: { taskId: task.id, runId: run.id }, body: { error: 'Timeout' } });
      const res = mockRes();

      await failRun(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed', error: 'Timeout' }),
        })
      );
    });
  });

  // ===========================================================================
  // Span Endpoints
  // ===========================================================================

  describe('POST /:taskId/runs/:runId/spans (recordSpan)', () => {
    it('should record a span', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const req = mockReq({
        params: { taskId: task.id, runId: run.id },
        body: { type: 'llm_call', label: 'claude', inputTokens: 100, outputTokens: 50 },
      });
      const res = mockRes();

      await recordSpan(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for missing type or label', async () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const req = mockReq({
        params: { taskId: task.id, runId: run.id },
        body: {},
      });
      const res = mockRes();

      await recordSpan(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
