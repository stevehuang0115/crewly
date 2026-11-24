/**
 * Tests for the nightly channel-page pass.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHANNEL_PAGE_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { MAX_BRIEF_MARKDOWN_BYTES, type WorkItem } from '../../types/v2/work-item.types.js';
import {
  buildNightlyBrief,
  ChannelPagesNightlyService,
  localDay,
  quoteRoomRows,
  type ChannelPagesNightlyDeps,
} from './channel-pages-nightly.service.js';
import type { AuthoredRoomRow } from './channel-page.wiring.js';

/** 03:30 local on 2026-11-23. */
const NIGHT = new Date(2026, 10, 23, 3, 30);

const row = (id: string, over: Partial<AuthoredRoomRow> = {}): AuthoredRoomRow => ({
  id,
  threadId: null,
  senderType: 'user',
  senderId: 'U1',
  content: `message ${id}`,
  createdAt: NIGHT.getTime() - 60 * 60 * 1000,
  author: null,
  ...over,
});

describe('ChannelPagesNightlyService', () => {
  let dir: string;
  let added: WorkItem[];
  let open: Set<string>;
  let now: Date;

  const service = (over: Partial<ChannelPagesNightlyDeps> = {}): ChannelPagesNightlyService =>
    new ChannelPagesNightlyService({
      statePath: path.join(dir, 'state', CHANNEL_PAGE_CONSTANTS.NIGHTLY_STATE_FILE),
      listActiveRooms: () => [{ channelId: 'room-1', messages: 2 }],
      getRoom: (id) => (id === 'room-1' ? { id, name: '#necina' } : null),
      listRoomRows: () => [row('a', { content: 'What goes in the talk?' }), row('b', { threadId: 'a', senderType: 'agent', senderId: 'atlas-1', content: 'Three parts.' })],
      sessionNames: async () => new Map([['atlas-1', 'Atlas']]),
      readPage: async () => ({ channelName: '#necina', lead: 'Atlas', covers: [{ who: 'Pia', what: 'video' }], notes: 'Old note.' }),
      addWorkItem: async (item) => {
        added.push(item);
      },
      isWorkItemOpen: async (id) => open.has(id),
      now: () => now,
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-pages-nightly-'));
    added = [];
    open = new Set();
    now = NIGHT;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('localDay is the machine-local calendar day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('quoteRoomRows names agents, marks thread replies and keeps the newest within the budget', () => {
    const names = new Map([['atlas-1', 'Atlas']]);
    const rows = [row('a', { content: 'first' }), row('b', { threadId: 'a', senderType: 'agent', senderId: 'atlas-1', content: 'second' })];
    const lines = quoteRoomRows(rows, names, 10_000);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d\d:\d\dZ a person: first$/);
    expect(lines[1]).toMatch(/^\d\d:\d\dZ Atlas \(in thread\): second$/);
    expect(quoteRoomRows(rows, names, Buffer.byteLength(lines[1], 'utf8') + 2)).toEqual([lines[1]]);
    expect(quoteRoomRows(rows, names, 5)).toEqual([]);
  });

  it('buildNightlyBrief carries the room id, the current page and the messages, and fits a work item', () => {
    const brief = buildNightlyBrief('2026-11-23', [
      { id: 'room-1', name: '#necina', page: { channelName: '#necina', lead: 'Atlas', covers: [{ who: 'Pia', what: 'video' }], notes: 'n'.repeat(900) }, lines: ['10:00Z a person: hi'] },
    ]);
    expect(brief).toContain('## #necina — room id `room-1`');
    expect(brief).toContain('lead Atlas');
    expect(brief).toContain('Pia: video');
    expect(brief).toContain('[clipped; read the full page with channel-notes --channel room-1]');
    expect(brief).toContain('10:00Z a person: hi');
    expect(brief).toContain('Never infer a lead');

    const huge = buildNightlyBrief('2026-11-23', [{ id: 'r', name: '#r', page: null, lines: Array.from({ length: 400 }, () => '频道'.repeat(40)) }]);
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(MAX_BRIEF_MARKDOWN_BYTES);
    expect(huge.endsWith('…[clipped]')).toBe(true);
  });

  it('raises one item for the orchestrator per night, for the rooms that were active', async () => {
    const svc = service();
    const item = await svc.tick();
    expect(item).not.toBeNull();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ target: ORCHESTRATOR_SESSION_NAME, type: 'delegate' });
    expect(added[0].metadata).toMatchObject({ kind: CHANNEL_PAGE_CONSTANTS.NIGHTLY_METADATA_KIND, day: '2026-11-23', rooms: ['room-1'], requiresVerification: false });
    expect(added[0].briefMarkdown).toContain('Atlas (in thread): Three parts.');
    expect(svc.readState()).toMatchObject({ lastDay: '2026-11-23', coveredUntil: NIGHT.getTime(), workItemId: added[0].id });

    await expect(svc.tick()).resolves.toBeNull();
    expect(added).toHaveLength(1);
  });

  it('waits for the nightly hour', async () => {
    now = new Date(2026, 10, 23, CHANNEL_PAGE_CONSTANTS.NIGHTLY_HOUR - 1, 59);
    await expect(service().tick()).resolves.toBeNull();
    expect(added).toHaveLength(0);
  });

  it('a quiet day raises nothing and is not looked at again', async () => {
    const svc = service({ listActiveRooms: () => [] });
    await expect(svc.tick()).resolves.toBeNull();
    expect(added).toHaveLength(0);
    expect(svc.readState().lastDay).toBe('2026-11-23');
  });

  it('skips while the previous item is open, and the next pass still covers that day', async () => {
    const svc = service();
    await svc.tick();
    open.add(added[0].id);
    now = new Date(2026, 10, 24, 3, 30);
    await expect(svc.tick()).resolves.toBeNull();
    expect(svc.readState()).toMatchObject({ lastDay: '2026-11-24', coveredUntil: NIGHT.getTime() });

    open.clear();
    now = new Date(2026, 10, 25, 3, 30);
    const sinceSeen: number[] = [];
    const next = service({ listActiveRooms: (since) => { sinceSeen.push(since); return [{ channelId: 'room-1', messages: 1 }]; } });
    await expect(next.tick()).resolves.not.toBeNull();
    expect(sinceSeen).toEqual([NIGHT.getTime()]);
  });

  it('never throws: a failing queue leaves the day to be tried again', async () => {
    const svc = service({ addWorkItem: async () => { throw new Error('pool down'); } });
    await expect(svc.tick()).resolves.toBeNull();
    expect(svc.readState().lastDay).toBeUndefined();
  });

  it('skips a room that is gone or has nothing to quote', async () => {
    await expect(service({ getRoom: () => null }).tick()).resolves.toBeNull();
    expect(added).toHaveLength(0);
  });

  it('start and stop are idempotent', () => {
    const svc = service();
    svc.start();
    svc.start();
    svc.stop();
    svc.stop();
  });
});
