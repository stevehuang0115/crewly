/**
 * Tests for the tickets API (specs/ticket-loop.md §5).
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTicketsRouter } from './tickets.routes.js';
import { TicketIntakeService, setTicketIntakeService, type IntakeMessage } from '../../services/v3/ticket-intake.service.js';
import { RequestService } from '../../services/v3/request.service.js';

let dir: string;
let svc: TicketIntakeService;
let requests: RequestService;
const app = express();
app.use(express.json());
app.use('/api/tickets', createTicketsRouter());

/**
 * Owner message.
 *
 * @param ts - Slack ts
 * @param text - Text
 * @returns Intake message
 */
function msg(ts: string, text: string): IntakeMessage {
  return {
    text,
    isOwner: true,
    origin: { channel: 'slack-dm', ref: `slackdm-D1-${ts}`, threadRef: `slack:D1:${ts}`, author: 'U1' },
    targetAgent: 'ella',
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tickets-api-'));
  RequestService.resetInstance();
  requests = RequestService.getInstance(dir);
  svc = new TicketIntakeService({ requests });
  setTicketIntakeService(svc);
});

afterEach(async () => {
  setTicketIntakeService(null);
  RequestService.resetInstance();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GET /api/tickets', () => {
  it('returns board rows and column counts', async () => {
    await svc.intake(msg('1.0', 'implement csv export'));
    await svc.intake(msg('2.0', '🐛 the login button does nothing'));
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.data.columns.todo).toBe(2);
    expect(res.body.data.tickets[0]).toMatchObject({ tkt: 'TKT-002', kind: 'issue', column: 'todo', assignee: 'ella', priorityLabel: 'P2' });
  });

  it('filters by kind, column and q', async () => {
    await svc.intake(msg('1.0', 'implement csv export'));
    await svc.intake(msg('2.0', '🐛 the login button does nothing'));
    expect((await request(app).get('/api/tickets?kind=issue')).body.count).toBe(1);
    expect((await request(app).get('/api/tickets?q=csv')).body.data.tickets[0].tkt).toBe('TKT-001');
    expect((await request(app).get('/api/tickets?column=done')).body.count).toBe(0);
  });

  it('rejects unknown column / kind', async () => {
    expect((await request(app).get('/api/tickets?column=nope')).status).toBe(400);
    expect((await request(app).get('/api/tickets?kind=bug')).status).toBe(400);
  });

  it('503 when the intake is not wired', async () => {
    setTicketIntakeService(null);
    expect((await request(app).get('/api/tickets')).status).toBe(503);
  });
});

describe('GET /api/tickets/:tkt', () => {
  it('finds a ticket by TKT-123, 123 or id', async () => {
    const t = await svc.intake(msg('1.0', 'implement csv export'));
    for (const ref of ['TKT-001', '1', t!.id]) {
      const res = await request(app).get(`/api/tickets/${ref}`);
      expect(res.status).toBe(200);
      expect(res.body.data.ticket.id).toBe(t!.id);
      expect(res.body.data.board.tkt).toBe('TKT-001');
    }
  });

  it('404 for an unknown ticket', async () => {
    expect((await request(app).get('/api/tickets/TKT-404')).status).toBe(404);
  });
});

describe('POST /api/tickets/:id/dismiss', () => {
  it('cancels the ticket and tags it dismissed; idempotent', async () => {
    const t = await svc.intake(msg('1.0', 'implement csv export'));
    const res = await request(app).post(`/api/tickets/${t!.id}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'cancelled', tags: expect.arrayContaining(['dismissed']) });
    expect(res.body.alreadyDismissed).toBe(false);
    const again = await request(app).post('/api/tickets/TKT-001/dismiss');
    expect(again.body.alreadyDismissed).toBe(true);
  });

  it('refuses agents — only the owner dismisses', async () => {
    const t = await svc.intake(msg('1.0', 'implement csv export'));
    const res = await request(app).post(`/api/tickets/${t!.id}/dismiss`).set('X-Agent-Session', 'ella');
    expect(res.status).toBe(403);
    expect((await requests.getById(t!.id))?.status).toBe('open');
  });

  it('404 unknown, 409 done', async () => {
    expect((await request(app).post('/api/tickets/TKT-9/dismiss')).status).toBe(404);
    const t = await svc.intake(msg('1.0', 'implement csv export'));
    await requests.update(t!.id, { status: 'done' });
    const res = await request(app).post(`/api/tickets/${t!.id}/dismiss`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_done');
  });
});
