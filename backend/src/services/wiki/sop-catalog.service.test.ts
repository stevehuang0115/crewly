/**
 * Tests for SopCatalogService — list / install / uninstall against a temp
 * catalog and a temp team vault.
 *
 * @module services/wiki/sop-catalog.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { SopCatalogService, teamSopsDir } from './sop-catalog.service';

describe('SopCatalogService', () => {
  let tmp: string;
  let configDir: string;
  let vaultPath: string;
  const svc = new SopCatalogService();

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sop-catalog-'));
    configDir = path.join(tmp, 'config');
    // Catalog: config/sops/{common,pm}/*.md
    await fs.mkdir(path.join(configDir, 'sops', 'common'), { recursive: true });
    await fs.mkdir(path.join(configDir, 'sops', 'pm'), { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'sops', 'common', 'blocker-handling.md'),
      '---\ntitle: Blocker Handling\n---\nbody',
    );
    await fs.writeFile(
      path.join(configDir, 'sops', 'pm', 'progress-tracking.md'),
      '# Progress Tracking\nbody',
    );
    // Team vault at <tmp>/teams/abc/wiki (installed store is the sibling sops/).
    vaultPath = path.join(tmp, 'teams', 'abc', 'wiki');
    await fs.mkdir(vaultPath, { recursive: true });
    process.env.CREWLY_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    delete process.env.CREWLY_CONFIG_DIR;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists the catalog with categories and titles, none installed initially', async () => {
    const list = await svc.list(vaultPath);
    expect(list.map((e) => e.path)).toEqual([
      'common/blocker-handling.md',
      'pm/progress-tracking.md',
    ]);
    expect(list[0]).toMatchObject({ category: 'common', title: 'Blocker Handling', installed: false });
    // Filename fallback title.
    expect(list[1].title).toBe('progress tracking');
    expect(list.every((e) => !e.installed)).toBe(true);
  });

  it('install copies into the team sops dir and flips installed=true', async () => {
    const res = await svc.install(vaultPath, 'pm/progress-tracking.md');
    expect(res).toEqual({ installed: true, path: 'pm/progress-tracking.md' });
    expect(existsSync(path.join(teamSopsDir(vaultPath), 'pm', 'progress-tracking.md'))).toBe(true);
    const list = await svc.list(vaultPath);
    expect(list.find((e) => e.path === 'pm/progress-tracking.md')?.installed).toBe(true);
    expect(list.find((e) => e.path === 'common/blocker-handling.md')?.installed).toBe(false);
  });

  it('uninstall removes the team copy (catalog untouched) and is idempotent', async () => {
    await svc.install(vaultPath, 'pm/progress-tracking.md');
    await svc.uninstall(vaultPath, 'pm/progress-tracking.md');
    expect(existsSync(path.join(teamSopsDir(vaultPath), 'pm', 'progress-tracking.md'))).toBe(false);
    // emptied category dir is pruned
    expect(existsSync(path.join(teamSopsDir(vaultPath), 'pm'))).toBe(false);
    // catalog original still there
    expect(existsSync(path.join(configDir, 'sops', 'pm', 'progress-tracking.md'))).toBe(true);
    // idempotent second call
    await expect(svc.uninstall(vaultPath, 'pm/progress-tracking.md')).resolves.toEqual({
      installed: false,
      path: 'pm/progress-tracking.md',
    });
  });

  it('rejects unsafe paths', async () => {
    await expect(svc.install(vaultPath, '../../../etc/passwd')).rejects.toThrow();
    await expect(svc.install(vaultPath, 'notmd.txt')).rejects.toThrow(/\.md/);
  });

  it('install throws when the catalog file is missing', async () => {
    await expect(svc.install(vaultPath, 'pm/nonexistent.md')).rejects.toThrow();
  });
});
