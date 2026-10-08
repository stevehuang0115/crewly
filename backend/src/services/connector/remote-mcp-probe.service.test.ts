/**
 * Tests for the remote MCP "test" probe: JSON and SSE replies, session id,
 * pagination, and errors that never carry the URL.
 *
 * @module services/connector/remote-mcp-probe.service.test
 */

import { parseRpcBody, probeRemoteMcp, scrubUrl, type FetchLike } from './remote-mcp-probe.service.js';

const URL_ = 'https://crm-600.zohomcp.com/mcp/SECRETKEY123456/message';

interface Call { headers: Record<string, string>; body: Record<string, unknown> }

/**
 * A fake MCP server.
 *
 * @param respond - Reply per JSON-RPC method
 * @returns fetch and the recorded calls
 */
function fakeServer(respond: (method: string, body: Record<string, unknown>) => { status?: number; sse?: boolean; result?: unknown; error?: unknown; sid?: string } | null) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body ?? '{}');
    calls.push({ headers: init.headers, body });
    const r = respond(body.method, body);
    if (!r) return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
    const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(r.error ? { error: r.error } : { result: r.result }) });
    const headers: Record<string, string> = { 'content-type': r.sse ? 'text/event-stream' : 'application/json' };
    if (r.sid) headers['mcp-session-id'] = r.sid;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 300,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => (r.sse ? `event: message\ndata: ${payload}\n\n` : payload),
    };
  };
  return { fetchImpl, calls };
}

describe('probeRemoteMcp', () => {
  it('initializes, lists tools over SSE and carries the session id', async () => {
    const { fetchImpl, calls } = fakeServer((method, body) => {
      if (method === 'initialize') return { sse: true, sid: 'sess-1', result: { protocolVersion: '2025-03-26', serverInfo: { name: 'Zoho MCP' } } };
      if (method === 'notifications/initialized') return null;
      if (method === 'tools/list') {
        const cursor = (body.params as { cursor?: string }).cursor;
        return cursor
          ? { sse: true, result: { tools: [{ name: 'ZohoMail_sendMail' }] } }
          : { sse: true, result: { tools: [{ name: 'ZohoCRM_getRecords' }, { name: 'ZohoCRM_createRecords' }], nextCursor: 'p2' } };
      }
      return { status: 400 };
    });
    const result = await probeRemoteMcp({ url: URL_, headers: { 'X-Extra': 'v' } }, fetchImpl);
    expect(result).toEqual({ ok: true, serverName: 'Zoho MCP', toolCount: 3, tools: ['ZohoCRM_getRecords', 'ZohoCRM_createRecords', 'ZohoMail_sendMail'] });
    expect(calls.map((c) => c.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(calls[0].headers['Mcp-Session-Id']).toBeUndefined();
    expect(calls[2].headers['Mcp-Session-Id']).toBe('sess-1');
    expect(calls[2].headers['MCP-Protocol-Version']).toBe('2025-03-26');
    expect(calls[0].headers.Accept).toContain('text/event-stream');
    expect(calls[0].headers['X-Extra']).toBe('v');
  });

  it('accepts plain JSON replies', async () => {
    const { fetchImpl } = fakeServer((method) =>
      method === 'initialize' ? { result: {} } : method === 'tools/list' ? { result: { tools: [{ name: 'a' }] } } : null);
    expect(await probeRemoteMcp({ url: URL_ }, fetchImpl)).toEqual({ ok: true, toolCount: 1, tools: ['a'] });
  });

  it('explains a 401 without the URL', async () => {
    const { fetchImpl } = fakeServer(() => ({ status: 401 }));
    const result = await probeRemoteMcp({ url: URL_ }, fetchImpl);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('401');
    expect(JSON.stringify(result)).not.toContain('SECRETKEY');
  });

  it('flags a 401 with a Bearer challenge as needing OAuth', async () => {
    const challenge = 'Bearer resource_metadata="https://crm-600.zohomcp.com/.well-known/oauth-protected-resource"';
    const fetchImpl: FetchLike = async () => ({ status: 401, ok: false, headers: { get: (n: string) => (n.toLowerCase() === 'www-authenticate' ? challenge : null) }, text: async () => '' });
    const result = await probeRemoteMcp({ url: URL_ }, fetchImpl);
    expect(result).toEqual({ ok: false, error: 'The server wants you to sign in (OAuth).', needsAuth: true, wwwAuthenticate: challenge });
  });

  it('reports a JSON-RPC error and a non-MCP reply', async () => {
    const err = fakeServer((m) => (m === 'initialize' ? { error: { code: -32600, message: 'bad' } } : null));
    expect(await probeRemoteMcp({ url: URL_ }, err.fetchImpl)).toEqual({ ok: false, error: 'The server returned an error for initialize: bad' });
    const html: FetchLike = async () => ({ status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>' });
    expect((await probeRemoteMcp({ url: URL_ }, html)).ok).toBe(false);
  });

  it('scrubs the URL out of network errors', async () => {
    const boom: FetchLike = async () => {
      throw new TypeError(`fetch failed for ${URL_}`, { cause: new Error('connect ECONNREFUSED /mcp/SECRETKEY123456/message') });
    };
    const result = await probeRemoteMcp({ url: URL_ }, boom);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRETKEY');
  });

  it('reports a timeout plainly', async () => {
    const slow: FetchLike = async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    };
    expect(await probeRemoteMcp({ url: URL_ }, slow)).toEqual({ ok: false, error: 'The server did not answer in time.' });
  });
});

describe('helpers', () => {
  it('scrubUrl removes the URL, its path and long segments', () => {
    expect(scrubUrl(`x ${URL_} y`, URL_)).toBe('x (server URL) y');
    expect(scrubUrl('at /mcp/SECRETKEY123456/message', URL_)).not.toContain('SECRETKEY');
    expect(scrubUrl('SECRETKEY123456', URL_)).toBe('…');
  });

  it('parseRpcBody picks the reply with the matching id', () => {
    const sse = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"x":1}}\n\n';
    expect(parseRpcBody('text/event-stream', sse, 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { x: 1 } });
    expect(parseRpcBody('application/json', '[{"id":1,"result":{}}]', 1)).toEqual({ id: 1, result: {} });
    expect(parseRpcBody('application/json', 'nope', 1)).toBeUndefined();
  });
});
