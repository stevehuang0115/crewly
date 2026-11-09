/**
 * Tests for reading a meeting's sources: an agent's vaults are only its own
 * teams' and their projects', wiki hits become pages, pages lose their
 * frontmatter, the newest handover is read, and decision cards keep the
 * fields the pack uses.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Team } from '../../types/index.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { decisionSource, readLatestHandover, readWikiPage, stripFrontmatter, teamsOfAgent, vaultsOfAgent, wikiHitToPage } from './drive-meeting.wiring.js';

function team(over: Partial<Team>): Team {
  return { id: 't1', name: 'Marketing', members: [], projectIds: [], createdAt: '', updatedAt: '', ...over } as unknown as Team;
}

const member = (id: string, name: string, sessionName: string, role = 'developer') => ({ id, name, sessionName, role }) as never;

describe('vaults', () => {
  const teams = [
    team({ id: 't1', name: 'Marketing', members: [member('m1', 'Ella', 'ella', 'marketing-lead')], projectIds: ['p1'] }),
    team({ id: 't2', name: 'Engineering', members: [member('m2', 'Owen', 'owen')], projectIds: ['p2'] }),
  ];
  const projects = [
    { id: 'p1', name: 'Site', path: '/work/site' },
    { id: 'p2', name: 'Engine', path: '/work/engine' },
  ];

  it('an agent reads its teams’ vaults and their projects’, nothing else', () => {
    expect(teamsOfAgent(teams, 'ella').map((t) => [t.team.name, t.role])).toEqual([['Marketing', 'marketing-lead']]);
    expect(vaultsOfAgent(teams, projects, 'ella', '/home/u/.crewly')).toEqual([
      { vaultPath: path.resolve('/home/u/.crewly/teams/t1/wiki'), label: 'Marketing' },
      { vaultPath: path.resolve('/work/site/.crewly/wiki'), label: 'Site' },
    ]);
    expect(vaultsOfAgent(teams, projects, 'nobody', '/home/u/.crewly')).toEqual([]);
  });
});

describe('wiki pages', () => {
  it('a hit becomes a titled page with its file', () => {
    const page = wikiHitToPage({ relativePath: 'llm-curated/brand-voice.md', filenameMatch: false, matchCount: 2, score: 3, snippets: [{ lineNumber: 1, text: 'Short.' }, { lineNumber: 4, text: 'Warm.' }], vaultPath: '/v', vaultLabel: 'Marketing' });
    expect(page).toEqual({ title: 'brand voice', where: 'Marketing/llm-curated/brand-voice.md', text: 'Short. … Warm.', absPath: path.join('/v', 'llm-curated/brand-voice.md') });
  });

  it('frontmatter removed; a missing page is null', async () => {
    expect(stripFrontmatter('---\ntitle: x\n---\nBody here')).toBe('Body here');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-wiki-'));
    const file = path.join(dir, 'p.md');
    fs.writeFileSync(file, '---\na: 1\n---\nHello');
    expect(await readWikiPage(file)).toBe('Hello');
    expect(await readWikiPage(path.join(dir, 'none.md'))).toBeNull();
  });
});

describe('readLatestHandover', () => {
  it('the newest handover of that agent, title line removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-handover-'));
    const old = path.join(dir, 'ella-2026-10-01T00-00-00-000Z.md');
    const fresh = path.join(dir, 'ella-2026-10-20T00-00-00-000Z.md');
    fs.writeFileSync(old, '# Handover\nold');
    fs.writeFileSync(fresh, '# Handover\nfresh work');
    fs.writeFileSync(path.join(dir, 'owen-2026-10-21T00-00-00-000Z.md'), '# Handover\nowen');
    fs.utimesSync(old, new Date('2026-10-01'), new Date('2026-10-01'));
    expect(await readLatestHandover(dir, 'ella')).toBe('fresh work');
    expect(await readLatestHandover(dir, 'nova')).toBeNull();
  });
});

describe('decisionSource', () => {
  it('keeps the fields the pack uses', () => {
    const d = {
      id: 'D-1',
      question: 'A or B?',
      options: [{ key: 'a', label: 'A', detail: 'x' }],
      defaultKey: 'a',
      deadline: '',
      requestedBy: 'ella',
      asker: 'ella',
      status: 'open',
      card: { slackChannelId: 'C0X', messageTs: '1.2', postedBy: 'ella', ownBot: true },
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    } as unknown as OwnerDecision;
    expect(decisionSource(d)).toEqual({
      id: 'D-1',
      question: 'A or B?',
      status: 'open',
      asker: 'ella',
      requestedBy: 'ella',
      options: [{ key: 'a', label: 'A' }],
      card: { slackChannelId: 'C0X', messageTs: '1.2' },
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  });
});
