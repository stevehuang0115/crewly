/**
 * Tests for the local Drive mode conversation file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DriveConversationStore, localKey, type DriveLocalConversation } from './drive-conversation.store.js';

const conv = (over: Partial<DriveLocalConversation> = {}): DriveLocalConversation => ({
  sessionId: 'drv_abcdefghijkl',
  conversationId: 'c1',
  kind: 'agent',
  targetName: 'Ella',
  agentSession: 'ella',
  channelId: 'dm-ella',
  startedAt: new Date(1_000_000).toISOString(),
  turns: [],
  ...over,
});

describe('DriveConversationStore', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-conv-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps what is written (0600), serialises updates, drops old ones', async () => {
    const store = new DriveConversationStore(path.join(dir, 'f.json'));
    expect(await store.list()).toEqual([]);
    await Promise.all([1, 2, 3].map((i) => store.update('drv_abcdefghijkl', `c${i}`, () => conv({ conversationId: `c${i}` }), 1_000_000)));
    expect((await store.list()).map((c) => c.conversationId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(fs.statSync(path.join(dir, 'f.json')).mode & 0o777).toBe(0o600);
    expect((await store.get('drv_abcdefghijkl', 'c2'))?.targetName).toBe('Ella');
    await store.update('drv_abcdefghijkl', 'c9', () => conv({ conversationId: 'c9', startedAt: new Date(10 * 86_400_000).toISOString() }), 10 * 86_400_000);
    expect((await store.list()).map((c) => c.conversationId)).toEqual(['c9']);
    expect(localKey('s', 'c1')).toBe('s:c1');
  });
});
