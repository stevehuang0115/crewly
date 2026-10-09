/**
 * Tests for the machine side of Drive mode: a push is verified by fetching
 * from Cloud with this machine's token; the owner's words reach the agent
 * (agent DM, team lead, team channel thread) with the reply note; `reply
 * --drive` goes to Cloud (not Slack); a plain reply is picked up; recall
 * answers from chat-v2; the end asks for one recap each and the recap closes
 * the conversation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IncomingMessage } from '../cloud/cloud-sync.types.js';
import { DriveConversationStore } from './drive-conversation.store.js';
import { DriveKeepWarm } from './drive-keep-warm.js';
import { DriveAgentService, driveCapabilities, ownerTurnText, pickConversation, recapRequest, type DriveAgentDeps } from './drive-agent.service.js';

const SID = 'drv_abcdefghijkl';
const NOW = new Date('2026-10-08T10:00:00.000Z');

interface CloudCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
}

function harness(cloudData: Record<string, unknown> = {}, extra: Partial<DriveAgentDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-agent-'));
  const calls: CloudCall[] = [];
  const delivered: Array<Record<string, unknown>> = [];
  const recorded: Array<Record<string, unknown>> = [];
  const notes: Array<{ session: string; text: string }> = [];
  const recaps: Array<{ text: string; nextStep: boolean; channelId: string }> = [];
  const closed: Array<[string, string]> = [];
  let clock = NOW.getTime();
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: String(init.method), url, body, auth: (init.headers as Record<string, string>)?.Authorization });
    const key = Object.keys(cloudData).find((k) => url.includes(k));
    const data = key ? cloudData[key] : { ok: true };
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const deps: DriveAgentDeps = {
    cloud: { getToken: () => 'machine-token', getCloudUrl: () => 'https://api.crewlyai.com/' },
    identity: async () => ({ instanceId: 'mac' }),
    deliverOwnerTurn: async (input) => {
      delivered.push(input as unknown as Record<string, unknown>);
      if (input.kind === 'channel') return { channelId: 'huddle-ce', threadId: input.threadId ?? 'root-1' };
      return { channelId: `dm-${input.agentSession}` };
    },
    recordAgentTurn: async (input) => {
      recorded.push(input as unknown as Record<string, unknown>);
    },
    notifyAgent: async (session, text) => {
      notes.push({ session, text });
      return true;
    },
    postRecap: async ({ conversation, text, nextStep }) => {
      recaps.push({ text, nextStep, channelId: conversation.channelId });
      return { where: 'slack-dm' };
    },
    ownerFeed: async () => ({
      messages: [
        { id: 'm1', channelId: 'dm-ella', channelType: 'dm', channelName: 'Ella', senderType: 'agent', senderId: 'ella', senderKind: 'agent', agentSession: 'ella', content: 'The newsletter is ready.', createdAt: NOW.getTime() - 1000 },
        { id: 'm2', channelId: 'dm-ella', channelType: 'dm', channelName: 'Ella', senderType: 'agent', senderId: 'ella', senderKind: 'agent', agentSession: 'ella', content: 'Banner done.', createdAt: NOW.getTime() - 500 },
      ],
      ownerTurns: [],
    }),
    closeTracking: (agent, channel) => closed.push([agent, channel]),
    store: new DriveConversationStore(path.join(dir, 'conv.json')),
    fetchImpl,
    now: () => new Date(clock),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
    ...extra,
  };
  const service = new DriveAgentService(deps);
  return { service, calls, delivered, recorded, notes, recaps, closed, dir, tick: (ms: number) => (clock += ms) };
}

function push(payload: Record<string, unknown>): IncomingMessage {
  return { id: 'r1', from: 'cloud', fromDeviceName: 'crewly-cloud', type: 'talk_message', payload, encrypted: false } as unknown as IncomingMessage;
}

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  sessionId: SID,
  conversationId: 'c1',
  text: '把周报发了吗？',
  target: { kind: 'agent', name: 'Ella', agentSession: 'ella' },
  ...over,
});

describe('pushes', () => {
  it('a deliver push is fetched from Cloud with the machine token, then delivered with the Drive note', async () => {
    const h = harness({ '/machine/deliveries/d1': delivery() });
    expect(await h.service.handle(push({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'mac' }))).toBe('done');
    expect(h.calls[0]).toMatchObject({ method: 'GET', url: `https://api.crewlyai.com/api/cloud/talk/session/${SID}/machine/deliveries/d1?instanceId=mac`, auth: 'Bearer machine-token' });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ kind: 'agent', agentSession: 'ella' });
    expect(String(h.delivered[0].text)).toContain(`reply --drive ${SID}`);
    expect(String(h.delivered[0].text)).toContain('把周报发了吗？');
    expect(String(h.delivered[0].text)).toContain('Not in Slack');
  });

  it('ignores Talk payloads, other machines and malformed pushes', async () => {
    const h = harness();
    expect(await h.service.handle(push({ v: 1, messageId: 'm1' }))).toBe('ignored');
    expect(await h.service.handle(push({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'air' }))).toBe('ignored');
    expect(await h.service.handle({ type: 'slack_event' } as unknown as IncomingMessage)).toBe('ignored');
    expect(h.calls).toEqual([]);
  });

  it('a second turn to a channel continues its thread', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery({ target: { kind: 'channel', name: '#ce', agentSession: 'owen', slackChannelId: 'C_CE', members: ['owen', 'vera'] } }) as never);
    await h.service.deliverFetched(delivery({ id: 'd2', text: 'and?', target: { kind: 'channel', name: '#ce', agentSession: 'owen', slackChannelId: 'C_CE' } }) as never);
    expect(h.delivered[0]).toMatchObject({ kind: 'channel', slackChannelId: 'C_CE' });
    expect(h.delivered[1]).toMatchObject({ channelId: 'huddle-ce', threadId: 'root-1' });
  });

  it('capability is advertised only while running', () => {
    const h = harness();
    h.service.start();
    expect(driveCapabilities()).toEqual(['drive_message']);
    h.service.stop();
    expect(driveCapabilities()).toEqual([]);
  });
});

describe('reply --drive', () => {
  it('records the answer (kept off Slack by the row mark) and sends it to Cloud', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery() as never);
    h.tick(1000);
    expect(await h.service.agentReply('ella', SID, { text: '发了，十点发的。', interim: false, recap: false })).toEqual({ conversationId: 'c1', closed: false });
    expect(h.recorded).toEqual([expect.objectContaining({ agentSession: 'ella', channelId: 'dm-ella', text: '发了，十点发的。', sessionId: SID })]);
    const post = h.calls.find((c) => c.method === 'POST');
    expect(post).toMatchObject({ url: `https://api.crewlyai.com/api/cloud/talk/session/${SID}/replies`, body: { instanceId: 'mac', conversationId: 'c1', agentSession: 'ella', text: '发了，十点发的。' } });
  });

  it('refuses a reply with no conversation, a bad session id or empty text', async () => {
    const h = harness();
    await expect(h.service.agentReply('ella', SID, { text: 'x', interim: false, recap: false })).rejects.toMatchObject({ status: 404 });
    await expect(h.service.agentReply('ella', 'nope', { text: 'x', interim: false, recap: false })).rejects.toMatchObject({ status: 400 });
    await h.service.deliverFetched(delivery() as never);
    await expect(h.service.agentReply('ella', SID, { text: '  ', interim: false, recap: false })).rejects.toMatchObject({ status: 400 });
  });

  it('a team member may answer the team conversation', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery({ target: { kind: 'team', name: 'CE', agentSession: 'owen', members: ['owen', 'vera'] } }) as never);
    expect(String(h.delivered[0].text)).toContain('for the CE team');
    h.tick(1000);
    expect((await h.service.agentReply('vera', SID, { text: 'Vera here: done.', interim: false, recap: false })).conversationId).toBe('c1');
  });

  it('a plain reply in a waiting conversation still reaches the phone, once', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery() as never);
    h.tick(1000);
    const dto = { id: 'x', channelId: 'dm-ella', senderType: 'agent', senderId: 'ella', content: 'Plain answer.', createdAt: NOW.getTime() + 1000 };
    await h.service.noteChatTurn(dto);
    await h.service.noteChatTurn({ ...dto, id: 'y' });
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.body?.text)).toEqual(['Plain answer.']);
    // Drive rows (reply --drive) and owner turns are never picked up again.
    await h.service.noteChatTurn({ ...dto, id: 'z', metadata: { via: 'drive-mode' } });
    await h.service.noteChatTurn({ ...dto, id: 'w', senderType: 'user' });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('recall', () => {
  it('answers Cloud with the agent\'s recent messages, best match first', async () => {
    const h = harness({ '/machine/recalls/r1': { agentSessions: ['ella'], hint: 'newsletter' } });
    expect(await h.service.handle(push({ v: 1, kind: 'drive', op: 'recall', sessionId: SID, id: 'r1', instanceId: 'mac' }))).toBe('done');
    const post = h.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(`https://api.crewlyai.com/api/cloud/talk/session/${SID}/machine/recalls/r1`);
    expect(post?.body).toEqual({ instanceId: 'mac', messages: [expect.objectContaining({ agentSession: 'ella', where: 'your DM', text: 'The newsletter is ready.' })] });
  });
});

describe('end and recap', () => {
  it('asks each open conversation once for a recap; the recap posts, reports to Cloud and closes', async () => {
    const h = harness({ '/machine/state': { ended: true, conversations: [{ conversationId: 'c1', agentSession: 'ella' }] } });
    await h.service.deliverFetched(delivery() as never);
    await h.service.handle(push({ v: 1, kind: 'drive', op: 'end', sessionId: SID, instanceId: 'mac' }));
    await h.service.handle(push({ v: 1, kind: 'drive', op: 'end', sessionId: SID, instanceId: 'mac' }));
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].session).toBe('ella');
    expect(h.notes[0].text).toContain(`reply --drive ${SID} --recap`);
    expect(h.notes[0].text).toContain('Owner: 把周报发了吗？');

    const out = await h.service.agentReply('ella', SID, { text: 'Drive mode recap — you asked about the report; I sent it at 10; next: nothing pending.', interim: false, recap: true });
    expect(out).toEqual({ conversationId: 'c1', closed: true });
    expect(h.recaps).toEqual([{ text: expect.stringContaining('Drive mode recap'), nextStep: false, channelId: 'dm-ella' }]);
    expect(h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/replies'))?.body).toMatchObject({ recap: true, nextStep: false });
    expect(h.closed).toEqual([['ella', 'dm-ella']]);
    // Closed: no more replies to it.
    await expect(h.service.agentReply('ella', SID, { text: 'more', interim: false, recap: false })).rejects.toMatchObject({ status: 404 });
  });

  it('a recap naming a next step keeps it tracked (nextStep true)', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery() as never);
    await h.service.agentReply('ella', SID, { text: 'Drive mode recap — next: I send the draft by 3 pm.', interim: false, recap: true });
    expect(h.recaps[0].nextStep).toBe(true);
  });
});

describe('v3: two-phase replies', () => {
  it('the delivered words ask for an ack within seconds, then the result (conclusion first, ≤3 sentences, options, no URLs)', () => {
    const text = ownerTurnText(SID, 'agent', 'Ella', '周报发了吗？');
    expect(text).toContain(`reply --drive ${SID} --ack`);
    expect(text).toMatch(/Within seconds, before any other work/);
    expect(text).toMatch(/conclusion first, at most 3 short spoken sentences/);
    expect(text).toMatch(/2–3 options/);
    expect(text).toMatch(/No URLs/);
    expect(text.endsWith('周报发了吗？')).toBe(true);
  });

  it('reply --drive --ack goes to Cloud as an interim ack; the full answer follows as a final reply', async () => {
    const h = harness();
    await h.service.deliverFetched(delivery() as never);
    await h.service.agentReply('ella', SID, { text: 'On it — five minutes.', interim: false, recap: false, ack: true });
    await h.service.agentReply('ella', SID, { text: 'Sent at ten, 1,200 readers.', interim: false, recap: false });
    const posts = h.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/replies')).map((c) => c.body);
    expect(posts[0]).toMatchObject({ text: 'On it — five minutes.', interim: true, ack: true });
    expect(posts[1]).toMatchObject({ text: 'Sent at ten, 1,200 readers.' });
    expect(posts[1]).not.toHaveProperty('ack');
    expect(h.recorded[0]).toMatchObject({ interim: true });
  });
});

describe('v3: keep-warm', () => {
  it('a warm push reads the list from Cloud, keeps those agents warm and pre-starts the new ones once; the end clears it', async () => {
    const keepWarm = new DriveKeepWarm(() => NOW.getTime());
    const prestarted: string[] = [];
    const until = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    const h = harness({ '/machine/state': { ended: false, conversations: [], warm: ['ella', 'owen'], warmUntil: until } }, { keepWarm, prestart: async (s) => void prestarted.push(s) });
    expect(await h.service.handle(push({ v: 1, kind: 'drive', op: 'warm', sessionId: SID, instanceId: 'mac' }))).toBe('done');
    expect(h.calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining(`/${SID}/machine/state?instanceId=mac`), auth: 'Bearer machine-token' });
    expect(keepWarm.warmAgents().sort()).toEqual(['ella', 'owen']);
    expect(prestarted).toEqual(['ella', 'owen']);
    // The reminder: nothing new to start.
    await h.service.handle(push({ v: 1, kind: 'drive', op: 'warm', sessionId: SID, instanceId: 'mac' }));
    expect(prestarted).toEqual(['ella', 'owen']);
  });

  it('a warm push after the session ended (or the end itself) drops the list', async () => {
    const keepWarm = new DriveKeepWarm(() => NOW.getTime());
    keepWarm.set(SID, ['ella'], NOW.getTime() + 60_000);
    const h = harness({ '/machine/state': { ended: true, conversations: [] } }, { keepWarm });
    await h.service.handle(push({ v: 1, kind: 'drive', op: 'end', sessionId: SID, instanceId: 'mac' }));
    expect(keepWarm.isWarm('ella')).toBe(false);
    keepWarm.set(SID, ['ella'], NOW.getTime() + 60_000);
    await h.service.handle(push({ v: 1, kind: 'drive', op: 'warm', sessionId: SID, instanceId: 'mac' }));
    expect(keepWarm.isWarm('ella')).toBe(false);
  });
});

describe('helpers', () => {
  it('owner turn text names the reply command', () => {
    expect(ownerTurnText(SID, 'agent', 'Ella', 'hi')).toMatch(/^\[Drive mode · session drv_abcdefghijkl\]/);
  });

  it('recap request says where it is posted', () => {
    const c = { sessionId: SID, conversationId: 'c1', kind: 'channel' as const, targetName: '#ce', agentSession: 'owen', channelId: 'h', startedAt: NOW.toISOString(), turns: [] };
    expect(recapRequest(c)).toContain('It is posted in #ce.');
  });

  it('pickConversation prefers the one waiting, own over member', () => {
    const base = { sessionId: SID, kind: 'agent' as const, targetName: 'x', channelId: 'h', startedAt: NOW.toISOString() };
    const answered = { ...base, conversationId: 'c1', agentSession: 'ella', turns: [{ from: 'owner' as const, name: 'o', text: 'a', at: '2026-10-08T09:00:00Z' }, { from: 'agent' as const, name: 'e', text: 'b', at: '2026-10-08T09:01:00Z' }] };
    const waiting = { ...base, conversationId: 'c2', agentSession: 'ella', turns: [{ from: 'owner' as const, name: 'o', text: 'a', at: '2026-10-08T08:00:00Z' }] };
    expect(pickConversation([answered, waiting], SID, 'ella', false)?.conversationId).toBe('c2');
  });
});
