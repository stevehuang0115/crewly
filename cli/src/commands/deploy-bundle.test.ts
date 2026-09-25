/**
 * Tests for `crewly deploy-bundle`: the answers file, --dry-run, local
 * validation, deploying through a running backend (polling) or in-process,
 * --json, exit codes, --templates-dir, and the interactive questions used by
 * `crewly onboard --template <bundle>`.
 */

jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

import { BundleError } from '../../../backend/src/services/bundle/bundle-apply.service.js';
import type { BundleCatalogEntry } from '../../../backend/src/services/bundle/bundle-catalog.js';
import type { BundleDeployment, BundleQuestion, BundleTemplate } from '../../../backend/src/types/solution-bundle.types.js';
import {
  answersSkeleton,
  askBundleQuestions,
  createRemoteTarget,
  deployBundle,
  deployBundleCommand,
  deploymentFailed,
  formatDeployment,
  loadAnswersFile,
  type BundleDeployTarget,
} from './deploy-bundle.js';

const QUESTIONS: BundleQuestion[] = [
  { id: 'business_name', label: '名字', type: 'text', required: true },
  { id: 'platforms', label: '平台', type: 'multiselect', required: true, options: [{ value: '小红书' }, { value: '抖音' }] },
  { id: 'tone', label: '语气', type: 'select', required: false, default: '亲切', options: [{ value: '亲切' }, { value: '专业' }] },
];

/** The fixture bundle. */
function template(): BundleTemplate {
  return {
    id: 'demo',
    name: 'Demo',
    description: 'd',
    roles: [{ role: 'team-leader', label: 'Lead', defaultName: 'Ava', count: 1, hierarchyLevel: 1, canDelegate: true, defaultSkills: [], jobTitle: '负责人' }],
    bundle: {
      schemaVersion: 1,
      label: '演示',
      tagline: 't',
      ownerSummary: 's',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
      questions: QUESTIONS,
      schedules: [{ id: 'd', title: '简报', cron: '0 9 * * *', task: 'x' }],
      firstWeek: [{ id: 'f', day: 0, title: '认识', task: 'x' }],
    },
  };
}

const CATALOG = {
  get: (id: string): BundleCatalogEntry | null =>
    id === 'demo' ? { template: template(), dir: '/t', file: '/t/template.json', validation: { ok: true, errors: [] } } : null,
};

/** A deployment in some state. */
function deployment(status: BundleDeployment['status'], stepStatus: 'done' | 'pending' | 'failed' = 'done'): BundleDeployment {
  return {
    templateId: 'demo',
    templateVersion: '1',
    jobId: 'job-1',
    status,
    runtime: 'claude-code',
    answers: {},
    startedAt: '',
    updatedAt: '',
    teams: [],
    steps: [
      { id: 'team', label: '建团队', status: 'done', message: '团队已就绪' },
      { id: 'slack', label: '建 Slack 频道', status: stepStatus, reason: 'slack_not_connected', message: '还没连 Slack', items: [{ id: 'c', label: '#x', status: 'pending', message: 'later' }] },
    ],
    connectors: [{ id: 'canva', products: [], required: false, why: '做图', status: 'not_connected', connectPath: '/connections?platform=canva' }],
    firstWeek: [],
    schedules: {},
    channels: {},
  };
}

const ANSWERS = { business_name: 'Acme', platforms: ['小红书'] };

describe('deploy-bundle', () => {
  let lines: string[];
  const log = (line: string): void => {
    lines.push(line);
  };

  beforeEach(() => {
    lines = [];
    process.exitCode = undefined;
  });

  afterAll(() => {
    process.exitCode = undefined;
  });

  describe('loadAnswersFile', () => {
    it('parses a JSON object', () => {
      expect(loadAnswersFile('a.json', () => '{"business_name":"x"}')).toEqual({ business_name: 'x' });
    });

    it('explains a missing file, bad JSON and a non-object', () => {
      expect(() => loadAnswersFile('a.json', () => { throw new Error('ENOENT'); })).toThrow('Cannot read the answers file: a.json');
      expect(() => loadAnswersFile('a.json', () => '{')).toThrow(/not valid JSON/);
      expect(() => loadAnswersFile('a.json', () => '[1]')).toThrow(/must be a JSON object/);
    });
  });

  it('answersSkeleton lists every question with its default', () => {
    expect(JSON.parse(answersSkeleton(QUESTIONS))).toEqual({ business_name: '', platforms: [], tone: '亲切' });
  });

  it('--dry-run validates and prints the plan without deploying', async () => {
    const local = jest.fn();
    const code = await deployBundle('demo', { dryRun: true }, { catalog: CATALOG, log, local, isRunning: async () => false });
    expect(code).toBe(0);
    expect(local).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('演示 (demo) — ready');
    expect(lines.join('\n')).toContain('Ava (负责人)');
    expect(lines.join('\n')).toContain('Nothing was deployed');
  });

  it('--dry-run of an unknown bundle fails', async () => {
    expect(await deployBundle('nope', { dryRun: true }, { catalog: CATALOG, log })).toBe(1);
  });

  it('refuses missing answers before deploying and prints an answers skeleton', async () => {
    const local = jest.fn();
    const code = await deployBundle('demo', { answers: { business_name: 'x' } }, { catalog: CATALOG, log, local, isRunning: async () => false });
    expect(code).toBe(1);
    expect(local).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('还没回答：平台（platforms）');
    expect(lines.join('\n')).toContain('"platforms": []');
  });

  it('deploys in-process when Crewly is not running, passing --templates-dir, --runtime and --allow-draft', async () => {
    const wait = jest.fn(async () => deployment('partial', 'pending'));
    const local = jest.fn((): BundleDeployTarget => ({ where: 'in-process', start: jest.fn(), getJob: jest.fn(), wait }));
    const code = await deployBundle(
      'demo',
      { answers: ANSWERS, runtime: 'crewly-agent', allowDraft: true, templatesDir: ['/pro/templates'] },
      { catalog: CATALOG, log, local, isRunning: async () => false },
    );
    expect(code).toBe(0);
    expect(local).toHaveBeenCalledWith(['/pro/templates']);
    expect(wait).toHaveBeenCalledWith({ templateId: 'demo', answers: ANSWERS, runtime: 'crewly-agent', allowDraft: true });
    const out = lines.join('\n');
    expect(out).toContain('Crewly is not running');
    expect(out).toContain('… 建 Slack 频道 — 还没连 Slack');
    expect(out).toContain('canva — 做图 → /connections?platform=canva');
    expect(out).toContain('finish by themselves');
  });

  it('deploys through the running backend and polls the job until it finishes', async () => {
    const getJob = jest.fn().mockResolvedValueOnce(deployment('running')).mockResolvedValueOnce(deployment('done'));
    const start = jest.fn(async () => deployment('running'));
    const sleep = jest.fn(async () => undefined);
    const code = await deployBundle('demo', { answers: ANSWERS, templatesDir: ['/x'] }, {
      catalog: CATALOG,
      log,
      isRunning: async () => true,
      remote: () => ({ where: 'backend', start, getJob }),
      sleep,
    });
    expect(code).toBe(0);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain('--templates-dir is not seen by it');
    expect(lines.join('\n')).toContain('✓ Deployed.');
  });

  it('stops polling at the timeout', async () => {
    let t = 0;
    const code = await deployBundle('demo', { answers: ANSWERS }, {
      catalog: CATALOG,
      log,
      isRunning: async () => true,
      remote: () => ({ where: 'backend', start: async () => deployment('running'), getJob: async () => deployment('running') }),
      sleep: async () => undefined,
      now: () => (t += 60_000),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Still running');
  });

  it('exits 1 when a step failed or the engine refused', async () => {
    const failed = await deployBundle('demo', { answers: ANSWERS }, {
      catalog: CATALOG,
      log,
      isRunning: async () => false,
      local: () => ({ where: 'in-process', start: jest.fn(), getJob: jest.fn(), wait: async () => deployment('partial', 'failed') }),
    });
    expect(failed).toBe(1);
    expect(lines.join('\n')).toContain('Run the same command again');
    const refused = await deployBundle('other', {}, {
      catalog: CATALOG,
      log,
      isRunning: async () => true,
      remote: () => ({ where: 'backend', start: async () => { throw new BundleError('unknown_bundle', '没有找到方案「other」'); }, getJob: jest.fn() }),
    });
    expect(refused).toBe(1);
    expect(lines.join('\n')).toContain('没有找到方案「other」');
  });

  it('--json prints the final deployment', async () => {
    await deployBundle('demo', { answers: ANSWERS, json: true }, {
      catalog: CATALOG,
      log,
      isRunning: async () => false,
      local: () => ({ where: 'in-process', start: jest.fn(), getJob: jest.fn(), wait: async () => deployment('done') }),
    });
    expect(JSON.parse(lines[lines.length - 1]).jobId).toBe('job-1');
  });

  it('deployBundleCommand reads --answers and sets the exit code', async () => {
    await deployBundleCommand('demo', { answers: 'answers.json' }, {
      catalog: CATALOG,
      log,
      readFile: () => '{',
    });
    expect(process.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('not valid JSON');
    process.exitCode = undefined;
    await deployBundleCommand('demo', { answers: 'answers.json' }, {
      catalog: CATALOG,
      log,
      readFile: () => JSON.stringify(ANSWERS),
      isRunning: async () => false,
      local: () => ({ where: 'in-process', start: jest.fn(), getJob: jest.fn(), wait: async () => deployment('done') }),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('createRemoteTarget posts to the apply route and unwraps errors', async () => {
    const http = jest
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { success: true, data: { jobId: 'job-1', deployment: deployment('running') } } })
      .mockResolvedValueOnce({ status: 200, body: { success: true, data: deployment('done') } })
      .mockResolvedValueOnce({ status: 400, body: { success: false, code: 'invalid_answers', error: '还没回答', missing: [{ id: 'x' }] } });
    const target = createRemoteTarget('http://localhost:9', http);
    expect((await target.start({ templateId: 'demo' })).status).toBe('running');
    expect(http).toHaveBeenCalledWith('POST', 'http://localhost:9/api/bundles/apply', { templateId: 'demo' });
    expect((await target.getJob('job 1')).status).toBe('done');
    expect(http).toHaveBeenCalledWith('GET', 'http://localhost:9/api/bundles/apply/job%201');
    await expect(target.start({ templateId: 'demo' })).rejects.toMatchObject({ code: 'invalid_answers', details: { missing: [{ id: 'x' }] } });
  });

  it('formatDeployment and deploymentFailed', () => {
    expect(formatDeployment(deployment('done'))[0]).toBe('  ✓ 建团队 — 团队已就绪');
    expect(deploymentFailed(deployment('done'))).toBe(false);
    expect(deploymentFailed(deployment('partial', 'failed'))).toBe(true);
    expect(deploymentFailed(deployment('failed'))).toBe(true);
  });

  describe('askBundleQuestions', () => {
    /** A prompt that answers from a list. */
    function answering(answers: string[]): (q: string) => Promise<string> {
      return async () => answers.shift() ?? '';
    }

    it('asks each question: text, numbered multiselect, Enter for the default', async () => {
      const answers = await askBundleQuestions(answering(['Acme', '1,2', '']), QUESTIONS, {}, log);
      expect(answers).toEqual({ business_name: 'Acme', platforms: ['小红书', '抖音'] });
    });

    it('re-asks an empty required answer and an invalid choice', async () => {
      const answers = await askBundleQuestions(answering(['', 'Acme', '9', '抖音', '5', '2']), QUESTIONS, {}, log);
      expect(answers).toEqual({ business_name: 'Acme', platforms: ['抖音'], tone: '专业' });
      expect(lines.join('\n')).toContain('这一项必填');
      expect(lines.join('\n')).toContain('请输入 1-2');
    });

    it('keeps answers given in advance', async () => {
      const ask = jest.fn(async () => '');
      const answers = await askBundleQuestions(ask, QUESTIONS, { business_name: 'Pre', platforms: ['小红书'], tone: '专业' }, log);
      expect(ask).not.toHaveBeenCalled();
      expect(answers).toEqual({ business_name: 'Pre', platforms: ['小红书'], tone: '专业' });
    });
  });
});
