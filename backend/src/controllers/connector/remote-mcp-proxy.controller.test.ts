/**
 * Tests for the agent → remote MCP proxy: agents only (403, never 401),
 * role allowlist, static headers + Bearer injection, refresh-and-retry on
 * 401, the owner-sign-in JSON-RPC error, and streamable-HTTP passthrough
 * (SSE body, Mcp-Session-Id both ways) against a real upstream server.
 *
 * @module controllers/connector/remote-mcp-proxy.controller.test
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import express, { type Application } from 'express';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { proxyRemoteMcp, rpcIdOf, setRemoteMcpProxyDeps, type ProxyDeps } from './remote-mcp-proxy.controller.js';
import type { RemoteMcpServer } from '../../services/connector/remote-mcp.service.js';

const logs: unknown[][] = [];
jest.mock('../../services/core/logger.service.js', () => {
  const log = (...args: unknown[]) => logs.push(args);
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: log, warn: log, debug: log, error: log }) }) } };
});
jest.mock('../../services/core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName: async (s: string) => (s === 'sales-1' ? { member: { role: 'sales' } } : s === 'dev-1' ? { member: { role: 'developer' } } : null) }) },
}));

/** Upstream MCP server double. */
let upstream: http.Server;
let upstreamUrl: string;
let seen: Array<{ method: string; headers: http.IncomingHttpHeaders; body: string }>;
let respond: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp/SECRETKEY123/message`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

let server: RemoteMcpServer;
let tokens: string[];
let oauth: boolean;
let allowed: boolean;
let auth: { usesOAuth: jest.Mock; getAccessToken: jest.Mock; onUnauthorized: jest.Mock; view: jest.Mock };
let app: Application;

beforeEach(() => {
  logs.length = 0;
  seen = [];
  respond = (_req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
    const id = (JSON.parse(body || '{}') as { id?: number }).id ?? null;
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
  };
  server = { id: 'zoho', label: 'Zoho', url: upstreamUrl, headers: { 'X-Static': 'static-value' }, createdAt: '' };
  tokens = ['AT-1'];
  oauth = true;
  allowed = true;
  auth = {
    usesOAuth: jest.fn(async () => oauth),
    getAccessToken: jest.fn(async () => tokens.shift() ?? null),
    onUnauthorized: jest.fn(async () => undefined),
    view: jest.fn(),
  };
  setRemoteMcpProxyDeps({
    servers: () => ({ get: async (id: string) => (id === 'zoho' ? server : undefined) }),
    auth: () => auth as unknown as ReturnType<ProxyDeps['auth']>,
    access: () => ({ isAllowed: async () => allowed, allowedRoles: async () => ['sales'] }),
    fetchImpl: (url, init) => fetch(url, init) as unknown as ReturnType<ProxyDeps['fetchImpl']>,
  });
  app = express();
  app.use(ownerUnlessAgentForTests);
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8'); } }));
  app.all('/api/connectors/remote-mcp/:id/mcp', proxyRemoteMcp);
});

const rpc = (body: unknown, session = 'dev-1') =>
  request(app).post('/api/connectors/remote-mcp/zoho/mcp').set('X-Agent-Session', session).set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').send(JSON.stringify(body));

it('refuses the owner and anonymous callers with 403 (never 401)', async () => {
  const res = await request(app).post('/api/connectors/remote-mcp/zoho/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.status).toBe(403);
  expect(seen).toHaveLength(0);
});

it('forwards with static headers and a Bearer token, passing Mcp-Session-Id both ways', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' }).set('Mcp-Session-Id', 'sess-0').set('MCP-Protocol-Version', '2025-03-26');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  expect(res.headers['mcp-session-id']).toBe('sess-1');
  expect(seen[0].headers['authorization']).toBe('Bearer AT-1');
  expect(seen[0].headers['x-static']).toBe('static-value');
  expect(seen[0].headers['mcp-session-id']).toBe('sess-0');
  expect(seen[0].headers['mcp-protocol-version']).toBe('2025-03-26');
  expect(seen[0].headers['x-agent-session']).toBeUndefined();
  expect(JSON.parse(seen[0].body)).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
});

it('enforces the role allowlist', async () => {
  allowed = false;
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.body.error.message).toContain('may not use Zoho');
  expect(seen).toHaveLength(0);
});

it('refreshes once on 401 and retries', async () => {
  tokens = ['AT-OLD', 'AT-NEW'];
  respond = (req, res, body) => {
    if (req.headers['authorization'] === 'Bearer AT-OLD') {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: {} }));
  };
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
  expect(res.body).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  expect(auth.getAccessToken).toHaveBeenLastCalledWith('zoho', { force: true });
  expect(seen.map((s) => s.headers['authorization'])).toEqual(['Bearer AT-OLD', 'Bearer AT-NEW']);
});

it('asks the owner to sign in when there is no token, answering a JSON-RPC error', async () => {
  tokens = [];
  const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'initialize' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32001 } });
  expect(res.body.error.message).toContain('sign in once');
  expect(auth.onUnauthorized).toHaveBeenCalledWith(server, 'dev-1');
  expect(seen).toHaveLength(0);
});

it('asks the owner when the refreshed token is refused too', async () => {
  tokens = ['AT-1', 'AT-2'];
  respond = (_req, res) => {
    res.writeHead(401);
    res.end();
  };
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.body.error.code).toBe(-32001);
  expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
});

it('streams an SSE response through', async () => {
  respond = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-sse' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
    setTimeout(() => {
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"done":true}}\n\n');
    }, 20);
  };
  const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call' }).buffer(true).parse((r, cb) => {
    let data = '';
    r.on('data', (c: Buffer) => (data += c.toString()));
    r.on('end', () => cb(null, data));
  });
  expect(res.headers['content-type']).toContain('text/event-stream');
  expect(res.headers['mcp-session-id']).toBe('sess-sse');
  expect(res.body).toContain('notifications/progress');
  expect(res.body).toContain('"done":true');
});

it('passes a GET (server-to-client stream) and a DELETE (end session)', async () => {
  tokens = ['AT-1', 'AT-1'];
  respond = (req, res) => {
    res.writeHead(req.method === 'GET' ? 405 : 204);
    res.end();
  };
  expect((await request(app).get('/api/connectors/remote-mcp/zoho/mcp').set('X-Agent-Session', 'dev-1')).status).toBe(405);
  expect((await request(app).delete('/api/connectors/remote-mcp/zoho/mcp').set('X-Agent-Session', 'dev-1').set('Mcp-Session-Id', 's')).status).toBe(204);
  expect(seen.map((s) => s.method)).toEqual(['GET', 'DELETE']);
});

it('works for a static-key server without a token', async () => {
  oauth = false;
  await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(seen[0].headers['authorization']).toBeUndefined();
  expect(auth.getAccessToken).not.toHaveBeenCalled();
});

it('answers 404 for an unknown server', async () => {
  const res = await request(app).post('/api/connectors/remote-mcp/nope/mcp').set('X-Agent-Session', 'dev-1').send({ jsonrpc: '2.0', id: 1, method: 'x' });
  expect(res.body.error.message).toContain('No such remote MCP server');
});

it('never logs the URL or a token', async () => {
  tokens = [];
  await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  tokens = ['AT-SECRET'];
  await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const logged = JSON.stringify(logs);
  expect(logged).not.toContain('SECRETKEY');
  expect(logged).not.toContain('AT-SECRET');
});

describe('rpcIdOf', () => {
  it('reads request ids and ignores notifications', () => {
    expect(rpcIdOf('{"id":3}')).toBe(3);
    expect(rpcIdOf('[{"id":"a"}]')).toBe('a');
    expect(rpcIdOf('{"method":"notifications/initialized"}')).toBeUndefined();
    expect(rpcIdOf('nope')).toBeUndefined();
  });
});
