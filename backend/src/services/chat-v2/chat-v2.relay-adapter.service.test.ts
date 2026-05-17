/**
 * Tests for ChatV2RelayAdapter — the bridge between local chat-v2 and the
 * Cloud relay queue used by Cloud Portal.
 *
 * @module services/chat-v2/chat-v2.relay-adapter.service.test
 */

import { EventEmitter } from 'events';
import { ChatV2Service } from './chat-v2.service.js';
import { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
import { loadChatV2Config } from './config.js';
import { ChatV2RelayAdapter } from './chat-v2.relay-adapter.service.js';
import type {
  ICloudSyncLike,
  IChatV2GatewayLike,
  IChatV2DispatcherLike,
} from './chat-v2.relay-adapter.service.js';
import type {
  IAgentDirectoryProvider,
  IAgentPresenceProvider,
} from '../../controllers/chat-v2/chat-v2.controller.js';
import type {
  ChatRequestPayload,
  ChatResponsePayload,
  ChatEventPayload,
  IncomingMessage,
} from '../cloud/cloud-sync.types.js';

/** Build an in-memory chat-v2 service with the same config the live server uses. */
function makeService(): { db: ChatDatabase; service: ChatV2Service } {
  const db = openChatDatabase({
    dbPath: ':memory:',
    inMemory: true,
    skipIntegrityCheck: true,
  });
  const service = new ChatV2Service({
    config: loadChatV2Config({}),
    db,
    getPresence: () => ({ status: 'online', lastSeenAt: 111 }),
    now: () => 1_000,
  });
  return { db, service };
}

/** Fake CloudSyncService — captures sendMessage calls and replays IncomingMessages. */
class FakeCloudSync extends EventEmitter implements ICloudSyncLike {
  public outbound: Array<{
    to: string;
    type: 'chat_response' | 'chat_event';
    payload: unknown;
  }> = [];
  public sendShouldThrow: Error | null = null;

  async sendMessage(
    toDeviceId: string,
    type: 'chat_response' | 'chat_event',
    payload: unknown,
  ): Promise<void> {
    if (this.sendShouldThrow) throw this.sendShouldThrow;
    this.outbound.push({ to: toDeviceId, type, payload });
  }

  emitInbound(msg: IncomingMessage): void {
    this.emit('message', msg);
  }
}

/**
 * Fake ChatV2Dispatcher — records dispatchMessage calls and (optionally)
 * rejects them. Lets tests assert that Portal-sourced sendMessage RPCs
 * actually wake the bound agent in addition to persisting.
 */
class FakeDispatcher implements IChatV2DispatcherLike {
  public calls: Array<{ channel: unknown; message: unknown }> = [];
  public rejectWith: Error | null = null;

  async dispatchMessage(channel: unknown, message: unknown): Promise<unknown> {
    this.calls.push({ channel, message });
    if (this.rejectWith) throw this.rejectWith;
    return undefined;
  }
}

/** Fake gateway — captures broadcast listeners so tests can fire events manually. */
class FakeGateway implements IChatV2GatewayLike {
  public listeners: Array<(channelId: string, event: unknown) => void> = [];
  onBroadcast(
    listener: (channelId: string, event: unknown) => void,
  ): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  fire(channelId: string, event: unknown): void {
    for (const l of this.listeners) l(channelId, event);
  }
}

/** Helper — build a chat_request IncomingMessage envelope. */
function buildRequestMsg(
  fromDevice: string,
  req: ChatRequestPayload,
): IncomingMessage {
  return {
    id: `msg-${req.id}`,
    from: fromDevice,
    fromDeviceName: `Portal-${fromDevice}`,
    type: 'chat_request',
    payload: req,
    encrypted: false,
    sentAt: new Date(0).toISOString(),
  };
}

/**
 * Wait one tick for the adapter's fire-and-forget reply chain. The adapter
 * awaits ChatV2Service (sync) but then awaits cloudSync.sendMessage which
 * is async — so we need to let microtasks drain before asserting outbound.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const directoryFixture: Awaited<
  ReturnType<IAgentDirectoryProvider['getTeams']>
> = [
  {
    id: 'orchestrator',
    name: 'Orchestrator Team',
    members: [
      {
        sessionName: 'crewly-orc',
        name: 'Orchestrator',
        role: 'orchestrator',
        agentStatus: 'active',
        workingStatus: 'idle',
      },
    ],
  },
];

const directory: IAgentDirectoryProvider = {
  async getTeams() {
    return directoryFixture;
  },
};
const presence: IAgentPresenceProvider = {
  async getPresence(agentSession: string) {
    return { agentSession, status: 'online', lastSeenAt: 9_000 };
  },
};

describe('ChatV2RelayAdapter', () => {
  let db: ChatDatabase;
  let service: ChatV2Service;
  let cloudSync: FakeCloudSync;
  let gateway: FakeGateway;
  let adapter: ChatV2RelayAdapter;

  beforeEach(() => {
    ({ db, service } = makeService());
    cloudSync = new FakeCloudSync();
    gateway = new FakeGateway();
    adapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      directory,
      presence,
      now: () => 10_000,
      portalIdleTtlMs: 60_000,
    });
    adapter.start();
  });

  afterEach(() => {
    adapter.stop();
    service.close();
    void db;
  });

  // -------------------------------------------------------------------------
  // RPC dispatch — happy paths
  // -------------------------------------------------------------------------

  it('listChannels returns an empty list on a fresh DB and replies via chat_response', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-1', { id: 'r-1', method: 'listChannels' }),
    );
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(1);
    const reply = cloudSync.outbound[0];
    expect(reply.to).toBe('portal-1');
    expect(reply.type).toBe('chat_response');
    const r = reply.payload as ChatResponsePayload;
    expect(r.id).toBe('r-1');
    expect(r.error).toBeUndefined();
    expect((r.result as { channels: unknown[] }).channels).toEqual([]);
  });

  it('ensureDmChannel creates a channel and replies with the DTO', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-2', {
        id: 'r-2',
        method: 'ensureDmChannel',
        params: { agentSession: 'crewly-orc', name: 'Orchestrator' },
      }),
    );
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(1);
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.id).toBe('r-2');
    expect(r.error).toBeUndefined();
    const ch = r.result as { agentSession: string; type: string; name: string };
    expect(ch.agentSession).toBe('crewly-orc');
    expect(ch.type).toBe('dm');
    expect(ch.name).toBe('Orchestrator');
  });

  it('sendMessage persists + replies with the canonical message DTO', async () => {
    // Pre-create the channel so sendMessage can target it.
    const ensure = service.ensureDmChannel({
      agentSession: 'crewly-orc',
      name: 'Orc',
      principal: { userId: 'dev-user-001', source: 'oss' },
    });

    cloudSync.emitInbound(
      buildRequestMsg('portal-3', {
        id: 'r-3',
        method: 'sendMessage',
        params: {
          channelId: ensure.channel.id,
          content: 'hello relay',
          clientMessageId: 'cmid-relay-1',
        },
      }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.error).toBeUndefined();
    const msg = r.result as { senderType: string; content: string };
    expect(msg.senderType).toBe('user');
    expect(msg.content).toBe('hello relay');
  });

  // ---------------------------------------------------------------------------
  // 2026-05-17 dispatcher-wiring: Portal-sourced user `sendMessage` RPCs must
  // also fire the ChatV2Dispatcher so the bound agent's PTY receives the
  // `[CHAT:<id>]` prompt. Without this, Portal-sent messages persisted but
  // agents never reacted (silent regression).
  // ---------------------------------------------------------------------------

  it('sendMessage fires the dispatcher on a Portal-sourced user message', async () => {
    adapter.stop();
    const dispatcher = new FakeDispatcher();
    const dispatchAdapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      dispatcher,
      directory,
      presence,
      now: () => 10_000,
      portalIdleTtlMs: 60_000,
    });
    dispatchAdapter.start();

    const ensure = service.ensureDmChannel({
      agentSession: 'crewly-orc',
      name: 'Orc',
      principal: { userId: 'dev-user-001', source: 'oss' },
    });

    cloudSync.emitInbound(
      buildRequestMsg('portal-dispatch', {
        id: 'r-dispatch',
        method: 'sendMessage',
        params: {
          channelId: ensure.channel.id,
          content: 'wake the agent',
          clientMessageId: 'cmid-dispatch',
        },
      }),
    );
    await flushMicrotasks();

    expect(dispatcher.calls).toHaveLength(1);
    const dispatched = dispatcher.calls[0].message as {
      senderType: string;
      content: string;
      channelId: string;
    };
    expect(dispatched.senderType).toBe('user');
    expect(dispatched.content).toBe('wake the agent');
    expect(dispatched.channelId).toBe(ensure.channel.id);

    dispatchAdapter.stop();
  });

  it('sendMessage skips dispatcher when none is wired (back-compat)', async () => {
    // Default adapter from beforeEach has no dispatcher — assert that a
    // Portal sendMessage still persists + replies without throwing.
    const ensure = service.ensureDmChannel({
      agentSession: 'crewly-orc',
      name: 'Orc',
      principal: { userId: 'dev-user-001', source: 'oss' },
    });

    cloudSync.emitInbound(
      buildRequestMsg('portal-nodisp', {
        id: 'r-nodisp',
        method: 'sendMessage',
        params: {
          channelId: ensure.channel.id,
          content: 'no dispatcher path',
          clientMessageId: 'cmid-nodisp',
        },
      }),
    );
    await flushMicrotasks();

    const reply = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { content: string }).content).toBe(
      'no dispatcher path',
    );
  });

  it('sendMessage swallows dispatcher rejection so the RPC still replies', async () => {
    adapter.stop();
    const dispatcher = new FakeDispatcher();
    dispatcher.rejectWith = new Error('agent PTY closed');
    const dispatchAdapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      dispatcher,
      directory,
      presence,
      now: () => 10_000,
      portalIdleTtlMs: 60_000,
    });
    dispatchAdapter.start();

    const ensure = service.ensureDmChannel({
      agentSession: 'crewly-orc',
      name: 'Orc',
      principal: { userId: 'dev-user-001', source: 'oss' },
    });

    cloudSync.emitInbound(
      buildRequestMsg('portal-rej', {
        id: 'r-rej',
        method: 'sendMessage',
        params: {
          channelId: ensure.channel.id,
          content: 'dispatch will fail',
          clientMessageId: 'cmid-rej',
        },
      }),
    );
    await flushMicrotasks();

    // RPC reply must still land — dispatch is fire-and-forget.
    const reply = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(reply.error).toBeUndefined();
    expect((reply.result as { content: string }).content).toBe(
      'dispatch will fail',
    );
    expect(dispatcher.calls).toHaveLength(1);

    dispatchAdapter.stop();
  });

  it('listAgents flattens the directory provider result', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-4', { id: 'r-4', method: 'listAgents' }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    const agents = (r.result as { agents: Array<{ agentSession: string }> })
      .agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].agentSession).toBe('crewly-orc');
  });

  it('getAgentPresence forwards to the presence provider', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-5', {
        id: 'r-5',
        method: 'getAgentPresence',
        params: { agentId: 'crewly-orc' },
      }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.result).toEqual({
      agentSession: 'crewly-orc',
      status: 'online',
      lastSeenAt: 9_000,
    });
  });

  // -------------------------------------------------------------------------
  // RPC dispatch — error paths
  // -------------------------------------------------------------------------

  it('returns an unsupported_method error envelope for unknown methods', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-6', {
        id: 'r-6',
        // Cast through unknown so the test can exercise the runtime check.
        method: 'deleteEverything' as unknown as ChatRequestPayload['method'],
      }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe('validation_error');
    expect(r.error?.message).toMatch(/unsupported_method/);
  });

  it('returns directory_unavailable when listAgents is called without a directory provider', async () => {
    adapter.stop();
    const noDirAdapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      now: () => 10_000,
    });
    noDirAdapter.start();
    cloudSync.emitInbound(
      buildRequestMsg('portal-7', { id: 'r-7', method: 'listAgents' }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.error?.message).toMatch(/directory_unavailable/);
    noDirAdapter.stop();
  });

  it('propagates ChatError details verbatim through the error envelope', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-8', {
        id: 'r-8',
        method: 'sendMessage',
        params: { channelId: 'does-not-exist', content: 'x' },
      }),
    );
    await flushMicrotasks();
    const r = cloudSync.outbound[0].payload as ChatResponsePayload;
    expect(r.error).toBeDefined();
    // The exact code depends on ChatV2Service; either channel_not_found
    // or validation_error are acceptable here — what we're asserting is
    // that a structured envelope IS returned (no hang, no internal
    // throw) so Portal can render an error.
    expect(typeof r.error?.code).toBe('string');
    expect(typeof r.error?.message).toBe('string');
  });

  it('drops chat_request messages with malformed payloads (no response)', async () => {
    cloudSync.emitInbound({
      id: 'm-bad',
      from: 'portal-9',
      fromDeviceName: 'Portal-9',
      type: 'chat_request',
      payload: { /* missing id + method */ },
      encrypted: false,
      sentAt: '',
    });
    await flushMicrotasks();
    // No reply because we can't correlate without an id.
    expect(cloudSync.outbound).toHaveLength(0);
  });

  it('ignores non-chat_request inbound messages', async () => {
    cloudSync.emitInbound({
      id: 'm-misc',
      from: 'portal-10',
      fromDeviceName: 'Portal-10',
      type: 'notification',
      payload: { title: 'hi', message: 'hi', urgency: 'low' },
      encrypted: false,
      sentAt: '',
    });
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Outbound broadcast fan-out
  // -------------------------------------------------------------------------

  it('forwards gateway broadcasts to every known Portal device', async () => {
    // Register two portals via chat_request.
    cloudSync.emitInbound(
      buildRequestMsg('portal-A', { id: 'r-a', method: 'listChannels' }),
    );
    cloudSync.emitInbound(
      buildRequestMsg('portal-B', { id: 'r-b', method: 'listChannels' }),
    );
    await flushMicrotasks();
    cloudSync.outbound.length = 0;

    gateway.fire('c-xyz', { type: 'message', payload: { channelId: 'c-xyz', message: { id: 'm-1' } } });
    await flushMicrotasks();

    expect(cloudSync.outbound).toHaveLength(2);
    for (const out of cloudSync.outbound) {
      expect(out.type).toBe('chat_event');
      const evt = out.payload as ChatEventPayload;
      expect(evt.channelId).toBe('c-xyz');
    }
    const recipients = cloudSync.outbound.map((o) => o.to).sort();
    expect(recipients).toEqual(['portal-A', 'portal-B']);
  });

  it('does not forward broadcasts when no Portal has registered', () => {
    gateway.fire('c-empty', { type: 'message', payload: {} });
    expect(cloudSync.outbound).toHaveLength(0);
  });

  it('evicts a Portal device after idle TTL passes (next broadcast skips it)', async () => {
    // Stop the default adapter so the TTL adapter is the sole listener
    // for both inbound chat_requests and gateway broadcasts.
    adapter.stop();
    let nowMs = 10_000;
    const ttlAdapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      now: () => nowMs,
      portalIdleTtlMs: 5_000,
    });
    ttlAdapter.start();

    cloudSync.emitInbound(
      buildRequestMsg('portal-stale', { id: 'r-stale', method: 'listChannels' }),
    );
    await flushMicrotasks();
    cloudSync.outbound.length = 0;
    expect(ttlAdapter.knownPortalCount()).toBe(1);

    // Advance past the TTL.
    nowMs = 10_000 + 6_000;
    expect(ttlAdapter.knownPortalCount()).toBe(0);

    gateway.fire('c-after-evict', { type: 'message', payload: {} });
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(0);

    ttlAdapter.stop();
  });

  it('keeps forwarding to a Portal that re-pings before TTL', async () => {
    adapter.stop();
    let nowMs = 10_000;
    const ttlAdapter = new ChatV2RelayAdapter({
      service,
      gateway,
      cloudSync,
      now: () => nowMs,
      portalIdleTtlMs: 5_000,
    });
    ttlAdapter.start();

    cloudSync.emitInbound(
      buildRequestMsg('portal-fresh', { id: 'r-1', method: 'listChannels' }),
    );
    await flushMicrotasks();
    cloudSync.outbound.length = 0;

    // Half the TTL in, ping again — last-seen resets.
    nowMs = 10_000 + 2_500;
    cloudSync.emitInbound(
      buildRequestMsg('portal-fresh', { id: 'r-2', method: 'listChannels' }),
    );
    await flushMicrotasks();
    cloudSync.outbound.length = 0;

    // Original TTL (5s from first ping) elapses, but Portal stays known
    // because the second ping reset the clock.
    nowMs = 10_000 + 6_000;
    expect(ttlAdapter.knownPortalCount()).toBe(1);
    gateway.fire('c-keep-alive', { type: 'message', payload: {} });
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(1);
    expect(cloudSync.outbound[0].to).toBe('portal-fresh');

    ttlAdapter.stop();
  });

  it('survives a chat_event sendMessage failure without breaking subsequent broadcasts', async () => {
    cloudSync.emitInbound(
      buildRequestMsg('portal-err', { id: 'r-1', method: 'listChannels' }),
    );
    await flushMicrotasks();
    cloudSync.outbound.length = 0;

    cloudSync.sendShouldThrow = new Error('relay down');
    gateway.fire('c-1', { type: 'message', payload: {} });
    await flushMicrotasks();
    // First broadcast failed; sendShouldThrow consumed (we'll only fail
    // once to confirm we don't crash) — clear and try again.
    cloudSync.sendShouldThrow = null;
    gateway.fire('c-2', { type: 'message', payload: {} });
    await flushMicrotasks();
    // Second broadcast lands.
    expect(cloudSync.outbound).toHaveLength(1);
    const evt = cloudSync.outbound[0].payload as ChatEventPayload;
    expect(evt.channelId).toBe('c-2');
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it('start is idempotent — calling twice does not double-subscribe', async () => {
    adapter.start(); // already started in beforeEach
    cloudSync.emitInbound(
      buildRequestMsg('portal-once', { id: 'r-1', method: 'listChannels' }),
    );
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(1);
  });

  it('stop detaches both listeners', async () => {
    adapter.stop();
    cloudSync.emitInbound(
      buildRequestMsg('portal-stopped', { id: 'r-1', method: 'listChannels' }),
    );
    await flushMicrotasks();
    expect(cloudSync.outbound).toHaveLength(0);
    gateway.fire('c-after-stop', { type: 'message', payload: {} });
    expect(cloudSync.outbound).toHaveLength(0);
  });
});
