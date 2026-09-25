/**
 * Tests for the bundle catalog: both template layouts, CREWLY_TEMPLATE_DIRS,
 * invalid bundles reported (not loaded), first directory wins, drafts
 * hidden by default, and the summary / detail DTOs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { BundleTemplate } from '../../types/solution-bundle.types.js';
import {
  BundleCatalog,
  isReady,
  readTextOrNull,
  resolveTemplateDirs,
  scanBundles,
  toBundleDetail,
  toBundleSummary,
} from './bundle-catalog.js';

/** A small valid bundle. */
function bundle(id: string, overrides: Partial<BundleTemplate['bundle']> = {}): BundleTemplate {
  return {
    id,
    name: `Name ${id}`,
    description: 'desc',
    tier: 'pro',
    roles: [
      { role: 'team-leader', label: 'Lead', defaultName: 'Ava', count: 1, hierarchyLevel: 1, canDelegate: true, defaultSkills: [], jobTitle: '负责人' },
      { role: 'researcher', label: 'Research', defaultName: 'Max', count: 2, hierarchyLevel: 2, canDelegate: false, defaultSkills: [] },
    ],
    bundle: {
      schemaVersion: 1,
      label: `标签 ${id}`,
      tagline: 't',
      ownerSummary: 's',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
      questions: [{ id: 'business_name', label: '名字', type: 'text', required: true }],
      norms: [{ id: 'voice', title: '口吻', file: 'norms/voice.md' }],
      schedules: [{ id: 'daily', title: '简报', cron: '0 9 * * *', task: '做' }],
      firstWeek: [{ id: 'hi', day: 0, title: '你好', task: '做' }],
      slack: { channels: [{ key: 'a', name: '审批', members: ['*'] }] },
      skills: { required: ['web-search'] },
      ...overrides,
    },
  };
}

describe('bundle catalog', () => {
  let root: string;
  let ossDir: string;
  let proDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bundle-catalog-'));
    ossDir = path.join(root, 'oss');
    proDir = path.join(root, 'pro');
    mkdirSync(ossDir);
    mkdirSync(proDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Write `<dir>/<id>/template.json` with its norm file. */
  function writeDirTemplate(dir: string, t: BundleTemplate): void {
    mkdirSync(path.join(dir, t.id, 'norms'), { recursive: true });
    writeFileSync(path.join(dir, t.id, 'template.json'), JSON.stringify(t));
    writeFileSync(path.join(dir, t.id, 'norms', 'voice.md'), '口吻 {{business_name}}');
  }

  it('reads the directory layout and flat files, skipping templates without a bundle section', () => {
    writeDirTemplate(proDir, bundle('pro-one'));
    const flat = bundle('flat-one', { norms: [{ id: 'voice', title: 'v', content: 'x' }] });
    writeFileSync(path.join(ossDir, 'flat-one.json'), JSON.stringify(flat));
    writeFileSync(path.join(ossDir, 'plain.json'), JSON.stringify({ id: 'plain', name: 'p', members: [] }));
    writeFileSync(path.join(ossDir, 'broken.json'), '{nope');
    const { bundles, invalid } = scanBundles([ossDir, proDir]);
    expect(bundles.map((b) => b.template.id)).toEqual(['flat-one', 'pro-one']);
    expect(bundles[1].dir).toBe(path.join(proDir, 'pro-one'));
    expect(invalid).toEqual([]);
  });

  it('reports invalid bundles instead of loading them (e.g. a missing norm file)', () => {
    mkdirSync(path.join(proDir, 'bad'));
    writeFileSync(path.join(proDir, 'bad', 'template.json'), JSON.stringify(bundle('bad')));
    const { bundles, invalid } = scanBundles([proDir]);
    expect(bundles).toEqual([]);
    expect(invalid[0].id).toBe('bad');
    expect(invalid[0].errors.join('\n')).toMatch(/not found: norms\/voice.md/);
  });

  it('first directory wins for a duplicate id', () => {
    writeDirTemplate(ossDir, bundle('same', { label: 'oss' }));
    writeDirTemplate(proDir, bundle('same', { label: 'pro' }));
    expect(scanBundles([ossDir, proDir]).bundles.map((b) => b.template.bundle.label)).toEqual(['oss']);
  });

  it('resolveTemplateDirs appends CREWLY_TEMPLATE_DIRS, dedupes and drops empty entries', () => {
    const env = { CREWLY_TEMPLATE_DIRS: `${proDir}${path.delimiter}${path.delimiter}${ossDir}` };
    expect(resolveTemplateDirs([ossDir], env)).toEqual([ossDir, proDir]);
    expect(resolveTemplateDirs([ossDir], {})).toEqual([ossDir]);
  });

  it('BundleCatalog hides drafts unless asked, and get() finds drafts', () => {
    writeDirTemplate(proDir, bundle('ready-one'));
    writeDirTemplate(proDir, bundle('draft-one', { status: 'draft', todo: ['write SOPs'] }));
    const catalog = new BundleCatalog(() => [proDir]);
    expect(catalog.list().map((b) => b.template.id)).toEqual(['ready-one']);
    expect(catalog.list({ includeDrafts: true }).map((b) => b.template.id)).toEqual(['draft-one', 'ready-one']);
    expect(catalog.get('draft-one')?.template.bundle.status).toBe('draft');
    expect(catalog.get('missing')).toBeNull();
    expect(catalog.invalid()).toEqual([]);
    expect(isReady(bundle('x'))).toBe(true);
    expect(isReady(bundle('x', { status: 'draft' }))).toBe(false);
  });

  it('builds the summary and the detail', () => {
    const t = bundle('dto');
    expect(toBundleSummary(t)).toEqual({
      id: 'dto',
      name: 'Name dto',
      label: '标签 dto',
      tagline: 't',
      description: 'desc',
      status: 'ready',
      tier: 'pro',
      recommendedRuntime: 'crewly-agent',
      serverTier: 'entry',
      memberCount: 3,
      questionCount: 1,
    });
    const detail = toBundleDetail(t);
    expect(detail.teams[0].members).toEqual([
      { name: 'Ava', role: 'team-leader', title: '负责人' },
      { name: 'Max1', role: 'researcher', title: 'Research' },
      { name: 'Max2', role: 'researcher', title: 'Research' },
    ]);
    expect(detail.questions).toHaveLength(1);
    expect(detail.schedules).toEqual([{ id: 'daily', title: '简报', cron: '0 9 * * *' }]);
    expect(detail.firstWeek).toEqual([{ id: 'hi', day: 0, title: '你好' }]);
    expect(detail.channels).toEqual(['审批']);
    expect(detail.skills).toEqual(['web-search']);
  });

  it('readTextOrNull returns null for a missing file', () => {
    expect(readTextOrNull(path.join(root, 'nope.md'))).toBeNull();
  });
});
