/**
 * End-to-end integration test for the chat-v2 dispatch pipeline.
 *
 * Spins up a real HTTP server with a real Express app, attaches a real
 * ChatV2Gateway against that server's httpServer, connects a real WebSocket
 * client (`ws`), posts a user message through the REST API, and asserts
 * that both the user frame and the fake-agent's reply frame arrive on the
 * WS subscription.
 *
 * Uses an in-memory ChatV2Service when better-sqlite3 is available; skips
 * when the platform module cannot load (arm64/x86_64 mismatch on dev
 * machines). The dispatcher is wired to a fake agent sink that calls the
 * reply back through the same HTTP endpoint — this is the contract
 * Phase 1 ships with.
 *
 * @module websocket/chat-v2.gateway.integration.test
 */

import { AddressInfo } from 'net';
import http from 'http';
import express from 'express';
import WebSocket from 'ws';
import type { ChatV2Service } from '../services/chat-v2/chat-v2.service.js';
import type { ChatV2DispatcherService } from '../services/chat-v2/chat-v2.dispatcher.service.js';
import type { AgentMessageSink } from '../services/chat-v2/chat-v2.dispatcher.service.js';
import {
  setChatV2RealtimeDeps,
} from '../services/chat-v2/chat-v2.realtime-holder.js';

// Hoisted helper: skip the whole suite if the SQLite native addon cannot
// actually open a database (arm64/x86_64 mismatch on dev machines shows
// up at `new Database()` time, not `require()` time).
function canOpenNativeSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const describeIfNative = canOpenNativeSqlite() ? describe : describe.skip;

describeIfNative('chat-v2 end-to-end dispatch pipeline', () => {
  let server: http.Server;
  let baseUrl: string;
  let wsUrl: string;
  let service: ChatV2Service | null = null;
  let dispatcher: ChatV2DispatcherService | null = null;
  let gateway: import('./chat-v2.gateway.js').ChatV2Gateway | null = null;
  // Fake agent sink captures dispatches and triggers a reply back through HTTP.
  let agentSink: AgentMessageSink;
  let fakeAgentReplies: Array<{ channelId: string; content: string }> = [];

  /**
   * Wait until the gateway has registered the subscriber for `channelId`.
   * The client's `open` event fires as soon as the WS handshake completes,
   * but the server's `handleConnection` awaits `verifyToken` + `getChannel`
   * before it registers. Tests that POST immediately after `open` race
   * the registration; this helper closes that window.
   */
  async function waitForSubscriber(channelId: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (gateway && gateway.subscriberCount(channelId) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`subscriber never registered on channel ${channelId}`);
  }

  beforeAll(async () => {
    // Lazy imports so the module-load cost is only paid when the suite
    // actually runs (skipped suites should not drag the native module in).
    const { ChatV2Service } = await import('../services/chat-v2/chat-v2.service.js');
    const { openChatDatabase } = await import('../services/chat-v2/sqlite/chat-db.js');
    const { loadChatV2Config } = await import('../services/chat-v2/config.js');
    const { ChatV2Gateway, devAnonymousTokenVerifier } = await import('./chat-v2.gateway.js');
    const { ChatV2DispatcherService: DispatcherClass } = await import(
      '../services/chat-v2/chat-v2.dispatcher.service.js'
    );
    const { createChatV2Router } = await import('../controllers/chat-v2/chat-v2.routes.js');

    const db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    service = new ChatV2Service({
      config: loadChatV2Config({}),
      db,
      getPresence: () => ({ status: 'online', lastSeenAt: null }),
      now: () => Date.now(),
    });

    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatV2Router(service));

    server = http.createServer(app);

    // Construct the fake agent sink. When the dispatcher pushes a user
    // message to the agent, the sink parses the [CHAT:<id>] tag and
    // POSTs a canned reply back through the public HTTP endpoint with
    // X-Agent-Session set to the bound session. This is the exact flow
    // the real `reply-channel` skill will execute.
    agentSink = {
      async sendMessageToAgent(sessionName, message) {
        // Parse the channel id out of the dispatched prompt.
        const m = /\[CHAT:([^\]\s]+)\]/.exec(message);
        if (!m) return { success: false, error: 'no CHAT tag in dispatch' };
        const channelId = m[1];
        const replyBody = {
          content: `agent-reply: received "${message.split('\n')[2] ?? ''}"`,
          contentType: 'markdown',
          clientMessageId: `reply-${Date.now()}`,
        };
        // POST back — the controller sets senderType='agent' when it sees
        // X-Agent-Session matching the channel's agent_session.
        const port = (server.address() as AddressInfo).port;
        await new Promise<void>((resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: `/api/chat/channels/${channelId}/messages`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Agent-Session': sessionName,
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve());
            },
          );
          req.on('error', reject);
          req.write(JSON.stringify(replyBody));
          req.end();
        });
        fakeAgentReplies.push({ channelId, content: replyBody.content });
        return { success: true };
      },
    };

    dispatcher = new DispatcherClass({ agentSink });

    gateway = new ChatV2Gateway({
      service: service!,
      verifyToken: devAnonymousTokenVerifier,
    });
    gateway.attach(server);

    setChatV2RealtimeDeps({ gateway, dispatcher: dispatcher! });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsUrl = `ws://127.0.0.1:${addr.port}/ws/chat`;
  }, 30000);

  afterAll(async () => {
    setChatV2RealtimeDeps(null);
    try { service?.close(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  beforeEach(() => {
    fakeAgentReplies = [];
  });

  async function httpJson<T>(path: string, opts: { method?: string; body?: unknown; agentHeader?: string } = {}): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const payload = opts.body ? JSON.stringify(opts.body) : undefined;
      const url = new URL(path, baseUrl);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: opts.method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
            ...(opts.agentHeader ? { 'X-Agent-Session': opts.agentHeader } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as T) : (undefined as unknown as T) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: text as unknown as T });
            }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('happy path: POST /messages → user WS frame + agent WS frame', async () => {
    // 1. Create a channel bound to a fake agent session.
    const createResp = await httpJson<{
      success: true;
      data: { id: string; agentSession: string };
    }>('/api/chat/channels', {
      method: 'POST',
      body: { agentSession: 'fake-agent-1', name: 'E2E Chat' },
    });
    expect(createResp.status).toBe(201);
    const channelId = createResp.body.data.id;

    // 2. Open a WS subscription.
    const ws = new WebSocket(`${wsUrl}?channelId=${encodeURIComponent(channelId)}`);
    const frames: unknown[] = [];
    const framesReady = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        frames.push(parsed);
        // Two message frames (user + agent) = we're done
        if (frames.filter((f) => (f as { type: string }).type === 'message').length >= 2) {
          resolve();
        }
      });
      ws.on('error', () => resolve()); // don't hang on failure
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Server-side registration is async (awaits verifyToken + getChannel).
    // The client's 'open' fires on handshake, before registerSubscriber
    // runs — wait for the subscriber to actually be in the gateway's map.
    await waitForSubscriber(channelId);

    // 3. Post the user message.
    const sendResp = await httpJson<{
      success: true;
      data: { id: string; senderType: string; content: string; metadata?: { clientMessageId?: string } };
    }>(`/api/chat/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: 'hello agent', clientMessageId: 'cmid-user-1' },
    });
    expect(sendResp.status).toBe(201);
    expect(sendResp.body.data.senderType).toBe('user');
    expect(sendResp.body.data.metadata?.clientMessageId).toBe('cmid-user-1');

    // 4. Wait up to 2s for both WS frames.
    await Promise.race([
      framesReady,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    // 5. Assertions
    const messageFrames = frames.filter((f) => (f as { type: string }).type === 'message') as Array<{
      type: 'message';
      payload: { channelId: string; message: { senderType: string; content: string } };
    }>;
    expect(messageFrames.length).toBeGreaterThanOrEqual(2);
    expect(messageFrames[0].payload.message.senderType).toBe('user');
    expect(messageFrames[0].payload.message.content).toBe('hello agent');
    expect(messageFrames[1].payload.message.senderType).toBe('agent');
    expect(messageFrames[1].payload.message.content).toContain('agent-reply');
    // Dispatcher recorded its side of the fake-agent call
    expect(fakeAgentReplies).toHaveLength(1);
    expect(fakeAgentReplies[0].channelId).toBe(channelId);

    ws.close();
  }, 15000);

  it('ping / pong round-trip over real socket', async () => {
    const createResp = await httpJson<{
      success: true;
      data: { id: string };
    }>('/api/chat/channels', {
      method: 'POST',
      body: { agentSession: 'fake-agent-2', name: 'Ping Test' },
    });
    const channelId = createResp.body.data.id;

    const ws = new WebSocket(`${wsUrl}?channelId=${encodeURIComponent(channelId)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await waitForSubscriber(channelId);

    const pong = await new Promise<unknown>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ type: 'ping', ts: 12345 }));
    });

    expect(pong).toEqual({ type: 'pong', ts: 12345 });
    ws.close();
  }, 15000);
});
