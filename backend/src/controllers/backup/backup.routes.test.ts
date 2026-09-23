/**
 * Tests for the workspace backup routes.
 */

import express from 'express';
import request from 'supertest';
import { createBackupRouter } from './backup.routes.js';

describe('backup routes', () => {
  function app(service: { start: jest.Mock; status: jest.Mock }) {
    const a = express();
    a.use(express.json());
    a.use('/api/backup', createBackupRouter(() => service as never));
    return a;
  }

  it('starts a push and answers 202', async () => {
    const service = { start: jest.fn().mockReturnValue({ state: 'running' }), status: jest.fn() };
    const res = await request(app(service)).post('/api/backup/push').send({ chatDb: false });
    expect(res.status).toBe(202);
    expect(service.start).toHaveBeenCalledWith({ chatDb: false });
  });

  it('refuses a second one while the first runs', async () => {
    const service = { start: jest.fn().mockReturnValue(null), status: jest.fn().mockReturnValue({ state: 'running' }) };
    const res = await request(app(service)).post('/api/backup/push');
    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ state: 'running' });
  });

  it('reports the state', async () => {
    const service = { start: jest.fn(), status: jest.fn().mockReturnValue({ state: 'done', backupId: 'b-1' }) };
    const res = await request(app(service)).get('/api/backup/push');
    expect(res.body.data).toEqual({ state: 'done', backupId: 'b-1' });
  });
});
