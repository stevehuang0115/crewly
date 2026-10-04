/**
 * Tests for the Slack delivery audit — owner messages Slack has that never
 * reached a machine. No real Slack or Cloud call: fetch and Cloud are fakes.
 *
 * @module services/slack/slack-delivery-audit.service.test
 */

import {
  SlackDeliveryAuditService,
  getSlackDeliveryAuditService,
  setSlackDeliveryAuditService,
  verdictOf,
  type SlackDeliveryAuditDeps,
} from './slack-delivery-audit.service.js';
import type { CloudRoutingDecision } from '../../types/slack.types.js';

const MAC = 'f4b6f0db-a047-4cd7-8405-cf4a06430fa4';
const AIR = '2577fec0-d975-4c7b-95cc-7ba3c3c4964a';
const ROOM = 'C0C46TTBNNP';
// 2026-10-04 00:00Z; the incident message (2026-10-03 16:06Z) is ~8 h earlier.
const NOW = Date.UTC(2026, 9, 4, 0, 0, 0);
const INCIDENT_TS = '1791043567.147439';

type SlackReply = Record<string, unknown>;

/** A fake Slack Web API: method → (params → body). */
function fakeSlack(routes: Record<string, (params: URLSearchParams, token: string) => SlackReply>) {
  const calls: Array<{ method: string; params: URLSearchParams; token: string }> = [];
  const fetchImpl = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
    const u = new URL(url);
    const method = u.pathname.split('/').pop() as string;
    const token = init.headers.Authorization.replace('Bearer ', '');
    calls.push({ method, params: u.searchParams, token });
    const handler = routes[method];
    const body = handler ? handler(u.searchParams, token) : { ok: false, error: 'unknown_method' };
    return { status: 200, json: async () => body } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function decision(over: Partial<CloudRoutingDecision>): CloudRoutingDecision {
  return {
    key: `u1:T1:${ROOM}:${over.ts ?? INCIDENT_TS}`,
    channelId: ROOM,
    ts: INCIDENT_TS,
    threadTs: null,
    rule: 'single-owner',
    owner: AIR,
    targets: [AIR],
    reason: 'Lowest instance id with an awake member: air',
    createdAt: '2026-10-03T16:06:07.405Z',
    ...over,
  };
}

function deps(over: Partial<SlackDeliveryAuditDeps> = {}): SlackDeliveryAuditDeps {
  return {
    listRooms: async () => [{ slackChannelId: ROOM, slackChannelName: 'content-team', members: ['crewly-marketing-ella', 'think-tank-atlas'] }],
    tokenFor: (members) => (members.length > 0 ? 'xoxb-ella' : null),
    ownerUserId: () => 'UOWNER',
    hasLocal: () => false,
    instanceId: async () => MAC,
    now: () => NOW,
    ...over,
  };
}

describe('SlackDeliveryAuditService', () => {
  afterEach(() => setSlackDeliveryAuditService(null));

  it('the 2026-10-03 message: in Slack, not on this machine, and Cloud pushed it to the other machine only', async () => {
    const slack = fakeSlack({
      'conversations.history': () => ({
        ok: true,
        messages: [
          { ts: INCIDENT_TS, user: 'UOWNER', text: '这个旧模板还能用吗' },
          // An agent's post and a join are not the owner speaking.
          { ts: '1791043600.000100', user: 'U0C30GRCPT4', bot_id: 'B1', text: 'working on it' },
          { ts: '1791043500.000100', user: 'UOWNER', subtype: 'channel_join', text: 'joined' },
        ],
      }),
    });
    const cloudDecisions = jest.fn(async () => [decision({ deliveries: { [AIR]: { status: 'pushed', eventId: 'Ev0C6B4T1S3V', at: 'x' } } })]);
    const audit = new SlackDeliveryAuditService(deps({ fetchImpl: slack.fetchImpl, cloudDecisions }));

    const report = await audit.audit({ hours: 24 });

    expect(slack.calls[0]).toMatchObject({ method: 'conversations.history', token: 'xoxb-ella' });
    expect(slack.calls[0].params.get('channel')).toBe(ROOM);
    expect(Number(slack.calls[0].params.get('oldest'))).toBeCloseTo(NOW / 1000 - 24 * 3600, 0);
    expect(cloudDecisions).toHaveBeenCalledWith(ROOM, new Date(NOW - 24 * 3600 * 1000));
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]).toMatchObject({
      channel: ROOM,
      channelName: 'content-team',
      ts: INCIDENT_TS,
      reachedHere: false,
      verdict: 'reached-other-instance',
      cloud: { owner: AIR, pushedTo: [AIR], rule: 'single-owner' },
    });
    expect(report.summary).toEqual({ total: 1, reachedHere: 0, reachedElsewhere: 1, missing: 0 });
    expect(report.channels).toEqual([{ channel: ROOM, name: 'content-team', readable: true, ownerMessages: 1 }]);
  });

  it('every verdict: here, pushed here but not recorded, never reached, no Cloud record', async () => {
    const ts = ['1791040000.000100', '1791040100.000100', '1791040200.000100', '1791040300.000100'];
    const slack = fakeSlack({
      'conversations.history': () => ({ ok: true, messages: ts.map((t) => ({ ts: t, user: 'UOWNER', text: t })) }),
    });
    const cloud = [
      decision({ ts: ts[1], owner: MAC, targets: [MAC], deliveries: { [MAC]: { status: 'pushed', eventId: 'e1', at: 'x' } } }),
      decision({ ts: ts[2], owner: null, rule: 'uncertain', targets: [MAC, AIR], deliveries: { [MAC]: { status: 'queued', eventId: 'e2', error: 'relay_error', at: 'x' } } }),
    ];
    const audit = new SlackDeliveryAuditService(
      deps({ fetchImpl: slack.fetchImpl, hasLocal: (_c, t) => t === ts[0], cloudDecisions: async () => cloud }),
    );
    const report = await audit.audit();
    expect(report.messages.map((m) => m.verdict)).toEqual(['reached-here', 'pushed-here-not-recorded', 'never-reached', 'no-cloud-record']);
    expect(report.messages[2].cloud?.queued).toEqual([{ instanceId: MAC, error: 'relay_error' }]);
    expect(report.summary).toEqual({ total: 4, reachedHere: 1, reachedElsewhere: 0, missing: 3 });
  });

  it('reads owner replies inside threads active in the window', async () => {
    const parent = '1791040000.000100';
    const slack = fakeSlack({
      'conversations.history': () => ({ ok: true, messages: [{ ts: parent, user: 'U0C2ZK849ND', bot_id: 'B2', text: 'D-92 reminder', reply_count: 2, latest_reply: '1791040500.000100' }] }),
      'conversations.replies': (p) => ({
        ok: true,
        messages: [
          { ts: p.get('ts'), user: 'U0C2ZK849ND', bot_id: 'B2', text: 'D-92 reminder' },
          { ts: '1791040500.000100', thread_ts: parent, user: 'UOWNER', text: '两者应该都要有' },
        ],
      }),
    });
    const audit = new SlackDeliveryAuditService(deps({ fetchImpl: slack.fetchImpl }));
    const report = await audit.audit();
    expect(report.messages).toEqual([expect.objectContaining({ ts: '1791040500.000100', threadTs: parent, verdict: 'no-cloud-record' })]);
    expect(report.cloudLog).toBe('unavailable');
  });

  it('lists a channel it cannot read instead of skipping it silently', async () => {
    const slack = fakeSlack({ 'conversations.history': () => ({ ok: false, error: 'not_in_channel' }) });
    const audit = new SlackDeliveryAuditService(
      deps({
        fetchImpl: slack.fetchImpl,
        listRooms: async () => [
          { slackChannelId: ROOM, slackChannelName: 'content-team', members: ['ella'] },
          { slackChannelId: 'C-NOBOT', slackChannelName: 'no-bot', members: [] },
        ],
      }),
    );
    const report = await audit.audit();
    expect(report.channels).toEqual([
      { channel: ROOM, name: 'content-team', readable: false, error: 'not_in_channel', ownerMessages: 0 },
      { channel: 'C-NOBOT', name: 'no-bot', readable: false, error: 'no_member_bot_token', ownerMessages: 0 },
    ]);
  });

  it('keeps every human message when the owner is unknown, and says when Cloud cannot be asked', async () => {
    const slack = fakeSlack({
      'conversations.history': () => ({ ok: true, messages: [{ ts: '1791040000.000100', user: 'USOMEONE', text: 'hi' }] }),
    });
    const audit = new SlackDeliveryAuditService(
      deps({ fetchImpl: slack.fetchImpl, ownerUserId: () => null, cloudDecisions: async () => null }),
    );
    const report = await audit.audit();
    expect(report.messages).toHaveLength(1);
    expect(report.cloudLog).toBe('unavailable');
  });

  it('caps the window at 168 hours', async () => {
    const slack = fakeSlack({ 'conversations.history': () => ({ ok: true, messages: [] }) });
    const audit = new SlackDeliveryAuditService(deps({ fetchImpl: slack.fetchImpl }));
    const report = await audit.audit({ hours: 10_000 });
    expect(report.since).toBe(new Date(NOW - 168 * 3600 * 1000).toISOString());
  });

  it('verdictOf: a push to another machine counts only when it is not this one', () => {
    const cloud = { rule: 'single-owner', owner: AIR, targets: [AIR], pushedTo: [AIR], queued: [], reason: '' };
    expect(verdictOf(false, cloud, MAC)).toBe('reached-other-instance');
    expect(verdictOf(false, cloud, AIR)).toBe('pushed-here-not-recorded');
    expect(verdictOf(true, null, MAC)).toBe('reached-here');
  });

  it('singleton holder', () => {
    const svc = new SlackDeliveryAuditService(deps());
    setSlackDeliveryAuditService(svc);
    expect(getSlackDeliveryAuditService()).toBe(svc);
  });
});
