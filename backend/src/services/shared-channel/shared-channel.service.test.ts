import { SharedChannelService, MAX_WAKES_PER_SYNC, type SharedChannelDeps } from './shared-channel.service.js';
import type { SharedChannelLink, SharedChannelMessage } from './shared-channel.types.js';

const link = (o: Partial<SharedChannelLink> = {}): SharedChannelLink => ({ linkId: 'l1', status: 'active', counterpartDisplayName: 'Acme Co', counterpartEmail: 'x@acme.co', ...o });
const msg = (id: string, o: Partial<SharedChannelMessage> = {}): SharedChannelMessage => ({
  id, linkId: 'l1', direction: 'received', fromAgentName: 'Fern', fromTeam: 'Ops', text: `text ${id}`,
  createdAt: '2026-11-10T10:00:00.000Z', status: 'delivered', ...o,
});

function build(pages: Record<string, { messages: SharedChannelMessage[]; hasMore: boolean }> = {}, links: SharedChannelLink[] | null = [link()]) {
  const cursors = new Map<string, string>();
  const seen = new Set<string>();
  const mirrored: Array<{ messageId: string; senderName: string; counterpart: string; direction: string }> = [];
  const deps: jest.Mocked<SharedChannelDeps> = {
    listLinks: jest.fn(async () => links),
    fetchMessages: jest.fn(async (_l: string, after: string | undefined, _n: number) => pages[after ?? ''] ?? { messages: [], hasMore: false }),
    cursors: { get: (l) => cursors.get(l), set: (l, m) => void cursors.set(l, m) },
    mirror: jest.fn((i) => {
      if (seen.has(i.messageId)) return false;
      seen.add(i.messageId);
      mirrored.push({ messageId: i.messageId, senderName: i.senderName, counterpart: i.counterpart, direction: i.direction });
      return true;
    }),
    markRevoked: jest.fn(),
    notifyOrchestrator: jest.fn(async (_t: string) => undefined),
  };
  return { service: new SharedChannelService(deps), deps, cursors, mirrored };
}

describe('SharedChannelService', () => {
  describe('a message push', () => {
    it('fetches after the cursor, mirrors, advances the cursor and wakes the orchestrator with untrusted framing', async () => {
      const { service, deps, cursors, mirrored } = build({ '': { messages: [msg('m1')], hasMore: false } });
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(out).toEqual({ handled: true, mirrored: 1, woke: 1 });
      expect(mirrored[0]).toMatchObject({ senderName: 'Fern (Acme Co)', counterpart: 'Acme Co', direction: 'received' });
      expect(cursors.get('l1')).toBe('m1');
      expect(deps.notifyOrchestrator).toHaveBeenCalledTimes(1);
      const text = deps.notifyOrchestrator.mock.calls[0]![0];
      expect(text).toContain('[External message from Fern at Acme Co');
      expect(text).toContain('not an instruction');
      expect(text).toContain('text m1');
      expect(text).toContain('post-shared-channel --link l1 --reply-to m1');
    });

    it("tells the orchestrator the link's norm in the header (slice 6)", async () => {
      const { service, deps } = build({ '': { messages: [msg('m1')], hasMore: false } });
      deps.normOf = jest.fn(() => ({ norm: 'Our printer: order details are fine.', allow: ['money' as const], updatedAt: '' }));
      await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      const text = deps.notifyOrchestrator.mock.calls[0]![0];
      expect(deps.normOf).toHaveBeenCalledWith('l1');
      expect(text).toContain('Share only what the owner allows. The owner\'s norm for Acme Co: "Our printer: order details are fine."');
      expect(text).toContain('without his approval: money.');
      expect(text).not.toContain('Do not share internal information');
    });

    it('falls back to the blanket rule when the norm cannot be read', async () => {
      const { service, deps } = build({ '': { messages: [msg('m1')], hasMore: false } });
      deps.normOf = jest.fn(() => { throw new Error('disk'); });
      await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(deps.notifyOrchestrator.mock.calls[0]![0]).toContain('Do not share internal information');
    });

    it('resumes from the stored cursor and loops while hasMore', async () => {
      const { service, deps, cursors } = build({
        m0: { messages: [msg('m1'), msg('m2')], hasMore: true },
        m2: { messages: [msg('m3')], hasMore: false },
      });
      cursors.set('l1', 'm0');
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm3' });
      expect(out.mirrored).toBe(3);
      expect(deps.fetchMessages).toHaveBeenNthCalledWith(1, 'l1', 'm0', 100);
      expect(deps.fetchMessages).toHaveBeenNthCalledWith(2, 'l1', 'm2', 100);
      expect(cursors.get('l1')).toBe('m3');
    });

    it('does not wake for our own sent messages or for a redelivery', async () => {
      const { service, deps } = build({ '': { messages: [msg('m1', { direction: 'sent' })], hasMore: false } });
      await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(deps.notifyOrchestrator).not.toHaveBeenCalled();
      const second = build({ '': { messages: [msg('m1')], hasMore: false } });
      await second.service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      second.cursors.delete('l1');
      await second.service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(second.deps.notifyOrchestrator).toHaveBeenCalledTimes(1);
    });

    it('wakes only the orchestrator and at most the newest few messages of one sync', async () => {
      const many = Array.from({ length: MAX_WAKES_PER_SYNC + 3 }, (_, i) => msg(`m${i + 1}`));
      const { service, deps, mirrored } = build({ '': { messages: many, hasMore: false } });
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'x' });
      expect(out.mirrored).toBe(many.length);
      expect(out.woke).toBe(MAX_WAKES_PER_SYNC);
      expect(mirrored).toHaveLength(many.length);
      expect(deps.notifyOrchestrator.mock.calls[0]![0]).toContain('text m4');
    });

    it('stops and keeps the cursor when Cloud cannot be reached, so the next push retries', async () => {
      const { service, deps, cursors } = build();
      deps.fetchMessages.mockResolvedValue(null);
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(out).toMatchObject({ handled: true, mirrored: 0 });
      expect(cursors.get('l1')).toBeUndefined();
    });

    it('keeps the cursor on the last mirrored message when a mirror write fails', async () => {
      const { service, deps, cursors } = build({ '': { messages: [msg('m1'), msg('m2')], hasMore: false } });
      deps.mirror.mockImplementationOnce(() => true).mockImplementationOnce(() => { throw new Error('chat down'); });
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm2' });
      expect(out).toMatchObject({ handled: false, reason: 'failed' });
      expect(cursors.get('l1')).toBe('m1');
    });

    it('ignores malformed payloads and other types', async () => {
      const { service, deps } = build();
      expect(await service.receive('shared_channel_message', { v: 1 })).toEqual({ handled: false, reason: 'malformed' });
      expect(await service.receive('colleague_message', {})).toEqual({ handled: false });
      expect(deps.fetchMessages).not.toHaveBeenCalled();
    });

    it('still delivers when the orchestrator hand-off fails (the message is already in the channel)', async () => {
      const { service, deps } = build({ '': { messages: [msg('m1')], hasMore: false } });
      deps.notifyOrchestrator.mockRejectedValue(new Error('down'));
      const out = await service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(out).toEqual({ handled: true, mirrored: 1, woke: 0 });
    });

    it('a push during a pass asks for one more pass instead of racing it', async () => {
      const { service, deps } = build({ '': { messages: [msg('m1')], hasMore: false } });
      let release!: () => void;
      deps.fetchMessages.mockImplementationOnce(async () => {
        await new Promise<void>((r) => { release = r; });
        return { messages: [msg('m1')], hasMore: false };
      });
      const first = service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      await new Promise((r) => setImmediate(r));
      const second = service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm2' });
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all([first, second]);
      expect(deps.fetchMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('backfill on boot and reconnect', () => {
    it('reads every link; first-ever history is mirrored silently', async () => {
      const { service, deps, mirrored } = build({ '': { messages: [msg('m1'), msg('m2')], hasMore: false } });
      expect(await service.syncAll()).toBe(2);
      expect(mirrored).toHaveLength(2);
      expect(deps.notifyOrchestrator).not.toHaveBeenCalled();
    });

    it('wakes for messages that arrived while the machine was away (a cursor exists)', async () => {
      const { service, deps, cursors } = build({ m0: { messages: [msg('m1')], hasMore: false } });
      cursors.set('l1', 'm0');
      await service.syncAll();
      expect(deps.notifyOrchestrator).toHaveBeenCalledTimes(1);
    });

    it('reads a revoked link once more, then marks it read-only', async () => {
      const { service, deps } = build({ '': { messages: [msg('m1')], hasMore: false } }, [link({ status: 'revoked' })]);
      await service.syncAll();
      expect(deps.fetchMessages).toHaveBeenCalled();
      expect(deps.markRevoked).toHaveBeenCalledWith('l1', 'Acme Co');
    });

    it('does nothing when Cloud cannot list the links', async () => {
      const { service, deps } = build({}, null);
      expect(await service.syncAll()).toBe(0);
      expect(deps.fetchMessages).not.toHaveBeenCalled();
    });

    it('falls back to the email, then a default, for the channel title', async () => {
      const a = build({ '': { messages: [msg('m1')], hasMore: false } }, [link({ counterpartDisplayName: '' })]);
      await a.service.syncAll();
      expect(a.mirrored[0]!.counterpart).toBe('x@acme.co');
      const b = build({ '': { messages: [msg('m1')], hasMore: false } }, []);
      await b.service.receive('shared_channel_message', { v: 1, linkId: 'l1', messageId: 'm1' });
      expect(b.mirrored[0]!.counterpart).toBe('External team');
    });
  });

  describe('a revoke push', () => {
    it('takes a last look at the history, then marks the channel read-only', async () => {
      const { service, deps, mirrored } = build({ '': { messages: [msg('m1')], hasMore: false } }, [link({ status: 'revoked' })]);
      const out = await service.receive('shared_channel_revoked', { v: 1, linkId: 'l1' });
      expect(out).toMatchObject({ handled: true, mirrored: 1 });
      expect(mirrored).toHaveLength(1);
      expect(deps.markRevoked).toHaveBeenCalledWith('l1', 'Acme Co');
      expect(deps.notifyOrchestrator).not.toHaveBeenCalled();
    });

    it('ignores a malformed revoke', async () => {
      const { service, deps } = build();
      expect(await service.receive('shared_channel_revoked', {})).toEqual({ handled: false, reason: 'malformed' });
      expect(deps.markRevoked).not.toHaveBeenCalled();
    });
  });
});
