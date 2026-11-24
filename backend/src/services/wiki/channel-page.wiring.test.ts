/**
 * Tests for the channel page wiring.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeChannelPage } from './channel-page.js';
import { agentNameOfRow, channelBlockFor, channelPageVault, channelRecordCommand, type AuthoredRoomRow } from './channel-page.wiring.js';

const row = (over: Partial<AuthoredRoomRow>): AuthoredRoomRow => ({
  id: 'm1',
  threadId: null,
  senderType: 'user',
  senderId: 'U1',
  content: 'hello',
  createdAt: Date.UTC(2026, 10, 21, 12),
  author: null,
  ...over,
});

describe('channel-page.wiring', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-page-wiring-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true, maxRetries: 3 });
  });

  it('puts pages in the global vault', () => {
    expect(channelPageVault('/home/x/.crewly')).toBe(path.join('/home/x/.crewly', 'global-wiki'));
  });

  it('names the agent that wrote a row: local session, remote agent, or nobody for a person', () => {
    const names = new Map([['flopost-pia-1', 'Pia']]);
    expect(agentNameOfRow(row({ senderType: 'agent', senderId: 'flopost-pia-1' }), names)).toBe('Pia');
    expect(agentNameOfRow(row({ senderType: 'agent', senderId: 'unknown-1' }), names)).toBe('unknown-1');
    expect(agentNameOfRow(row({ senderId: 'Ella (Personal Assistant Team) (agent)', author: 'pa-ella-1' }), names)).toBe('Ella');
    expect(agentNameOfRow(row({ senderId: 'Pia (agent)', author: 'flopost-pia-1' }), names)).toBe('Pia');
    expect(agentNameOfRow(row({ senderId: 'UG94JLNGK' }), names)).toBeNull();
  });

  it('the record command names the room', () => {
    expect(channelRecordCommand('room-1')).toContain('channel-notes/execute.sh --channel room-1 --lead');
  });

  it('builds the block from the page and the recent threads', async () => {
    await writeChannelPage(vault, { name: '#necina', id: 'room-1' }, { lead: 'Atlas', cover: { who: 'Atlas', what: 'the Saturday talk outline' } }, 'owner');
    const now = Date.UTC(2026, 10, 23);
    const block = await channelBlockFor(
      {
        vaultPath: vault,
        now: () => now,
        sessionNames: async () => new Map([['think-tank-atlas-1', 'Atlas']]),
        listRoomRows: () => [
          row({ id: 'root', content: 'What goes in the Saturday talk?' }),
          row({ id: 'r1', threadId: 'root', senderType: 'agent', senderId: 'think-tank-atlas-1', content: 'Three parts…' }),
        ],
      },
      { id: 'room-1', name: '#necina' },
    );
    expect(block).toContain('Lead: Atlas');
    expect(block).toContain('- Atlas: the Saturday talk outline');
    expect(block).toContain('"What goes in the Saturday talk?" — Atlas');
    expect(block).toContain('--channel room-1');
  });

  it('says nothing for a room with no page and no thread, and never throws', async () => {
    const deps = { vaultPath: vault, sessionNames: async () => new Map<string, string>(), listRoomRows: () => [] as AuthoredRoomRow[] };
    await expect(channelBlockFor(deps, { id: 'room-2', name: '#quiet' })).resolves.toBe('');
    await expect(
      channelBlockFor({ ...deps, listRoomRows: () => { throw new Error('db closed'); } }, { id: 'room-2', name: '#quiet' }),
    ).resolves.toBe('');
  });
});
