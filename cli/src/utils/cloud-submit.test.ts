/**
 * Tests for cli/utils/cloud-submit.
 *
 * `fs` and `axios` are mocked (matching the cloud.test.ts pattern) so we can
 * drive loadCloudToken / collectSkillFiles / submitToCloud without real I/O.
 */

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockStatSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a),
  readFileSync: (...a: any[]) => mockReadFileSync(...a),
  readdirSync: (...a: any[]) => mockReaddirSync(...a),
  statSync: (...a: any[]) => mockStatSync(...a),
}));

const mockAxiosPost = jest.fn();
const mockIsAxiosError = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...a: any[]) => mockAxiosPost(...a),
    isAxiosError: (e: any) => mockIsAxiosError(e),
  },
}));

import { loadCloudToken, collectSkillFiles, submitToCloud } from './cloud-submit.js';

/** Build a Dirent-like entry. */
function dirent(name: string, kind: 'file' | 'dir') {
  return { name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file' };
}

const manifest = {
  id: 'my-skill',
  name: 'My Skill',
  description: 'd',
  version: '1.0.0',
  category: 'productivity',
  assignableRoles: ['agent'],
  tags: ['x'],
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAxiosError.mockReturnValue(false);
});

describe('loadCloudToken', () => {
  it('returns null when the config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadCloudToken()).toBeNull();
  });

  it('returns the token and cloudUrl when present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ token: 'jwt', cloudUrl: 'https://c' }));
    expect(loadCloudToken()).toEqual({ token: 'jwt', cloudUrl: 'https://c' });
  });

  it('returns null when the file has no token', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ cloudUrl: 'https://c' }));
    expect(loadCloudToken()).toBeNull();
  });
});

describe('collectSkillFiles', () => {
  it('walks the dir, base64-encodes files, and marks .sh executable', () => {
    mockReaddirSync.mockImplementation((dir: unknown) => {
      if ((dir as string).endsWith('my-skill')) {
        return [dirent('skill.json', 'file'), dirent('execute.sh', 'file'), dirent('sub', 'dir')];
      }
      return [dirent('nested.md', 'file')];
    });
    mockReadFileSync.mockImplementation((p: unknown) => Buffer.from(`data:${p}`));
    mockStatSync.mockReturnValue({ mode: 0o644 });

    const files = collectSkillFiles('/abs/my-skill');
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['execute.sh', 'skill.json', 'sub/nested.md']);

    const sh = files.find((f) => f.path === 'execute.sh')!;
    expect(sh.executable).toBe(true); // .sh → executable even with 0o644 mode
    expect(Buffer.from(sh.contentBase64, 'base64').toString()).toContain('data:');

    const json = files.find((f) => f.path === 'skill.json')!;
    expect(json.executable).toBe(false);
  });

  it('throws when the total size exceeds the cap', () => {
    mockReaddirSync.mockReturnValue([dirent('big.bin', 'file')]);
    mockReadFileSync.mockReturnValue(Buffer.alloc(3 * 1024 * 1024));
    mockStatSync.mockReturnValue({ mode: 0o644 });
    expect(() => collectSkillFiles('/abs/my-skill')).toThrow(/size limit/);
  });
});

describe('submitToCloud', () => {
  function loggedIn() {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('config.json')) return JSON.stringify({ token: 'jwt', cloudUrl: 'https://c' });
      return Buffer.from('file');
    });
    mockReaddirSync.mockReturnValue([dirent('skill.json', 'file')]);
    mockStatSync.mockReturnValue({ mode: 0o644 });
  }

  it('throws a login hint when not logged in', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(submitToCloud('/abs/my-skill', manifest)).rejects.toThrow(/crewly cloud login/);
  });

  it('posts to the cloud and returns the PR result', async () => {
    loggedIn();
    mockAxiosPost.mockResolvedValue({
      data: { prUrl: 'https://github.com/x/y/pull/1', branch: 'skill/my-skill', updated: false },
    });
    const res = await submitToCloud('/abs/my-skill', manifest);
    expect(res.prUrl).toBe('https://github.com/x/y/pull/1');

    const [url, payload, config] = mockAxiosPost.mock.calls[0] as [string, { manifest: { id: string }; files: unknown[] }, { headers: Record<string, string> }];
    expect(url).toBe('https://c/api/registry/submit');
    expect(payload.manifest.id).toBe('my-skill');
    expect(payload.files.length).toBe(1);
    expect(config.headers.Authorization).toBe('Bearer jwt');
  });

  it('maps a 401 to a re-login message', async () => {
    loggedIn();
    mockIsAxiosError.mockReturnValue(true);
    mockAxiosPost.mockRejectedValue({ response: { status: 401, data: { error: 'no' }, headers: {} } });
    await expect(submitToCloud('/abs/my-skill', manifest)).rejects.toThrow(/login\W+again/i);
  });

  it('maps a 429 to a rate-limit message with retry hint', async () => {
    loggedIn();
    mockIsAxiosError.mockReturnValue(true);
    mockAxiosPost.mockRejectedValue({
      response: { status: 429, data: { error: 'slow down' }, headers: { 'retry-after': '120' } },
    });
    await expect(submitToCloud('/abs/my-skill', manifest)).rejects.toThrow(/retry after 120s/);
  });
});
