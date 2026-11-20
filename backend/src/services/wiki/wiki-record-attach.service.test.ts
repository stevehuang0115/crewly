import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WikiRecordAttachService,
  aliasesOf,
  countAlias,
  matchEntities,
  renderRecords,
  type EntityPage,
} from './wiki-record-attach.service.js';

const page = (over: Partial<EntityPage> & { title: string }): EntityPage => ({
  vaultPath: '/v',
  relativePath: `llm-curated/customers/${over.title.toLowerCase()}.md`,
  summary: '',
  aliases: [over.title],
  frontmatter: { title: over.title },
  body: '',
  ...over,
});

describe('countAlias', () => {
  it('matches a Latin name as a whole word, any case', () => {
    expect(countAlias('We met xin and Xin again', 'Xin')).toBe(2);
    expect(countAlias('taxing work', 'Xin')).toBe(0);
    expect(countAlias('RoboHub2 is not it', 'RoboHub')).toBe(0);
  });

  it('matches a CJK name inside running text', () => {
    expect(countAlias('今天刘欣回了邮件', '刘欣')).toBe(1);
  });

  it('ignores names too short to mean anything', () => {
    expect(countAlias('a b c ai', 'ai')).toBe(0);
    expect(countAlias('欣欣向荣', '欣')).toBe(0);
  });
});

describe('aliasesOf', () => {
  it('returns the title plus aliases, without duplicates', () => {
    expect(aliasesOf({ title: 'RoboHub', aliases: ['robohub', '刘欣', 'Xin', ' '] })).toEqual(['RoboHub', '刘欣', 'Xin']);
  });

  it('accepts a comma-separated string', () => {
    expect(aliasesOf({ title: 'A Co', aliases: 'Alpha, Al' })).toEqual(['A Co', 'Alpha', 'Al']);
  });
});

describe('matchEntities', () => {
  it('returns the pages named in the text, most mentioned first', () => {
    const robo = page({ title: 'RoboHub', aliases: ['RoboHub', 'Xin', 'Michael Zhang'] });
    const hanami = page({ title: 'Hanami', aliases: ['Hanami', 'Jack'] });
    const other = page({ title: 'Acme' });
    const got = matchEntities('Michael Zhang of RoboHub wrote; Jack has not. RoboHub again.', [hanami, other, robo]);
    expect(got.map((m) => m.page.title)).toEqual(['RoboHub', 'Hanami']);
    expect(got[0].matched).toEqual(['RoboHub', 'Michael Zhang']);
    expect(got[0].count).toBe(3);
  });
});

describe('renderRecords', () => {
  it('says nothing when nothing matched', () => {
    expect(renderRecords([], 0)).toBe('');
  });

  it('shows title, where the page is, the summary and the body', () => {
    const block = renderRecords(
      [{ page: page({ title: 'RoboHub', summary: 'In talks; proposal v5 sent 10/13.', body: '## Timeline\n- 10/9 call, 46 min', updated: '2026-11-19T10:00:00Z' }), matched: ['RoboHub'], count: 1 }],
      0,
    );
    expect(block).toContain('## RoboHub — customers/robohub.md, updated 2026-11-19 (matched: RoboHub)');
    expect(block).toContain('proposal v5 sent 10/13');
    expect(block).toContain('10/9 call, 46 min');
    expect(block).toContain('do not propose what a record says is already done');
    expect(block.endsWith('[end of records]')).toBe(true);
  });

  it('clips a long page and the whole block', () => {
    const long = page({ title: 'Big', body: 'x'.repeat(5000) });
    const block = renderRecords([{ page: long, matched: ['Big'], count: 1 }], 0);
    expect(block).toContain('clipped; the full page is customers/big.md');
    expect(block.length).toBeLessThan(2400);
  });

  it('mentions a restricted record without its content', () => {
    const block = renderRecords([], 1);
    expect(block).toContain('restricted to certain people');
    expect(block).not.toContain('##');
  });
});

describe('WikiRecordAttachService', () => {
  let vault: string;
  let usage: jest.Mock;
  let service: WikiRecordAttachService;

  const write = (folder: string, name: string, frontmatter: string, body: string): void => {
    const dir = join(vault, 'llm-curated', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `---\n${frontmatter}\n---\n${body}\n`);
  };

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'crewly-attach-'));
    usage = jest.fn();
    service = new WikiRecordAttachService({ recordUsage: usage });
    write('customers', 'robohub.md', 'title: RoboHub\nsummary: In talks; proposal v5 sent 10/13.\nkeep_because: hard_fact\naliases: [刘欣, Xin, Michael Zhang]', '## Timeline\n- 10/9 call with Xin, Michael, Jason (46 min)');
    write('customers', 'secret.md', 'title: Hanami\nsummary: Price floor.\nkeep_because: hard_fact\nvisible_to_people: [p-steve]', 'floor is 5k');
    write('people', 'old.md', 'title: Gone Co\nsummary: x\nkeep_because: hard_fact\nsuperseded_by: llm-curated/people/new.md', 'old');
    write('docs', 'unrelated.md', 'title: RoboHub notes\nsummary: x\nkeep_because: hard_fact', 'not an entity page');
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('attaches the page named in the thread and records it in the usage ledger', async () => {
    const block = await service.blockFor({
      agentSession: 'grace',
      text: 'Michael Zhang 来信问意见。\n我在想一般咨询行业的通用做法和流程是怎样的',
      vaultPaths: [vault],
      ownerOnlyAudience: false,
    });
    expect(block).toContain('## RoboHub — customers/robohub.md');
    expect(block).toContain('10/9 call with Xin');
    expect(usage).toHaveBeenCalledWith(vault, { via: 'attach', agent: 'grace', query: 'Michael Zhang', hits: ['llm-curated/customers/robohub.md'], miss: false });
  });

  it('returns nothing when no name is mentioned, and reads only the entity folders', async () => {
    expect(await service.blockFor({ agentSession: 'grace', text: 'How is the weather?', vaultPaths: [vault], ownerOnlyAudience: false })).toBe('');
    const pages = await service.listEntityPages(vault);
    expect(pages.map((p) => p.title).sort()).toEqual(['Hanami', 'RoboHub']);
  });

  it('withholds a page restricted to people outside a private conversation with the owner', async () => {
    const inRoom = await service.blockFor({ agentSession: 'grace', text: 'What about Hanami?', vaultPaths: [vault], ownerOnlyAudience: false });
    expect(inRoom).toContain('restricted to certain people');
    expect(inRoom).not.toContain('floor is 5k');

    const inDm = await service.blockFor({ agentSession: 'grace', text: 'What about Hanami?', vaultPaths: [vault], ownerOnlyAudience: true });
    expect(inDm).toContain('floor is 5k');
  });

  it('hides a page whose roles do not include the agent, without a notice', async () => {
    write('customers', 'lead-only.md', 'title: Zeta\nsummary: x\nkeep_because: hard_fact\nvisibility: [team-leader]', 'lead notes');
    service.invalidate();
    expect(await service.blockFor({ agentSession: 'dev', text: 'Zeta called', vaultPaths: [vault], viewerRole: 'developer', ownerOnlyAudience: true })).toBe('');
    expect(await service.blockFor({ agentSession: 'tl', text: 'Zeta called', vaultPaths: [vault], viewerRole: 'team-leader', ownerOnlyAudience: true })).toContain('lead notes');
  });

  it('delivers without records when a vault cannot be read', async () => {
    expect(await service.blockFor({ agentSession: 'grace', text: 'RoboHub', vaultPaths: ['/nonexistent/vault'], ownerOnlyAudience: false })).toBe('');
  });
});
