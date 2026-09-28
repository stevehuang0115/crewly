/**
 * Tests for keeping `.crewly/tickets/` tracked — real git in temp repos,
 * isolated from the machine's global git config and excludes.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ensureTicketsTracked } from './ticket-tracking.js';
import { runGit } from '../worktree/worktree-git.js';

describe('ensureTicketsTracked', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME'];

  beforeAll(async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-git-home-'));
    await fs.writeFile(path.join(isolated, 'gitconfig'), '');
    for (const k of ENV) saved[k] = process.env[k];
    process.env.GIT_CONFIG_GLOBAL = path.join(isolated, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.XDG_CONFIG_HOME = isolated;
  });

  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-tickets-git-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function initRepo(gitignore?: string): Promise<void> {
    await runGit(dir, ['init', '-q']);
    if (gitignore !== undefined) await fs.writeFile(path.join(dir, '.gitignore'), gitignore);
    await fs.mkdir(path.join(dir, '.crewly', 'tickets'), { recursive: true });
    await fs.mkdir(path.join(dir, '.crewly', 'requests'), { recursive: true });
    await fs.writeFile(path.join(dir, '.crewly', 'tickets', 'A-1-x.md'), 'x');
    await fs.writeFile(path.join(dir, '.crewly', 'requests', 'r.json'), '{}');
  }

  async function untracked(): Promise<string[]> {
    const r = await runGit(dir, ['status', '--porcelain', '-uall']);
    return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
  }

  it.each(['.crewly/\n', '.crewly\n', '/.crewly/\n', '.crewly/*\n', '.crewly/**\n'])(
    'un-ignores only the tickets folder when .gitignore has %j',
    async (rule) => {
      await initRepo(rule);
      expect(await ensureTicketsTracked(dir)).toBe('unignored');
      const files = await untracked();
      expect(files).toContain('.crewly/tickets/A-1-x.md');
      expect(files).not.toContain('.crewly/requests/r.json');
      const text = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
      expect(text.startsWith(rule)).toBe(true); // the user's line is untouched
    },
  );

  it('is idempotent: the block is appended once', async () => {
    await initRepo('node_modules\n.crewly/\n');
    await ensureTicketsTracked(dir);
    expect(await ensureTicketsTracked(dir)).toBe('tracked');
    const text = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(text.split('!.crewly/tickets/\n')).toHaveLength(2);
  });

  it('leaves .gitignore alone when the folder is not ignored', async () => {
    await initRepo('node_modules\n');
    expect(await ensureTicketsTracked(dir)).toBe('tracked');
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  it('does nothing outside a git repo', async () => {
    expect(await ensureTicketsTracked(dir)).toBe('not-a-repo');
    await expect(fs.access(path.join(dir, '.gitignore'))).rejects.toThrow();
  });

  it('works when .crewly is ignored from info/exclude and there is no .gitignore', async () => {
    await initRepo();
    await fs.appendFile(path.join(dir, '.git', 'info', 'exclude'), '.crewly/\n');
    expect(await ensureTicketsTracked(dir)).toBe('unignored');
    expect(await untracked()).toContain('.crewly/tickets/A-1-x.md');
  });

  it('reports still-ignored when git cannot answer', async () => {
    const git = jest.fn(async (_cwd: string, args: string[]) =>
      args[0] === 'rev-parse'
        ? { ok: true, code: 0, stdout: 'true\n', stderr: '' }
        : { ok: false, code: 128, stdout: '', stderr: 'fatal' },
    );
    expect(await ensureTicketsTracked(dir, git)).toBe('still-ignored');
  });
});
