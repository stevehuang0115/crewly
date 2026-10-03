/**
 * Tests for the context-only queue (specs/2026-10-03-one-responder-per-message.md).
 *
 * @module services/chat-v2/room-context-backlog.test
 */

import { ROOM_CONTEXT_CONSTANTS } from '../../constants.js';
import { RoomContextBacklog, contextOnlyLine, renderContextOnlyBlock } from './room-context-backlog.js';

describe('RoomContextBacklog', () => {
  let now = 1_000;
  const backlog = () => new RoomContextBacklog({ now: () => now });
  const entry = (messageId: string, content = 'text') => ({ messageId, sender: 'steve', content, responderName: 'Atlas' });

  beforeEach(() => {
    now = 1_000;
  });

  it('take returns what was queued for that agent and room, once, without the message being delivered now', () => {
    const b = backlog();
    b.add('ella', 'room-1', entry('m1'));
    b.add('ella', 'room-1', entry('m1')); // a hand-off re-route: no duplicate
    b.add('ella', 'room-2', entry('m2'));
    b.add('noah', 'room-1', entry('m3'));
    expect(b.take('ella', 'room-1', 'm9').map((e) => e.messageId)).toEqual(['m1']);
    expect(b.take('ella', 'room-1')).toEqual([]);
    expect(b.peek('ella', 'room-2')).toHaveLength(1);
    // The message being delivered now is never its own context.
    expect(b.take('noah', 'room-1', 'm3')).toEqual([]);
  });

  it('keeps the newest entries, drops expired ones, and restore puts them back first', () => {
    const b = backlog();
    for (let i = 0; i < ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES + 2; i++) b.add('ella', 'r', entry(`m${i}`));
    expect(b.peek('ella', 'r')).toHaveLength(ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES);
    expect(b.peek('ella', 'r')[0].messageId).toBe('m2');

    const taken = b.take('ella', 'r');
    b.add('ella', 'r', entry('later'));
    b.restore('ella', 'r', taken);
    const ids = b.peek('ella', 'r').map((e) => e.messageId);
    // Restored entries go first; the queue still keeps only the newest.
    expect(ids[ids.length - 1]).toBe('later');
    expect(ids).toHaveLength(ROOM_CONTEXT_CONSTANTS.MAX_ENTRIES);
    expect(ids).toContain('m3');

    now += ROOM_CONTEXT_CONSTANTS.TTL_MS + 1;
    expect(b.take('ella', 'r')).toEqual([]);
  });

  it('renders an English context-only block naming who is answering', () => {
    expect(renderContextOnlyBlock([])).toBe('');
    const block = renderContextOnlyBlock([{ ...entry('m1', '我之前不是说了吗 两者应该都要有'), threadId: 'root-1', at: 1 }]);
    expect(block).toContain('[Context only — not for you to answer]');
    expect(block).toContain('steve (thread root-1): 我之前不是说了吗 两者应该都要有 — Atlas is answering this; do not reply unless you are asked.');
    expect(contextOnlyLine({ sender: 'steve', content: 'x'.repeat(1000) }).length).toBeLessThan(ROOM_CONTEXT_CONSTANTS.PER_ENTRY_CHARS + 120);
    expect(contextOnlyLine({ sender: 'steve', content: 'hi' })).toContain('not addressed to you');
  });
});
