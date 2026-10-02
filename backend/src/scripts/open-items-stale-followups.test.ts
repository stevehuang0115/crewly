import { classifyStaleFollowUps } from './open-items-stale-followups.js';
import type { Request } from '../types/v2/request.types.js';
import type { WorkItem } from '../types/v2/work-item.types.js';
import type { OpenItemsChatMessage } from '../services/open-items/open-items.service.js';

const wi = (id: string, status: string, created: string, reqId: string, itemId: string) =>
  ({ id, status, createdAt: created, target: 'a', title: 't', metadata: { openItemFollowUp: { requestId: reqId, itemId } } }) as unknown as WorkItem;
const req = (id: string, n: number) =>
  ({ id, ticketNumber: n, chatRef: { channelId: 'c', threadRootId: `root${n}`, messageId: `root${n}` }, openItems: [{ id: 'i', text: 'promise', agent: 'a' }] }) as unknown as Request;

describe('classifyStaleFollowUps', () => {
  const base = { fromMs: Date.parse('2026-10-02T00:04:00Z'), toMs: Date.parse('2026-10-02T00:06:59Z') };
  const at = '2026-10-02T00:05:00Z';
  const msg = { id: 'm', channelId: 'c', senderType: 'agent', senderId: 'a', content: 'x', createdAt: 1 } as OpenItemsChatMessage;

  it('separates delivered from genuine misses and counts what it examined', () => {
    const r = classifyStaleFollowUps({
      ...base,
      requests: [req('r1', 186), req('r2', 97)],
      pool: [wi('w1', 'blocked', at, 'r1', 'i'), wi('w2', 'blocked', at, 'r2', 'i'), wi('w3', 'done', at, 'r1', 'i'), wi('w4', 'blocked', '2026-10-01T10:00:00Z', 'r1', 'i')],
      listThread: (_c, root) => (root === 'root186' ? [msg] : []),
      service: { deliveredBy: () => true },
    });
    expect(r.examinedItems).toBe(2);
    expect(r.examinedThreads).toBe(2);
    expect(r.rows.map((x) => x.verdict)).toEqual(['stale-delivered', 'keep-genuine-miss']);
    const r2 = classifyStaleFollowUps({ ...base, requests: [req('r2', 97)], pool: [wi('w2', 'blocked', at, 'r2', 'i')], listThread: () => [], service: { deliveredBy: () => false } });
    expect(r2.rows[0].verdict).toBe('keep-genuine-miss');
  });

  it('examines nothing when the window has no follow-ups', () => {
    expect(classifyStaleFollowUps({ ...base, requests: [], pool: [], listThread: () => [], service: { deliveredBy: () => true } }).examinedItems).toBe(0);
  });
});
