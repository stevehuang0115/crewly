/**
 * Tests for bundle manifest validation: a complete bundle passes, every
 * class of mistake is reported, and templates without a bundle section keep
 * loading exactly as before (backward compatibility).
 */

import * as fs from 'fs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { TemplateService } from '../template/template.service.js';
import {
  bundleTeams,
  hasBundleSection,
  isValidCronExpression,
  leadRoleOf,
  parseMemberRef,
  validateBundleTemplate,
} from './bundle-manifest.js';
import type { BundleTemplate } from '../../types/solution-bundle.types.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));

const OSS_TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'config', 'templates');

/** A complete, valid bundle template. */
function validBundle(): BundleTemplate {
  return {
    id: 'demo-bundle',
    name: 'Demo',
    description: 'Demo bundle',
    version: '1.0.0',
    hierarchical: true,
    mission: '为 {{business_name}} 做内容',
    roles: [
      {
        role: 'team-leader',
        label: 'Lead',
        defaultName: 'Ava',
        count: 1,
        hierarchyLevel: 1,
        canDelegate: true,
        defaultSkills: ['delegate-task'],
        promptAdditions: '你是 {{lead_name}}，{{team_name}} 的负责人，品牌 {{business_name}}',
      },
      {
        role: 'content-strategist',
        label: 'Writer',
        defaultName: 'Leo',
        count: 1,
        hierarchyLevel: 2,
        canDelegate: false,
        reportsTo: 'team-leader',
        defaultSkills: [],
      },
    ],
    bundle: {
      schemaVersion: 1,
      label: '演示',
      tagline: '一句话',
      ownerSummary: '做什么',
      runtime: { recommended: 'crewly-agent', compatible: ['claude-code'] },
      server: { tier: 'entry' },
      timezone: '{{timezone}}',
      teamName: '{{business_name}} 团队',
      questions: [
        { id: 'business_name', label: '名字', type: 'text', required: true },
        { id: 'timezone', label: '时区', type: 'select', required: false, default: 'Asia/Shanghai', options: [{ value: 'Asia/Shanghai' }] },
      ],
      norms: [{ id: 'voice', title: '口吻', trigger: 'content', content: '{{business_name}} 的口吻' }],
      sops: [{ id: 'review', title: '审核', category: 'content', content: '先给 {{lead_name}} 看' }],
      reviewPoints: [{ id: 'publish', what: '发布', approver: 'owner' }],
      skills: { required: ['web-search'], optional: ['social-media-post'] },
      connectors: [{ id: 'google-workspace', products: ['gmail'], required: false, why: '读邮件' }],
      slack: { channels: [{ key: 'approvals', name: '{{business_name}}-审批', members: ['team-leader', 'content-strategist'] }] },
      schedules: [{ id: 'daily', title: '简报', cron: '0 9 * * 1-5', target: 'team-leader', task: '给老板发简报' }],
      firstWeek: [{ id: 'hello', day: 0, title: '认识', task: '了解 {{business_name}}' }],
    },
  };
}

/** Validation errors of a bundle after a mutation. */
function errorsAfter(mutate: (t: BundleTemplate & Record<string, unknown>) => void): string[] {
  const t = validBundle() as BundleTemplate & Record<string, unknown>;
  mutate(t);
  return validateBundleTemplate(t).errors;
}

describe('validateBundleTemplate', () => {
  it('accepts a complete bundle', () => {
    expect(validateBundleTemplate(validBundle())).toEqual({ ok: true, errors: [] });
  });

  it('requires the bundle section and its owner-facing fields', () => {
    expect(validateBundleTemplate({ id: 'x', name: 'x', description: '' }).errors).toContain('bundle: section required');
    expect(errorsAfter((t) => { t.bundle.label = ''; })).toContain('bundle.label: required');
    expect(errorsAfter((t) => { (t.bundle as { schemaVersion: number }).schemaVersion = 2; })).toContain('bundle.schemaVersion: must be 1');
  });

  it('checks runtime and server tier', () => {
    expect(errorsAfter((t) => { (t.bundle.runtime as { recommended: string }).recommended = 'gpt-9'; })[0]).toMatch(/runtime.recommended/);
    expect(errorsAfter((t) => { (t.bundle.server as { tier: string }).tier = 'huge'; })[0]).toMatch(/server.tier/);
  });

  it('needs a lead, unique ASCII member names and known reportsTo', () => {
    expect(errorsAfter((t) => { t.roles[0].canDelegate = false; }).join('\n')).toMatch(/one role must be the lead/);
    expect(errorsAfter((t) => { t.roles[1].defaultName = '小李'; }).join('\n')).toMatch(/ASCII/);
    expect(errorsAfter((t) => { t.roles[1].defaultName = 'ava'; }).join('\n')).toMatch(/duplicate "ava"/);
    expect(errorsAfter((t) => { t.roles[1].reportsTo = 'boss'; }).join('\n')).toMatch(/unknown role "boss"/);
    expect(errorsAfter((t) => { t.roles = []; }).join('\n')).toMatch(/at least one role/);
  });

  it('reports placeholders no question fills', () => {
    const errors = errorsAfter((t) => { t.bundle.schedules![0].task = '给 {{owner_name}} 发'; });
    expect(errors).toEqual(['bundle.schedules[0].task: placeholder without a question: {{owner_name}}']);
  });

  it('allows the built-ins team_name / lead_name and forbids them as question ids', () => {
    expect(validateBundleTemplate(validBundle()).ok).toBe(true);
    const errors = errorsAfter((t) => { t.bundle.questions!.push({ id: 'team_name', label: 'x', type: 'text', required: true }); });
    expect(errors.join('\n')).toMatch(/built-in placeholder/);
  });

  it('checks question shapes: id, options, defaults', () => {
    expect(errorsAfter((t) => { t.bundle.questions![0].id = 'Business-Name'; }).join('\n')).toMatch(/lower snake case/);
    expect(errorsAfter((t) => { t.bundle.questions![1].options = []; }).join('\n')).toMatch(/needs options/);
    expect(errorsAfter((t) => { delete t.bundle.questions![1].default; }).join('\n')).toMatch(/optional question needs a default/);
    expect(errorsAfter((t) => { t.bundle.questions![1].default = 'Mars/Base'; }).join('\n')).toMatch(/not an option/);
    expect(errorsAfter((t) => { t.bundle.questions!.push({ ...t.bundle.questions![0] }); }).join('\n')).toMatch(/duplicate "business_name"/);
  });

  it('checks member refs in schedules, first-week tasks and channels', () => {
    expect(errorsAfter((t) => { t.bundle.schedules![0].target = 'designer'; })).toEqual(['bundle.schedules[0].target: unknown role "designer" in team "main"']);
    expect(errorsAfter((t) => { t.bundle.firstWeek![0].target = 'ops/team-leader'; })).toEqual(['bundle.firstWeek[0].target: unknown team "ops"']);
    expect(errorsAfter((t) => { t.bundle.slack!.channels![0].members = ['*']; })).toEqual([]);
    expect(errorsAfter((t) => { t.bundle.slack!.channels![0].members = []; })[0]).toMatch(/at least one ref/);
  });

  it('accepts refs into extra teams', () => {
    const errors = errorsAfter((t) => {
      t.bundle.teams = [{ key: 'ops', name: '运营', roles: [{ ...t.roles[0], defaultName: 'Oli' }] }];
      t.bundle.schedules![0].target = 'ops/team-leader';
    });
    expect(errors).toEqual([]);
  });

  it('checks cron, day, time and ids', () => {
    expect(errorsAfter((t) => { t.bundle.schedules![0].cron = '0 25 * * *'; })[0]).toMatch(/cron/);
    expect(errorsAfter((t) => { t.bundle.firstWeek![0].day = 7; })[0]).toMatch(/day: integer 0-6/);
    expect(errorsAfter((t) => { t.bundle.firstWeek![0].time = '9am'; })[0]).toMatch(/HH:MM/);
    expect(errorsAfter((t) => { t.bundle.schedules!.push({ ...t.bundle.schedules![0] }); })[0]).toMatch(/duplicate "daily"/);
  });

  it('checks connectors and google products', () => {
    expect(errorsAfter((t) => { t.bundle.connectors![0].id = 'myspace'; })[0]).toMatch(/connectors\[0\].id/);
    expect(errorsAfter((t) => { t.bundle.connectors![0].products = ['youtube']; })[0]).toMatch(/products/);
    expect(errorsAfter((t) => { t.bundle.connectors!.push({ id: 'canva', products: ['gmail'], required: false, why: 'x' }); })[0]).toMatch(/only for google-workspace/);
    expect(errorsAfter((t) => { t.bundle.connectors![0].why = ''; })[0]).toMatch(/why/);
  });

  it('checks norms and SOPs: one of content/file, safe paths, reserved id', () => {
    expect(errorsAfter((t) => { t.bundle.norms![0].file = 'norms/x.md'; })[0]).toMatch(/exactly one of content \/ file/);
    expect(errorsAfter((t) => { delete t.bundle.norms![0].content; t.bundle.norms![0].file = '../secret.md'; })[0]).toMatch(/relative path/);
    expect(errorsAfter((t) => { t.bundle.norms![0].id = 'owner-review-points'; })[0]).toMatch(/written from reviewPoints/);
    expect(errorsAfter((t) => { t.bundle.sops![0].team = 'nope'; })[0]).toMatch(/unknown team "nope"/);
  });

  it('reads referenced files when given a directory, and checks their placeholders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bundle-manifest-'));
    try {
      mkdirSync(path.join(dir, 'norms'));
      writeFileSync(path.join(dir, 'norms', 'ok.md'), '{{business_name}}');
      writeFileSync(path.join(dir, 'norms', 'bad.md'), '{{nobody}}');
      const read = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);
      const make = (file: string): BundleTemplate => {
        const t = validBundle();
        t.bundle.norms = [{ id: 'n', title: 'n', file }];
        return t;
      };
      expect(validateBundleTemplate(make('norms/ok.md'), { dir, readFile: read }).ok).toBe(true);
      expect(validateBundleTemplate(make('norms/bad.md'), { dir, readFile: read }).errors[0]).toMatch(/\{\{nobody\}\}/);
      expect(validateBundleTemplate(make('norms/missing.md'), { dir, readFile: read }).errors[0]).toMatch(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  it('isValidCronExpression', () => {
    expect(isValidCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isValidCronExpression('*/15 8-18 * * *')).toBe(true);
    expect(isValidCronExpression('0,30 9 1 1,6 0')).toBe(true);
    expect(isValidCronExpression('0 9 * *')).toBe(false);
    expect(isValidCronExpression('0 9 * * 7')).toBe(false);
    expect(isValidCronExpression('0 9 * * 5-1')).toBe(false);
    expect(isValidCronExpression('*/0 * * * *')).toBe(false);
    expect(isValidCronExpression('a b c d e')).toBe(false);
  });

  it('parseMemberRef', () => {
    expect(parseMemberRef('team-leader')).toEqual({ teamKey: 'main', role: 'team-leader' });
    expect(parseMemberRef('ops/researcher')).toEqual({ teamKey: 'ops', role: 'researcher' });
  });

  it('leadRoleOf and bundleTeams', () => {
    const t = validBundle();
    expect(leadRoleOf(t.roles)).toBe('team-leader');
    expect(leadRoleOf([])).toBe('');
    t.bundle.teams = [{ key: 'ops', name: '运营', roles: [{ ...t.roles[0], defaultName: 'Oli' }] }];
    expect(bundleTeams(t).map((x) => [x.key, x.name, x.leadRole])).toEqual([
      ['main', '{{business_name}} 团队', 'team-leader'],
      ['ops', '运营', 'team-leader'],
    ]);
  });

  it('hasBundleSection', () => {
    expect(hasBundleSection({ bundle: {} })).toBe(true);
    expect(hasBundleSection({ bundle: 'x' })).toBe(false);
    expect(hasBundleSection(null)).toBe(false);
  });
});

describe('backward compatibility', () => {
  afterEach(() => TemplateService.clearInstance());

  it('no shipped OSS template carries a bundle section (paid bundles live in crewly-pro)', () => {
    const files = fs.readdirSync(OSS_TEMPLATES_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      expect(hasBundleSection(JSON.parse(fs.readFileSync(path.join(OSS_TEMPLATES_DIR, file), 'utf-8')))).toBe(false);
    }
  });

  it('every existing OSS template still loads in TemplateService', () => {
    const service = TemplateService.getInstance(OSS_TEMPLATES_DIR);
    const ids = service.listTemplates().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['personal-assistant-team', 'growth-marketing-team', 'web-dev-team']));
    expect(service.listOnboardingStarters().map((t) => t.id)).toEqual(['personal-assistant-team', 'growth-marketing-team']);
  });

  it('a template with a bundle section still loads as a plain template, bundle carried through', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bundle-compat-'));
    try {
      writeFileSync(path.join(dir, 'demo-bundle.json'), JSON.stringify(validBundle()));
      const service = TemplateService.getInstance(dir);
      const template = service.getTemplate('demo-bundle');
      expect(template?.roles.map((r) => r.defaultName)).toEqual(['Ava', 'Leo']);
      expect(template?.bundle?.label).toBe('演示');
      expect(validateBundleTemplate(validBundle()).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
