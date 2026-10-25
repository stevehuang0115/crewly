import fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { defaultPackageFileName, describeKnowledge, teamExportCommand, teamImportCommand } from './team-export.js';

jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => (s: string) => s }),
}));

const reply = (status: number, json: unknown): Response => ({ ok: status < 400, status, json: async () => json }) as unknown as Response;

const pkg = {
  version: '1.1',
  exportedAt: '2026-10-25T12:00:00.000Z',
  team: { id: '5ad0642a-66dd-46b7-9744-c968123c1691', name: 'CE Site', members: [{ id: 'm1' }, { id: 'm2' }] },
  prompts: { m1: 'You run Gmail' },
  norms: { 'sop.md': '# SOP' },
  cronTasks: [{ id: 'cron-1' }],
  portability: { redactions: 2, scanClean: true, connectors: ['google-workspace'], strippedFields: ['agentId'] },
};

describe('crewly team export', () => {
  let lines: string[];
  let dir: string;
  const print = (l: string): void => void lines.push(l);
  beforeEach(async () => {
    lines = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-team-export-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('names the file after the team and the day', () => {
    expect(defaultPackageFileName('CE Site!', '2026-10-25T12:00:00Z')).toBe('crewly-team-ce-site-2026-10-25.json');
    expect(defaultPackageFileName('???', '2026-10-25T12:00:00Z')).toBe('crewly-team-team-2026-10-25.json');
  });

  it('resolves the team by name, writes the package and summarizes it', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(reply(200, { success: true, data: [{ id: pkg.team.id, name: 'CE Site' }, { id: 'other', name: 'Other' }] }))
      .mockResolvedValueOnce(reply(200, { success: true, data: pkg }));
    const out = path.join(dir, 'ce.json');
    expect(await teamExportCommand('ce site', { out }, print, fetchImpl as never)).toBe(0);
    expect(fetchImpl.mock.calls[0]![0]).toMatch(/\/api\/teams$/);
    expect(fetchImpl.mock.calls[1]![0]).toMatch(new RegExp(`/api/teams/${pkg.team.id}/export$`));
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toEqual(pkg);
    const text = lines.join('\n');
    expect(text).toContain('Exported CE Site');
    expect(text).toContain('members: 2, prompts: 1, norms: 1, schedules: 1');
    expect(text).toContain('secrets masked: 2; final scan clean');
    expect(text).toContain('reconnect after import: google-workspace');
  });

  it('asks for the wiki with --wiki and reports what travelled', async () => {
    const withWiki = {
      ...pkg,
      version: '1.2',
      wiki: { 'llm-curated/index.md': '# Index', 'llm-curated/decisions/a.md': 'A' },
      portability: { ...pkg.portability, knowledge: { included: true, pages: 3, bytes: 900, skipped: ['llm-curated/digests/huge.md'] } },
    };
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: withWiki }));
    expect(await teamExportCommand(pkg.team.id, { out: path.join(dir, 'w.json'), wiki: true }, print, fetchImpl as never)).toBe(0);
    expect(fetchImpl.mock.calls[0]![0]).toMatch(/\/export\?wiki=1$/);
    expect(lines.join('\n')).toContain('wiki: 2 of 3 page(s) included; 1 skipped as too large: llm-curated/digests/huge.md');
  });

  it('describes the knowledge in one line', () => {
    expect(describeKnowledge(undefined, 0)).toBe('wiki: not recorded by this package version');
    expect(describeKnowledge({ included: false, pages: 0, bytes: 0, skipped: [] }, 0)).toBe('wiki: the team has no pages');
    expect(describeKnowledge({ included: false, pages: 14, bytes: 9000, skipped: [] }, 0)).toBe("wiki: 14 page(s) stayed on this machine — add --wiki to include the team's knowledge");
    expect(describeKnowledge({ included: true, pages: 14, bytes: 9000, skipped: [] }, 14)).toBe('wiki: 14 of 14 page(s) included');
  });

  it('skips the lookup when given an id', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: pkg }));
    await teamExportCommand(pkg.team.id, { out: path.join(dir, 'x.json') }, print, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toMatch(/\/export$/);
  });

  it('lists the teams when the name is unknown', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: [{ id: 'a', name: 'Alpha' }] }));
    expect(await teamExportCommand('Nope', {}, print, fetchImpl as never)).toBe(1);
    expect(lines[0]).toMatch(/No team named "Nope".*Alpha/);
  });

  it('exits 2 and warns when the final scan is not clean', async () => {
    const dirty = { ...pkg, portability: { ...pkg.portability, scanClean: false } };
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: dirty }));
    expect(await teamExportCommand(pkg.team.id, { out: path.join(dir, 'd.json') }, print, fetchImpl as never)).toBe(2);
    expect(lines.join('\n')).toMatch(/open the file before sharing/);
  });

  it('says so when Crewly is not running', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await teamExportCommand('CE', {}, print, fetchImpl as never)).toBe(1);
    expect(lines[0]).toMatch(/not running/);
  });

  it('relays an owner-only refusal', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(403, { success: false, error: 'owner_only', message: 'Only the owner can export or import a team package.' }));
    expect(await teamExportCommand(pkg.team.id, {}, print, fetchImpl as never)).toBe(1);
    expect(lines[0]).toMatch(/Only the owner/);
  });
});

describe('crewly team import', () => {
  let lines: string[];
  let dir: string;
  const print = (l: string): void => void lines.push(l);
  beforeEach(async () => {
    lines = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-team-import-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('posts the package and reports what to reconnect', async () => {
    const file = path.join(dir, 'p.json');
    await fs.writeFile(file, JSON.stringify(pkg));
    const result = { team: pkg.team, promptsImported: 1, normsImported: 1, cronTasksImported: 1, connectorsToReconnect: ['google-workspace'] };
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: result }));
    expect(await teamImportCommand(file, {}, print, fetchImpl as never)).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toMatch(/\/api\/teams\/import$/);
    expect(JSON.parse(init.body).version).toBe('1.1');
    const text = lines.join('\n');
    expect(text).toContain('Imported CE Site');
    expect(text).toContain('wiki pages: 0');
    expect(text).toMatch(/reconnect on this machine: google-workspace/);
  });

  it('unwraps a saved API answer', async () => {
    const file = path.join(dir, 'answer.json');
    await fs.writeFile(file, JSON.stringify({ success: true, data: pkg }));
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { success: true, data: { team: pkg.team, promptsImported: 0, normsImported: 0, cronTasksImported: 0 } }));
    expect(await teamImportCommand(file, {}, print, fetchImpl as never)).toBe(0);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).team.name).toBe('CE Site');
  });

  it('rejects a file that is not a package', async () => {
    const file = path.join(dir, 'x.json');
    await fs.writeFile(file, JSON.stringify({ hello: 1 }));
    expect(await teamImportCommand(file, {}, print, jest.fn())).toBe(1);
    expect(lines[0]).toMatch(/not a Crewly team package/);
  });

  it('reports an unreadable file and a backend refusal', async () => {
    expect(await teamImportCommand(path.join(dir, 'missing.json'), {}, print, jest.fn())).toBe(1);
    expect(lines[0]).toMatch(/Cannot read/);
    const file = path.join(dir, 'p.json');
    await fs.writeFile(file, JSON.stringify(pkg));
    const fetchImpl = jest.fn().mockResolvedValue(reply(400, { success: false, message: 'Unsupported team export version: 9.0 (this Crewly reads 1.0, 1.1)' }));
    expect(await teamImportCommand(file, {}, print, fetchImpl as never)).toBe(1);
    expect(lines.at(-1)).toMatch(/Unsupported team export version/);
  });
});
