/**
 * Tests for TempMemberStore — the bounded history of temporary members and
 * the seat requests (specs/2026-11-26-temp-members-seat-requests.md).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { TEMP_MEMBER_CONSTANTS } from '../../constants.js';
import { TempMemberStore, type SeatRequest, type TempMemberEvent } from './temp-member.store.js';

const event = (over: Partial<TempMemberEvent> = {}): TempMemberEvent => ({
  type: 'created',
  at: '2026-11-26T10:00:00.000Z',
  teamId: 't1',
  teamName: 'Marketing',
  memberId: 'm1',
  memberName: 'Temp-Developer-1',
  session: 'marketing-temp-developer-1-member-1',
  role: 'developer',
  reason: 'two launches at once',
  by: 'mkt-owen',
  ...over,
});

const request = (over: Partial<SeatRequest> = {}): SeatRequest => ({
  decisionId: 'D-1',
  teamId: 't1',
  teamName: 'Marketing',
  role: 'developer',
  reason: 'every week',
  askerSession: 'mkt-owen',
  askerName: 'Owen',
  at: '2026-11-26T10:00:00.000Z',
  status: 'open',
  ...over,
});

describe('TempMemberStore', () => {
  let dir: string;
  let store: TempMemberStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'temp-store-'));
    store = TempMemberStore.inHome(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('is empty without a file and writes temp-members.json in the home', async () => {
    expect(await store.events()).toEqual([]);
    expect(await store.seatRequests()).toEqual([]);
    await store.record(event());
    const raw = JSON.parse(await fs.readFile(path.join(dir, TEMP_MEMBER_CONSTANTS.STORE_FILE), 'utf8'));
    expect(raw.events).toHaveLength(1);
    expect(raw.events[0]).toMatchObject({ type: 'created', teamId: 't1', role: 'developer', by: 'mkt-owen', reason: 'two launches at once' });
  });

  it('keeps events in order across concurrent writes and filters by time', async () => {
    await Promise.all([
      store.record(event({ memberId: 'a', at: '2026-11-20T00:00:00.000Z' })),
      store.record(event({ memberId: 'b', at: '2026-11-25T00:00:00.000Z', type: 'removed' })),
      store.record(event({ memberId: 'c', at: '2026-11-26T00:00:00.000Z' })),
    ]);
    expect((await store.events()).map((e) => e.memberId)).toEqual(['a', 'b', 'c']);
    expect((await store.events(Date.parse('2026-11-24T00:00:00.000Z'))).map((e) => e.memberId)).toEqual(['b', 'c']);
  });

  it('drops the oldest events past the cap', async () => {
    const file = path.join(dir, TEMP_MEMBER_CONSTANTS.STORE_FILE);
    const events = Array.from({ length: TEMP_MEMBER_CONSTANTS.MAX_EVENTS }, (_, i) => event({ memberId: `m${i}` }));
    await fs.writeFile(file, JSON.stringify({ version: 1, events, seatRequests: [] }));
    await store.record(event({ memberId: 'newest' }));
    const all = await store.events();
    expect(all).toHaveLength(TEMP_MEMBER_CONSTANTS.MAX_EVENTS);
    expect(all[0].memberId).toBe('m1');
    expect(all[all.length - 1].memberId).toBe('newest');
  });

  it('adds and updates a seat request by its decision id', async () => {
    await store.addSeatRequest(request());
    expect(await store.updateSeatRequest('D-1', { status: 'declined', settledAt: '2026-11-27T00:00:00.000Z' })).toMatchObject({ status: 'declined', role: 'developer' });
    expect(await store.updateSeatRequest('D-9', { status: 'approved' })).toBeNull();
    expect(await new TempMemberStore(path.join(dir, TEMP_MEMBER_CONSTANTS.STORE_FILE)).seatRequests()).toEqual([
      expect.objectContaining({ decisionId: 'D-1', status: 'declined', settledAt: '2026-11-27T00:00:00.000Z' }),
    ]);
  });

  it('past the cap drops settled seat requests, never an open one', async () => {
    const file = path.join(dir, TEMP_MEMBER_CONSTANTS.STORE_FILE);
    const seatRequests = [
      request({ decisionId: 'D-open', status: 'open' }),
      ...Array.from({ length: TEMP_MEMBER_CONSTANTS.MAX_SEAT_REQUESTS - 1 }, (_, i) => request({ decisionId: `D-old-${i}`, status: 'declined' })),
    ];
    await fs.writeFile(file, JSON.stringify({ version: 1, events: [], seatRequests }));
    await store.addSeatRequest(request({ decisionId: 'D-new' }));
    const ids = (await store.seatRequests()).map((r) => r.decisionId);
    expect(ids).toHaveLength(TEMP_MEMBER_CONSTANTS.MAX_SEAT_REQUESTS);
    expect(ids).toContain('D-open');
    expect(ids).toContain('D-new');
    expect(ids).not.toContain('D-old-0');
  });

  it('treats an unreadable file as empty', async () => {
    await fs.writeFile(path.join(dir, TEMP_MEMBER_CONSTANTS.STORE_FILE), '{not json');
    expect(await store.events()).toEqual([]);
  });
});
