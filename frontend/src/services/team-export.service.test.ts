import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TEAM_EXPORT_API,
  TeamPackageApiError,
  describeImport,
  describeKnowledge,
  describePackage,
  downloadTeamPackage,
  fetchTeamPackage,
  importTeamPackage,
  packageFileName,
  readTeamPackageFile,
  type TeamPackage,
} from './team-export.service';

const portability = { redactions: 2, scanClean: true, connectors: ['google-workspace'], strippedFields: ['agentId'] };
const pkg: TeamPackage = {
  version: '1.1',
  exportedAt: '2026-10-25T12:00:00.000Z',
  team: { id: 't1', name: 'CE Site', members: [{}, {}, {}] },
  prompts: { a: 'x', b: 'y' },
  norms: {},
  cronTasks: [{}],
  portability,
};

const reply = (status: number, body: unknown): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('team-export.service', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds paths and file names', () => {
    expect(TEAM_EXPORT_API.exportPath('a b')).toBe('/api/teams/a%20b/export');
    expect(packageFileName('CE Site!', '2026-10-25T12:00:00Z')).toBe('crewly-team-ce-site-2026-10-25.json');
    expect(packageFileName('***', '2026-10-25T12:00:00Z')).toBe('crewly-team-team-2026-10-25.json');
  });

  it('fetches a package and unwraps the envelope', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, data: pkg }));
    expect(await fetchTeamPackage('t1')).toEqual(pkg);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/teams/t1/export');
  });

  it('turns a refusal into a TeamPackageApiError with the backend message', async () => {
    fetchMock.mockResolvedValue(reply(403, { success: false, error: 'owner_only', message: 'Only the owner can export or import a team package.' }));
    await expect(fetchTeamPackage('t1')).rejects.toMatchObject({ name: 'TeamPackageApiError', status: 403, message: 'Only the owner can export or import a team package.' });
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('no json'); } } as unknown as Response);
    await expect(fetchTeamPackage('t1')).rejects.toBeInstanceOf(TeamPackageApiError);
  });

  it('downloads the package under its file name', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, data: pkg }));
    const download = vi.fn();
    const out = await downloadTeamPackage('t1', download);
    expect(out.fileName).toBe('crewly-team-ce-site-2026-10-25.json');
    expect(download).toHaveBeenCalledWith('crewly-team-ce-site-2026-10-25.json', expect.stringContaining('"version": "1.1"'));
    expect(JSON.parse(download.mock.calls[0][1])).toEqual(pkg);
  });

  it('describes a package', () => {
    expect(describePackage(pkg)).toBe(
      '3 members, 2 prompts, 0 norms, 1 schedule. Secrets masked: 2; final scan clean. Reconnect after import: google-workspace. Wiki: not recorded by this package version. Running state and credentials are not in the file.',
    );
    const knowledge = { included: true, pages: 3, bytes: 900, skipped: ['llm-curated/digests/huge.md'] };
    expect(describePackage({ ...pkg, wiki: { 'llm-curated/index.md': '# Index', 'a.md': 'A' }, portability: { ...portability, knowledge } })).toContain('Wiki: 2 of 3 pages included. 1 skipped as too large.');
    expect(describePackage({ ...pkg, portability: { ...portability, scanClean: false, connectors: [] } })).toContain('open the file before sharing it');
    expect(describePackage({ ...pkg, portability: undefined })).toBe('3 members, 2 prompts, 0 norms, 1 schedule. Running state and credentials are not in the file.');
  });

  it('describes the knowledge and asks for it in the export path', () => {
    expect(describeKnowledge(undefined, 0)).toBe('Wiki: not recorded by this package version.');
    expect(describeKnowledge({ included: false, pages: 0, bytes: 0, skipped: [] }, 0)).toBe('Wiki: the team has no pages.');
    expect(describeKnowledge({ included: false, pages: 1, bytes: 10, skipped: [] }, 0)).toBe("Wiki: 1 page stayed on this machine (export with the wiki to include the team's knowledge).");
    expect(describeKnowledge({ included: true, pages: 14, bytes: 9000, skipped: [] }, 14)).toBe('Wiki: 14 of 14 pages included.');
    expect(TEAM_EXPORT_API.exportPath('t1', true)).toBe('/api/teams/t1/export?wiki=1');
    expect(TEAM_EXPORT_API.exportPath('t1')).toBe('/api/teams/t1/export');
  });

  it('reads a package file, unwrapping a saved API answer', async () => {
    const file = (name: string, text: string): File => ({ name, text: async () => text }) as unknown as File;
    expect(await readTeamPackageFile(file('p.json', JSON.stringify(pkg)))).toEqual(pkg);
    expect(await readTeamPackageFile(file('a.json', JSON.stringify({ success: true, data: pkg })))).toEqual(pkg);
    await expect(readTeamPackageFile(file('x.json', '{nope'))).rejects.toThrow('x.json is not a JSON file.');
    await expect(readTeamPackageFile(file('y.json', JSON.stringify({ hello: 1 })))).rejects.toThrow('not a Crewly team package');
  });

  it('posts an import and describes the result', async () => {
    const result = { team: { id: 't2', name: 'CE Site' }, promptsImported: 2, normsImported: 0, cronTasksImported: 1, connectorsToReconnect: ['google-workspace'] };
    fetchMock.mockResolvedValue(reply(200, { success: true, data: result }));
    expect(await importTeamPackage(pkg)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/teams/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).team.name).toBe('CE Site');
    expect(describeImport(result)).toBe('2 prompts, 0 norms, 1 schedule, 0 wiki pages. Members are inactive until you start them. Reconnect on this machine: google-workspace (Settings › Connectors).');
    expect(describeImport({ ...result, wikiPagesImported: 3, wikiPagesRejected: ['../x.md'] })).toContain('3 wiki pages. Members are inactive until you start them. 1 wiki page refused (unsafe path).');
    expect(describeImport({ ...result, connectorsToReconnect: [] })).not.toContain('Reconnect');
  });
});
