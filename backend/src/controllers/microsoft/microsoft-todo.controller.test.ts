/**
 * Tests for the Microsoft To Do controller — envelopes, query/body plumbing,
 * the role gate on data routes, and the error → status + hint mapping.
 *
 * @module controllers/microsoft/microsoft-todo.controller.test
 */

import request from 'supertest';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import { createMicrosoftTodoRouter } from './microsoft-todo.routes.js';
import { setMicrosoftTodoControllerDeps, type MicrosoftTodoControllerDeps } from './microsoft-todo.controller.js';
import { MicrosoftError, type MicrosoftTokenService } from '../../services/microsoft/microsoft-token.service.js';
import type { MicrosoftTodoService } from '../../services/microsoft/microsoft-todo.service.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const mockGatedIds: string[] = [];
jest.mock('../connector/connector.controller.js', () => ({
  requireConnectorAccess: (id: string) => {
    mockGatedIds.push(id);
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.get('X-Test-Deny')) {
        res.status(403).json({ success: false, error: 'connector_forbidden' });
        return;
      }
      next();
    };
  },
}));

const CONNECT_URL = 'https://api.crewlyai.com/api/cloud/microsoft/start?token=cloud-jwt&returnUrl=x';
const LIST = { id: 'L1', name: 'Groceries' };

let app: Application;
let tokens: { status: jest.Mock; disconnect: jest.Mock; buildConnectUrl: jest.Mock };
let todo: { listLists: jest.Mock; createList: jest.Mock; listTasks: jest.Mock; addTask: jest.Mock; updateTask: jest.Mock; deleteTask: jest.Mock };

beforeEach(() => {
  tokens = {
    status: jest.fn().mockResolvedValue({ connected: true, cloudConnected: true, microsoftUserId: 'mu', email: 's@outlook.com' }),
    disconnect: jest.fn().mockResolvedValue({ removed: true }),
    buildConnectUrl: jest.fn().mockReturnValue(CONNECT_URL),
  };
  todo = { listLists: jest.fn(), createList: jest.fn(), listTasks: jest.fn(), addTask: jest.fn(), updateTask: jest.fn(), deleteTask: jest.fn() };
  setMicrosoftTodoControllerDeps({ tokens: tokens as unknown as MicrosoftTokenService, todo: todo as unknown as MicrosoftTodoService } as MicrosoftTodoControllerDeps);
  app = express();
  app.use(express.json());
  app.use('/api/microsoft-todo', createMicrosoftTodoRouter());
});

afterEach(() => setMicrosoftTodoControllerDeps(null));

it('status / connect-url / disconnect wrap the token service and are not role-gated', async () => {
  expect((await request(app).get('/api/microsoft-todo/status').set('X-Test-Deny', '1')).body).toEqual({
    success: true,
    data: { connected: true, cloudConnected: true, microsoftUserId: 'mu', email: 's@outlook.com' },
  });
  const cu = await request(app).get('/api/microsoft-todo/connect-url');
  expect(cu.body.data.url).toBe(CONNECT_URL);
  expect(tokens.buildConnectUrl.mock.calls[0][0]).toMatch(/\/connections\?platform=microsoft-todo$/);
  expect((await request(app).delete('/api/microsoft-todo/disconnect')).body).toEqual({ success: true, data: { removed: true } });
});

it('data routes sit behind the microsoft-todo allowlist', async () => {
  expect(mockGatedIds).toContain('microsoft-todo');
  const res = await request(app).get('/api/microsoft-todo/lists').set('X-Test-Deny', '1');
  expect(res.status).toBe(403);
  expect(todo.listLists).not.toHaveBeenCalled();
});

it('lists: list all, create by name', async () => {
  todo.listLists.mockResolvedValue([{ id: 'L0', name: 'Tasks', isDefault: true }, LIST]);
  expect((await request(app).get('/api/microsoft-todo/lists')).body).toEqual({
    success: true,
    data: { count: 2, lists: [{ id: 'L0', name: 'Tasks', isDefault: true }, LIST] },
  });
  todo.createList.mockResolvedValue({ id: 'L9', name: 'Trip' });
  expect((await request(app).post('/api/microsoft-todo/lists').send({ name: 'Trip' })).body.data).toEqual({ id: 'L9', name: 'Trip' });
  expect(todo.createList).toHaveBeenCalledWith('Trip');
});

it('tasks: list with list/all/limit, add, update (null due clears), delete', async () => {
  todo.listTasks.mockResolvedValue({ list: LIST, tasks: [{ id: 't1', title: 'Milk', status: 'notStarted' }], hasMore: true });
  const listed = await request(app).get('/api/microsoft-todo/tasks?list=Groceries&all=1&limit=5');
  expect(listed.body.data).toEqual({ list: LIST, count: 1, tasks: [{ id: 't1', title: 'Milk', status: 'notStarted' }], hasMore: true });
  expect(todo.listTasks).toHaveBeenCalledWith({ list: 'Groceries', includeCompleted: true, limit: 5 });
  todo.listTasks.mockResolvedValue({ list: LIST, tasks: [], hasMore: false });
  expect((await request(app).get('/api/microsoft-todo/tasks')).body.data).toEqual({ list: LIST, count: 0, tasks: [] });
  expect(todo.listTasks).toHaveBeenLastCalledWith({ list: undefined, includeCompleted: false, limit: undefined });

  todo.addTask.mockResolvedValue({ list: LIST, task: { id: 't2', title: 'Eggs', status: 'notStarted' } });
  await request(app).post('/api/microsoft-todo/tasks').send({ list: 'Groceries', title: 'Eggs', due: '2026-10-01', importance: 'high', note: 'free range' });
  expect(todo.addTask).toHaveBeenCalledWith({ list: 'Groceries', title: 'Eggs', note: 'free range', due: '2026-10-01', importance: 'high' });

  todo.updateTask.mockResolvedValue({ list: LIST, task: { id: 't2', title: 'Eggs', status: 'completed' } });
  const patched = await request(app).patch('/api/microsoft-todo/tasks/t2').send({ list: 'Groceries', complete: true, due: null });
  expect(patched.body).toEqual({ success: true, data: { list: LIST, task: { id: 't2', title: 'Eggs', status: 'completed' } } });
  expect(todo.updateTask).toHaveBeenCalledWith({ list: 'Groceries', taskId: 't2', title: undefined, note: undefined, due: null, importance: undefined, complete: true });

  todo.deleteTask.mockResolvedValue({ list: LIST, taskId: 't2', deleted: true });
  expect((await request(app).delete('/api/microsoft-todo/tasks/t2?list=Groceries')).body.data).toEqual({ list: LIST, taskId: 't2', deleted: true });
  expect(todo.deleteTask).toHaveBeenCalledWith('Groceries', 't2');
});

it('maps not_connected to 409 with the connect URL, rate_limited to 429 + Retry-After, forbidden with a mailbox hint, and unexpected throws to 500', async () => {
  todo.listLists.mockRejectedValueOnce(new MicrosoftError(409, 'not_connected', 'no grant'));
  let res = await request(app).get('/api/microsoft-todo/lists');
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ success: false, error: 'not_connected', message: 'no grant', hint: CONNECT_URL });

  todo.listLists.mockRejectedValueOnce(new MicrosoftError(429, 'rate_limited', 'slow down', 30));
  res = await request(app).get('/api/microsoft-todo/lists');
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBe('30');
  expect(res.body).toMatchObject({ error: 'rate_limited', retryAfter: 30, hint: expect.stringContaining('30 seconds') });

  todo.listLists.mockRejectedValueOnce(new MicrosoftError(403, 'forbidden', 'MailboxNotEnabledForRESTAPI'));
  res = await request(app).get('/api/microsoft-todo/lists');
  expect(res.status).toBe(403);
  expect(res.body.hint).toMatch(/mailbox/);

  todo.listLists.mockRejectedValueOnce(new MicrosoftError(503, 'not_configured', 'x'));
  res = await request(app).get('/api/microsoft-todo/lists');
  expect(res.status).toBe(503);
  expect(res.body.hint).toMatch(/not configured for Microsoft/);

  todo.listLists.mockRejectedValueOnce(new Error('boom'));
  res = await request(app).get('/api/microsoft-todo/lists');
  expect(res.status).toBe(500);
  expect(res.body.error).toBe('internal');
});
