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
import { TicketReviewService, setTicketReviewService } from '../../services/v3/ticket-review.service.js';

let dir: string;
let svc: TicketIntakeService;
let requests: RequestService;
let reworks: Array<{ reason: string; target: string }>;
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
  reworks = [];
  const review = new TicketReviewService({
    requests,
    fallbackAgent: 'crewly-orc',
    createRework: async ({ reason, target }) => {
      reworks.push({ reason, target });
      return 'wi-1';
    },
  });
  setTicketReviewService(review);
  svc.setReviewHandler(review);
});

afterEach(async () => {
  setTicketIntakeService(null);
  setTicketReviewService(null);
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
    await requests.update(t!.id, { status: 'done', accepted: true });
    const res = await request(app).post(`/api/tickets/${t!.id}/dismiss`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_done');
  });
});

describe('Phase 2 review endpoints', () => {
  /**
   * A ticket that the agent answered (now 待验收).
   *
   * @returns The ticket id
   */
  async function inReview(): Promise<string> {
    const t = await svc.intake(msg('1.0', 'implement csv export'));
    await requests.update(t!.id, { status: 'done', reply: { at: new Date().toISOString(), by: 'ella', messageId: 'm1', excerpt: 'done: csv export' } });
    expect((await requests.getById(t!.id))?.status).toBe('waiting_confirmation');
    return t!.id;
  }

  it('lists a 待验收 ticket in to_review with the answer and the auto-accept time', async () => {
    await inReview();
    const res = await request(app).get('/api/tickets?column=to_review');
    expect(res.body.count).toBe(1);
    expect(res.body.data.tickets[0]).toMatchObject({ column: 'to_review', submitCount: 1, reply: { excerpt: 'done: csv export' } });
    expect(res.body.data.tickets[0].autoAcceptAt).toEqual(expect.any(String));
  });

  it('verify → done; a second verify is 409 already_done', async () => {
    const id = await inReview();
    const res = await request(app).post(`/api/tickets/${id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('done');
    const again = await request(app).post(`/api/tickets/${id}/verify`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_done');
  });

  it('reject needs a reason, reopens, records it as a criterion and queues rework for whoever answered', async () => {
    const id = await inReview();
    expect((await request(app).post(`/api/tickets/${id}/reject`).send({ reason: '  ' })).status).toBe(400);
    const res = await request(app).post(`/api/tickets/${id}/reject`).send({ reason: 'the header row is missing' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'running', rejectCount: 1 });
    expect(res.body.data.acceptance).toEqual([expect.objectContaining({ text: 'the header row is missing', source: 'reject', check: 'judgment' })]);
    expect(reworks).toEqual([{ reason: 'the header row is missing', target: 'ella' }]);
    // Not in review any more.
    expect((await request(app).post(`/api/tickets/${id}/reject`).send({ reason: 'again' })).body.code).toBe('not_in_review');
  });

  it('owner-only actions refuse agents; self-check is open to agents', async () => {
    const id = await inReview();
    for (const [method, url] of [
      ['post', `/api/tickets/${id}/verify`],
      ['post', `/api/tickets/${id}/reject`],
      ['put', `/api/tickets/${id}/acceptance`],
      ['patch', `/api/tickets/${id}`],
    ] as const) {
      const res = await request(app)[method](url).set('X-Agent-Session', 'ella').send({ reason: 'x', items: [], priority: 'high' });
      expect(res.status).toBe(403);
    }
    await request(app).put(`/api/tickets/${id}/acceptance`).send({ items: [{ text: 'has a header row', check: 'auto' }] });
    const sc = await request(app)
      .post(`/api/tickets/${id}/self-check`)
      .set('X-Agent-Session', 'ella')
      .send({ index: 0, result: 'pass', evidence: 'ran the export' });
    expect(sc.status).toBe(200);
    expect(sc.body.data.acceptance[0]).toMatchObject({ selfCheck: 'pass', evidence: 'ran the export' });
    expect((await request(app).post(`/api/tickets/${id}/self-check`).send({ index: 5, result: 'pass' })).status).toBe(400);
  });

  it('acceptance PUT replaces the live list (removed ones kept with removedAt); POST twin works', async () => {
    const id = await inReview();
    await request(app).put(`/api/tickets/${id}/acceptance`).send({ items: ['a', { text: 'b', check: 'auto' }] });
    const res = await request(app).post(`/api/tickets/${id}/acceptance`).send({ items: ['b'] });
    expect(res.status).toBe(200);
    const all = res.body.data.acceptance as Array<{ text: string; removedAt?: string; check?: string }>;
    expect(all.find((a) => a.text === 'a')?.removedAt).toEqual(expect.any(String));
    expect(all.find((a) => a.text === 'b')).toMatchObject({ check: 'auto' });
    const board = (await request(app).get(`/api/tickets/${id}`)).body.data.board;
    expect(board.acceptance.map((a: { text: string }) => a.text)).toEqual(['b']);
    expect((await request(app).put(`/api/tickets/${id}/acceptance`).send({ items: 'nope' })).status).toBe(400);
  });

  it('PATCH and its POST twin edit priority / title; bad values are 400', async () => {
    const id = await inReview();
    expect((await request(app).patch(`/api/tickets/${id}`).send({ priority: 'urgent', title: 'CSV export' })).body.data).toMatchObject({
      priority: 'urgent',
      title: 'CSV export',
    });
    expect((await request(app).post(`/api/tickets/${id}/update`).send({ kind: 'issue' })).body.data.kind).toBe('issue');
    expect((await request(app).patch(`/api/tickets/${id}`).send({ priority: 'asap' })).status).toBe(400);
    expect((await request(app).patch(`/api/tickets/${id}`).send({})).status).toBe(400);
  });

  it('503 when review is not wired', async () => {
    setTicketReviewService(null);
    expect((await request(app).post('/api/tickets/TKT-001/verify')).status).toBe(503);
  });
});
