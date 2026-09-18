/**
 * Tests for the Google Workspace controller — response envelopes, the
 * not_connected → 409 + connect-URL hint mapping, the other error codes,
 * connect-url building and the send dry-run.
 *
 * @module controllers/google/google.controller.test
 */

import request from 'supertest';
import express, { type Application } from 'express';
import { createGoogleRouter } from './google.routes.js';
import { setGoogleControllerDeps, type GoogleControllerDeps } from './google.controller.js';
import { GoogleWorkspaceError, type GoogleWorkspaceTokenService } from '../../services/google/google-workspace-token.service.js';
import { base64UrlDecode, type GmailService } from '../../services/google/gmail.service.js';
import type { CalendarService } from '../../services/google/calendar.service.js';

jest.mock('../../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const CONNECT_URL = 'https://api.crewlyai.com/api/cloud/google/workspace/start?token=cloud-jwt&returnUrl=x';

let app: Application;
let tokens: { status: jest.Mock; disconnect: jest.Mock; buildConnectUrl: jest.Mock };
let gmail: { search: jest.Mock; read: jest.Mock; send: jest.Mock };
let calendar: { listEvents: jest.Mock; createEvent: jest.Mock };

beforeEach(() => {
  tokens = {
    status: jest.fn().mockResolvedValue({ connected: true, cloudConnected: true, email: 'owner@example.com' }),
    disconnect: jest.fn().mockResolvedValue({ removed: true }),
    buildConnectUrl: jest.fn().mockReturnValue(CONNECT_URL),
  };
  gmail = { search: jest.fn(), read: jest.fn(), send: jest.fn() };
  calendar = { listEvents: jest.fn(), createEvent: jest.fn() };
  setGoogleControllerDeps({
    tokens: tokens as unknown as GoogleWorkspaceTokenService,
    gmail: gmail as unknown as GmailService,
    calendar: calendar as unknown as CalendarService,
  } as GoogleControllerDeps);

  app = express();
  app.use(express.json());
  app.use('/api/google', createGoogleRouter());
});

afterEach(() => {
  setGoogleControllerDeps(null);
});

describe('GET /status', () => {
  it('returns the token service status', async () => {
    const res = await request(app).get('/api/google/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { connected: true, cloudConnected: true, email: 'owner@example.com' } });
  });

  it('maps a Cloud not_configured to 503 with a distinct hint', async () => {
    tokens.status.mockRejectedValueOnce(new GoogleWorkspaceError(503, 'not_configured', 'no client'));
    const res = await request(app).get('/api/google/status');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: 'not_configured', hint: expect.stringContaining('not configured') });
  });
});

describe('GET /connect-url', () => {
  it('defaults the return URL to this API origin + /settings?tab=integrations', async () => {
    const res = await request(app).get('/api/google/connect-url').set('Host', 'localhost:8787');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { url: CONNECT_URL } });
    expect(tokens.buildConnectUrl).toHaveBeenCalledWith('http://localhost:8787/settings?tab=integrations');
  });

  it('honours an explicit http(s) returnUrl and ignores a non-http one', async () => {
    await request(app).get('/api/google/connect-url').query({ returnUrl: 'http://localhost:3000/settings?tab=integrations' }).set('Host', 'localhost:8787');
    expect(tokens.buildConnectUrl).toHaveBeenLastCalledWith('http://localhost:3000/settings?tab=integrations');

    await request(app).get('/api/google/connect-url').query({ returnUrl: 'javascript:alert(1)' }).set('Host', 'localhost:8787');
    expect(tokens.buildConnectUrl).toHaveBeenLastCalledWith('http://localhost:8787/settings?tab=integrations');
  });

  it('answers 401 not_logged_in when there is no Cloud session', async () => {
    tokens.buildConnectUrl.mockImplementation(() => { throw new GoogleWorkspaceError(401, 'not_logged_in', 'sign in'); });
    const res = await request(app).get('/api/google/connect-url');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: 'not_logged_in', hint: expect.stringContaining('Sign in to Crewly Cloud') });
  });
});

describe('DELETE /disconnect', () => {
  it('revokes and reports removed', async () => {
    const res = await request(app).delete('/api/google/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { removed: true } });
  });
});

describe('GET /gmail/search', () => {
  it('passes q and max through and wraps the hits', async () => {
    gmail.search.mockResolvedValueOnce([{ id: 'm1' }]);
    const res = await request(app).get('/api/google/gmail/search').query({ q: 'is:unread', max: '5' });
    expect(res.status).toBe(200);
    expect(gmail.search).toHaveBeenCalledWith({ query: 'is:unread', max: 5 });
    expect(res.body).toEqual({ success: true, data: { query: 'is:unread', count: 1, messages: [{ id: 'm1' }] } });
  });

  it('400s without q', async () => {
    const res = await request(app).get('/api/google/gmail/search');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'validation' });
    expect(gmail.search).not.toHaveBeenCalled();
  });

  it('maps not_connected to 409 with the connect URL as the hint', async () => {
    gmail.search.mockRejectedValueOnce(new GoogleWorkspaceError(409, 'not_connected', 'no grant'));
    const res = await request(app).get('/api/google/gmail/search').query({ q: 'x' }).set('Host', 'localhost:8787');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'not_connected', message: 'no grant', hint: CONNECT_URL });
    expect(tokens.buildConnectUrl).toHaveBeenCalledWith('http://localhost:8787/settings?tab=integrations');
  });

  it('falls back to a textual hint for not_connected when not even signed in to Cloud', async () => {
    gmail.search.mockRejectedValueOnce(new GoogleWorkspaceError(409, 'not_connected', 'no grant'));
    tokens.buildConnectUrl.mockImplementation(() => { throw new GoogleWorkspaceError(401, 'not_logged_in', 'sign in'); });
    const res = await request(app).get('/api/google/gmail/search').query({ q: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.hint).toContain('Sign in to Crewly Cloud');
  });

  it('passes Google 502/401 through with their status', async () => {
    gmail.search.mockRejectedValueOnce(new GoogleWorkspaceError(502, 'google_error', 'boom'));
    expect((await request(app).get('/api/google/gmail/search').query({ q: 'x' })).status).toBe(502);
    gmail.search.mockRejectedValueOnce(new GoogleWorkspaceError(401, 'google_error', 'bad token'));
    const res = await request(app).get('/api/google/gmail/search').query({ q: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.hint).toContain('retry once');
  });

  it('turns an unexpected throw into a 500 internal', async () => {
    gmail.search.mockRejectedValueOnce(new Error('kaboom'));
    const res = await request(app).get('/api/google/gmail/search').query({ q: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, error: 'internal', message: 'kaboom' });
  });
});

describe('GET /gmail/messages/:id', () => {
  it('reads by id', async () => {
    gmail.read.mockResolvedValueOnce({ id: 'm1', body: 'hi' });
    const res = await request(app).get('/api/google/gmail/messages/m1');
    expect(res.status).toBe(200);
    expect(gmail.read).toHaveBeenCalledWith('m1');
    expect(res.body).toEqual({ success: true, data: { id: 'm1', body: 'hi' } });
  });

  it('passes a Gmail 404 through', async () => {
    gmail.read.mockRejectedValueOnce(new GoogleWorkspaceError(404, 'google_error', 'not found'));
    expect((await request(app).get('/api/google/gmail/messages/nope')).status).toBe(404);
  });
});

describe('POST /gmail/send', () => {
  it('sends with the normalised input', async () => {
    gmail.send.mockResolvedValueOnce({ id: 's1', threadId: 't1', labelIds: ['SENT'] });
    const res = await request(app).post('/api/google/gmail/send').send({
      to: 'a@b.c', subject: 'Hi', text: 'x', cc: 'c@d.e', threadId: 't1', inReplyTo: '<m@x>',
    });
    expect(res.status).toBe(200);
    expect(gmail.send).toHaveBeenCalledWith({ to: 'a@b.c', subject: 'Hi', text: 'x', cc: 'c@d.e', threadId: 't1', inReplyTo: '<m@x>' });
    expect(res.body).toEqual({ success: true, data: { id: 's1', threadId: 't1', labelIds: ['SENT'] } });
  });

  it('dryRun returns the RFC 822 preview and never calls Gmail', async () => {
    const res = await request(app).post('/api/google/gmail/send').send({ to: 'a@b.c', subject: 'Hi', text: 'hello', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.raw).toContain('To: a@b.c\r\nSubject: Hi\r\n');
    expect(res.body.data.raw).toContain(Buffer.from('hello').toString('base64'));
    expect(gmail.send).not.toHaveBeenCalled();
    expect(base64UrlDecode(Buffer.from(res.body.data.raw).toString('base64url'))).toBe(res.body.data.raw);
  });

  it('400s a dry run without to/subject, without calling Gmail', async () => {
    const res = await request(app).post('/api/google/gmail/send').send({ subject: 'Hi', text: 'x', dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'validation' });
    expect(gmail.send).not.toHaveBeenCalled();
  });

  it('propagates validation from the service as 400', async () => {
    gmail.send.mockRejectedValueOnce(new GoogleWorkspaceError(400, 'validation', '"to" is required'));
    const res = await request(app).post('/api/google/gmail/send').send({ subject: 'Hi', text: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('"to" is required');
  });
});

describe('GET /calendar/events', () => {
  it('maps from/to/calendarId/max onto the service', async () => {
    calendar.listEvents.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    const res = await request(app).get('/api/google/calendar/events').query({ from: '2026-09-18T00:00:00Z', to: '2026-09-19T00:00:00Z', calendarId: 'ops@x', max: '3' });
    expect(res.status).toBe(200);
    expect(calendar.listEvents).toHaveBeenCalledWith({ calendarId: 'ops@x', timeMin: '2026-09-18T00:00:00Z', timeMax: '2026-09-19T00:00:00Z', max: 3 });
    expect(res.body).toEqual({ success: true, data: { count: 2, events: [{ id: 'e1' }, { id: 'e2' }] } });
  });

  it('sends undefined for absent filters', async () => {
    calendar.listEvents.mockResolvedValueOnce([]);
    await request(app).get('/api/google/calendar/events');
    expect(calendar.listEvents).toHaveBeenCalledWith({ calendarId: undefined, timeMin: undefined, timeMax: undefined, max: undefined });
  });

  it('maps not_connected to 409 with the connect URL', async () => {
    calendar.listEvents.mockRejectedValueOnce(new GoogleWorkspaceError(409, 'not_connected', 'no grant'));
    const res = await request(app).get('/api/google/calendar/events');
    expect(res.status).toBe(409);
    expect(res.body.hint).toBe(CONNECT_URL);
  });
});

describe('POST /calendar/events', () => {
  it('creates with array attendees', async () => {
    calendar.createEvent.mockResolvedValueOnce({ id: 'n1' });
    const res = await request(app).post('/api/google/calendar/events').send({
      summary: 'Review', start: '2026-09-20T14:00:00', end: '2026-09-20T15:00:00', timezone: 'Asia/Shanghai', description: 'd', attendees: ['a@b.c'],
    });
    expect(res.status).toBe(200);
    expect(calendar.createEvent).toHaveBeenCalledWith({
      calendarId: undefined, summary: 'Review', start: '2026-09-20T14:00:00', end: '2026-09-20T15:00:00', description: 'd', attendees: ['a@b.c'], timezone: 'Asia/Shanghai',
    });
    expect(res.body).toEqual({ success: true, data: { id: 'n1' } });
  });

  it('accepts comma-separated attendees and surfaces validation as 400', async () => {
    calendar.createEvent.mockRejectedValueOnce(new GoogleWorkspaceError(400, 'validation', '"summary" is required'));
    const res = await request(app).post('/api/google/calendar/events').send({ start: '2026-10-01', end: '2026-10-02', attendees: 'a@b.c, d@e.f' });
    expect(calendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({ summary: '', attendees: ['a@b.c', ' d@e.f'] }));
    expect(res.status).toBe(400);
  });
});
