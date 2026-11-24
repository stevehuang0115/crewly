/**
 * Tests for channel pages.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHANNEL_PAGE_CONSTANTS } from '../../constants.js';
import {
  applyChannelPagePatch,
  channelIdTag,
  channelPageRelativePath,
  channelSlug,
  parseChannelPage,
  readChannelPage,
  recentThreadsOf,
  renderChannelBlock,
  renderChannelPageBody,
  writeChannelPage,
  type ChannelPage,
  type RoomRow,
} from './channel-page.js';
import { checkRetention, parsePage } from './wiki-page.js';

const T0 = Date.UTC(2026, 10, 21, 12);
const msg = (id: string, over: Partial<RoomRow> = {}): RoomRow => ({ id, threadId: null, senderType: 'user', senderId: 'U1', content: `message ${id}`, createdAt: T0, ...over });

describe('channel-page', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-page-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true, maxRetries: 3 });
  });

  describe('paths', () => {
    it('slugs a room name', () => {
      expect(channelSlug('#necina')).toBe('necina');
      expect(channelSlug('#Mini CE')).toBe('mini-ce');
      expect(channelSlug('内容 团队')).toBe('内容-团队');
      expect(channelSlug('###')).toBe('channel');
      expect(channelPageRelativePath({ name: '#necina' })).toBe('llm-curated/channels/necina.md');
      expect(channelPageRelativePath({ name: '#necina', id: 'room-1' })).toBe(`llm-curated/channels/necina-${channelIdTag('room-1')}.md`);
      expect(channelIdTag('room-1')).toMatch(/^[0-9a-f]{6}$/);
    });
  });

  describe('applyChannelPagePatch', () => {
    const base: ChannelPage = { channelName: '#necina', covers: [{ who: 'Pia', what: 'video' }] };

    it('sets and clears the lead and purpose', () => {
      const set = applyChannelPagePatch(base, { lead: ' Atlas ', purpose: 'NECINA talk\nprep' });
      expect(set.lead).toBe('Atlas');
      expect(set.purpose).toBe('NECINA talk prep');
      const cleared = applyChannelPagePatch(set, { lead: '', purpose: '' });
      expect(cleared.lead).toBeUndefined();
      expect(cleared.purpose).toBeUndefined();
    });

    it('adds a cover line, replaces the line of the same name, removes one', () => {
      const added = applyChannelPagePatch(base, { cover: { who: 'Atlas', what: 'talk outline' } });
      expect(added.covers).toEqual([{ who: 'Pia', what: 'video' }, { who: 'Atlas', what: 'talk outline' }]);
      const replaced = applyChannelPagePatch(added, { cover: { who: 'pia', what: 'video and editing' } });
      expect(replaced.covers).toEqual([{ who: 'Atlas', what: 'talk outline' }, { who: 'pia', what: 'video and editing' }]);
      expect(applyChannelPagePatch(replaced, { uncover: 'ATLAS' }).covers).toEqual([{ who: 'pia', what: 'video and editing' }]);
      expect(base.covers).toHaveLength(1);
    });

    it('ignores an empty cover line and caps the notes', () => {
      expect(applyChannelPagePatch(base, { cover: { who: 'Atlas', what: '  ' } }).covers).toHaveLength(1);
      const long = applyChannelPagePatch(base, { notes: 'x'.repeat(CHANNEL_PAGE_CONSTANTS.NOTES_MAX_CHARS + 50) });
      expect(long.notes).toHaveLength(CHANNEL_PAGE_CONSTANTS.NOTES_MAX_CHARS);
      expect(applyChannelPagePatch(long, { notes: '' }).notes).toBeUndefined();
    });
  });

  describe('read and write', () => {
    it('returns null before the first write', async () => {
      await expect(readChannelPage(vault, { name: '#necina', id: 'room-1' })).resolves.toBeNull();
    });

    it('writes a page that passes the wiki retention gate and reads back the same', async () => {
      const now = new Date(T0);
      await writeChannelPage(vault, { name: '#necina', id: 'room-1' }, { lead: 'Atlas', purpose: 'NECINA talk prep' }, 'flopost-pia-1', now);
      const written = await writeChannelPage(vault, { name: '#necina', id: 'room-1' }, { cover: { who: 'Pia', what: 'video and editing' }, notes: 'Decided: three parts.' }, 'crewly-orc', new Date(T0 + 1000));

      const raw = fs.readFileSync(path.join(vault, channelPageRelativePath({ name: '#necina', id: 'room-1' })), 'utf8');
      const { frontmatter, body } = parsePage(raw);
      expect(checkRetention(frontmatter)).toBeNull();
      expect(frontmatter.source).toBe(CHANNEL_PAGE_CONSTANTS.SOURCE);
      expect(frontmatter['lead_set_by']).toBe('flopost-pia-1');
      expect(frontmatter.recorded).toBe(now.toISOString());
      expect(body).toContain('## Lead\nAtlas');
      expect(body).toContain('- Pia: video and editing');

      const read = await readChannelPage(vault, { name: '#necina', id: 'room-1' });
      expect(read).toEqual(written);
      expect(read).toMatchObject({ channelId: 'room-1', lead: 'Atlas', purpose: 'NECINA talk prep', notes: 'Decided: three parts.' });
    });

    it('two rooms whose names slug alike keep separate pages; a renamed room keeps its page', async () => {
      await writeChannelPage(vault, { name: '#a-b', id: 'room-1' }, { lead: 'Atlas' }, 'owner');
      await writeChannelPage(vault, { name: '#a b', id: 'room-2' }, { lead: 'Pia' }, 'owner');
      expect((await readChannelPage(vault, { name: '#a-b', id: 'room-1' }))?.lead).toBe('Atlas');
      expect((await readChannelPage(vault, { name: '#a b', id: 'room-2' }))?.lead).toBe('Pia');

      await writeChannelPage(vault, { name: '#renamed', id: 'room-1' }, { purpose: 'New name' }, 'owner');
      const renamed = await readChannelPage(vault, { name: '#renamed', id: 'room-1' });
      expect(renamed).toMatchObject({ channelName: '#renamed', lead: 'Atlas', purpose: 'New name' });
      expect(fs.readdirSync(path.join(vault, 'llm-curated/channels'))).toHaveLength(2);
    });

    it('text that reads like the Notes heading does not leak the page into the notes', async () => {
      const room = { name: '#necina', id: 'room-1' };
      await writeChannelPage(vault, room, { purpose: 'see the ## Notes', lead: '## Notes', cover: { who: 'Ella', what: 'keeps ## Notes' }, notes: 'Real note.\n## Notes\nstill a note' }, 'owner');
      const once = await readChannelPage(vault, room);
      expect(once?.notes).toBe('Real note.\n## Notes\nstill a note');
      await writeChannelPage(vault, room, { purpose: 'changed' }, 'owner');
      expect((await readChannelPage(vault, room))?.notes).toBe(once?.notes);
    });

    it('parses a page with nothing recorded', () => {
      const page = parseChannelPage(renderChannelPageBody({ channelName: '#x', covers: [] }), '#x');
      expect(page).toEqual({ channelName: '#x', covers: [] });
    });
  });

  describe('recentThreadsOf', () => {
    const nameOf = (row: RoomRow): string | null => (row.senderType === 'agent' ? row.senderId : null);

    it('lists threads a person opened with the agents that answered, newest first', () => {
      const threads = recentThreadsOf(
        [
          msg('a', { content: 'What goes in the Saturday talk?' }),
          msg('a1', { threadId: 'a', senderType: 'agent', senderId: 'Atlas' }),
          msg('a2', { threadId: 'a', senderType: 'agent', senderId: 'Atlas' }),
          msg('a3', { threadId: 'a', senderType: 'agent', senderId: 'Pia' }),
          msg('b', { content: 'Cut the video to 60s', createdAt: T0 + 5000 }),
        ],
        nameOf,
      );
      expect(threads).toEqual([
        { at: T0 + 5000, opening: 'Cut the video to 60s', answeredBy: [] },
        { at: T0, opening: 'What goes in the Saturday talk?', answeredBy: ['Atlas', 'Pia'] },
      ]);
    });

    it('skips a thread an agent opened and replies whose opening was not read', () => {
      const threads = recentThreadsOf(
        [msg('x', { senderType: 'agent', senderId: 'Atlas' }), msg('y1', { threadId: 'old-root', senderType: 'agent', senderId: 'Pia' })],
        nameOf,
      );
      expect(threads).toEqual([]);
    });
  });

  describe('renderChannelBlock', () => {
    it('is empty when nothing is known', () => {
      expect(renderChannelBlock({ channelName: '#x', page: null, recent: [] })).toBe('');
      expect(renderChannelBlock({ channelName: '#x', page: { channelName: '#x', covers: [] }, recent: [] })).toBe('');
    });

    it('shows lead, covers, notes, recent threads and the record command', () => {
      const block = renderChannelBlock({
        channelName: '#necina',
        page: { channelName: '#necina', lead: 'Atlas', purpose: 'Talk prep', covers: [{ who: 'Pia', what: 'video' }], notes: 'Decided: three parts.' },
        recent: [{ at: T0, opening: 'What goes in the talk?', answeredBy: ['Atlas'] }],
        recordCommand: '`cmd`',
        readCommand: '`read`',
      });
      expect(block).toContain('Purpose: Talk prep');
      expect(block).toContain('Lead: Atlas');
      expect(block).toContain('- Pia: video');
      expect(block).toContain('Decided: three parts.');
      expect(block).toContain('- 11-21 "What goes in the talk?" — Atlas');
      expect(block).toContain('record it right away: `cmd`');
      expect(block.endsWith('[end of channel notes]')).toBe(true);
    });

    it('with threads but no page, says nobody is named lead', () => {
      const block = renderChannelBlock({ channelName: '#x', page: null, recent: [{ at: T0, opening: 'q', answeredBy: [] }] });
      expect(block).toContain('Lead: nobody named yet');
      expect(block).toContain('no agent answered');
    });

    it('clips an oversized block', () => {
      const block = renderChannelBlock({
        channelName: '#x',
        page: { channelName: '#x', covers: Array.from({ length: 20 }, (_, i) => ({ who: `Agent${i}`, what: 'w'.repeat(190) })) },
        recent: [],
      });
      expect(block.length).toBeLessThanOrEqual(CHANNEL_PAGE_CONSTANTS.BLOCK_MAX_CHARS + 40);
      expect(block.endsWith('[end of channel notes]')).toBe(true);
    });
  });
});
