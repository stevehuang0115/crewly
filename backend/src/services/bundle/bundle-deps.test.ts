/**
 * Tests for the backend-free bundle collaborators (used by the CLI).
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { StorageService } from '../core/storage.service.js';
import { bundleTemplateDirs } from './bundle-catalog.js';
import { createBaseBundleDeps } from './bundle-deps.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('bundle deps', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'bundle-deps-'));
    StorageService.clearInstance();
  });

  afterEach(() => {
    StorageService.clearInstance();
    rmSync(home, { recursive: true, force: true });
  });

  it('template dirs: OSS templates, then --templates-dir, then CREWLY_TEMPLATE_DIRS', () => {
    expect(bundleTemplateDirs('/pkg', ['/pro'], { CREWLY_TEMPLATE_DIRS: '/env' })).toEqual([
      path.join('/pkg', 'config', 'templates'),
      '/pro',
      '/env',
    ]);
  });

  it('leaves Slack, the orchestrator and connector checks out (steps go pending)', () => {
    const deps = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => null, env: {} });
    expect(deps.slack).toBeNull();
    expect(deps.orchestrator).toBeNull();
    expect(deps.connectors).toBeNull();
    expect(deps.schedules).not.toBeNull();
    expect(deps.crewlyHome).toBe(home);
    expect(deps.store.fileFor('x')).toBe(path.join(home, 'bundles', 'x.json'));
  });

  it('reads teams from the given home and finds bundled skills in the package', async () => {
    const deps = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => null, env: {} });
    expect(await deps.teams.get('nope')).toBeNull();
    expect(await deps.skills.isAvailable('web-search')).toBe(true);
    expect(await deps.skills.isAvailable('get-team-norms')).toBe(true);
  });

  it('resolves the runtime from the orchestrator harness and DEEPSEEK_API_KEY', async () => {
    const local = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => 'codex-cli', env: {} });
    expect(await local.resolveRuntime('crewly-agent', undefined)).toBe('codex-cli');
    const hosted = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => 'claude-code', env: { DEEPSEEK_API_KEY: 'k' } });
    expect(await hosted.resolveRuntime('crewly-agent', undefined)).toBe('crewly-agent');
    const failing = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => { throw new Error('x'); }, env: {} });
    expect(await failing.resolveRuntime('crewly-agent', undefined)).toBe('crewly-agent');
  });

  it('the catalog reads the OSS templates (none of which is a bundle)', () => {
    const deps = createBaseBundleDeps({ crewlyHome: home, packageRoot: PACKAGE_ROOT, getOrcHarness: async () => null, env: {} });
    expect(deps.catalog.list()).toEqual([]);
  });
});
