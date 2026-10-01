/**
 * Tests for the durable decision store and the ticket thread store.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DecisionStore } from './decision-store.js';
import { TicketThreadStore } from './ticket-thread-store.js';
import type { OwnerDecision } from '../../types/decision.types.js';

const draft = (extra: Partial<OwnerDecision> = {}): Omit<OwnerDecision, 'id' | 'createdAt' | 'updatedAt'> => ({
  question: 'Send it on Monday?',
  options: [{ key: 'a', label: 'Send' }, { key: 'b', label: 'Hold' }],
  defaultKey: 'b',
  deadline: '2026-10-02T12:00:00.000Z',
  requestedBy: 'tl-sam',
  asker: 'dev-ann',
  status: 'open',
  ...extra,
});

describe('DecisionStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decisions-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('assigns D-1, D-2 and keeps them across a reload', async () => {
    const store = DecisionStore.inHome(dir);
    expect((await store.create(draft())).id).toBe('D-1');
    expect((await store.create(draft())).id).toBe('D-2');
    const again = DecisionStore.inHome(dir);
    expect((await again.list()).map((d) => d.id).sort()).toEqual(['D-1', 'D-2']);
    expect((await again.create(draft())).id).toBe('D-3');
  });

  it('update applies a patch; null leaves it alone; findByCard finds the card', async () => {
    const store = DecisionStore.inHome(dir);
    const d = await store.create(draft());
    expect(await store.update(d.id, () => null)).toBeNull();
    const u = await store.update(d.id, () => ({ card: { slackChannelId: 'C1', messageTs: '1.2', postedBy: 'dev-ann', ownBot: true } }));
    expect(u?.card?.messageTs).toBe('1.2');
    expect((await store.findByCard('C1', '1.2'))?.id).toBe(d.id);
    expect(await store.findByCard('C1', '9.9')).toBeNull();
    expect(await store.update('D-99', () => ({ status: 'resolved' }))).toBeNull();
  });

  it('prune drops old settled decisions, keeps pending ones', async () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const store = new DecisionStore(path.join(dir, 'd.json'), () => now);
    const settled = await store.create(draft());
    await store.update(settled.id, () => ({ status: 'resolved' }));
    const open = await store.create(draft());
    now = new Date('2026-12-01T00:00:00Z');
    expect(await store.prune()).toBe(1);
    expect((await store.list()).map((d) => d.id)).toEqual([open.id]);
  });
});

describe('TicketThreadStore', () => {
  it('first thread wins, survives reload, found by thread', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tthreads-'));
    try {
      const store = TicketThreadStore.inHome(dir);
      await store.set('/p', 'APP-1', { slackChannelId: 'C1', threadTs: '1.1' });
      await store.set('/p', 'APP-1', { slackChannelId: 'C2', threadTs: '2.2' });
      const again = TicketThreadStore.inHome(dir);
      expect(await again.get('/p', 'APP-1')).toMatchObject({ slackChannelId: 'C1', threadTs: '1.1' });
      expect(await again.findByThread('C1', '1.1')).toEqual({ projectPath: '/p', ticketId: 'APP-1' });
      expect(await again.get('/p', 'APP-2')).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
