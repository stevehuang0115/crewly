/**
 * Tests for SignalDigestService: proposing (history blocks, replacing the
 * site's unanswered actions), posting the card, and the owner's Do / Skip by
 * button and by API — Do opens an experiment ticket and tells the lead.
 *
 * @module services/signal-digest/signal-digest.service.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SlackOutgoingMessage } from '../../types/slack.types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import { SignalDigestError } from './signal-digest-contract.js';
import { SignalDigestService, experimentTicketDescription, type SignalDigestServiceDeps, type SignalTicketInput } from './signal-digest.service.js';
import { SignalDigestStore } from './signal-digest-store.js';

const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as ComponentLogger;

const action = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  source: 'gsc',
  signal: `signal ${key}`,
  proposal: `Do ${key}`,
  expectedEffect: '+10 clicks a week',
  effort: 'S — 1 h',
  ...extra,
});

const SITE = 'visa.careerengine.us';

interface Harness {
  service: SignalDigestService;
  sent: SlackOutgoingMessage[];
  updates: Array<{ channel: string; ts: string; text: string; blocks: unknown; token?: string }>;
  tickets: SignalTicketInput[];
  told: Array<{ session: string; text: string }>;
  setNow: (iso: string) => void;
  deps: SignalDigestServiceDeps;
}

let dir: string;

async function harness(over: Partial<SignalDigestServiceDeps> = {}): Promise<Harness> {
  let now = new Date('2026-10-03T13:00:00Z');
  const sent: SlackOutgoingMessage[] = [];
  const updates: Harness['updates'] = [];
  const tickets: SignalTicketInput[] = [];
  const told: Harness['told'] = [];
  let ts = 100;
  const deps: SignalDigestServiceDeps = {
    store: new SignalDigestStore(path.join(dir, 'signal-digests.json'), () => now),
    slack: () => ({
      isConnected: () => true,
      sendMessage: async (m: SlackOutgoingMessage) => {
        sent.push(m);
        ts += 1;
        return `${ts}.000`;
      },
      updateMessage: async (channel: string, messageTs: string, text: string, blocks?: unknown, token?: string) => {
        updates.push({ channel, ts: messageTs, text, blocks, token });
      },
    }),
    instanceId: () => 'inst-1',
    isOwner: (u) => u === 'U_OWNER',
    identityOf: async (s) => (s === 'tl-owen' ? { botToken: 'xoxb-owen', username: 'Owen' } : { username: s }),
    teamOf: async (s) => (s === 'tl-owen' ? 'team-ce' : undefined),
    teamChannelOf: async (t) => (t === 'team-ce' ? 'C_CE' : null),
    ownerDmOf: async () => 'D_OWNER',
    displayName: async (s) => (s === 'tl-owen' ? 'Owen' : undefined),
    createTicket: async (input) => {
      tickets.push(input);
      return { id: `CE-${tickets.length + 10}` };
    },
    deliverToAgent: async (session, text) => {
      told.push({ session, text });
      return true;
    },
    logger,
    now: () => now,
    ...over,
  };
  return {
    service: new SignalDigestService(deps),
    sent,
    updates,
    tickets,
    told,
    setNow: (iso) => {
      now = new Date(iso);
    },
    deps,
  };
}

const click = (digestId: string, n: number, o: 'do' | 'skip', channel: string, ts: string, user = 'U_OWNER', i = 'inst-1') => ({
  user: { id: user },
  actions: [{ action_id: `decision:signal:${n}:${o}`, value: JSON.stringify({ s: digestId, n, o, i }) }],
  container: { channel_id: channel, message_ts: ts },
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-digest-svc-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('propose', () => {
  it('stores the digest and posts one card in the lead\'s team channel with its own bot', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'CE site', items: [action('a'), action('b'), action('c')] });
    expect(d).toMatchObject({ id: 'SD-1', site: SITE, asker: 'tl-owen', teamId: 'team-ce', project: 'CE site' });
    expect(d.items.map((i) => [i.n, i.status])).toEqual([[1, 'open'], [2, 'open'], [3, 'open']]);
    expect(d.card).toEqual({ slackChannelId: 'C_CE', messageTs: '101.000', postedBy: 'tl-owen', ownBot: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ channelId: 'C_CE', botToken: 'xoxb-owen', text: `Daily signals · ${SITE}: 3 actions` });
  });

  it('requires a caller and a valid proposal', async () => {
    const h = await harness();
    await expect(h.service.propose(undefined, { site: SITE, items: [action('a'), action('b'), action('c')] })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.propose('tl-owen', { site: SITE, items: [action('a')] })).rejects.toBeInstanceOf(SignalDigestError);
    expect(h.sent).toHaveLength(0);
  });

  it('falls back to the owner DM when the lead has no team channel, and records a post error when Slack is down', async () => {
    const h = await harness({ teamChannelOf: async () => null });
    const d = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    expect(d.card?.slackChannelId).toBe('D_OWNER');

    const down = await harness({ slack: () => null });
    const d2 = await down.service.propose('tl-owen', { site: 'other', items: [action('a'), action('b'), action('c')] });
    expect(d2.card).toBeUndefined();
    expect(d2.postError).toBe('Slack is not connected');
  });

  it('falls back to the shared bot under the lead\'s name when its own bot is refused', async () => {
    const posted: SlackOutgoingMessage[] = [];
    const h = await harness({
      slack: () => ({
        isConnected: () => true,
        sendMessage: async (m: SlackOutgoingMessage) => {
          if (m.botToken) throw new Error('not_in_channel');
          posted.push(m);
          return '200.000';
        },
        updateMessage: async () => undefined,
      }),
    });
    const d = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    expect(d.card).toEqual({ slackChannelId: 'C_CE', messageTs: '200.000', postedBy: 'crewly', ownBot: false });
    expect(posted[0]).toMatchObject({ username: 'Owen' });
    expect(posted[0].botToken).toBeUndefined();
  });

  it('replaces the site\'s earlier unanswered actions (expired, card redrawn) and lets them be proposed again', async () => {
    const h = await harness();
    const first = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    await h.service.choose(first.id, 1, 'skip');
    h.setNow('2026-10-04T13:00:00Z');
    const second = await h.service.propose('tl-owen', { site: SITE, items: [action('b'), action('c'), action('d')] });
    const old = await h.service.get(first.id);
    expect(old?.items.map((i) => i.status)).toEqual(['skip', 'expired', 'expired']);
    expect(h.updates.some((u) => u.ts === first.card?.messageTs && JSON.stringify(u.blocks).includes('replaced by a newer digest'))).toBe(true);
    expect(second.items.map((i) => i.key)).toEqual(['b', 'c', 'd']);
  });

  it('refuses actions the owner already chose Do on or skipped, naming each', async () => {
    const h = await harness();
    const first = await h.service.propose('tl-owen', { site: SITE, project: 'CE site', items: [action('a'), action('b'), action('c')] });
    await h.service.choose(first.id, 1, 'do');
    await h.service.choose(first.id, 2, 'skip');
    h.setNow('2026-10-04T13:00:00Z');
    const err = await h.service.propose('tl-owen', { site: SITE, items: [action('A'), action('b'), action('x')] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalDigestError);
    expect((err as SignalDigestError).status).toBe(409);
    expect((err as Error).message).toMatch(/"A": the owner chose Do on 2026-10-03 \(SD-1, CE-11\)/);
    expect((err as Error).message).toMatch(/"b": the owner skipped it/);
    // Nothing changed: the first digest's open item is still open, no new digest.
    expect((await h.service.get(first.id))?.items[2].status).toBe('open');
    expect(await h.service.list(SITE)).toHaveLength(1);
  });

  it('a skip stops blocking after 30 days', async () => {
    const h = await harness();
    const first = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    await h.service.choose(first.id, 1, 'skip');
    h.setNow('2026-11-03T13:00:01Z');
    await expect(h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('y'), action('z')] })).resolves.toMatchObject({ id: 'SD-2' });
  });
});

describe('answers', () => {
  it('Do by button: experiment ticket in the project with the lead\'s team, lead told, card redrawn with its own bot', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'CE site', items: [action('a', { metric: 'GSC clicks for a' }), action('b'), action('c')] });
    const out = await h.service.handleInteraction(click(d.id, 1, 'do', 'C_CE', '101.000'));
    expect(out).toMatchObject({ handled: true, reason: 'do' });
    expect(out.digest?.items[0]).toMatchObject({ status: 'do', answeredBy: 'U_OWNER', ticketId: 'CE-11' });
    expect(h.tickets).toHaveLength(1);
    expect(h.tickets[0]).toMatchObject({
      project: 'CE site',
      team: 'team-ce',
      title: 'Experiment: Do a',
      labels: ['experiment', 'signal-digest'],
      source: 'signal-digest:SD-1#1',
    });
    expect(h.tickets[0].description).toContain('- Metric: GSC clicks for a');
    expect(h.tickets[0].acceptance).toHaveLength(3);
    expect(h.told).toEqual([{ session: 'tl-owen', text: expect.stringMatching(/^\[SIGNAL DIGEST\] The owner chose Do for SD-1 action 1 .*Ticket CE-11 is ready in CE site/) }]);
    const last = h.updates[h.updates.length - 1];
    expect(last).toMatchObject({ channel: 'C_CE', ts: '101.000', token: 'xoxb-owen' });
    expect(JSON.stringify(last.blocks)).toContain('✔ Do → CE-11');
    expect(JSON.stringify(last.blocks)).toContain('decision:signal:2:do');
  });

  it('Skip by button records it, tells nobody, opens no ticket', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'CE site', items: [action('a'), action('b'), action('c')] });
    const out = await h.service.handleInteraction(click(d.id, 2, 'skip', 'C_CE', '101.000'));
    expect(out.handled).toBe(true);
    expect(out.digest?.items[1].status).toBe('skip');
    expect(h.tickets).toHaveLength(0);
    expect(h.told).toHaveLength(0);
    expect(JSON.stringify(h.updates[0].blocks)).toContain('⤼ Skipped');
  });

  it('Do without a project: no ticket, the card and the lead say why', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    const out = await h.service.choose(d.id, 3, 'do');
    expect(out.items[2]).toMatchObject({ status: 'do', ticketError: expect.stringContaining('no project') });
    expect(h.told[0].text).toMatch(/No ticket was created .*Create it yourself with project-tickets/);
  });

  it('a failing ticket create is recorded, not thrown', async () => {
    const h = await harness({
      createTicket: async () => {
        throw new Error('Project "CE" not found');
      },
    });
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'CE', items: [action('a'), action('b'), action('c')] });
    const out = await h.service.choose(d.id, 1, 'do');
    expect(out.items[0]).toMatchObject({ status: 'do', ticketError: 'Project "CE" not found' });
  });

  it('ignores clicks that are not the owner\'s, not on the stored card, from another instance, unknown, or already answered', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    expect(await h.service.handleInteraction(click(d.id, 1, 'do', 'C_CE', '101.000', 'U_SOMEONE'))).toMatchObject({ handled: false, reason: 'not the owner' });
    expect(await h.service.handleInteraction(click(d.id, 1, 'do', 'C_OTHER', '101.000'))).toMatchObject({ handled: false, reason: 'click is not on the stored card' });
    expect(await h.service.handleInteraction(click(d.id, 1, 'do', 'C_CE', '101.000', 'U_OWNER', 'inst-2'))).toMatchObject({ handled: false, reason: 'card belongs to instance inst-2' });
    expect(await h.service.handleInteraction(click('SD-9', 1, 'do', 'C_CE', '101.000'))).toMatchObject({ handled: false, reason: 'unknown digest SD-9' });
    expect(await h.service.handleInteraction(click(d.id, 7, 'do', 'C_CE', '101.000'))).toMatchObject({ handled: false, reason: 'no action 7' });
    await h.service.handleInteraction(click(d.id, 1, 'skip', 'C_CE', '101.000'));
    expect(await h.service.handleInteraction(click(d.id, 1, 'do', 'C_CE', '101.000'))).toMatchObject({ handled: false, reason: 'already skip' });
    expect(await h.service.handleInteraction({ actions: [{ action_id: 'decision:a', value: '{"d":"D-1","o":"a"}' }] })).toMatchObject({ handled: false, reason: 'not a signal digest action' });
    expect((await h.service.get(d.id))?.items[0].status).toBe('skip');
  });

  it('choose (API) refuses unknown digests, unknown items and answered items', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, items: [action('a'), action('b'), action('c')] });
    await expect(h.service.choose('SD-9', 1, 'do')).rejects.toMatchObject({ status: 404 });
    await expect(h.service.choose(d.id, 9, 'do')).rejects.toMatchObject({ status: 404 });
    await h.service.choose(d.id, 1, 'skip');
    await expect(h.service.choose(d.id, 1, 'do')).rejects.toMatchObject({ status: 409 });
  });

  it('history lists Do and Skip with their windows and open actions', async () => {
    const h = await harness();
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'P', items: [action('a'), action('b'), action('c')] });
    await h.service.choose(d.id, 1, 'do');
    await h.service.choose(d.id, 2, 'skip');
    const history = await h.service.history(SITE);
    expect(history.map((e) => [e.key, e.status])).toEqual([['a', 'do'], ['b', 'skip'], ['c', 'open']]);
    expect(history[0].ticketId).toBe('CE-11');
  });
});

describe('experiment cards (#986)', () => {
  const spec = { source: 'gsc', measure: 'ctr', query: 'h1b visa fee', page: 'https://visa.careerengine.us/h1b-fee' };

  it('Do creates an experiment card linked to the new ticket, as the lead', async () => {
    const createExperiment = jest.fn().mockResolvedValue({ id: 'EXP-3' });
    const h = await harness({ createExperiment });
    const d = await h.service.propose('tl-owen', {
      site: SITE,
      project: 'CE site',
      config: '/abs/ce.json',
      items: [action('a', { metric: 'GSC CTR for h1b visa fee', experiment: spec }), action('b'), action('c')],
    });
    const out = await h.service.choose(d.id, 1, 'do');
    expect(createExperiment).toHaveBeenCalledWith(
      {
        title: 'Do a',
        hypothesis: 'Do a → +10 clicks a week',
        metric: { source: 'gsc', measure: 'ctr', config: '/abs/ce.json', query: 'h1b visa fee', page: 'https://visa.careerengine.us/h1b-fee', label: 'GSC CTR for h1b visa fee' },
        ticket: { kind: 'project', project: 'CE site', id: 'CE-11' },
      },
      'tl-owen',
    );
    expect(out.items[0]).toMatchObject({ ticketId: 'CE-11', experimentId: 'EXP-3' });
    expect(h.tickets[0].description).toContain('measured automatically by the experiment card');
    expect(h.told[0].text).toMatch(/with experiment card EXP-3: ship the change and close the ticket/);
    expect(JSON.stringify(h.updates[h.updates.length - 1].blocks)).toContain('✔ Do → CE-11 · EXP-3');
  });

  it('a failed experiment card keeps the ticket and tells the lead to add one', async () => {
    const h = await harness({ createExperiment: jest.fn().mockRejectedValue(new Error('metric.measure for gsc must be one of: clicks')) });
    const d = await h.service.propose('tl-owen', { site: SITE, project: 'P', config: '/abs/ce.json', items: [action('a', { experiment: spec }), action('b'), action('c')] });
    const out = await h.service.choose(d.id, 1, 'do');
    expect(out.items[0]).toMatchObject({ ticketId: 'CE-11', experimentError: 'metric.measure for gsc must be one of: clicks' });
    expect(h.told[0].text).toMatch(/The experiment card was not created \(metric\.measure .*\); create it with experiment-card/);
  });

  it('no card without a spec, a config, or a ticket; "not running" when the service is off', async () => {
    const createExperiment = jest.fn().mockResolvedValue({ id: 'EXP-1' });
    const h = await harness({ createExperiment });
    const noConfig = await h.service.propose('tl-owen', { site: 'a', project: 'P', items: [action('a', { experiment: spec }), action('b'), action('c')] });
    await h.service.choose(noConfig.id, 1, 'do');
    const noSpec = await h.service.propose('tl-owen', { site: 'b', project: 'P', config: '/abs/x.json', items: [action('a'), action('b'), action('c')] });
    await h.service.choose(noSpec.id, 1, 'do');
    const noProject = await h.service.propose('tl-owen', { site: 'c', config: '/abs/x.json', items: [action('a', { experiment: spec }), action('b'), action('c')] });
    const np = await h.service.choose(noProject.id, 1, 'do');
    expect(createExperiment).not.toHaveBeenCalled();
    expect(np.items[0]).not.toHaveProperty('experimentError');

    const off = await harness({ createExperiment: undefined });
    const d = await off.service.propose('tl-owen', { site: SITE, project: 'P', config: '/abs/x.json', items: [action('a', { experiment: spec }), action('b'), action('c')] });
    expect((await off.service.choose(d.id, 1, 'do')).items[0].experimentError).toBe('experiment cards are not running on this instance');
  });
});

describe('experimentTicketDescription', () => {
  it('carries the signal, proposal, effect, effort and the experiment fields', () => {
    const text = experimentTicketDescription(
      { id: 'SD-2', site: SITE, asker: 'tl', items: [], createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' },
      { n: 2, key: 'gsc:x', source: 'gsc', signal: 'S', proposal: 'P', expectedEffect: 'E', effort: 'M', status: 'do' },
    );
    expect(text).toContain('From the daily signal digest SD-2 for visa.careerengine.us (2026-10-03), action 2.');
    expect(text).toContain('- Hypothesis: P → E');
    expect(text).toContain('- Metric: name the metric');
    expect(text).toContain('- Window: 14 days after shipping');
    expect(text).toContain('`gsc:x`');
  });
});

describe('instance', () => {
  it('get/set the running service', async () => {
    const h = await harness();
    SignalDigestService.setInstance(h.service);
    expect(SignalDigestService.getInstance()).toBe(h.service);
    SignalDigestService.setInstance(null);
    expect(SignalDigestService.getInstance()).toBeNull();
  });
});
